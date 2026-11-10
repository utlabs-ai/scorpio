import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

// Exercise billing's real SQL against every migration, with only D1/DO boundaries substituted.
const built = await build({ entryPoints: [new URL('../src/billing.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const billing = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const DAY = 864e5
const ARCHIVE = "UPDATE rooms SET status = 'archived', archived_at = ?, archived_reason = 'downgrade' WHERE id = ? AND status = 'active'"
const RESTORE = "UPDATE rooms SET status = 'active', archived_at = NULL, archived_reason = NULL, active_at = ? WHERE id = ?"

function setup({ count = 3, archived = false, failSql = null, failId = null, failTimes = 0 } = {}) {
  const db = new DatabaseSync(':memory:')
  const migrations = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, migrations), 'utf8'))
  const t = Date.now()
  db.prepare("INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES ('u1', 'alice', 'a@x', ?, 0)").run(t - 30 * DAY)
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at, downgraded_at) VALUES ('u1', 'pro', 'active', ?, 'creem', ?, ?)")
    .run(t - DAY, t - 30 * DAY, archived ? t - DAY : null)
  for (let i = 1; i <= count; i++) {
    db.prepare('INSERT INTO rooms (id, owner_id, name, status, created_at, active_at, archived_at, archived_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`r${i}`, 'u1', `Room ${i}`, archived ? 'archived' : 'active', t - 30 * DAY, t - i * DAY, archived ? t - DAY : null, archived ? 'downgrade' : null)
  }
  const writes = [], calls = []
  let failures = 0
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const row = db.prepare(sql).get(...args); return row === undefined ? null : { ...row } },
    all: async () => ({ results: db.prepare(sql).all(...args).map((row) => ({ ...row })) }),
    run: async () => {
      writes.push({ sql, args })
      if (sql === failSql && (failId === null || args.at(-1) === failId) && failures++ < failTimes) throw new Error('D1 offline')
      return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }
    },
  })
  const env = {
    DB: { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) },
    KV: { get: async () => null }, PLANS: 'hosted', OPS_ACCOUNTS: '',
    ROOMS: { getByName: (id) => ({
      planArchive: async (...args) => { calls.push(['planArchive', id, ...args]); return true },
      planChanged: async () => { calls.push(['planChanged', id]) },
    }) },
  }
  const rows = () => db.prepare('SELECT id, status, archived_reason FROM rooms ORDER BY id').all().map((r) => ({ ...r }))
  const alerts = () => db.prepare("SELECT kind, subject FROM alerts WHERE kind = 'room_index' ORDER BY subject").all().map((r) => ({ ...r }))
  const attempts = (sql, id) => writes.filter((w) => w.sql === sql && w.args.at(-1) === id).length
  return { db, env, calls, writes, rows, alerts, attempts }
}

const normalized = (writes) => writes.filter((w) => w.sql === ARCHIVE || w.sql === RESTORE)
  .map((w) => ({ sql: w.sql, args: [0, w.args[1]] }))
const user = { id: 'u1', handle: 'alice' }

test('existing downgrade keeps the DO order and exact D1 room writes', async () => {
  const s = setup()
  await billing.lapseExpired(s.env)
  assert.deepEqual(s.calls, [
    ['planArchive', 'r2', true, 'downgrade'], ['planArchive', 'r3', true, 'downgrade'],
    ['planChanged', 'r1'], ['planChanged', 'r2'], ['planChanged', 'r3'],
  ])
  assert.deepEqual(normalized(s.writes), [
    { sql: ARCHIVE, args: [0, 'r2'] }, { sql: ARCHIVE, args: [0, 'r3'] },
  ])
  assert.deepEqual(s.rows().map((r) => r.status), ['active', 'archived', 'archived'])
  assert.ok(s.db.prepare("SELECT downgraded_at FROM entitlements WHERE user_id = 'u1'").get().downgraded_at)
})

test('existing restore keeps the DO order and exact D1 room writes', async () => {
  const s = setup({ archived: true })
  await billing.planMoved(s.env, user, 'pro')
  assert.deepEqual(s.calls, [
    ['planArchive', 'r1', false, 'downgrade'], ['planArchive', 'r2', false, 'downgrade'], ['planArchive', 'r3', false, 'downgrade'],
    ['planChanged', 'r1'], ['planChanged', 'r2'], ['planChanged', 'r3'],
  ])
  assert.deepEqual(normalized(s.writes), [
    { sql: RESTORE, args: [0, 'r1'] }, { sql: RESTORE, args: [0, 'r2'] }, { sql: RESTORE, args: [0, 'r3'] },
  ])
  assert.deepEqual(s.rows().map((r) => r.status), ['active', 'active', 'active'])
  assert.equal(s.db.prepare("SELECT downgraded_at FROM entitlements WHERE user_id = 'u1'").get().downgraded_at, null)
})

test('downgrade retries one failed index write and records no alert after it succeeds', async () => {
  const s = setup({ failSql: ARCHIVE, failId: 'r2', failTimes: 1 })
  await billing.lapseExpired(s.env)
  assert.equal(s.attempts(ARCHIVE, 'r2'), 2)
  assert.deepEqual(s.rows().map((r) => r.status), ['active', 'archived', 'archived'])
  assert.deepEqual(s.alerts(), [])
})

test('downgrade gives up after three retries, alerts, and finishes the other rooms and entitlement', async () => {
  const s = setup({ failSql: ARCHIVE, failId: 'r2', failTimes: 4 })
  await billing.lapseExpired(s.env)
  assert.equal(s.attempts(ARCHIVE, 'r2'), 4)
  assert.deepEqual(s.rows().map((r) => r.status), ['active', 'active', 'archived'])
  assert.deepEqual(s.alerts(), [{ kind: 'room_index', subject: 'r2' }])
  assert.ok(s.db.prepare("SELECT downgraded_at FROM entitlements WHERE user_id = 'u1'").get().downgraded_at)
  assert.deepEqual(s.calls.filter((c) => c[0] === 'planChanged').map((c) => c[1]), ['r1', 'r2', 'r3'])
})

test('restore gives up after three retries, alerts, and finishes the other rooms and entitlement', async () => {
  const s = setup({ archived: true, failSql: RESTORE, failId: 'r1', failTimes: 4 })
  await billing.planMoved(s.env, user, 'pro')
  assert.equal(s.attempts(RESTORE, 'r1'), 4)
  assert.deepEqual(s.rows().map((r) => r.status), ['archived', 'active', 'active'])
  assert.deepEqual(s.alerts(), [{ kind: 'room_index', subject: 'r1' }])
  assert.equal(s.db.prepare("SELECT downgraded_at FROM entitlements WHERE user_id = 'u1'").get().downgraded_at, null)
  assert.deepEqual(s.calls.filter((c) => c[0] === 'planChanged').map((c) => c[1]).sort(), ['r1', 'r2', 'r3'])
})

test('a persistent outage retries only the first of fifteen restore writes', async () => {
  const s = setup({ count: 15, archived: true, failSql: RESTORE, failTimes: Infinity })
  const start = process.cpuUsage()
  await billing.planMoved(s.env, user, 'pro')
  const cpu = process.cpuUsage(start)
  const cpuMs = (cpu.user + cpu.system) / 1000
  assert.ok(cpuMs < 5000, `took ${cpuMs.toFixed(0)} ms CPU`)
  assert.equal(s.attempts(RESTORE, 'r1'), 4)
  for (let i = 2; i <= 15; i++) assert.equal(s.attempts(RESTORE, `r${i}`), 1)
  assert.equal(s.alerts().length, 15)
  assert.equal(s.calls.filter((c) => c[0] === 'planChanged').length, 15)
})
