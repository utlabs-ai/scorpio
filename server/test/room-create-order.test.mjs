import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const built = await build({
  entryPoints: [new URL('../src/room-actions.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
})
const { createRoom } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

function setup({ initFails = false, insertFails = false, memberFails = false } = {}) {
  const calls = []
  const pending = []
  let failInsert = insertFails
  let failMember = memberFails
  const env = {
    KV: { get: async () => null },
    ROOMS: { getByName: () => ({
      init: async () => { calls.push('init'); if (initFails) throw new Error('DO unavailable') },
    }) },
    DB: { prepare: (sql) => ({ bind: (...args) => ({
      first: async () => ({ n: 0 }),
      all: async () => ({ results: [] }),
      run: async () => {
        if (sql.startsWith('INSERT OR IGNORE INTO rooms')) {
          calls.push('rooms')
          if (failInsert) { failInsert = false; throw new Error('D1 unavailable') }
        } else if (sql.startsWith('INSERT INTO room_members')) {
          calls.push('room_members')
          if (failMember) { failMember = false; throw new Error('D1 membership unavailable') }
        }
        return { meta: { changes: 1 } }
      },
    }) }) },
  }
  return { env, ctx: { waitUntil: (promise) => pending.push(promise) }, calls, pending }
}

const user = { id: 'u-kai', handle: 'kai' }
const topic = { name: 'Example', topic: 'Description', code: '' }

test('a failed DO init never writes a rooms index row', async () => {
  const s = setup({ initFails: true })
  await assert.rejects(createRoom(s.env, s.ctx, user, topic), /DO unavailable/)
  assert.deepEqual(s.calls, ['init'])
})

test('a failed D1 insert is retried after DO init without failing create', async () => {
  const s = setup({ insertFails: true })
  const id = await createRoom(s.env, s.ctx, user, topic)
  assert.equal(id.length, 22)
  assert.deepEqual(s.calls, ['init', 'rooms'])
  await Promise.all(s.pending)
  assert.deepEqual(s.calls, ['init', 'rooms', 'rooms', 'room_members'])
})

test('a failed membership write retries the idempotent room insert and finishes the index', async () => {
  const s = setup({ memberFails: true })
  await createRoom(s.env, s.ctx, user, topic)
  await Promise.all(s.pending)
  assert.deepEqual(s.calls, ['init', 'rooms', 'room_members', 'rooms', 'room_members'])
})
