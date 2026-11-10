import assert from 'node:assert/strict'
import test from 'node:test'
import { brief, mineOf, openOf, yoursOf } from '../src/task-brief.ts'

const item = (n, o = {}) => ({
  id: `T${n}`, round: 1, title: `item ${n}`, desc: null, blockedBy: [], blocked: false, status: 'todo', assignee: null,
  createdBy: 'kai', createdSeq: n, doneSeq: null, createdMs: 1000 + n, doneMs: null, updatedBy: 'kai', updatedMs: 1000 + n, reply: null, ...o,
})
const present = new Set(['kai', 'api@kai', 'web@kai'])

test('a Brief: the short fields, by is the creator, since the last change, left when the assignee is not in the topic', () => {
  const b = brief(item(7, { status: 'doing', assignee: 'api@kai', blockedBy: ['T3'], blocked: true, updatedMs: 5000, reply: { seq: 12, from: 'kai', ts: 1, closer: 'api@kai' } }), present)
  assert.deepEqual(b, { id: 'T7', title: 'item 7', status: 'doing', assignee: 'api@kai', by: 'kai', after: ['T3'], blocked: true, since: 5000, reply: { seq: 12, from: 'kai' }, left: false })
  assert.equal(brief(item(8, { assignee: 'old@kai' }), present).left, true)
  assert.equal(brief(item(9), present).left, false, 'nobody on it is not "left"')
})

test('mine: yours (open, under my name) and opened (open, mine, under someone else), oldest change first', () => {
  const items = [
    item(1, { assignee: 'api@kai', updatedMs: 9000 }),
    item(2, { assignee: 'api@kai', status: 'doing', updatedMs: 2000 }),
    item(3, { assignee: 'api@kai', status: 'done' }),
    item(4, { createdBy: 'api@kai', assignee: 'kai', updatedMs: 7000 }),
    item(5, { createdBy: 'api@kai', assignee: 'web@kai', updatedMs: 3000 }),
    item(6, { createdBy: 'api@kai', assignee: null }),
    item(10, { createdBy: 'api@kai', assignee: 'api@kai' }),
    item(11, { createdBy: 'api@kai', assignee: 'kai', status: 'done' }),
  ]
  const m = mineOf(items, 'api@kai', present)
  assert.deepEqual(m.yours.map((b) => b.id), ['T10', 'T2', 'T1'])
  assert.deepEqual(m.opened.map((b) => b.id), ['T5', 'T4'])
  assert.deepEqual(yoursOf(items, 'api@kai', present), m.yours)
})

test('open: every open item in id order, or those under one name', () => {
  const items = [item(3, { assignee: 'kai' }), item(1, { assignee: 'api@kai', status: 'doing' }), item(2, { status: 'done' }), item(12, { assignee: 'gone@kai' })]
  assert.deepEqual(openOf(items, null, present).map((b) => b.id), ['T1', 'T3', 'T12'])
  assert.deepEqual(openOf(items, 'gone@kai', present).map((b) => [b.id, b.left]), [['T12', true]])
})
