import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
  } }] })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const { RoomDO } = await load('room-do.ts')

test('retention uses the last posted message even when a schedule remains on', () => {
  const room = { sql: { exec: () => ({ toArray: () => [{ ts: 100 }] }) }, scheduleCount: () => { throw Error('schedule must not extend retention') } }
  assert.equal(RoomDO.prototype.lastCountedAt.call(room, { created_at: 1 }), 100)
})

function roomForQuiet(row, lastAt) {
  const writes = []
  const broadcasts = []
  return {
    writes, broadcasts,
    stopSchedules: () => {},
    wrap: (fn) => ({ ok: fn() }),
    room: () => row,
    lastCountedAt: () => lastAt,
    sql: { exec: (...args) => writes.push(args) },
    broadcastRoom: (...args) => broadcasts.push(args),
  }
}

test('quietArchive keeps archived and recently active rooms; archives only the quiet one', async () => {
  for (const lastAt of [99, 100]) {
    const archived = roomForQuiet({ archived_at: 44, archived_reason: 'owner' }, lastAt)
    assert.deepEqual((await RoomDO.prototype.quietArchive.call(archived, 100)).ok, { archivedAt: 44, archivedReason: 'owner', lastAt })
    assert.deepEqual(archived.writes, [])
  }
  const active = roomForQuiet({ archived_at: null, archived_reason: null }, 100)
  assert.deepEqual((await RoomDO.prototype.quietArchive.call(active, 100)).ok, { archivedAt: null, archivedReason: null, lastAt: 100 })
  assert.deepEqual(active.writes, [])
  const quiet = roomForQuiet({ archived_at: null, archived_reason: null }, 99)
  const out = (await RoomDO.prototype.quietArchive.call(quiet, 100)).ok
  assert.equal(out.archivedReason, 'retention')
  assert.equal(out.lastAt, 99)
  assert.equal(typeof out.archivedAt, 'number')
  assert.deepEqual(quiet.writes, [["UPDATE room SET archived_at = ?, archived_reason = 'retention'", out.archivedAt]])
  assert.deepEqual(quiet.broadcasts, [[true]])
})

test('retentionPurge keeps deleted, unarchived and recent rooms; purges only an old archive', async () => {
  const room = (row) => {
    const purges = []
    return { purges, wrap: (fn) => ({ ok: fn() }), roomRow: () => row, markDeleted: (...args) => { purges.push(args); return 123 } }
  }
  for (const [row, expected] of [
    [{ deleted_at: 77, archived_at: 1 }, 77],
    [{ deleted_at: null, archived_at: null }, null],
    [{ deleted_at: null, archived_at: 100 }, null],
  ]) {
    const fake = room(row)
    assert.deepEqual((await RoomDO.prototype.retentionPurge.call(fake, 100)).ok, { deletedAt: expected })
    assert.deepEqual(fake.purges, [])
  }
  const due = room({ deleted_at: null, archived_at: 99 })
  assert.deepEqual((await RoomDO.prototype.retentionPurge.call(due, 100)).ok, { deletedAt: 123 })
  assert.deepEqual(due.purges, [[{ reason: 'retention' }]])
})

const retention = await load('room-retention.ts')

test('quietDecision preserves all three branches at the cutoff', () => {
  assert.deepEqual(retention.quietDecision({ archived_at: 44, archived_reason: 'owner' }, 99, 100, 500), { archivedAt: 44, archivedReason: 'owner', lastAt: 99, write: false })
  assert.deepEqual(retention.quietDecision({ archived_at: 44, archived_reason: null }, 100, 100, 500), { archivedAt: 44, archivedReason: null, lastAt: 100, write: false })
  assert.deepEqual(retention.quietDecision({ archived_at: null, archived_reason: null }, 100, 100, 500), { archivedAt: null, archivedReason: null, lastAt: 100, write: false })
  assert.deepEqual(retention.quietDecision({ archived_at: null, archived_reason: null }, 101, 100, 500), { archivedAt: null, archivedReason: null, lastAt: 101, write: false })
  assert.deepEqual(retention.quietDecision({ archived_at: null, archived_reason: null }, 99, 100, 500), { archivedAt: 500, archivedReason: 'retention', lastAt: 99, write: true })
})

test('purgeDecision preserves deleted, unarchived, recent and old archive cases', () => {
  assert.deepEqual(retention.purgeDecision({ deleted_at: 77, archived_at: 1 }, 100, 500), { deletedAt: 77, write: false })
  assert.deepEqual(retention.purgeDecision({ deleted_at: null, archived_at: null }, 100, 500), { deletedAt: null, write: false })
  assert.deepEqual(retention.purgeDecision({ deleted_at: null, archived_at: 100 }, 100, 500), { deletedAt: null, write: false })
  assert.deepEqual(retention.purgeDecision({ deleted_at: null, archived_at: 101 }, 100, 500), { deletedAt: null, write: false })
  assert.deepEqual(retention.purgeDecision({ deleted_at: null, archived_at: 99 }, 100, 500), { deletedAt: 500, write: true })
})
