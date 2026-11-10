import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const built = await build({ entryPoints: [new URL('../src/room-index.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { repairRoomIndex } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const now = Date.now()
const owner = { account: 'kai', active: true, human: true }
const state = (overrides = {}) => ({ topic: 'old', public: false, archivedAt: null, archivedReason: null, deletedAt: null, accounts: [owner], ...overrides })

function setup() {
  const db = new DatabaseSync(':memory:')
  const migrations = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, migrations), 'utf8'))
  for (const h of ['kai', 'lee', 'mei', 'ash', 'zed']) {
    db.prepare('INSERT INTO users (id, handle, primary_email, created_at) VALUES (?, ?, ?, 1)').run(`u-${h}`, h, `${h}@x.test`)
  }
  const states = new Map(), checked = [], changed = []
  let race = null
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const row = db.prepare(sql).get(...args); return row === undefined ? null : { ...row } },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => {
      if (race && sql.startsWith('UPDATE rooms SET ') && args.at(-2) === race) {
        db.prepare("UPDATE rooms SET status = 'deleted' WHERE id = ?").run(race)
        race = null
      }
      return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }
    },
  })
  const env = {
    DB: { prepare: (sql) => stmt(sql) },
    ROOMS: { getByName: (id) => ({
      indexState: async () => { checked.push(id); const value = states.get(id); if (value instanceof Error) throw value; return value },
      roomsChanged: async (handle, told) => { changed.push([id, handle, told]); return [] },
    }) },
  }
  function room(id, { status = 'active', topic = 'old', visibility = 'private', archivedAt = null, archivedReason = null } = {}) {
    db.prepare('INSERT INTO rooms (id, owner_id, name, topic, visibility, status, created_at, active_at, archived_at, archived_reason) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)')
      .run(id, 'u-kai', id, topic, visibility, status, archivedAt, archivedReason)
    db.prepare('INSERT INTO room_members (room_id, user_id, active, updated_at) VALUES (?, ?, 1, 1)').run(id, 'u-kai')
  }
  function member(id, handle, active = 1) {
    db.prepare('INSERT INTO room_members (room_id, user_id, active, updated_at) VALUES (?, ?, ?, 1)').run(id, `u-${handle}`, active)
  }
  function alert(id, ageMs = 0) {
    db.prepare("INSERT INTO alerts (kind, subject, day, detail, created_at) VALUES ('room_index', ?, ?, '{}', ?)")
      .run(id, new Date(now - ageMs).toISOString().slice(0, 10), now - ageMs)
  }
  const read = (id) => ({ ...db.prepare('SELECT status, topic, visibility, active_at, archived_at, archived_reason FROM rooms WHERE id = ?').get(id) })
  const members = (id) => db.prepare('SELECT user_id, active FROM room_members WHERE room_id = ? ORDER BY user_id').all(id).map((r) => ({ ...r }))
  return { db, env, room, member, alert, states, checked, changed, read, members, race: (id) => { race = id } }
}

test('only recent room_index alerts are checked', async () => {
  const s = setup()
  s.room('old'); s.alert('old', 3 * 864e5); s.states.set('old', { ok: state({ topic: 'new' }) })
  await repairRoomIndex(s.env, now)
  assert.deepEqual(s.checked, [])
  assert.equal(s.read('old').topic, 'old')
})

test('archived, restored, topic, visibility and member rows are repaired from DO state', async () => {
  const s = setup()
  s.room('archive'); s.alert('archive'); s.states.set('archive', { ok: state({ archivedAt: 900, archivedReason: 'downgrade' }) })
  s.room('restore', { status: 'archived', archivedAt: 500, archivedReason: 'downgrade' })
  s.alert('restore'); s.states.set('restore', { ok: state() })
  s.room('other'); s.alert('other')
  s.member('other', 'mei'); s.member('other', 'ash'); s.member('other', 'zed', 0)
  s.states.set('other', { ok: state({ topic: 'new', public: true, accounts: [owner, { account: 'lee', active: true, human: true }, { account: 'ash', active: false, human: false }] }) })
  await repairRoomIndex(s.env, now)
  assert.deepEqual([s.read('archive').status, s.read('archive').archived_at, s.read('archive').archived_reason], ['archived', 900, 'downgrade'])
  assert.deepEqual([s.read('restore').status, s.read('restore').archived_at, s.read('restore').archived_reason, s.read('restore').active_at], ['active', null, null, now])
  assert.deepEqual([s.read('other').topic, s.read('other').visibility], ['new', 'link'])
  assert.deepEqual(s.members('other'), [
    { user_id: 'u-ash', active: 0 }, { user_id: 'u-kai', active: 1 }, { user_id: 'u-lee', active: 1 }, { user_id: 'u-zed', active: 0 },
  ])
  assert.ok(s.changed.length > 0, 'status changes notify the owner’s other active rooms')
})

test('a status changed between read and write is not overwritten', async () => {
  const s = setup()
  s.room('race'); s.alert('race'); s.states.set('race', { ok: state({ archivedAt: 123, archivedReason: 'owner' }) })
  s.race('race')
  await repairRoomIndex(s.env, now)
  assert.equal(s.read('race').status, 'deleted')
  assert.equal(s.read('race').archived_at, null)
})

test('a DO refusal and a thrown room do not stop another room', async () => {
  const s = setup()
  for (const id of ['refused', 'thrown', 'good']) { s.room(id); s.alert(id) }
  s.states.set('refused', { err: { code: 'no_room' } })
  s.states.set('thrown', new Error('DO offline'))
  s.states.set('good', { ok: state({ topic: 'repaired' }) })
  await repairRoomIndex(s.env, now)
  assert.equal(s.read('refused').topic, 'old')
  assert.equal(s.read('thrown').topic, 'old')
  assert.equal(s.read('good').topic, 'repaired')
})
