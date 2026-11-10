import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function load(entry) {
  const out = await build({
    entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
    plugins: [{
      name: 'cloudflare-workers-stub',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
      },
    }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const { RoomDO } = await load('room-do.ts')
const { Quota } = await load('room/quota.ts')

function recorder() {
  const calls = []
  const DB = { prepare(sql) {
    const call = { sql, args: [] }
    calls.push(call)
    return { bind(...args) { call.args = args; return { run: async () => ({}) } } }
  } }
  const saved = new Map()
  const waited = []
  const ctx = { storage: { kv: { get: (key) => saved.get(key), put: (key, value) => saved.set(key, value), delete: (key) => saved.delete(key) } }, waitUntil: (promise) => waited.push(promise) }
  return { calls, DB, saved, waited, ctx }
}

test('counted message marks room active with the original SQL and bind order', async () => {
  const h = recorder()
  const room = { env: { DB: h.DB }, ctx: h.ctx, activeDay: null, roomInfo: () => ({ id: 'room-1' }) }
  Quota.prototype.markActive.call(room)
  await Promise.all(h.waited)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].sql, 'UPDATE rooms SET active_at = MAX(COALESCE(active_at, 0), ?) WHERE id = ?')
  assert.equal(typeof h.calls[0].args[0], 'number')
  assert.equal(h.calls[0].args[1], 'room-1')
  assert.equal(typeof h.saved.get('activeDay'), 'string')
})

test('sender activity uses the original SQL and day, kind, account bind order', async () => {
  const h = recorder()
  const room = { env: { DB: h.DB }, ctx: h.ctx, senders: null }
  Quota.prototype.markSender.call(room, 'agent', 'ana')
  await Promise.all(h.waited)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].sql, 'INSERT OR IGNORE INTO activity_daily (user_id, day, kind) SELECT id, ?, ? FROM users WHERE handle = ?')
  assert.deepEqual(h.calls[0].args, [h.saved.get('senders').day, 'agent', 'ana'])
})

const report = await load('room-report.ts')

function outside() {
  const db = []
  const kv = []
  const objects = []
  const env = {
    DB: { prepare(sql) {
      const call = { sql, args: [], method: null }
      db.push(call)
      return { bind(...args) {
        call.args = args
        return {
          run: async () => { call.method = 'run'; return {} },
          first: async () => { call.method = 'first'; return { msgs: 7 } },
        }
      } }
    } },
    KV: {
      get: async (...args) => { kv.push(['get', ...args]); return '12' },
      put: async (...args) => { kv.push(['put', ...args]) },
      delete: async (...args) => { kv.push(['delete', ...args]) },
    },
    FILES: { delete: async (...args) => { objects.push(args) } },
  }
  return { env, db, kv, objects }
}

test('markActive writes the same active_at SQL and bind order', async () => {
  const h = outside()
  await report.markActive(h.env, 'room-1', 123)
  assert.deepEqual(h.db, [{ sql: 'UPDATE rooms SET active_at = MAX(COALESCE(active_at, 0), ?) WHERE id = ?', args: [123, 'room-1'], method: 'run' }])
})

test('markSender writes the same activity_daily SQL and bind order', async () => {
  const h = outside()
  await report.markSender(h.env, '2026-10-11', 'agent', 'ana')
  assert.deepEqual(h.db, [{ sql: 'INSERT OR IGNORE INTO activity_daily (user_id, day, kind) SELECT id, ?, ? FROM users WHERE handle = ?', args: ['2026-10-11', 'agent', 'ana'], method: 'run' }])
})

test('addUsage preserves SQL, bind order and returns msgs', async () => {
  const h = outside()
  assert.equal(await report.addUsage(h.env, '2026-10-11', 3, 'ana'), 7)
  assert.deepEqual(h.db, [{ sql: `INSERT INTO usage_daily (user_id, day, msgs) SELECT id, ?, ? FROM users WHERE handle = ?
           ON CONFLICT (user_id, day) DO UPDATE SET msgs = msgs + excluded.msgs RETURNING msgs`, args: ['2026-10-11', 3, 'ana'], method: 'first' }])
})

test('alertOps forwards all arguments', async () => {
  const calls = []
  const env = {}
  const extra = { bytes: 9 }
  await report.alertOps(env, 'room_db', 'room-1', 'text', extra, { alert: (...args) => { calls.push(args) } })
  assert.deepEqual(calls, [[env, 'room_db', 'room-1', 'text', extra]])
})

test('opsConfig reads KV with the original options and catches failure', async () => {
  const h = outside()
  assert.equal(await report.opsConfig(h.env), '12')
  assert.deepEqual(h.kv, [['get', 'config:ops', { type: 'json', cacheTtl: 300 }]])
  h.env.KV.get = async () => { throw Error('KV unavailable') }
  assert.equal(await report.opsConfig(h.env), null)
})

test('notify forwards recipient and payload', async () => {
  const calls = []
  const env = {}
  const payload = { type: 'quota_warn', tag: 'q', url: '/' }
  await report.notify(env, 'ana', payload, { notifyPerson: (...args) => { calls.push(args) } })
  assert.deepEqual(calls, [[env, 'ana', payload]])
})

test('publicSnapshotDelete deletes the same KV key', async () => {
  const h = outside()
  await report.publicSnapshotDelete(h.env, 'room-1')
  assert.deepEqual(h.kv, [['delete', 'public:room-1']])
})

test('publicSnapshotSize reads the same KV key and cacheTtl', async () => {
  const h = outside()
  assert.equal(await report.publicSnapshotSize(h.env), '12')
  assert.deepEqual(h.kv, [['get', 'config:public_snapshot', { cacheTtl: 300 }]])
})

test('publicSnapshotPut serializes the same snapshot under the same key', async () => {
  const h = outside()
  const snap = { name: 'Room', messages: [{ seq: 1 }] }
  await report.publicSnapshotPut(h.env, 'room-1', snap)
  assert.deepEqual(h.kv, [['put', 'public:room-1', JSON.stringify(snap), { expirationTtl: 86400 }]])
})

test('fileGone forwards room, file and heir unchanged', async () => {
  const calls = []
  const env = {}
  await report.fileGone(env, 'room-1', 'file-1', null, { fileGone: (...args) => { calls.push(args) } })
  assert.deepEqual(calls, [[env, 'room-1', 'file-1', null]])
})

test('deleteObject forwards the exact R2 key', async () => {
  const h = outside()
  await report.deleteObject(h.env, 'rooms/room-1/file-1')
  assert.deepEqual(h.objects, [['rooms/room-1/file-1']])
})

test('deleteRoomObjects forwards room id and returns count', async () => {
  const calls = []
  const env = {}
  const count = await report.deleteRoomObjects(env, 'room-1', { deleteRoomObjects: (...args) => { calls.push(args); return 3 } })
  assert.equal(count, 3)
  assert.deepEqual(calls, [[env, 'room-1']])
})

test('ownerPlan resolves plan, then limits, without changing arguments', async () => {
  const calls = []
  const env = {}
  const limits = { msgsPerRoomDay: 42 }
  const result = await report.ownerPlan(env, 'ana', {
    planOfHandle: (...args) => { calls.push(['plan', ...args]); return 'pro' },
    limitsFor: (...args) => { calls.push(['limits', ...args]); return limits },
  })
  assert.deepEqual(result, { plan: 'pro', limits })
  assert.deepEqual(calls, [['plan', env, 'ana'], ['limits', env, 'pro']])
})
