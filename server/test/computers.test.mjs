// Computers running agents have a cap: Free 1, Pro 5, counted per computer
// (device id or machine hash), at the person's 「授权」; one live token per computer; back on Free only the most recently
// used stay. The real device.ts and billing.ts, bundled as wrangler would, against D1 stood in for by node:sqlite with
// every migration (as invite.test.mjs).
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const DAY = 864e5
async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}
const device = await load('device.ts')
const billing = await load('billing.ts')
const tick = () => new Promise((r) => setImmediate(r))
function fakeD1(db, onRun) {
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => { await tick(); const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r } },
    all: async () => { await tick(); return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) } },
    run: async () => { await tick(); const changes = Number(db.prepare(sql).run(...args).changes); onRun?.(sql, changes); return { meta: { changes } } },
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
const MIGRATIONS = new URL('../migrations/', import.meta.url)
function setup({ plans = null, hosted = true, onRun = null } = {}) {
  const db = new DatabaseSync(':memory:')
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'))
  const env = {
    DB: fakeD1(db, onRun), INVITE_SALT: 'salt-for-tests', ...(hosted ? { PLANS: 'hosted' } : {}), PUBLIC_URL: 'https://scorpio.test',
    DEVICE_CODE_LIMIT: { limit: async () => ({ success: true }) },
    KV: { get: async (k) => (k === 'config:plans' ? plans : null) },
    ROOMS: { getByName: () => ({ planChanged: async () => {}, planArchive: async () => true }) },
  }
  const user = (id) => db.prepare('INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES (?, ?, ?, ?, 0)').run(id, id, `${id}@x.test`, Date.now())
  const pro = (id, provider = 'creem', end = Date.now() + 30 * DAY) => db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES (?, 'pro', 'active', ?, ?, ?)").run(id, end, provider, Date.now())
  const row = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? { ...r } : null }
  const req = (path, body) => new Request(`https://scorpio.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  /** The CLI asks for a code on a computer: its device id and machine id (sha256 hex, as 0.5.9 sends). */
  const ask = async (deviceId, machine = null, name = deviceId) => (await device.deviceCode(req('/oauth/device/code', { device_name: name, device_id: deviceId, cli_version: '0.5.11', ...(machine ? { machine_id: hex(machine) } : {}) }), env)).json()
  const redeem = async (c) => (await device.deviceToken(req('/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: c.device_code }), env, ctx)).json()
  /** A computer authorized and its token taken, as login does. */
  const login = async (userId, deviceId, machine = null) => { const c = await ask(deviceId, machine); assert.equal(await device.decide(env, c.user_code, userId, true), true); return redeem(c) }
  const live = (userId) => db.prepare('SELECT id, device_id FROM agent_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at').all(userId).map((r) => ({ ...r }))
  return { db, env, user, pro, row, ask, redeem, login, live }
}
const ctx = { waitUntil: () => {} }
const hex = (n) => crypto.createHash('sha256').update(String(n)).digest('hex')

test('Free: the second computer is refused at 「授权」 and polling gets the limit, count and settings link', async () => {
  const { env, user, ask, redeem, login, row, live } = setup()
  user('a')
  await login('a', 'device-one', 'laptop')
  const c = await ask('device-two', 'desktop')
  const r = await device.decide(env, c.user_code, 'a', true)
  assert.deepEqual(r, { state: 'limit', n: 1, limit: 1, plan: 'free', computers: ['device-one'], proLimit: 5 })
  assert.equal(row('SELECT status FROM device_codes WHERE user_code = ?', c.user_code).status, 'limit', 'the code records what the person saw')
  const blocked = await redeem(c)
  assert.deepEqual([blocked.error, blocked.current, blocked.limit, blocked.url], ['device_limit', 1, 1, 'https://scorpio.test/settings#devices'])
  assert.match(blocked.next, /revoke an old computer.*pricing.*approve the code/)
  assert.equal(await device.decide(env, c.user_code, 'a', false), true, 'denying is never refused')
  const c2 = await ask('device-two', 'desktop')
  await device.revokeComputer(env, ctx, 'a', live('a')[0].id)
  assert.equal(await device.decide(env, c2.user_code, 'a', true), true)
  assert.ok((await redeem(c2)).access_token)
  assert.equal((await device.computersOf(env, 'a')).length, 1)
})

test('default computer names use the lowest free number and keep hostname details separate', async () => {
  const { env, user, row } = setup()
  user('kai')
  const first = await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local')
  const second = await device.deviceForHost(env, 'kai', 'device-two', 'MBP-2.local', 'MBP.local')
  assert.equal(first.seat, 'computer-1-daemon')
  assert.equal(second.seat, 'computer-2-daemon')
  const again = await device.deviceForHost(env, 'kai', 'device-one', 'changed.local', 'changed.local')
  assert.deepEqual([again.name, again.seat, again.hostname], ['computer-1', 'computer-1-daemon', 'changed.local'])
  assert.equal(row('SELECT machine FROM devices WHERE user_id = ? AND device_id = ?', 'kai', 'device-one').machine, 'changed')
  assert.equal(device.machineName('A__Very.Long.Host_Name.local'), 'a--very')
  assert.equal(device.defaultComputerName(['computer-1', 'computer-3', 'box']), 'computer-2')
})

test('a daemon\'s detected CLIs are kept per computer: written when they change, bad entries dropped, an older daemon keeps what is stored', async () => {
  const { env, user, row } = setup()
  user('kai')
  const stored = () => row('SELECT clis FROM devices WHERE user_id = ? AND device_id = ?', 'kai', 'device-one').clis
  const claude = { kind: 'claude', installed: true, version: '2.1.301', at: 1000 }
  const codex = { kind: 'codex', installed: false, version: null, at: 1000 }
  const first = await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local', [claude, codex])
  assert.deepEqual(first.clis, [claude, codex])
  assert.deepEqual(JSON.parse(stored()), [claude, codex])
  // The same detection again writes nothing; an older daemon (no clis) gets the stored ones back and changes nothing.
  const before = stored()
  await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local', [claude, codex])
  assert.equal(stored(), before)
  assert.deepEqual((await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local')).clis, [claude, codex])
  // Wrong shapes: that entry goes (a repeated kind, a made-up kind, a missing flag, no time); too many or not a list: all of it, and the stored value stays.
  const mixed = await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local', [
    { kind: 'codex', installed: true, version: '0.46.0\n' + 'x'.repeat(60), at: 2000.7 }, { kind: 'codex', installed: false, version: null, at: 3 },
    { kind: 'gemini', installed: true, version: '1', at: 1 }, { kind: 'claude', version: '1', at: 1 }, { kind: 'claude', installed: true, version: '1.0.0' }, null, 'x',
  ])
  assert.deepEqual(mixed.clis, [{ kind: 'codex', installed: true, version: ('0.46.0 ' + 'x'.repeat(60)).slice(0, 40), at: 2000 }])
  const kept = stored()
  for (const bad of ['claude', { kind: 'claude' }, Array.from({ length: 9 }, () => claude), [{ kind: 'gemini' }], []]) {
    assert.equal(stored(), kept)
    assert.deepEqual((await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local', bad)).clis, JSON.parse(kept))
  }
  assert.deepEqual(device.cleanClis([{ ...claude, installed: false, version: '2.1.301' }]), [{ ...claude, installed: false, version: null }], 'not installed has no version')
  const t = Date.now()
  await env.DB.prepare('INSERT INTO agent_tokens (id, user_id, hash, device_name, scopes, created_at, expires_at, issued_for, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('token-one', 'kai', 'hash', 'MBP.local', 'agent', t, t + DAY, 'local', 'device-one').run()
  assert.deepEqual((await device.computersOf(env, 'kai'))[0].clis, JSON.parse(kept), 'the Devices list gets them')
  // A computer that never reported has none.
  const other = await device.deviceForHost(env, 'kai', 'device-two', 'Other.local', 'Other.local')
  assert.equal(other.clis, null)
})

test('host joins store the reported daemon version and latest valid rollback without losing it on an old join', async () => {
  const { env, user, row } = setup()
  user('kai')
  const bad = { bad: { version: '0.15.38', build: 'a'.repeat(64) }, at: Date.now() - 1000 }
  await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local', null, '0.15.39', bad)
  const report = () => row('SELECT daemon_version, daemon_joined_at, rollback_bad_version, rollback_bad_build, rollback_at FROM devices WHERE user_id = ? AND device_id = ?', 'kai', 'device-one')
  assert.equal(report().daemon_version, '0.15.39')
  assert.ok(report().daemon_joined_at >= bad.at)
  assert.deepEqual([report().rollback_bad_version, report().rollback_bad_build, report().rollback_at], ['0.15.38', 'a'.repeat(64), bad.at])
  await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local', null, null, { bad: { version: '0.1.0', build: 'x' }, at: Date.now() })
  assert.equal(report().daemon_version, '0.15.39', 'an old join preserves the last reported version')
  assert.equal(report().rollback_at, bad.at, 'an invalid report does not erase the last valid rollback')
  await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local', null, '0.15.40', { ...bad, at: bad.at - 1 })
  assert.equal(report().rollback_at, bad.at, 'an older report does not replace a newer rollback')
})

test('same-version host joins within one day write one daemon version report', async () => {
  const writes = []
  const { db, env, user, row } = setup({ onRun: (sql, changes) => {
    if (sql.startsWith('UPDATE devices SET daemon_version')) writes.push(changes)
  } })
  user('kai')
  const join = () => device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local', null, '0.15.39')
  await join()
  const firstAt = row('SELECT daemon_joined_at FROM devices WHERE user_id = ? AND device_id = ?', 'kai', 'device-one').daemon_joined_at
  await join()
  assert.deepEqual(writes, [1, 0], 'the second conditional update writes no D1 row')
  assert.equal(row('SELECT daemon_joined_at FROM devices WHERE user_id = ? AND device_id = ?', 'kai', 'device-one').daemon_joined_at, firstAt)
  db.prepare('UPDATE devices SET daemon_joined_at = ? WHERE user_id = ? AND device_id = ?').run(Date.now() - DAY - 1, 'kai', 'device-one')
  await join()
  assert.deepEqual(writes, [1, 0, 1], 'a report older than one day is refreshed')
})

test('renaming a device keeps its seat until a valid name changes and accepts a one-line note', async () => {
  const { env, user, row } = setup()
  user('kai')
  await device.deviceForHost(env, 'kai', 'device-one', 'MBP.local', 'MBP.local')
  const t = Date.now()
  await env.DB.prepare('INSERT INTO agent_tokens (id, user_id, hash, device_name, scopes, created_at, expires_at, issued_for, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('token-one', 'kai', 'hash', 'MBP.local', 'agent', t, t + DAY, 'local', 'device-one').run()
  const renamed = await device.renameDevice(env, 'kai', 'token-one', { name: 'Desk', note: '  Work\nMac  ' })
  assert.deepEqual([renamed.device.name, renamed.device.note, renamed.device.seat], ['desk', 'Work Mac', 'desk-daemon'])
  assert.equal(row('SELECT seat FROM devices WHERE user_id = ? AND device_id = ?', 'kai', 'device-one').seat, 'desk-daemon')
  await assert.rejects(device.renameDevice(env, 'kai', 'token-one', { name: '-bad' }), (e) => e.code === 'bad_name')
  await assert.rejects(device.renameDevice(env, 'kai', 'token-one', { note: 'x'.repeat(61) }), (e) => e.code === 'bad_request')
})

test('a code blocked at the device limit can be approved after revoking an old computer', async () => {
  const { env, user, ask, redeem, login, live } = setup()
  user('a')
  await login('a', 'device-one', 'laptop')
  const c = await ask('device-two', 'desktop')
  assert.equal((await device.decide(env, c.user_code, 'a', true)).state, 'limit')
  assert.ok(await device.findPending(env, c.user_code, 'a'))
  await device.revokeComputer(env, ctx, 'a', live('a')[0].id)
  assert.equal(await device.decide(env, c.user_code, 'a', true), true)
  assert.ok((await redeem(c)).access_token)
})

test('two codes approved one after the other: the second is refused (an approved code not redeemed yet counts)', async () => {
  const { env, user, ask } = setup()
  user('a')
  const c1 = await ask('device-one', 'laptop'), c2 = await ask('device-two', 'desktop')
  assert.equal(await device.decide(env, c1.user_code, 'a', true), true)
  assert.equal((await device.decide(env, c2.user_code, 'a', true)).state, 'limit')
})

test('the same computer again is never refused: the same device id (logout, login), or the same machine hash with a new device id (a reinstall); its older token goes', async () => {
  const { env, user, login, live } = setup()
  user('a')
  await login('a', 'device-one', 'laptop')
  await login('a', 'device-one', 'laptop')
  assert.equal(live('a').length, 1, 'one live token: the new one')
  await login('a', 'device-new', 'laptop') // ~/.scorpio removed and installed again
  assert.deepEqual(live('a').map((t) => t.device_id), ['device-new'])
  const cs = await device.computersOf(env, 'a')
  assert.equal(cs.length, 1)
  assert.deepEqual(cs[0].deviceIds, ['device-new'])
})

test('Pro: 5 computers, the 6th refused; a trial or invite Pro counts as Pro', async () => {
  const { env, user, pro, login, ask } = setup()
  user('p'); pro('p')
  for (let i = 1; i <= 5; i++) await login('p', `device-p${i}`, `p${i}`)
  const r = await device.decide(env, (await ask('device-p6', 'p6')).user_code, 'p', true)
  assert.deepEqual([r.state, r.n, r.limit, r.plan], ['limit', 5, 5, 'pro'])
  user('t'); pro('t', 'trial', Date.now() + 7 * DAY)
  await login('t', 'device-t1', 't1')
  assert.equal(await device.decide(env, (await ask('device-t2', 't2')).user_code, 't', true), true)
})

test('revoking a row revokes the whole computer: its tokens from before (two on one device id, or one per device id with one machine hash) and an approved code', async () => {
  const { env, db, user, login, ask, live, row } = setup({ plans: { free: { devices: 3 } } })
  user('a')
  await login('a', 'device-one', 'laptop')
  // A second live token on the same device id, as before one-token-per-computer (0027 revokes these on release).
  db.prepare("INSERT INTO agent_tokens (id, user_id, hash, device_name, created_at, expires_at, device_id) VALUES ('old-tok', 'a', 'h-old', 'device-one', ?, ?, 'device-one')").run(Date.now() - DAY, Date.now() + 300 * DAY)
  await login('a', 'device-other', 'desktop')
  const c = await ask('device-one', 'laptop')
  assert.equal(await device.decide(env, c.user_code, 'a', true), true)
  const laptop = (await device.computersOf(env, 'a')).find((x) => x.deviceIds.includes('device-one'))
  assert.equal(laptop.tokenIds.length, 2)
  await device.revokeComputer(env, ctx, 'a', 'old-tok')
  assert.deepEqual(live('a').map((t) => t.device_id), ['device-other'], "the laptop's tokens are gone, the desktop stays")
  assert.equal(row('SELECT status FROM device_codes WHERE user_code = ?', c.user_code).status, 'denied', "and the laptop's approved code")
})

test('back on Free when the trial ends: of 5 computers only the most recently used stays; Pro again brings none back', async () => {
  const { env, db, user, pro, login, live } = setup()
  user('a'); pro('a', 'trial', Date.now() + 7 * DAY)
  for (let i = 1; i <= 5; i++) await login('a', `device-a${i}`, `a${i}`)
  db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE device_id = 'device-a3'").run(Date.now() + 1000)
  db.prepare("UPDATE entitlements SET period_end = ? WHERE user_id = 'a'").run(Date.now() - 1000)
  await billing.lapseExpired(env)
  assert.deepEqual(live('a').map((t) => t.device_id), ['device-a3'])
  db.prepare("UPDATE entitlements SET period_end = ?, status = 'active', downgraded_at = NULL WHERE user_id = 'a'").run(Date.now() + 30 * DAY)
  assert.equal((await device.computersOf(env, 'a')).length, 1)
})

test("the number is config:plans (only up); someone's own deployment has no cap; a token with no device id is a computer of its own and is never revoked by a new token", async () => {
  const two = setup({ plans: { free: { devices: 2 }, pro: { devices: 3 } } })
  two.user('a')
  await two.login('a', 'device-one', 'one')
  await two.login('a', 'device-two', 'two')
  assert.equal((await device.decide(two.env, (await two.ask('device-three', 'three')).user_code, 'a', true)).limit, 2)
  const self = setup({ hosted: false })
  self.user('a')
  for (let i = 1; i <= 7; i++) await self.login('a', `device-s${i}`, `s${i}`)
  assert.equal(self.live('a').length, 7)
  const old = setup({ plans: { free: { devices: 3 } } })
  old.user('a')
  for (const id of ['t1', 't2']) old.db.prepare("INSERT INTO agent_tokens (id, user_id, hash, device_name, created_at, expires_at) VALUES (?, 'a', ?, 'old', ?, ?)").run(id, `h-${id}`, Date.now() - DAY, Date.now() + 300 * DAY)
  assert.equal((await device.computersOf(old.env, 'a')).length, 2)
  await old.login('a', 'device-new', 'new')
  assert.equal(old.live('a').length, 3)
})

test('0027: of the live tokens on one account and device id, only the newest stays; other devices and accounts, and tokens with no device id, are left', async () => {
  const { db, user, live } = setup()
  user('a'); user('b')
  const tok = (id, u, dev, at) => db.prepare('INSERT INTO agent_tokens (id, user_id, hash, device_name, created_at, expires_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, u, `h-${id}`, 'x', at, Date.now() + 300 * DAY, dev)
  tok('a1', 'a', 'dev-1', 1000); tok('a2', 'a', 'dev-1', 2000); tok('a3', 'a', 'dev-1', 3000)
  tok('a4', 'a', 'dev-2', 1500); tok('a5', 'a', null, 1000); tok('a6', 'a', null, 900)
  tok('b1', 'b', 'dev-1', 500)
  db.exec(fs.readFileSync(new URL('0027_one_token_per_computer.sql', MIGRATIONS), 'utf8'))
  assert.deepEqual(live('a').map((t) => t.id).sort(), ['a3', 'a4', 'a5', 'a6'])
  assert.deepEqual(live('b').map((t) => t.id), ['b1'])
})

test('concurrent first joins get distinct defaults and reuse a gap in computer names', async () => {
  const { env, user, db } = setup()
  user('kai')
  const devices = await Promise.all(['device-one', 'device-two', 'device-three'].map((id) => device.deviceForHost(env, 'kai', id, 'box.local', 'box')))
  assert.deepEqual(devices.map((d) => d.name).sort(), ['computer-1', 'computer-2', 'computer-3'])
  db.prepare("UPDATE devices SET name = 'desk' WHERE user_id = 'kai' AND name = 'computer-2'").run()
  assert.equal((await device.deviceForHost(env, 'kai', 'device-four', 'box.local', 'box')).name, 'computer-2')
})

test('a host join clears only its own device logout episode, and repeated joins leave it clear', async () => {
  const s = setup()
  try {
    s.user('kai')
    s.user('mei')
    for (const [owner, id] of [['kai', 'device-one'], ['kai', 'device-two'], ['mei', 'device-one']]) {
      await device.deviceForHost(s.env, owner, id, 'box.local', 'box')
      s.db.prepare('UPDATE devices SET logged_out_at = 123 WHERE user_id = ? AND device_id = ?').run(owner, id)
    }
    for (let i = 0; i < 2; i++) {
      await device.deviceForHost(s.env, 'kai', 'device-one', 'box.local', 'box')
      assert.equal(s.row("SELECT logged_out_at FROM devices WHERE user_id = 'kai' AND device_id = 'device-one'").logged_out_at, null)
    }
    assert.equal(s.row("SELECT logged_out_at FROM devices WHERE user_id = 'kai' AND device_id = 'device-two'").logged_out_at, 123)
    assert.equal(s.row("SELECT logged_out_at FROM devices WHERE user_id = 'mei' AND device_id = 'device-one'").logged_out_at, 123)
  } finally { s.db.close() }
})
