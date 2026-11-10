// A computer logged out (docs/api/auth.md): the 401 says why a known token stopped working, and a computer
// whose newest token expired asks to come back with a relogin code, which tells the person once per episode (a push to
// every browser, a line in each topic of its daemon seat); any other computer gets an ordinary code. The real device.ts and auth.ts, bundled as wrangler would,
// against D1 stood in for by node:sqlite with every migration (as computers.test.mjs).
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const MIN = 60_000
async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}
const device = await load('device.ts')
const auth = await load('auth.ts')
const logout = await load('device-logout.ts')
const { pushText } = await load('push-text.ts')
const { activatePage } = await load('activate-page.ts')
const { ApiError, errorResponse } = await load('util.ts')

const tick = () => new Promise((r) => setImmediate(r))
function fakeD1(db) {
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => { await tick(); const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r } },
    all: async () => { await tick(); return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) } },
    run: async () => { await tick(); return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } } },
  })
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      await tick()
      db.exec('BEGIN')
      try {
        // As D1, a statement with RETURNING gives its rows back (deviceToken reads the tokens it replaced).
        const out = list.map((s) => {
          if (!/\bRETURNING\b/i.test(s.sql)) return { results: [], meta: { changes: Number(db.prepare(s.sql).run(...s.args).changes) } }
          const results = db.prepare(s.sql).all(...s.args).map((r) => ({ ...r }))
          return { results, meta: { changes: results.length } }
        })
        db.exec('COMMIT')
        return out
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
  }
}
const b64u = (buf) => Buffer.from(buf).toString('base64url')

const MIGRATIONS = new URL('../migrations/', import.meta.url)
async function setup() {
  const db = new DatabaseSync(':memory:')
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'))
  // Web Push for real up to the push service: a VAPID key, and the person's browser with every switch off.
  const vapid = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const browser = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const p256dh = b64u(await crypto.webcrypto.subtle.exportKey('raw', browser.publicKey))
  const lines = [], closed = []
  const env = {
    DB: fakeD1(db), INVITE_SALT: 'salt-for-tests', PUBLIC_URL: 'https://scorpio.test',
    DEVICE_CODE_LIMIT: { limit: async () => ({ success: true }) },
    VAPID_PRIVATE_JWK: JSON.stringify(await crypto.webcrypto.subtle.exportKey('jwk', vapid.privateKey)),
    KV: { get: async () => null },
    ROOMS: { getByName: (id) => ({
      loggedOutLine: async (...a) => { lines.push([id, ...a]); return { ok: true } },
      closeTokens: async (ids, reason) => { closed.push([id, ids, reason]); return ids.length },
    }) },
  }
  const pushes = []
  globalThis.fetch = async (url, init) => { pushes.push({ url: String(url), topic: init.headers.Topic }); return new Response(null, { status: 201 }) }
  const user = (id) => {
    db.prepare('INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES (?, ?, ?, ?, 0)').run(id, id, `${id}@x.test`, Date.now())
    db.prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at, todo_assigned, quota_warn) VALUES (?, ?, ?, ?, ?, 0, 0)")
      .run(`https://fcm.googleapis.com/fcm/send/${id}`, id, p256dh, b64u(crypto.randomBytes(16)), Date.now())
    db.prepare("INSERT INTO rooms (id, owner_id, name, topic, visibility, status, created_at) VALUES (?, ?, ?, '', 'private', 'active', ?)").run(`room-${id}`, id, `room-${id}`, Date.now())
  }
  const row = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? { ...r } : null }
  const waits = []
  const ctx = { waitUntil: (p) => waits.push(p) }
  const settle = async () => { while (waits.length) await waits.shift() }
  const req = (path, body, cf) => {
    const r = new Request(`https://scorpio.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (cf) Object.defineProperty(r, 'cf', { value: cf })
    return r
  }
  const ask = async (deviceId, extra = {}, cf = null) => {
    const res = await device.deviceCode(req('/oauth/device/code', { device_name: 'MBP.local', device_id: deviceId, cli_version: '0.16.0', ...extra }, cf), env, ctx)
    const body = await res.json()
    await settle()
    return body
  }
  const relogin = (deviceId, cf = null) => ask(deviceId, { relogin: true }, cf)
  const redeem = async (c) => (await device.deviceToken(req('/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: c.device_code }), env, ctx)).json()
  const login = async (userId, deviceId) => { const c = await ask(deviceId); assert.equal(await device.decide(env, c.user_code, userId, true), true); return redeem(c) }
  /** What the server answers a request with this token: null when it is accepted, else the 401's body. */
  const check = async (token) => {
    const r = new Request('https://scorpio.test/rooms', { headers: { authorization: `Bearer ${token}` } })
    try { await auth.agentFromRequest(r, env, { waitUntil: () => {} }); return null } catch (e) {
      assert.equal(e.status, 401)
      return { error: e.code, ...e.extra, next: e.next }
    }
  }
  /** The computer's newest token runs out: only then may it ask to come back. */
  const expire = (deviceId) => db.prepare('UPDATE agent_tokens SET expires_at = ? WHERE id = (SELECT id FROM agent_tokens WHERE device_id = ? ORDER BY created_at DESC LIMIT 1)').run(Date.now() - 1, deviceId)
  return { db, env, ctx, user, row, ask, relogin, redeem, login, check, expire, pushes, lines, closed, settle, req }
}
const topicOf = async (tag) => b64u(await crypto.webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(tag))).slice(0, 32)

test('a token that stops working has its connections closed in each active topic of the account, with the reason', async () => {
  const s = await setup()
  s.user('a'); s.user('b')
  // A topic of b's where a is a member, and an archived one of a's are asked too; a deleted one and b's own are not.
  s.db.prepare("INSERT INTO rooms (id, owner_id, name, topic, visibility, status, created_at) VALUES ('room-shared', 'b', 'shared', '', 'private', 'active', ?)").run(Date.now())
  s.db.prepare("INSERT INTO room_members (room_id, user_id, active, updated_at) VALUES ('room-shared', 'a', 1, ?)").run(Date.now())
  s.db.prepare("INSERT INTO rooms (id, owner_id, name, topic, visibility, status, created_at) VALUES ('room-old', 'a', 'old', '', 'private', 'archived', ?)").run(Date.now())
  s.db.prepare("INSERT INTO rooms (id, owner_id, name, topic, visibility, status, created_at) VALUES ('room-gone', 'a', 'gone', '', 'private', 'deleted', ?)").run(Date.now())
  const id = (deviceId) => s.db.prepare('SELECT id FROM agent_tokens WHERE device_id = ? ORDER BY created_at').all(deviceId).map((r) => r.id)
  const asked = async () => { await s.settle(); return s.closed.splice(0).map(([room, ids, reason]) => [room, ids, reason]).sort() }

  // Replaced: a new token for the same computer closes the old one's connections, not the new one's.
  await s.login('a', 'device-one')
  assert.deepEqual(await asked(), [], 'a first token replaces nothing')
  const [old] = id('device-one')
  await s.login('a', 'device-one')
  assert.deepEqual(await asked(), [['room-a', [old], 'replaced'], ['room-old', [old], 'replaced'], ['room-shared', [old], 'replaced']])

  // Settings revoke: every live token of that computer.
  await s.login('a', 'device-two')
  await asked()
  const two = id('device-two')
  await device.revokeComputer(s.env, s.ctx, 'a', two[0])
  assert.deepEqual(await asked(), [['room-a', two, 'revoked'], ['room-old', two, 'revoked'], ['room-shared', two, 'revoked']])
  await device.revokeComputer(s.env, s.ctx, 'a', two[0])
  assert.deepEqual(await asked(), [], 'a token no longer live closes nothing again')

  // The plan: the computers past Free's limit.
  s.db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('a', 'pro', 'active', ?, 'creem', ?)").run(Date.now() + 864e5, Date.now())
  await s.login('a', 'device-three')
  await asked()
  s.db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE device_id = 'device-three'").run(Date.now() + MIN)
  s.db.prepare("DELETE FROM entitlements WHERE user_id = 'a'").run()
  assert.equal(await device.keepRecentComputers(s.env, 'a'), 1)
  const one = s.db.prepare("SELECT id FROM agent_tokens WHERE device_id = 'device-one' AND revoked_at IS NOT NULL AND revoked_reason = 'plan'").all().map((r) => r.id)
  assert.equal(one.length, 1)
  assert.deepEqual(s.closed.splice(0).sort(), [['room-a', one, 'plan'], ['room-old', one, 'plan'], ['room-shared', one, 'plan']])
  assert.equal(await device.keepRecentComputers(s.env, 'a'), 0)
  assert.deepEqual(s.closed, [], 'nothing revoked: no topic is woken')
})

test('a revoked token\'s connections close in every topic of the account, past 50, at most 20 topics at a time', async () => {
  const s = await setup()
  s.user('a')
  for (let i = 0; i < 64; i++) {
    s.db.prepare("INSERT INTO rooms (id, owner_id, name, topic, visibility, status, created_at) VALUES (?, 'a', ?, '', 'private', ?, ?)")
      .run(`room-${i}`, `room-${i}`, i % 8 ? 'active' : 'archived', Date.now())
  }
  let open = 0, most = 0
  s.env.ROOMS.getByName = (id) => ({ closeTokens: async (ids, reason) => { most = Math.max(most, ++open); await tick(); open--; s.closed.push([id, ids, reason]); return 1 } })
  await s.login('a', 'device-one')
  await device.revokeComputer(s.env, s.ctx, 'a', s.row("SELECT id FROM agent_tokens WHERE device_id = 'device-one'").id)
  await s.settle()
  assert.equal(new Set(s.closed.map(([room]) => room)).size, 65, 'the 64 and a\'s first topic, archived ones too')
  assert.ok(s.closed.every(([, , reason]) => reason === 'revoked'))
  assert.equal(most, 20)
})

test('the 401 says why a known token stopped working: revoked, replaced, plan, expired; an unknown token has no reason', async () => {
  const s = await setup()
  s.user('a')
  const first = await s.login('a', 'device-one')
  assert.equal(await s.check(first.access_token), null)
  const second = await s.login('a', 'device-one')
  assert.equal((await s.check(first.access_token)).reason, 'replaced')
  s.db.prepare("UPDATE agent_tokens SET expires_at = ? WHERE hash = ?").run(Date.now() - 1, crypto.createHash('sha256').update(second.access_token).digest('hex'))
  const expired = await s.check(second.access_token)
  assert.deepEqual([expired.error, expired.reason], ['unauthorized', 'expired'])
  assert.match(expired.next, /scorpio login/)

  const third = await s.login('a', 'device-two')
  await device.revokeComputer(s.env, s.ctx, 'a', s.row("SELECT id FROM agent_tokens WHERE device_id = 'device-two'").id)
  assert.equal((await s.check(third.access_token)).reason, 'revoked')

  // Pro ended: the computers past Free's one are revoked for the plan.
  s.db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('a', 'pro', 'active', ?, 'creem', ?)").run(Date.now() + 864e5, Date.now())
  const kept = await s.login('a', 'device-three')
  const dropped = await s.login('a', 'device-four')
  s.db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE device_id = 'device-three'").run(Date.now() + MIN)
  s.db.prepare("DELETE FROM entitlements WHERE user_id = 'a'").run()
  assert.equal(await device.keepRecentComputers(s.env, 'a'), 1)
  assert.equal(await s.check(kept.access_token), null)
  assert.equal((await s.check(dropped.access_token)).reason, 'plan')

  const unknown = await s.check('sco_never-issued')
  assert.equal(unknown.error, 'unauthorized')
  assert.ok(!('reason' in unknown), 'a token the server does not know has no reason')
})

test('the answer carries the reason beside error and next', async () => {
  const res = errorResponse(new ApiError('unauthorized', 'Run: scorpio login', 401, undefined, { reason: 'revoked' }))
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: 'unauthorized', reason: 'revoked', next: 'Run: scorpio login' })
  assert.deepEqual(await errorResponse(new ApiError('unauthorized', 'Run: scorpio login', 401)).json(), { error: 'unauthorized', next: 'Run: scorpio login' })
})

test('why a token is refused, from its record: a deleted account and a revocation from before the reasons count as revoked', () => {
  const t = Date.now()
  const live = { revoked_at: null, revoked_reason: null, expires_at: t + MIN, deleted_at: null }
  assert.equal(logout.tokenRefusal(live, t), null)
  assert.equal(logout.tokenRefusal({ ...live, deleted_at: t }, t), 'revoked')
  assert.equal(logout.tokenRefusal({ ...live, revoked_at: t }, t), 'revoked')
  assert.equal(logout.tokenRefusal({ ...live, revoked_at: t, revoked_reason: 'plan' }, t), 'plan')
  assert.equal(logout.tokenRefusal({ ...live, revoked_at: t, revoked_reason: 'replaced', expires_at: t - 1 }, t), 'replaced', 'revoked before it expired')
  assert.equal(logout.tokenRefusal({ ...live, expires_at: t - 1 }, t), 'expired')
})

test('a revoked computer asking to come back gets an ordinary code: no push, no line, no logout mark', async () => {
  const s = await setup()
  s.user('a')
  await s.login('a', 'device-one')
  await device.revokeComputer(s.env, s.ctx, 'a', s.row('SELECT id FROM agent_tokens').id)
  const c = await s.relogin('device-one')
  assert.match(c.user_code, /^[A-Z]{4}-[A-Z]{4}$/)
  assert.deepEqual({ ...s.row('SELECT relogin, device_code FROM device_codes WHERE user_code = ?', c.user_code) }, { relogin: 0, device_code: null })
  assert.equal(s.row("SELECT logged_out_at FROM devices WHERE device_id = 'device-one'").logged_out_at, null)
  assert.deepEqual([s.pushes, s.lines], [[], []])
  // A device the server never saw is no different.
  await s.relogin('device-unknown')
  assert.deepEqual([s.pushes, s.lines], [[], []])
})

test('a computer whose newest token still works gets an ordinary code when it asks to come back: no push, no line, no logout mark, no shared code', async () => {
  const s = await setup()
  s.user('a')
  await s.login('a', 'device-one')
  const c = await s.relogin('device-one')
  assert.match(c.user_code, /^[A-Z]{4}-[A-Z]{4}$/)
  assert.deepEqual({ ...s.row('SELECT relogin, device_code FROM device_codes WHERE user_code = ?', c.user_code) }, { relogin: 0, device_code: null })
  assert.equal(s.row("SELECT logged_out_at FROM devices WHERE device_id = 'device-one'").logged_out_at, null)
  assert.deepEqual([s.pushes, s.lines], [[], []])
  // Asking again with the same device id is another ordinary code, never the first one's device code.
  const again = await s.relogin('device-one')
  assert.notEqual(again.device_code, c.device_code)
  assert.notEqual(again.user_code, c.user_code)
  assert.deepEqual([s.pushes, s.lines], [[], []])
})

test('an unexpected logout: the first relogin request pushes and posts once; the next within 10 minutes gets the same code and tells nobody', async () => {
  const s = await setup()
  s.user('a')
  await s.login('a', 'device-one')
  s.expire('device-one')
  s.db.prepare("UPDATE devices SET name = 'work-mac' WHERE device_id = 'device-one'").run()
  const before = Date.now()
  const c = await s.relogin('device-one', { country: 'CN', city: 'Shanghai' })
  assert.deepEqual(s.pushes.map((p) => p.url), ['https://fcm.googleapis.com/fcm/send/a'], 'every browser of the person, whatever its switches')
  assert.equal(s.pushes[0].topic, await topicOf('logout:device-one'))
  assert.deepEqual(s.lines, [['room-a', 'a', 'device-one', 'work-mac']])
  assert.ok(s.row("SELECT logged_out_at FROM devices WHERE device_id = 'device-one'").logged_out_at >= before)
  assert.deepEqual({ ...s.row('SELECT relogin, country, city FROM device_codes WHERE user_code = ?', c.user_code) }, { relogin: 1, country: null, city: null })

  const again = await s.relogin('device-one')
  assert.deepEqual([again.device_code, again.user_code, again.verification_uri_complete], [c.device_code, c.user_code, `https://scorpio.test/activate?code=${c.user_code}`])
  assert.ok(again.expires_in > 0 && again.expires_in <= c.expires_in)
  assert.equal(s.pushes.length, 1)
  assert.equal(s.lines.length, 1)

  // After 10 minutes a new code, still the same episode: nothing more is said.
  s.db.prepare('UPDATE device_codes SET created_at = created_at - ?').run(11 * MIN)
  const later = await s.relogin('device-one')
  assert.notEqual(later.user_code, c.user_code)
  assert.deepEqual([s.pushes.length, s.lines.length], [1, 1])
})

test('a token issued for the computer ends the episode; the next unexpected logout tells the person again', async () => {
  const s = await setup()
  s.user('a')
  await s.login('a', 'device-one')
  s.expire('device-one')
  const c = await s.relogin('device-one')
  assert.equal(await device.decide(s.env, c.user_code, 'a', true), true)
  const back = await s.redeem(c)
  assert.ok(back.access_token)
  assert.equal(await s.check(back.access_token), null)
  assert.equal(s.row("SELECT logged_out_at FROM devices WHERE device_id = 'device-one'").logged_out_at, null)
  assert.equal(s.row('SELECT device_code FROM device_codes WHERE user_code = ?', c.user_code).device_code, null, 'a redeemed code is not kept')
  s.expire('device-one')
  await s.relogin('device-one')
  assert.deepEqual([s.pushes.length, s.lines.length], [2, 2])
})

test('a login code (no relogin) for a known computer tells nobody', async () => {
  const s = await setup()
  s.user('a')
  await s.login('a', 'device-one')
  await s.ask('device-one')
  assert.deepEqual([s.pushes, s.lines], [[], []])
  assert.equal(s.row("SELECT logged_out_at FROM devices WHERE device_id = 'device-one'").logged_out_at, null)
})

test('the devices row and the approval page get the logout without the request place', async () => {
  const s = await setup()
  s.user('a')
  s.user('b')
  await s.login('a', 'device-one')
  s.expire('device-one')
  const c = await s.relogin('device-one', { country: 'CN', city: 'Shanghai' })
  const out = await logout.loggedOutDevices(s.env, 'a', Date.now())
  assert.equal(out.get('device-one').code, c.user_code)
  assert.equal((await logout.loggedOutDevices(s.env, 'b', Date.now())).size, 0)

  assert.deepEqual(s.row('SELECT country, city FROM device_codes WHERE user_code = ?', c.user_code), { country: null, city: null })
  // Codes issued before this change may still have a place; it is no longer read or shown.
  s.db.prepare('UPDATE device_codes SET country = ?, city = ? WHERE user_code = ?').run('CN', 'Shanghai', c.user_code)
  const mine = await device.findPending(s.env, c.user_code, 'a')
  assert.equal(mine.relogin.loggedOutAt, s.row("SELECT logged_out_at FROM devices WHERE device_id = 'device-one'").logged_out_at)
  assert.deepEqual(mine.relogin, { loggedOutAt: mine.relogin.loggedOutAt })
  assert.equal((await device.findPending(s.env, c.user_code, 'b')).relogin.loggedOutAt, null, 'not their computer: no logout time')
  const login = await s.ask('device-two')
  assert.equal((await device.findPending(s.env, login.user_code, 'a')).relogin, undefined)

  const page = async (lang) => (await activatePage(lang, { handle: 'a', email: 'a@x.test' }, { state: 'confirm', code: mine.code, device: mine.device, createdAt: mine.createdAt, relogin: mine.relogin })).text()
  const zh = await page('zh'), en = await page('en')
  assert.match(zh, /<dt>掉线时间<\/dt><dd><time data-ts="\d+"><\/time><\/dd>/)
  assert.match(en, /<dt>Logged out<\/dt><dd><time data-ts="\d+"><\/time><\/dd>/)
  for (const html of [zh, en]) assert.doesNotMatch(html, /申请来自|Request from|Shanghai|中国|China/)
})

test('the push names the computer and asks for a tap, in both languages', () => {
  const shown = pushText({ type: 'device_logged_out', tag: 'logout:device-one', url: '/activate?code=BCDF-GHJK', name: 'work-mac' })
  assert.deepEqual(shown.en, { title: 'Scorpio', body: 'work-mac logged out unexpectedly. Tap to bring it back online.' })
  assert.deepEqual(shown.zh, { title: 'Scorpio', body: 'work-mac 意外掉线了，点一下让它重新上线。' })
})
