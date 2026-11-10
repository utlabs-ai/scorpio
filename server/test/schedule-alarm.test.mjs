import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const built = await build({ entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
} }] })
const { RoomDO } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

function fixture() {
  const room = Object.create(RoomDO.prototype)
  const row = { n: 1, enabled: 1, next_at: Date.now() - 10_000 }
  const kv = new Map()
  const alarms = []
  const fired = []
  room.sql = { exec(query) {
    if (query.startsWith('SELECT * FROM schedules WHERE enabled'))
      return { toArray: () => row.enabled ? [row] : [] }
    if (query.startsWith('SELECT MIN(next_at) AS at FROM schedules'))
      return { one: () => ({ at: row.enabled ? row.next_at : null }) }
    throw Error(`Unexpected SQL: ${query}`)
  } }
  room.ctx = { storage: {
    kv: { get: (key) => kv.get(key), put: (key, value) => kv.set(key, value), delete: (key) => kv.delete(key) },
    setAlarm: async (at) => { alarms.push(at) },
  }, getWebSockets: () => [] }
  room.fire = async (due, at) => { fired.push([due, at]); row.enabled = 0; row.next_at = null }
  if ('scheduler' in room) room.scheduler.fire = room.fire
  return { room, row, kv, alarms, fired }
}

test('alarm waits for the retry gate before firing an overdue schedule', async () => {
  const { room, row, kv, alarms, fired } = fixture()
  const dueAt = row.next_at
  const retry = Date.now() + 60_000
  kv.set('scheduleRetryDue', retry)
  await room.alarm()
  assert.deepEqual(fired, [])
  assert.equal(alarms.at(-1), retry)
  assert.equal(kv.get('scheduleRetryDue'), retry)

  kv.set('scheduleRetryDue', Date.now() - 1_000)
  await room.alarm()
  assert.deepEqual(fired, [[row, dueAt]])
  assert.equal(kv.has('scheduleRetryDue'), false)
})

test('alarm clears a spent retry key even when no schedule is due', async () => {
  const { room, row, kv, alarms, fired } = fixture()
  row.enabled = 0
  kv.set('scheduleRetryDue', Date.now() - 1_000)
  await room.alarm()
  assert.equal(kv.has('scheduleRetryDue'), false)
  assert.deepEqual(fired, [])
  assert.deepEqual(alarms, [])
})
