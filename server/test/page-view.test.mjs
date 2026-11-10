import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { HELLO_MESSAGES, PAGE_REPLY_CHARS, pageMessage, pageTodo } from '../src/page-view.ts'
import { VISIBLE_DONE_MS, VISIBLE_ITEMS_SQL } from '../src/todo-visibility.ts'

test('the page gets the first 200 characters of a quoted reply, counted as characters; the message itself is whole', () => {
  assert.equal(HELLO_MESSAGES, 50)
  assert.equal(PAGE_REPLY_CHARS, 200)
  const long = '回'.repeat(150) + '😀'.repeat(100) // 250 characters, 350 UTF-16 units
  const m = { seq: 9, text: 'x'.repeat(500), reply: { seq: 3, from: 'kai', text: long } }
  const p = pageMessage(m)
  assert.equal([...p.reply.text].length, 200)
  assert.equal(p.reply.text, '回'.repeat(150) + '😀'.repeat(50), 'no emoji cut in half')
  assert.equal(p.text.length, 500, 'only the quote is cut')
  assert.equal(m.reply.text, long, 'the stored message is not touched')
  const short = { seq: 1, reply: { seq: 0, from: 'kai', text: 'ok' } }
  assert.equal(pageMessage(short), short)
  const none = { seq: 2, reply: null }
  assert.equal(pageMessage(none), none)
})

test("the page's task list: unfinished items in full, done ones as ids, latest first; the rest as it is", () => {
  // The order comes from VISIBLE_ITEMS_SQL, as room-do.ts reads it.
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE items (n INTEGER PRIMARY KEY, status TEXT NOT NULL, done_ms INTEGER, updated_ms INTEGER NOT NULL)')
  const T = 10 * VISIBLE_DONE_MS
  const add = (n, status, doneMs = null) => db.prepare('INSERT INTO items VALUES (?, ?, ?, ?)').run(n, status, doneMs, doneMs ?? T)
  add(1, 'done', T - 3_600_000); add(2, 'doing'); add(3, 'done', T - 60_000); add(4, 'todo'); add(5, 'done', T - 2 * VISIBLE_DONE_MS)
  const items = db.prepare(VISIBLE_ITEMS_SQL).all(T - VISIBLE_DONE_MS).map((r) => ({ id: `T${r.n}`, status: r.status, title: `item ${r.n}` }))
  const state = { round: { n: 1 }, items, rounds: [{ n: 1 }], counts: { todo: 1, doing: 1, done: 2, total: 4 }, deleted: [{ id: 'T9' }] }
  const p = pageTodo(state)
  assert.deepEqual(p.items, [{ id: 'T2', status: 'doing', title: 'item 2' }, { id: 'T4', status: 'todo', title: 'item 4' }])
  assert.deepEqual(p.done, ['T3', 'T1'], 'done in the last 24 hours, latest first; T5 is older')
  assert.deepEqual([p.round, p.rounds, p.counts, p.deleted], [state.round, state.rounds, state.counts, state.deleted])
  assert.equal(state.items.length, 4, "the daemon's full list is not touched")
})
