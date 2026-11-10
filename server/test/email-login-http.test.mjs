import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { worker, ORIGIN } from './helpers/worker.mjs'

const post = (w, route, body, cookie, headers = {}) => w.fetch(route, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) })
const files = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => item.isDirectory() ? files(path.join(dir, item.name)) : [path.join(dir, item.name)]) : []
async function capturedCode(dir) {
  for (let i = 0; i < 30; i++) {
    const name = files(dir).find((f) => f.includes(`${path.sep}email-text${path.sep}`) && f.endsWith('.txt'))
    if (name) return /\b([0-9]{6})\b/.exec(fs.readFileSync(name, 'utf8'))?.[1]
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Local email simulator did not capture the message')
}

test('local Worker simulation serves both pages and signs in with the captured email code', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-email-test-'))
  const w = await worker({ TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET: undefined, LOGIN_CODE_KEY: 'local-test-key-0123456789abcdef', EMAIL_SENDING_DOMAIN: 'example.com', EMAIL_LOGIN_NO_TURNSTILE: 'true' }, { email: true, resourceTmpPath: temp })
  try {
    const login = await w.fetch('/login')
    assert.equal(login.status, 200)
    const loginHtml = await login.text()
    assert.match(loginHtml, /id="email-start"/)
    assert.match(loginHtml, /data-day="This address has used today&#39;s codes\./)
    const invalid = await post(w, '/auth/email/start', { email: 'bad' })
    assert.deepEqual(await w.json(invalid), { status: 400, error: 'email_invalid', next: 'Enter a valid email address.' })
    const cross = await w.fetch('/auth/email/start', { method: 'POST', headers: { origin: 'https://foreign.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'one@example.test' }) })
    assert.equal((await w.json(cross)).error, 'forbidden')
    const noFlow = await post(w, '/auth/email/verify', { code: 'bad' })
    assert.equal((await w.json(noFlow)).error, 'email_session_lost')
    const started = await post(w, '/auth/email/start', { email: 'one@example.test', next: 'https://foreign.test/steal' })
    assert.equal(started.status, 200)
    assert.equal(started.headers.get('cache-control'), 'no-store')
    const flowCookie = started.headers.get('set-cookie')
    assert.match(flowCookie, /^email_login=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1800; Secure/)
    const startBody = await w.json(started)
    assert.equal(startBody.next, '/login/code')
    assert.ok(!JSON.stringify(startBody).includes('one@example.test'))
    const code = await capturedCode(temp)
    assert.match(code, /^[0-9]{6}$/)
    const page = await w.fetch('/login/code', { headers: { cookie: flowCookie.split(';')[0] } })
    assert.equal(page.status, 200)
    const codeHtml = await page.text()
    assert.match(codeHtml, /one@example\.test/)
    assert.match(codeHtml, /data-day="This address has used today&#39;s codes\./)
    const signed = await post(w, '/auth/email/verify', { code }, flowCookie.split(';')[0])
    assert.equal(signed.status, 200)
    assert.equal((await w.json(signed)).next, '/')
    assert.match(signed.headers.get('set-cookie'), /email_login=/)
    const used = await post(w, '/auth/email/verify', { code }, flowCookie.split(';')[0])
    assert.equal((await w.json(used)).error, 'email_session_lost')
    const usedMalformed = await post(w, '/auth/email/verify', { code: 'bad' }, flowCookie.split(';')[0])
    assert.equal((await w.json(usedMalformed)).error, 'email_session_lost')
  } finally { await w.dispose(); fs.rmSync(temp, { recursive: true, force: true }) }
})

test('new email signups start at ask in the database, agent API and settings page', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-signup-perm-test-'))
  const w = await worker({ TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET: undefined, LOGIN_CODE_KEY: 'local-test-key-0123456789abcdef', EMAIL_SENDING_DOMAIN: 'example.com', EMAIL_LOGIN_NO_TURNSTILE: 'true' }, { email: true, resourceTmpPath: temp })
  try {
    const email = 'new-perm@example.test'
    const started = await post(w, '/auth/email/start', { email })
    assert.equal(started.status, 200)
    const flowCookie = started.headers.get('set-cookie').split(';')[0]
    const signed = await post(w, '/auth/email/verify', { code: await capturedCode(temp) }, flowCookie)
    assert.equal(signed.status, 200)
    const cookie = /(?:^|,\s*)(sid=[^;]+)/.exec(signed.headers.get('set-cookie'))?.[1]
    assert.ok(cookie, 'signup issues a web session')
    const account = await w.db.prepare('SELECT id, spawn_perm FROM users WHERE primary_email = ?').bind(email).first()
    assert.ok(account, 'signup creates the account through createUser')
    assert.equal(account.spawn_perm, 'ask')

    const settings = await w.fetch('/settings', { headers: { cookie } })
    assert.equal(settings.status, 200)
    assert.match(await settings.text(), /name="spawn-perm" value="ask" checked/)

    const device = await post(w, '/oauth/device/code', {})
    assert.equal(device.status, 200)
    const { device_code, user_code } = await device.json()
    assert.equal((await post(w, '/activate', { user_code, decision: 'approve' }, cookie)).status, 200)
    const token = await post(w, '/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code })
    assert.equal(token.status, 200)
    const { access_token } = await token.json()
    assert.ok(access_token)
    const setting = await w.fetch('/api/v1/account/spawn-perm', { headers: { authorization: `Bearer ${access_token}` } })
    assert.equal(setting.status, 200)
    assert.deepEqual(await setting.json(), { perm: 'ask' })
  } finally { await w.dispose(); fs.rmSync(temp, { recursive: true, force: true }) }
})

test('hosted login remains unconfigured until delivery verification is set', async () => {
  const configured = { PLANS: 'hosted', LOGIN_CODE_KEY: 'local-test-key-0123456789abcdef', EMAIL_SENDING_DOMAIN: 'example.com', TURNSTILE_SITE_KEY: 'local-test-site', TURNSTILE_SECRET: 'local-test-secret' }
  const w = await worker({ ...configured, EMAIL_LOGIN_DELIVERY_VERIFIED: undefined }, { email: true })
  try {
    const page = await w.fetch('/login')
    const html = await page.text()
    assert.doesNotMatch(html, /id="email-start"/)
    assert.doesNotMatch(html, /Continue with email|class="sx-or"/)
    const start = await post(w, '/auth/email/start', { email: 'one@example.test' })
    assert.equal((await w.json(start)).error, 'email_send_failed')
  } finally { await w.dispose() }
  const ready = await worker({ ...configured, EMAIL_LOGIN_DELIVERY_VERIFIED: 'true' }, { email: true })
  try {
    const page = await ready.fetch('/login')
    const html = await page.text()
    assert.match(html, /id="email-start"/)
    assert.match(html, /class="sx-or"/)
    const noToken = await post(ready, '/auth/email/start', { email: 'one@example.test' })
    assert.equal((await ready.json(noToken)).error, 'email_challenge_failed')
  } finally { await ready.dispose() }
})
