import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { LEFT_DOING_SQL, LEFT_TODO_SQL } from '../src/left-items.ts'

// The room's items table as RoomDO builds it (CREATE plus the columns added later).
function room() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE items (
    n INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
    assignee TEXT, created_by TEXT NOT NULL, created_seq INTEGER, done_seq INTEGER,
    created_ms INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_ms INTEGER NOT NULL,
    descr TEXT, blocked_by TEXT NOT NULL DEFAULT '[]', round INTEGER, done_ms INTEGER)`)
  const add = db.prepare("INSERT INTO items (n, title, status, assignee, created_by, created_ms, updated_by, updated_ms, blocked_by) VALUES (?, 't', ?, ?, 'kai', 1, 'kai', 1, ?)")
  add.run(3, 'doing', 'api@kai', '[]')
  add.run(5, 'todo', 'api@kai', '[]')
  add.run(6, 'done', 'api@kai', '[]')
  add.run(7, 'doing', 'web@kai', '[2]') // taken while T2 holds it up
  add.run(8, 'doing', 'lead@zoe', '[]')
  add.run(9, 'doing', null, '[]')
  return db
}

// What releaseItems does with them: the doing ones under the names, one by one.
function release(db, names, by, at) {
  const rows = db.prepare(LEFT_DOING_SQL).all(JSON.stringify(names))
  for (const r of rows) db.prepare(LEFT_TODO_SQL).run(r.n, by, at)
  return rows.map((r) => r.n)
}

const items = (db) => Object.fromEntries(db.prepare('SELECT n, status, assignee, updated_by, updated_ms, blocked_by FROM items ORDER BY n').all().map((r) => [r.n, { ...r }]))

test('an agent that leaves: its doing items go back to todo under its name; todo, done and others stay', () => {
  const db = room()
  assert.deepEqual(release(db, ['api@kai'], 'api@kai', 50), [3])
  const it = items(db)
  assert.deepEqual(it[3], { n: 3, status: 'todo', assignee: 'api@kai', updated_by: 'api@kai', updated_ms: 50, blocked_by: '[]' })
  assert.equal(it[5].updated_ms, 1, 'a todo item is not touched')
  assert.equal(it[6].status, 'done')
  assert.equal(it[7].status, 'doing')
  assert.equal(it[8].status, 'doing')
  assert.deepEqual(release(db, ['api@kai'], 'api@kai', 60), [], 'a second leave finds nothing')
  db.close()
})

test('a person leaves or is removed: every name of the account at once, by the actor of the call; blocked_by stays', () => {
  const db = room()
  assert.deepEqual(release(db, ['kai', 'api@kai', 'web@kai', 'daemon@kai'], 'kai', 70), [3, 7])
  const it = items(db)
  assert.equal(it[7].status, 'todo')
  assert.equal(it[7].assignee, 'web@kai')
  assert.equal(it[7].updated_by, 'kai')
  assert.equal(it[7].blocked_by, '[2]', 'nothing is unblocked')
  assert.equal(it[8].status, 'doing', 'another account keeps its items')
  assert.equal(it[9].status, 'doing', 'an item with no assignee is no one\'s')
  db.close()
})

test('no names, or names with nothing doing: nothing changes', () => {
  const db = room()
  assert.deepEqual(release(db, [], 'kai', 80), [])
  assert.deepEqual(release(db, ['nobody@kai', "o'brien@kai"], 'kai', 80), [])
  assert.equal(db.prepare("SELECT COUNT(*) AS k FROM items WHERE updated_ms = 80").get().k, 0)
  db.close()
})
