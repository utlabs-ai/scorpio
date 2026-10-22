// Agents see their tasks: the reminder's task block, "Your tasks changed:",
// the lines under a message, and what the daemon remembers between deliveries.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.SCORPIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-tasks-'))
const { renderDelivery, taskLines, taskChanges, taskNotes, taskSnapshot, deliveryDue, ago } = await import('../src/render/forward.mjs')
const { composeDelivery } = await import('../src/daemon/main.mjs')
const { agentOutput, newSyntax } = await import('../src/names.mjs')

const ROOM = 'R8K2Q'
const NOW = Date.UTC(2026, 9, 9, 12)
const H = 3_600_000
const members = [
  { name: 'kai', kind: 'human', status: 'active' },
  { name: 'api@kai', kind: 'agent', status: 'active' },
  { name: 'web@kai', kind: 'agent', status: 'active' },
  { name: 'pm@kai', kind: 'agent', status: 'active' },
  { name: 'old@kai', kind: 'agent', status: 'left' },
]
const item = (n, o = {}) => ({ id: `T${n}`, title: `Item ${n}`, status: 'todo', assignee: null, createdBy: 'kai', blockedBy: [], blocked: false, createdSeq: n, doneSeq: null, updatedBy: 'kai', updatedMs: NOW - H, reply: null, ...o })
const msg = (seq, extra = {}) => ({ seq, from: 'kai', fromKind: 'human', text: `hello ${seq}`, reply: null, broadcast: false, ts: 1000 + seq, ...extra })
const room = (items, extra = {}) => ({ roomId: ROOM, roomName: 'Login rework', topic: '', owner: 'kai', members, items, ...extra })

test('ago: minutes, hours, days', () => {
  assert.equal(ago(NOW - 20 * 60_000, NOW), '20 min')
  assert.equal(ago(NOW - 5 * H, NOW), '5 h')
  assert.equal(ago(NOW - 50 * H, NOW), '2 d')
})

test('the task block is always there: nothing under your name says so; what you opened, waiting; the whole topic', () => {
  const items = [
    item(6, { createdBy: 'api@kai', assignee: 'kai', updatedMs: NOW - 5 * H }),
    item(9, { createdBy: 'api@kai', assignee: 'web@kai', updatedMs: NOW - 26 * H }),
    item(108, { assignee: 'old@kai' }),
    item(117, { status: 'doing', assignee: 'web@kai', updatedMs: NOW - 30 * H }),
    item(2, { status: 'done', assignee: 'api@kai' }),
  ]
  const lines = taskLines({ items, members, name: 'api@kai', roomId: ROOM, role: 'api', now: NOW })
  assert.deepEqual(lines, [
    '',
    'No task under your name.',
    'You opened, waiting on others: T9 Item 9 (web@kai, 1 d); T6 Item 6 (kai, 5 h)',
    `The topic's open tasks: 3 todo, 1 doing; under members who left: T108; doing with no change for over a day: T117. All of them: scorpio task topicId=${ROOM} role=api open=true`,
  ])
  // Nothing open at all: no topic line, and the block still says there is nothing under the name.
  assert.deepEqual(taskLines({ items: [], members, name: 'api@kai', roomId: ROOM }), ['', 'No task under your name.'])
  // In the reminder, before the closing line.
  const text = renderDelivery({ room: room(items), messages: [msg(1)], name: 'api@kai', remind: 'x', now: NOW })
  assert.ok(text.includes('| api@kai (you) | agent |'), text)
  assert.ok(text.includes(`\n\nNo task under your name.\nYou opened, waiting on others: T9`), text)
  assert.ok(text.includes('open=true\n\nHow topics work and the rules: the scorpio skill.'), text)
})

test('what you opened: at most 10, then where the rest are', () => {
  const items = Array.from({ length: 12 }, (_, k) => item(k + 1, { createdBy: 'api@kai', assignee: 'kai', updatedMs: NOW - (20 - k) * H }))
  const line = taskLines({ items, members, name: 'api@kai', roomId: ROOM, now: NOW }).find((l) => l.startsWith('You opened'))
  assert.equal(line.split('; T').length, 10)
  assert.ok(line.endsWith(`; and 2 more: scorpio task topicId=${ROOM} mine=true`), line)
})

test('task changes: by someone else since the last delivery, never your own; nothing without an earlier snapshot', () => {
  const before = taskSnapshot([
    item(6, { assignee: 'api@kai' }),
    item(9, { createdBy: 'api@kai', assignee: 'kai' }),
    item(4, { assignee: 'api@kai' }),
    item(265, { assignee: 'api@kai', blockedBy: ['T255'], blocked: true }),
    item(7, { assignee: 'api@kai' }),
    item(8, { assignee: 'api@kai' }),
  ], 'api@kai')
  const items = [
    item(12, { assignee: 'api@kai', updatedBy: 'pm@kai', createdSeq: 40 }),
    item(6, { assignee: 'api@kai', status: 'done', updatedBy: 'kai', doneSeq: 41 }),
    item(9, { createdBy: 'api@kai', assignee: 'web@kai', updatedBy: 'pm@kai' }),
    item(255, { status: 'done', assignee: 'web@kai', updatedBy: 'web@kai', doneSeq: 42 }),
    item(265, { assignee: 'api@kai', blockedBy: ['T255'], blocked: false }),
    item(7, { assignee: 'api@kai', status: 'done', updatedBy: 'api@kai' }), // its own doing
    item(13, { assignee: 'api@kai', updatedBy: 'api@kai' }), // took it itself
  ]
  const deleted = [{ id: 'T4', title: 'Item 4', assignee: 'api@kai', createdBy: 'kai', by: 'pm@kai', ms: NOW }, { id: 'T8', title: 'Item 8', assignee: 'api@kai', createdBy: 'kai', by: 'api@kai', ms: NOW }]
  assert.deepEqual(taskChanges(before, { items, deleted, name: 'api@kai' }), [
    'T12 Item 12 is now yours (by pm@kai)',
    'T265 Item 265 can start: T255 was delivered',
    'T9 Item 9 moved to web@kai (by pm@kai)',
    'T6 Item 6 was closed by kai',
    'T4 Item 4 was deleted by pm@kai',
  ])
  assert.deepEqual(taskChanges(undefined, { items, deleted, name: 'api@kai' }), [], 'state from before 0.5.3')
  // What the messages of this delivery open or deliver is said under them, not twice.
  assert.deepEqual(taskChanges(before, { items, deleted, name: 'api@kai', shown: [40, 41, 42] }), [
    'T9 Item 9 moved to web@kai (by pm@kai)',
    'T4 Item 4 was deleted by pm@kai',
  ])
})

test('under a message: it opens a task for you, delivers one you opened, or frees yours', () => {
  const items = [
    item(12, { assignee: 'api@kai' }),
    item(9, { createdBy: 'api@kai', assignee: 'web@kai', status: 'done' }),
    item(255, { assignee: 'web@kai', status: 'doing' }), // the daemon's items can be a moment behind the message
    item(265, { assignee: 'api@kai', blockedBy: ['T255'], blocked: true }),
    item(266, { assignee: 'api@kai', blockedBy: ['T255', 'T300'], blocked: true }),
    item(300, { assignee: 'web@kai' }),
  ]
  const todo = (t, rel) => ({ id: t.id, title: t.title, assignee: t.assignee, status: rel === 'result' ? 'done' : t.status, round: 1, rel })
  assert.deepEqual(taskNotes(msg(5, { todo: [todo(items[0], 'source')] }), { name: 'api@kai', items }), ['Opens T12 Item 12 for you.'])
  assert.deepEqual(taskNotes(msg(6, { todo: [todo(items[1], 'result')] }), { name: 'api@kai', items }), ['Delivers T9 Item 9 (you opened it).'])
  assert.deepEqual(taskNotes(msg(7, { todo: [todo(items[2], 'result')] }), { name: 'api@kai', items }), ['Delivers T255 Item 255: your T265 can start now.'])
  assert.deepEqual(taskNotes(msg(8, { todo: [todo(items[0], 'source')] }), { name: 'web@kai', items }), [], 'not for others')
  const text = renderDelivery({ room: room(items), messages: [msg(7, { todo: [todo(items[2], 'result')] })], name: 'api@kai' })
  assert.ok(text.includes('hello 7\n+--------------------------------------+\nDelivers T255 Item 255: your T265 can start now.'), text)
})

test('a delivery: "Your tasks changed:" after the topic changes, before the messages; the daemon keeps the snapshot', () => {
  const entry = { roomId: ROOM, name: 'api@kai', role: 'api', ts: 5 }
  const first = room([item(6, { assignee: 'api@kai' })])
  const d1 = composeDelivery({ entry, room: first, messages: [msg(1)], reminded: undefined, pokedSeq: undefined, maxBytes: 100_000, now: NOW })
  assert.deepEqual(d1.tasks, [])
  assert.deepEqual(Object.keys(d1.next.tasks), ['T6'])
  const second = room([item(6, { assignee: 'web@kai', updatedBy: 'pm@kai' })])
  const d2 = composeDelivery({ entry, room: second, messages: [msg(2)], reminded: d1.next, pokedSeq: 1, maxBytes: 100_000, now: NOW })
  assert.match(d2.text, /\): 1 new message for you\.\n\nYour tasks changed:\n- T6 Item 6 moved to web@kai \(by pm@kai\)\n\n#2 from kai/)
  // A resend: no changes again.
  const again = composeDelivery({ entry, room: second, messages: [msg(2)], reminded: d2.next, pokedSeq: 2, maxBytes: 100_000, now: NOW })
  assert.ok(!again.text.includes('Your tasks changed'))
  // Items not known yet: no changes, the old snapshot kept.
  const blind = deliveryDue(d1.next, { session: 5, room: { ...second, items: undefined }, name: 'api@kai' })
  assert.deepEqual(blind.tasks, [])
  assert.deepEqual(blind.next.tasks, d1.next.tasks)
})

test('answers: a nested item hint is in the new syntax; mine= and open= count as task arguments', () => {
  const out = agentOutput({ roomId: 'R1', seq: 3, item: { error: 'item_closed', next: 'See: scorpio todo roomId=R1' } })
  assert.deepEqual(out, { topicId: 'R1', seq: 3, item: { error: 'item_closed', next: 'See: scorpio task topicId=R1' } })
  assert.equal(newSyntax('run todo mine=true'), 'run task mine=true')
  assert.equal(newSyntax('then todo open=true to=kai'), 'then task open=true to=kai')
})
