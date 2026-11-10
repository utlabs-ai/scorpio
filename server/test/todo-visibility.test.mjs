import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { VISIBLE_COUNTS_SQL, VISIBLE_DONE_MS, VISIBLE_ITEMS_SQL } from '../src/todo-visibility.ts'

test('visible TODO spans stored rounds and drops only completions older than 24 hours', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE items (n INTEGER, round INTEGER, status TEXT, done_ms INTEGER, updated_ms INTEGER)')
  const insert = db.prepare('INSERT INTO items VALUES (?, ?, ?, ?, ?)')
  const at = 1_800_000_000_000
  const cutoff = at - VISIBLE_DONE_MS
  insert.run(1, 1, 'todo', null, at - 4 * VISIBLE_DONE_MS)
  insert.run(2, 2, 'doing', null, at - 3 * VISIBLE_DONE_MS)
  insert.run(3, 1, 'done', cutoff - 1, at)
  insert.run(4, 2, 'done', cutoff, at)
  insert.run(5, 2, 'done', at - 1000, at)

  assert.deepEqual(db.prepare(VISIBLE_ITEMS_SQL).all(cutoff).map((r) => r.n), [2, 1, 5, 4])
  assert.deepEqual(Object.fromEntries(db.prepare(VISIBLE_COUNTS_SQL).all(cutoff).map((r) => [r.status, r.k])), { doing: 1, done: 2, todo: 1 })
  assert.equal(db.prepare('SELECT COUNT(*) AS k FROM items').get().k, 5, 'older completions remain stored')
  db.close()
})
