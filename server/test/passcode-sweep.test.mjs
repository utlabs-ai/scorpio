import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const built = await build({ entryPoints: [new URL('../src/room-passcode-sweep.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { sweepPasscodeFailures } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const dir = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, dir), 'utf8'))
  db.prepare("INSERT INTO users (id, handle, primary_email, created_at) VALUES ('u-kai', 'kai', 'kai@example.com', 1)").run()
  const values = new Map(), called = []
  let active = 0, peak = 0, fail = null
  let checkpointAt = 0
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), all: async () => ({ results: db.prepare(sql).all(...args) }) })
  const env = {
    DB: { prepare: (sql) => stmt(sql) },
    KV: {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => {
        if (key === 'passcodeSweepV1') assert.equal(active, 0)
        if (key === 'passcodeSweepV1:after') {
          assert.ok(!checkpointAt || Date.now() - checkpointAt >= 1000, 'KV checkpoints must respect the per-key write limit')
          checkpointAt = Date.now()
        }
        values.set(key, value)
      },
      delete: async (key) => {
        if (key === 'passcodeSweepV1:after') assert.ok(!checkpointAt || Date.now() - checkpointAt >= 1000)
        return values.delete(key)
      },
    },
    ROOMS: { getByName: (id) => ({ prunePasscodeFailures: async () => {
      called.push(id); active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      if (id === fail) throw new Error('interrupted sweep')
    } }) },
  }
  const room = (id, visibility = 'private', status = 'active', pending = 0) => db.prepare('INSERT INTO rooms (id, owner_id, name, topic, visibility, status, purge_pending, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)').run(id, 'u-kai', id, '', visibility, status, pending)
  return { env, room, values, called, peak: () => peak, fail: (id) => { fail = id } }
}

test('sweep pages at most 20 calls, includes public, archived and pending purge topics, completes once', async (t) => {
  const f = fixture(t)
  for (let i = 0; i < 43; i++) f.room(`r${String(i).padStart(2, '0')}`)
  f.room('archived', 'private', 'archived')
  f.room('pending', 'private', 'deleted', 1)
  f.room('purged', 'private', 'deleted')
  f.room('public', 'link')
  await sweepPasscodeFailures(f.env)
  assert.equal(f.called.length, 46)
  assert.ok(f.called.includes('archived') && f.called.includes('pending'))
  assert.ok(!f.called.includes('purged') && f.called.includes('public'))
  assert.equal(f.peak(), 20)
  assert.equal(f.values.get('passcodeSweepV1'), 'done')
  assert.equal(f.values.has('passcodeSweepV1:after'), false)
  await sweepPasscodeFailures(f.env)
  assert.equal(f.called.length, 46, 'the next day makes no DO calls')
})

test('an interrupted page leaves the completion flag unset and resumes after the last completed page', async (t) => {
  const f = fixture(t)
  for (let i = 0; i < 43; i++) f.room(`r${String(i).padStart(2, '0')}`)
  f.fail('r22')
  await assert.rejects(sweepPasscodeFailures(f.env), /interrupted sweep/)
  assert.equal(f.values.has('passcodeSweepV1'), false)
  assert.equal(f.values.get('passcodeSweepV1:after'), 'r19')
  const first = f.called.length
  f.fail(null)
  // The next daily invocation runs outside the previous invocation's one-second KV write window.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await sweepPasscodeFailures(f.env)
  assert.deepEqual(f.called.slice(first), Array.from({ length: 23 }, (_, i) => `r${String(i + 20).padStart(2, '0')}`))
  assert.equal(f.values.get('passcodeSweepV1'), 'done')
})

test('an empty sweep completes without waking any topic', async (t) => {
  const f = fixture(t)
  await sweepPasscodeFailures(f.env)
  assert.deepEqual(f.called, [])
  assert.equal(f.values.get('passcodeSweepV1'), 'done')
})

test('early timer callbacks cannot advance a checkpoint before the KV write window', async (t) => {
  const f = fixture(t)
  for (let i = 0; i < 21; i++) f.room(`r${String(i).padStart(2, '0')}`)
  const timer = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => timer(callback, Math.max(0, ms - 50), ...args))
  await sweepPasscodeFailures(f.env)
  assert.equal(f.called.length, 21)
  assert.equal(f.values.get('passcodeSweepV1'), 'done')
})
