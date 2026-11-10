import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { runRetention, DAY_MS } from '../src/retention.ts'
import { quietDecision, purgeDecision } from '../src/room-retention.ts'

const days = { archiveAfterDays: 90, binAfterDays: 90, proGraceDays: 30, accountRestoreDays: 7 }

function setup({ status = 'active', lastAt = Date.now() - 200 * DAY_MS, archivedAt = null, failSql }) {
  const db = new DatabaseSync(':memory:')
  const migrations = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, migrations), 'utf8'))
  db.prepare("INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES ('u1', 'alice', 'a@x', 1, 0)").run()
  db.prepare('INSERT INTO rooms (id, owner_id, name, status, created_at, active_at, archived_at, archived_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('r1', 'u1', 'Room', status, 1, Date.now() - 200 * DAY_MS, archivedAt, status === 'archived' ? 'retention' : null)
  const object = { archived_at: archivedAt, archived_reason: status === 'archived' ? 'retention' : null, deleted_at: null, lastAt }
  let failures = 0
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => {
      if (sql.startsWith(failSql) && failures++ === 0) throw new Error('D1 offline')
      return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }
    },
  })
  const env = {
    DB: { prepare: (sql) => stmt(sql) },
    ROOMS: { getByName: () => ({
      quietArchive: async (cutoff) => {
        const out = quietDecision(object, object.lastAt, cutoff, Date.now())
        if (out.write) { object.archived_at = out.archivedAt; object.archived_reason = out.archivedReason }
        return { ok: out }
      },
      retentionPurge: async (cutoff) => {
        const out = purgeDecision(object, cutoff, Date.now())
        if (out.write) object.deleted_at = out.deletedAt
        return { ok: out }
      },
    }) },
  }
  const purged = []
  const run = () => runRetention(env, days, async (id) => { purged.push(id) })
  const row = () => ({ ...db.prepare("SELECT status, active_at, archived_at, deleted_at, purge_pending FROM rooms WHERE id = 'r1'").get() })
  return { run, row, purged }
}

test('failed quiet archive D1 write is retried by the next daily run', async () => {
  const s = setup({ failSql: "UPDATE rooms SET status = 'archived'" })
  await s.run()
  assert.equal(s.row().status, 'active')
  await s.run()
  assert.equal(s.row().status, 'archived')
})

test('failed active_at catch-up is retried by the next daily run', async () => {
  const s = setup({ lastAt: Date.now(), failSql: 'UPDATE rooms SET active_at = MAX' })
  const oldAt = s.row().active_at
  await s.run()
  assert.equal(s.row().active_at, oldAt)
  await s.run()
  assert.ok(s.row().active_at > oldAt)
  assert.equal(s.row().status, 'active')
})

test('failed purge index write stops purgeRoom, then the next daily run retries both', async () => {
  const s = setup({ status: 'archived', archivedAt: Date.now() - 200 * DAY_MS, failSql: "UPDATE rooms SET status = 'deleted'" })
  await s.run()
  assert.equal(s.row().status, 'archived')
  assert.deepEqual(s.purged, [])
  await s.run()
  assert.equal(s.row().status, 'deleted')
  assert.equal(s.row().purge_pending, 1)
  assert.deepEqual(s.purged, ['r1'])
})
