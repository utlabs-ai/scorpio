import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { worker } from './helpers/worker.mjs'

// setSite comes in the same bundle, so the test can turn on what our deployment wraps around the server.
const built = await build({ stdin: { contents: "export * from './email-login.ts'; export { setSite } from './layout.ts'", resolveDir: new URL('../src/', import.meta.url).pathname, loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', write: false, external: ['cloudflare:workers'], logLevel: 'silent' })
const login = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const authBuilt = await build({ entryPoints: [new URL('../src/auth.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, external: ['cloudflare:workers'], logLevel: 'silent' })
const auth = await import(`data:text/javascript;base64,${Buffer.from(authBuilt.outputFiles[0].text).toString('base64')}`)
const req = (ip = '192.0.2.1') => new Request('https://scorpio.test/auth/email/start', { headers: { 'cf-connecting-ip': ip } })
const codeOf = (mail) => /\b([0-9]{6})\b/.exec(mail.subject)?.[1]

async function setup(overrides = {}) {
  const w = await worker({ TURNSTILE_SITE_KEY: undefined, TURNSTILE_SECRET: undefined })
  const sent = []
  let fail = false
  const env = {
    DB: w.db, KV: w.kv, LOGIN_CODE_KEY: 'local-test-key-0123456789abcdef',
    EMAIL_SENDING_DOMAIN: 'example.com', EMAIL_LOGIN_NO_TURNSTILE: 'true',
    EMAIL: { async send(message) { if (fail) throw Object.assign(new Error('refused'), { code: 'E_RATE_LIMIT_EXCEEDED' }); sent.push(message); return { messageId: `local-${sent.length}` } } },
    ...overrides,
  }
  return { ...w, env, sent, setFailure(v) { fail = v } }
}
async function start(s, email, flow, ip) { return login.startEmail(req(ip), s.env, email, '/app', '', flow, 'en') }
async function coolOff(s) {
  const t = Date.now() - 61_000
  await s.db.prepare("UPDATE email_login_sends SET sent_at = ? WHERE state = 'accepted'").bind(t).run()
  await s.db.prepare("UPDATE email_login_challenges SET sent_at = ? WHERE state = 'active'").bind(t).run()
}

test('code flow: wrong tries stop at five; expired code can be resent; old code is invalidated', async () => {
  const s = await setup()
  try {
    const first = await start(s, ' Person@Example.test ')
    assert.equal(s.sent.length, 1)
    assert.equal(s.sent[0].to, 'person@example.test')
    assert.equal(s.sent[0].from, 'Scorpio <no-reply@example.com>')
    assert.match(s.sent[0].html, /font-size:32px/)
    const replay = await start(s, 'person@example.test', first.flowId)
    assert.equal(replay.reused, true)
    assert.equal(s.sent.length, 1)
    await assert.rejects(start(s, 'person@example.test'), { code: 'email_cooldown', status: 429 })
    const correct = codeOf(s.sent[0])
    const stored = await s.db.prepare('SELECT code_hash FROM email_login_challenges WHERE flow_id = ?').bind(first.flowId).first()
    assert.match(stored.code_hash, /^[0-9a-f]{64}$/)
    assert.ok(!stored.code_hash.includes(correct))
    for (let n = 1; n <= 5; n++) await assert.rejects(login.verifyEmail(s.env, first.flowId, correct === '000000' ? '111111' : '000000', null), { code: n === 5 ? 'email_code_attempts' : 'email_code_wrong' })
    await assert.rejects(login.verifyEmail(s.env, first.flowId, correct, null), { code: 'email_code_attempts' })
    await coolOff(s)
    const second = await login.resendEmail(req(), s.env, first.flowId, 'zh')
    assert.equal(s.sent.length, 2)
    assert.match(s.sent[1].subject, /^Scorpio 登录验证码：/)
    await assert.rejects(login.verifyEmail(s.env, first.flowId, correct, null), { code: 'email_session_lost' })
    const signed = await login.verifyEmail(s.env, second.flowId, codeOf(s.sent[1]), null)
    assert.equal(signed.user.email, 'person@example.test')
    await assert.rejects(login.verifyEmail(s.env, second.flowId, codeOf(s.sent[1]), null), { code: 'email_session_lost' })
  } finally { await s.dispose() }
})

test('the code mail signs with our address and support mail only on our deployment', async () => {
  const s = await setup()
  try {
    await start(s, 'self@example.test')
    assert.match(s.sent[0].text, /\n\nScorpio$/)
    login.setSite(true, undefined)
    await start(s, 'ours@example.test')
    assert.match(s.sent[1].text, /\n\nScorpio · scorpio\.utlabs\.ai · support@utlabs\.ai$/)
  } finally { login.setSite(false, undefined); await s.dispose() }
})

test('a thirty-minute flow expiry is enforced even when its code has not expired', async () => {
  const s = await setup()
  try {
    const first = await start(s, 'session@example.test')
    await s.db.prepare('UPDATE email_login_challenges SET flow_expires_at = ? WHERE flow_id = ?').bind(Date.now() - 1, first.flowId).run()
    assert.equal(await login.emailFlow(s.env, first.flowId), null)
    await assert.rejects(login.verifyEmail(s.env, first.flowId, codeOf(s.sent[0]), null), { code: 'email_session_lost' })
    await assert.rejects(login.verifyEmail(s.env, first.flowId, 'bad', null), { code: 'email_session_lost' })
    await assert.rejects(login.resendEmail(req(), s.env, first.flowId, 'en'), { code: 'email_session_lost' })
  } finally { await s.dispose() }
})

test('an existing dev identity is refused after email verification links it to a real sign-in', async () => {
  const s = await setup()
  try {
    const claim = { provider: 'dev', subject: 'dev-first@example.test', email: 'dev-first@example.test', suggestedHandle: 'dev-first' }
    const dev = await auth.signIn(s.env, claim)
    const flow = await start(s, claim.email)
    const verified = await login.verifyEmail(s.env, flow.flowId, codeOf(s.sent[0]), null)
    assert.equal(verified.user.id, dev.id)
    await assert.rejects(auth.signIn(s.env, claim), { code: 'forbidden', status: 403 })
  } finally { await s.dispose() }
})

test('provider failure preserves an existing code; expiry leaves the flow available for resend', async () => {
  const s = await setup()
  try {
    const first = await start(s, 'one@example.test')
    const code = codeOf(s.sent[0])
    await coolOff(s)
    s.setFailure(true)
    await assert.rejects(login.resendEmail(req(), s.env, first.flowId, 'en'), { code: 'email_send_failed' })
    assert.equal((await login.emailFlow(s.env, first.flowId)).state, 'active')
    assert.equal((await login.verifyEmail(s.env, first.flowId, code, null)).user.email, 'one@example.test')
    s.setFailure(false)
    const expiring = await start(s, 'expired@example.test')
    await coolOff(s)
    await s.db.prepare('UPDATE email_login_challenges SET code_expires_at = ? WHERE flow_id = ?').bind(Date.now() - 1, expiring.flowId).run()
    assert.equal(login.flowView(await login.emailFlow(s.env, expiring.flowId)).state, 'expired')
    await assert.rejects(login.verifyEmail(s.env, expiring.flowId, codeOf(s.sent[1]), null), { code: 'email_code_expired' })
    const second = await login.resendEmail(req(), s.env, expiring.flowId, 'en')
    assert.notEqual(second.flowId, expiring.flowId)
    assert.equal(login.flowView(await login.emailFlow(s.env, second.flowId)).state, 'ready')
  } finally { await s.dispose() }
})

test('concurrent starts reserve one send and a failed human check sends nothing', async () => {
  const s = await setup()
  try {
    const results = await Promise.allSettled([start(s, 'race@example.test'), start(s, 'race@example.test')])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(s.sent.length, 1)
  } finally { await s.dispose() }
  const guarded = await setup({ PLANS: 'hosted', EMAIL_LOGIN_DELIVERY_VERIFIED: 'true', TURNSTILE_SITE_KEY: 'test-site', TURNSTILE_SECRET: 'test-secret' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ success: false })
  try {
    await assert.rejects(login.startEmail(req(), guarded.env, 'challenge@example.test', '/app', 'bad-token', undefined, 'en'), { code: 'email_challenge_failed' })
    assert.equal(guarded.sent.length, 0)
  } finally { globalThis.fetch = originalFetch; await guarded.dispose() }
})

test('concurrent wrong guesses cannot exceed five and duplicate correct submission signs in once', async () => {
  const s = await setup()
  try {
    const first = await start(s, 'guess@example.test')
    const correct = codeOf(s.sent[0]), wrong = correct === '000000' ? '111111' : '000000'
    await Promise.allSettled(Array.from({ length: 10 }, () => login.verifyEmail(s.env, first.flowId, wrong, null)))
    assert.equal((await login.emailFlow(s.env, first.flowId)).attempts, 5)
    await assert.rejects(login.verifyEmail(s.env, first.flowId, correct, null), { code: 'email_code_attempts' })
    await coolOff(s)
    const second = await login.resendEmail(req(), s.env, first.flowId, 'en')
    const results = await Promise.allSettled([login.verifyEmail(s.env, second.flowId, codeOf(s.sent[1]), null), login.verifyEmail(s.env, second.flowId, codeOf(s.sent[1]), null)])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  } finally { await s.dispose() }
})

test('address and daily caps are enforced from the D1 send ledger', async () => {
  const s = await setup()
  try {
    let flow
    for (let i = 0; i < 3; i++) { flow = await start(s, 'cap@example.test'); if (i < 2) await coolOff(s) }
    await coolOff(s)
    await assert.rejects(start(s, 'cap@example.test'), { code: 'email_rate_limited', status: 429 })
    assert.equal(s.sent.length, 3)
    await s.kv.put('config:email_login', JSON.stringify({ dailyCap: 3 }))
    await assert.rejects(start(s, 'other@example.test', undefined, '192.0.2.9'), { code: 'email_send_limited', status: 429 })
    assert.ok(flow.flowId)
  } finally { await s.dispose() }
})

test('one address can receive at most ten codes per UTC day', async () => {
  const s = await setup()
  try {
    for (let i = 0; i < 10; i++) {
      await start(s, 'daily@example.test')
      await s.db.prepare("UPDATE email_login_sends SET sent_at = ? WHERE state = 'accepted'").bind(Date.now() - 901_000).run()
    }
    await assert.rejects(start(s, 'DAILY@example.test'), { code: 'email_day_limited', status: 429 })
    assert.equal(s.sent.length, 10)
    await s.db.prepare("UPDATE email_login_sends SET day = 'yesterday' WHERE email_key = (SELECT email_key FROM email_login_sends LIMIT 1)").run()
    await start(s, 'daily@example.test')
    assert.equal(s.sent.length, 11)
  } finally { await s.dispose() }
})

test('twenty IP send attempts are allowed and the next one is refused', async () => {
  const s = await setup()
  try {
    for (let i = 0; i < 20; i++) await start(s, `ip-${i}@example.test`)
    await assert.rejects(start(s, 'ip-last@example.test'), { code: 'email_send_limited', status: 429 })
    assert.equal(s.sent.length, 20)
  } finally { await s.dispose() }
})

test('new email users receive the configured trial and invite; dev cannot claim their account', async () => {
  const s = await setup({ PLANS: 'hosted', EMAIL_LOGIN_DELIVERY_VERIFIED: 'true', TURNSTILE_SITE_KEY: 'test-site', TURNSTILE_SECRET: 'test-secret', INVITE_SALT: 'local-invite-key' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('turnstile/v0/siteverify')) return Response.json({ success: true })
    throw new Error('Unexpected network request')
  }
  try {
    await s.kv.put('config:trial', JSON.stringify({ enabled: true, days: 5 }))
    await s.db.prepare('INSERT INTO users (id,handle,primary_email,created_at,is_test) VALUES (?,?,?,?,0)').bind('inviter', 'inviter', 'inviter@example.test', Date.now()).run()
    await s.db.prepare('INSERT INTO invites (code,inviter_id,created_at) VALUES (?,?,?)').bind('ABC234', 'inviter', Date.now()).run()
    const first = await login.startEmail(req(), s.env, 'trial@example.test', '/app', 'test-token', undefined, 'en')
    const trial = await login.verifyEmail(s.env, first.flowId, codeOf(s.sent[0]), null)
    const entitlement = await s.db.prepare('SELECT provider, period_end FROM entitlements WHERE user_id = ?').bind(trial.user.id).first()
    assert.equal(entitlement.provider, 'trial')
    assert.ok(entitlement.period_end > Date.now() + 4 * 86400_000)
    const second = await login.startEmail(req(), s.env, 'friend@example.test', '/app', 'test-token', undefined, 'en')
    const friend = await login.verifyEmail(s.env, second.flowId, codeOf(s.sent[1]), 'ABC234')
    const record = await s.db.prepare('SELECT invited_by FROM users WHERE id = ?').bind(friend.user.id).first()
    assert.equal(record.invited_by, 'inviter')
    await assert.rejects(auth.signIn(s.env, { provider: 'dev', subject: 'friend@example.test', email: 'friend@example.test', suggestedHandle: 'friend' }), { code: 'forbidden' })
  } finally { globalThis.fetch = originalFetch; await s.dispose() }
})

test('verified email links to an existing account and a deleted email remains blocked until its restore window ends', async () => {
  const restoreMs = 60 * 60_000
  const s = await setup({ ACCOUNT_RESTORE_MS: String(restoreMs) })
  try {
    await s.db.prepare('INSERT INTO users (id,handle,primary_email,created_at,is_test) VALUES (?,?,?,?,0)').bind('existing', 'existing', 'link@example.test', Date.now()).run()
    await s.db.prepare('INSERT INTO identities (provider,subject,email,user_id,created_at) VALUES (?,?,?,?,?)').bind('google', 'google-1', 'link@example.test', 'existing', Date.now()).run()
    const first = await start(s, 'link@example.test')
    assert.equal((await login.verifyEmail(s.env, first.flowId, codeOf(s.sent[0]), null)).user.id, 'existing')
    await s.db.prepare('UPDATE users SET primary_email = ?, deleted_email = ?, deleted_at = ? WHERE id = ?').bind('deleted:existing', 'link@example.test', Date.now(), 'existing').run()
    await coolOff(s)
    const second = await start(s, 'link@example.test')
    await assert.rejects(login.verifyEmail(s.env, second.flowId, codeOf(s.sent[1]), null), { code: 'account_deleted' })
    await s.db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(Date.now() - 2 * restoreMs, 'existing').run()
    await coolOff(s)
    const third = await start(s, 'link@example.test')
    const user = (await login.verifyEmail(s.env, third.flowId, codeOf(s.sent[2]), null)).user
    assert.notEqual(user.id, 'existing')
    const oldIdentity = await s.db.prepare("SELECT 1 FROM identities WHERE provider = 'email' AND user_id = 'existing'").first()
    assert.equal(oldIdentity, null)
  } finally { await s.dispose() }
})

test('a deployment sends sign-in codes from no-reply@ its own sending domain; without one, email sign-in is off', async () => {
  const s = await setup({ EMAIL_SENDING_DOMAIN: 'example.test' })
  try {
    assert.equal(login.emailLoginConfigured(s.env), true)
    await start(s, 'person@example.test')
    assert.equal(s.sent[0].from, 'Scorpio <no-reply@example.test>')
    assert.equal(login.emailLoginConfigured({ ...s.env, EMAIL_SENDING_DOMAIN: undefined }), false)
  } finally { await s.dispose() }
})
