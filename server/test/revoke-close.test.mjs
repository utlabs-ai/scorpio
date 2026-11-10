// A token that stops working loses its connections (docs/api/auth.md): Settings revoke, the plan, and a newer token
// for the same computer close every WebSocket opened with that token (the daemon's host connection and an agent's
// wait) with 4011 and the reason; other tokens' and the browser's stay open, and a reconnect hears the 401 with the
// reason. The whole Worker and room object in Miniflare, as the lifecycle contract runs them; one worker for the three
// cases (one account each), since starting one takes most of the time.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { worker, ORIGIN } from './helpers/worker.mjs'

const DAY = 864e5
const append = `
export class TestRoom extends RoomDO {
  async testOpen() { return this.ctx.getWebSockets().filter((w) => w.readyState === 1).map((w) => w.deserializeAttachment().name).sort(); }
}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(ok, ms) {
  const end = Date.now() + ms
  while (!(await ok()) && Date.now() < end) await sleep(50)
  return ok()
}

// The close reaches the test only when Miniflare stops (as in the lifecycle contract): it is read after dispose; 1006
// then means the socket was still open: null.
async function socket(res) {
  assert.equal(res.status, 101, await res.text().catch(() => ''))
  const s = { close: undefined }
  res.webSocket.addEventListener('close', (e) => { s.close ??= e.code === 1006 ? null : [e.code, e.reason] })
  res.webSocket.accept()
  return s
}

test('a token that stops working (revoked, replaced, plan) has its connections closed with 4011 and the reason', async () => {
  // Hosted, so the daily job applies Free's one computer (the plan case).
  const w = await worker({ PLANS: 'hosted' }, { append, className: 'TestRoom' })
  const api = (t, path, init = {}, role) => w.fetch(`/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${t}`, ...(role ? { 'x-scorpio-role': role } : {}), ...(init.headers || {}) } })
  const postJson = (path, body) => w.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const pro = (p, end) => w.db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES (?, 'pro', 'active', ?, 'creem', ?)").bind(p.id, end, Date.now()).run()

  /** The person's computer signs in with the device flow (so the token has a device id), as `scorpio login` does. */
  async function login(p) {
    const code = await w.json(await postJson('/oauth/device/code', { device_name: 'box', device_id: `device-${p.handle}`, cli_version: '0.16.0' }))
    assert.equal((await p.post('/activate', { user_code: code.user_code, decision: 'approve' })).status, 200)
    const tok = await w.json(await postJson('/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code }))
    assert.ok(tok.access_token, JSON.stringify(tok))
    return tok.access_token
  }

  /**
   * One account's topic with four connections: a daemon seat and an agent (api@) on the token under test, another
   * agent (other@) on a second token of the account, and the person's page.
   */
  async function cast(p, token) {
    const room = await w.topic(p)
    const ns = await w.mf.getDurableObjectNamespace('ROOMS')
    const stub = ns.get(ns.idFromName(room))
    const second = `tok-${p.handle}-second-0123456789`
    await w.db.prepare('INSERT INTO agent_tokens (id, user_id, hash, device_name, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(`t-${p.handle}-2`, p.id, createHash('sha256').update(second).digest('hex'), 'second', Date.now(), Date.now() + DAY, Date.now()).run()
    const join = async (t, body) => {
      const r = await w.json(await api(t, `/rooms/${room}/join`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
      assert.equal(r.status, 200, JSON.stringify(r))
      return r
    }
    const seat = await join(token, { host: true, device_id: `device-${p.handle}`, machine: 'box' })
    await join(token, { role: 'api' })
    await join(second, { role: 'other' })
    const ws = (t, role) => api(t, `/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, role)
    const sockets = {
      daemon: await socket(await ws(token, seat.name.split('@')[0])),
      api: await socket(await ws(token, 'api')),
      other: await socket(await ws(second, 'other')),
      page: await socket(await p.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } })),
    }
    assert.deepEqual(await stub.testOpen(), [`api@${p.handle}`, p.handle, `other@${p.handle}`, seat.name].sort())
    return { stub, sockets, ws }
  }

  /** After the token ended: its two connections are closed and the others open; a reconnect with it hears the 401. */
  async function closed(p, c, token, reason) {
    assert.ok(await until(async () => (await c.stub.testOpen()).length === 2, 10_000), `${reason}: the token's two connections close`)
    assert.deepEqual(await c.stub.testOpen(), [p.handle, `other@${p.handle}`])
    const again = await w.json(await c.ws(token, 'api'))
    assert.deepEqual([again.status, again.error, again.reason], [401, 'unauthorized', reason])
  }

  const cases = []
  try {
    // Settings revoke (kai's helper token, id t-kai).
    const kai = await w.person('kai')
    const kaiToken = 'tok-kai-0123456789abcdef'
    const revoked = await cast(kai, kaiToken)
    assert.equal((await kai.post('/devices/t-kai/revoke')).status, 303)
    await closed(kai, revoked, kaiToken, 'revoked')
    cases.push(['revoked', revoked.sockets])

    // A newer token for the same computer (lee is on Pro, so the device flow's second computer is allowed).
    const lee = await w.person('lee')
    await pro(lee, Date.now() + 30 * DAY)
    const leeToken = await login(lee)
    const replaced = await cast(lee, leeToken)
    await login(lee)
    await closed(lee, replaced, leeToken, 'replaced')
    cases.push(['replaced', replaced.sockets])

    // Pro has ended: the daily job takes mia back to Free's one computer, the most recently used (the second token).
    const mia = await w.person('mia')
    const miaToken = 'tok-mia-0123456789abcdef'
    const plan = await cast(mia, miaToken)
    await pro(mia, Date.now() - DAY)
    await w.db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = 't-mia'").bind(Date.now() - DAY).run()
    assert.equal((await (await w.mf.getWorker()).scheduled({ cron: '17 3 * * *' })).outcome, 'ok')
    assert.equal((await w.db.prepare("SELECT revoked_reason FROM agent_tokens WHERE id = 't-mia'").first()).revoked_reason, 'plan')
    await closed(mia, plan, miaToken, 'plan')
    cases.push(['plan', plan.sockets])
  } finally {
    await w.dispose()
  }
  const all = cases.flatMap(([, s]) => Object.values(s))
  assert.ok(await until(() => all.every((s) => s.close !== undefined), 10_000))
  for (const [reason, sockets] of cases) {
    assert.deepEqual(Object.fromEntries(Object.entries(sockets).map(([n, s]) => [n, s.close])),
      { daemon: [4011, reason], api: [4011, reason], other: null, page: null }, reason)
  }
})
