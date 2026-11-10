import assert from 'node:assert/strict'
import test from 'node:test'
import * as items from '../src/room-items.ts'

const descNext = 'A task stores no description: write it in the message (send … add= / update=); the task shows the thread of its messages.'
const personNext = (name) => `A task for a person comes from a message to them: @${name} in it (or let them write it).`

test('blockersOf returns saved numbers and treats malformed JSON as empty', () => {
  assert.deepEqual(items.blockersOf({ blocked_by: '[1,2]' }), [1, 2])
  assert.deepEqual(items.blockersOf({ blocked_by: null }), [])
  assert.deepEqual(items.blockersOf({ blocked_by: 'broken' }), [])
})

test('itemViewOf keeps every field, compatibility round and asked fields', () => {
  const row = { n: 7, title: 'Ship', descr: null, blocked_by: '[2]', status: 'doing', assignee: 'api@kai', created_by: 'kai', created_seq: 9, done_seq: null, created_ms: 10, done_ms: null, updated_by: 'api@kai', updated_ms: 11 }
  const asked = { current: { seq: 9, from: 'kai', ts: 10, line: 'Ship' }, reply: null }
  assert.deepEqual(items.itemViewOf(row, true, asked), {
    id: 'T7', round: 1, title: 'Ship', desc: null, blockedBy: ['T2'], blocked: true, status: 'doing', assignee: 'api@kai', createdBy: 'kai', createdSeq: 9, doneSeq: null, createdMs: 10, doneMs: null, updatedBy: 'api@kai', updatedMs: 11, ...asked,
  })
  assert.equal(items.itemViewOf({ ...row, blocked_by: 'bad' }, false, asked).blocked, false)
})

test('countsOf fills only known statuses and keeps total as their sum', () => {
  assert.deepEqual(items.countsOf([]), { todo: 0, doing: 0, done: 0, total: 0 })
  assert.deepEqual(items.countsOf([{ status: 'todo', k: 2 }, { status: 'doing', k: 3 }, { status: 'done', k: 4 }, { status: 'other', k: 9 }]), { todo: 2, doing: 3, done: 4, total: 9 })
})

test('deletedOf retains every visible deleted-item field', () => {
  assert.deepEqual(items.deletedOf({ n: 3, title: 'Gone', assignee: null, created_by: 'kai', by_name: 'api@kai', ms: 99 }), { id: 'T3', title: 'Gone', assignee: null, createdBy: 'kai', by: 'api@kai', ms: 99 })
})

test('itemNumberOf accepts legacy T/P/bare forms and rejects other ids', () => {
  assert.equal(items.itemNumberOf(' T12 '), 12)
  assert.equal(items.itemNumberOf('p3'), 3)
  assert.equal(items.itemNumberOf('4'), 4)
  assert.equal(items.itemNumberOf('T'), null)
  assert.equal(items.itemNumberOf(null), null)
})

test('closedRefusal has the exact code, next and status only for done', () => {
  assert.deepEqual(items.closedRefusal({ n: 5, status: 'done' }), { code: 'item_closed', next: 'T5 is already delivered. Open a new task if there is more to do.', status: 409 })
  assert.equal(items.closedRefusal({ n: 5, status: 'todo' }), null)
})

test('idsOf trims and drops blanks without deduplicating', () => {
  assert.deepEqual(items.idsOf(undefined), [])
  assert.deepEqual(items.idsOf([' T3 ', '', ' 4 ', 'T3']), ['T3', '4', 'T3'])
})

test('memberNameOf and assigneeRefusal keep member lookup and refusal text', () => {
  assert.equal(items.memberNameOf(' @API@kai '), 'API@kai')
  assert.equal(items.memberNameOf('   '), '')
  const denied = { code: 'bad_request', next: 'to=ghost: give it to a person or an agent in this topic by full name (a person is their account, an agent role@account; see scorpio members).' }
  assert.deepEqual(items.assigneeRefusal('ghost', undefined), denied)
  assert.deepEqual(items.assigneeRefusal('ghost', { status: 'left', kind: 'agent' }), denied)
  assert.deepEqual(items.assigneeRefusal('ghost', { status: 'active', kind: 'host' }), denied)
  assert.equal(items.assigneeRefusal('kai', { status: 'active', kind: 'human' }), null)
  assert.equal(items.assigneeRefusal('api@kai', { status: 'active', kind: 'agent' }), null)
})

test('toPersonRefusal keeps all short circuits and the exact next', () => {
  assert.equal(items.toPersonRefusal(null, 'api@kai', [], true), null)
  assert.equal(items.toPersonRefusal('lee', 'lee', [], true), null)
  assert.equal(items.toPersonRefusal('lee', 'api@kai', [], false), null)
  assert.equal(items.toPersonRefusal('lee', 'api@kai', ['lee'], true), null)
  assert.deepEqual(items.toPersonRefusal('lee', 'api@kai', [], true), { code: 'bad_request', next: personNext('lee') })
})

test('addInputs keeps description refusal, title normalization and positive source', () => {
  assert.equal(items.NO_DESC_NEXT, descNext)
  assert.equal(items.TO_PERSON_NEXT('lee'), personNext('lee'))
  assert.deepEqual(items.addInputs({ desc: '' }), { code: 'bad_request', next: descNext })
  assert.deepEqual(items.addInputs({ title: '   ' }), { code: 'bad_request', next: "add='<title>' is required: one line, one thing that will be delivered on its own." })
  assert.deepEqual(items.addInputs({ title: '  A  B  ', from: 8.9 }), { title: 'A B', from: 8 })
  assert.deepEqual(items.addInputs({ title: 'A', from: 0 }), { title: 'A', from: null })
  assert.equal(items.addInputs({ title: 'x'.repeat(201) }).title.length, 200)
})

test('assignedPush retains all five no-push cases and both payload URLs', () => {
  const actor = { kind: 'agent', name: 'api@kai' }
  const item = { id: 'T2', title: 'Review', assignee: 'lee', status: 'todo', createdSeq: 12 }
  const info = { id: 'room-1', name: 'Room' }
  assert.equal(items.assignedPush({ ...item, assignee: null }, actor, true, false, info, undefined), null)
  assert.equal(items.assignedPush({ ...item, assignee: actor.name }, actor, true, false, info, undefined), null)
  assert.equal(items.assignedPush({ ...item, status: 'done' }, actor, true, false, info, undefined), null)
  assert.equal(items.assignedPush(item, actor, false, false, info, undefined), null)
  assert.equal(items.assignedPush(item, actor, true, true, info, undefined), null)
  assert.deepEqual(items.assignedPush(item, actor, true, false, info, undefined), { type: 'todo_assigned', room: info, seq: 12, item: { id: 'T2', title: 'Review' }, tag: 'todo:room-1:T2', url: '/r/room-1#todo', by: 'api@kai', byDisplayName: undefined })
  assert.deepEqual(items.assignedPush(item, { kind: 'human', name: 'kai' }, true, false, info, 'Kai', 17), { type: 'todo_assigned', room: info, seq: 17, item: { id: 'T2', title: 'Review' }, tag: 'todo:room-1:T2', url: '/r/room-1?jump=17', by: 'kai', byDisplayName: 'Kai' })
})

test('rateStep increments within a minute and resets in the next minute', () => {
  assert.deepEqual(items.rateStep({ minute: 10, n: 39 }, 10, 40), { state: { minute: 10, n: 40 }, over: false })
  assert.deepEqual(items.rateStep({ minute: 10, n: 40 }, 10, 40), { state: { minute: 10, n: 41 }, over: true })
  assert.deepEqual(items.rateStep({ minute: 10, n: 41 }, 11, 40), { state: { minute: 11, n: 1 }, over: false })
})

test('personMayCase separates message add, own done/undo, and other edits', () => {
  assert.equal(items.personMayCase({ op: 'add', from: 7 }), 'fromMessage')
  assert.equal(items.personMayCase({ op: 'add', from: 7, to: 'lee' }), 'other')
  assert.equal(items.personMayCase({ op: 'done' }), 'doneOrUndo')
  assert.equal(items.personMayCase({ op: 'edit', status: 'todo' }), 'doneOrUndo')
  assert.equal(items.personMayCase({ op: 'edit', status: 'todo', title: 'rename' }), 'other')
  assert.equal(items.personMayCase({ op: 'delete' }), 'other')
})

test('titleOf uses first nonblank line, then file name, then message number', () => {
  assert.equal(items.titleOf('  @lee  First line\nSecond line', [], 8), 'First line')
  assert.equal(items.titleOf('  \n', [{ name: 'a.pdf' }], 8), 'a.pdf')
  assert.equal(items.titleOf('', [], 8), '#8')
  assert.equal(items.titleOf('x'.repeat(81), [], 8), 'x'.repeat(79) + '…')
})

test('takeDecision keeps taken and blocked refusals, force, and previous fields', () => {
  const actor = { kind: 'agent', account: 'kai', name: 'api@kai' }
  const doing = { n: 3, status: 'doing', assignee: 'other@kai' }
  assert.deepEqual(items.takeDecision(doing, actor, false, []), { refusal: { code: 'item_taken', next: 'other@kai is doing T3. To take it over anyway: todo take=T3 force=true, then tell other@kai.', status: 409 } })
  assert.deepEqual(items.takeDecision(doing, actor, true, [1]), { previous: { assignee: 'other@kai' }, fields: { assignee: 'api@kai', status: 'doing' } })
  const waiting = { n: 3, status: 'todo', assignee: 'other@kai' }
  assert.deepEqual(items.takeDecision(waiting, actor, false, [1, 2]), { refusal: { code: 'item_blocked', next: 'T3 waits for T1, T2, not delivered yet. Take something that can start (scorpio todo), or force=true to start anyway.', status: 409 } })
  assert.deepEqual(items.takeDecision(waiting, actor, true, [1]), { previous: { assignee: 'other@kai', status: 'todo' }, fields: { assignee: 'api@kai', status: 'doing' } })
  assert.deepEqual(items.takeDecision({ n: 3, status: 'doing', assignee: 'api@kai' }, actor, false, []), { previous: {}, fields: { assignee: 'api@kai', status: 'doing' } })
  assert.deepEqual(items.takeDecision({ n: 3, status: 'todo', assignee: 'api@kai' }, actor, false, []), { previous: { status: 'todo' }, fields: { assignee: 'api@kai', status: 'doing' } })
})

test('closePlan keeps agent versus person assignee and message result fields', () => {
  const agent = { kind: 'agent', account: 'kai', name: 'api@kai' }
  const human = { kind: 'human', account: 'kai', name: 'kai' }
  assert.deepEqual(items.closePlan({ status: 'todo', assignee: null }, agent, null, 123), { assignee: 'api@kai', previous: { status: 'todo', assignee: null }, fields: { status: 'done', done_seq: null, done_ms: 123, assignee: 'api@kai' }, logTo: { status: 'done', assignee: 'api@kai' } })
  assert.deepEqual(items.closePlan({ status: 'doing', assignee: null }, human, 8, 123), { assignee: null, previous: { status: 'doing' }, fields: { status: 'done', done_seq: 8, done_ms: 123, assignee: null }, logTo: { status: 'done', doneSeq: 8 } })
  assert.deepEqual(items.closePlan({ status: 'todo', assignee: 'lee' }, agent, 8, 123), { assignee: 'lee', previous: { status: 'todo' }, fields: { status: 'done', done_seq: 8, done_ms: 123, assignee: 'lee' }, logTo: { status: 'done', doneSeq: 8 } })
  assert.deepEqual(items.closePlan({ status: 'todo', assignee: 'lee' }, agent, 0, 123).logTo, { status: 'done' })
})

test('deleteDecision refuses the first other doing item, unless forced', () => {
  const actor = { kind: 'agent', account: 'kai', name: 'api@kai' }
  const rows = [{ n: 1, status: 'todo', assignee: 'lee' }, { n: 2, status: 'doing', assignee: 'helper@lee' }, { n: 3, status: 'doing', assignee: 'other@kai' }]
  assert.deepEqual(items.deleteDecision(rows, actor, false), { code: 'item_taken', next: 'helper@lee is doing T2. To delete it anyway: todo delete=T2 force=true, then tell helper@lee.', status: 409 })
  assert.equal(items.deleteDecision(rows, actor, true), null)
  assert.equal(items.deleteDecision([{ n: 2, status: 'doing', assignee: 'api@kai' }, { n: 3, status: 'done', assignee: 'lee' }], actor, false), null)
})

test('makesCycle finds direct and indirect paths, and accepts unrelated or empty blockers', () => {
  assert.equal(items.makesCycle(1, [1], new Map()), true)
  assert.equal(items.makesCycle(1, [3], new Map([[3, [2]], [2, [1]]])), true)
  assert.equal(items.makesCycle(1, [3], new Map([[3, [2]], [2, []]])), false)
  assert.equal(items.makesCycle(1, [], new Map([[2, [1]]])), false)
})

const editActor = { kind: 'agent', account: 'kai', name: 'api@kai' }
const editRow = { n: 3, title: 'Old', descr: null, status: 'todo', assignee: 'api@kai', created_seq: 7, blocked_by: '[]' }
function editDeps(calls = [], overrides = {}) {
  return {
    assigneeOf(to) { calls.push(`assigneeOf:${to}`); return to || null },
    messageExists(seq) { calls.push(`messageExists:${seq}`); return true },
    itemNumbers(list) { calls.push('itemNumbers'); return (list || []).map((id) => Number(id.slice(1))) },
    blockersMap() { calls.push('blockersMap'); return new Map() },
    ...overrides,
  }
}
const edit = (row, p, deps = editDeps()) => items.editPlan(row, editActor, p, deps, (to) => `todo edit=T3 to=${to} force=true`, 123)

test('editPlan changes each field alone and returns null for no change', () => {
  assert.equal(edit(editRow, {}), null)
  assert.equal(edit(editRow, { title: ' Old ' }), null)
  assert.deepEqual(edit(editRow, { title: ' New  title ' }), { fields: { title: 'New title' }, prev: { title: 'Old' }, next: { title: 'New title' }, closing: false })
  assert.deepEqual(edit(editRow, { to: 'lee' }), { fields: { assignee: 'lee' }, prev: { assignee: 'api@kai' }, next: { assignee: 'lee' }, closing: false })
  assert.deepEqual(edit(editRow, { from: 8 }), { fields: { created_seq: 8 }, prev: { createdSeq: 7 }, next: { createdSeq: 8 }, closing: false })
  assert.deepEqual(edit(editRow, { after: ['T2'] }), { fields: { blocked_by: '[2]' }, prev: { blockedBy: [] }, next: { blockedBy: ['T2'] }, closing: false })
  assert.deepEqual(edit(editRow, { status: 'doing' }), { fields: { status: 'doing', done_ms: null, done_seq: null }, prev: { status: 'todo' }, next: { status: 'doing' }, closing: false })
  assert.deepEqual(edit({ ...editRow, status: 'doing' }, { status: 'todo' }), { fields: { status: 'todo', done_ms: null, done_seq: null }, prev: { status: 'doing' }, next: { status: 'todo' }, closing: false })
})

test('editPlan combines fields, closes with the passed time, and assigns a new doer', () => {
  assert.deepEqual(edit(editRow, { title: 'New', to: 'lee', from: 8, after: ['T2'], status: 'done' }), {
    fields: { title: 'New', assignee: 'lee', created_seq: 8, blocked_by: '[2]', status: 'done', done_ms: 123 },
    prev: { title: 'Old', assignee: 'api@kai', createdSeq: 7, blockedBy: [], status: 'todo' },
    next: { title: 'New', assignee: 'lee', createdSeq: 8, blockedBy: ['T2'], status: 'done' },
    closing: true,
  })
  assert.deepEqual(edit({ ...editRow, assignee: null }, { status: 'doing' }), {
    fields: { status: 'doing', done_ms: null, done_seq: null, assignee: 'api@kai' },
    prev: { status: 'todo', assignee: null }, next: { status: 'doing', assignee: 'api@kai' }, closing: false,
  })
})

test('editPlan returns the seven exact refusals', () => {
  assert.deepEqual(edit(editRow, { title: '  ' }), { refusal: { code: 'bad_request', next: 'title= cannot be empty.' } })
  assert.deepEqual(edit(editRow, { desc: '' }), { refusal: { code: 'bad_request', next: descNext } })
  assert.deepEqual(edit({ ...editRow, status: 'doing', assignee: 'helper@lee' }, { to: 'lee' }), { refusal: { code: 'item_taken', next: 'helper@lee is doing T3. To hand it over anyway: todo edit=T3 to=lee force=true, then tell helper@lee.', status: 409 } })
  assert.deepEqual(edit(editRow, { from: 0 }), { refusal: { code: 'bad_request', next: 'from= is the seq of the message the task came from.' } })
  assert.deepEqual(edit(editRow, { from: 99 }, editDeps([], { messageExists: () => false })), { refusal: { code: 'message_not_found', next: 'from=99: there is no such message.', status: 404 } })
  assert.deepEqual(edit(editRow, { after: ['T3'] }), { refusal: { code: 'item_cycle', next: 'T3 cannot wait on T3: that would make it wait on itself.', status: 409 } })
  assert.deepEqual(edit(editRow, { status: 'waiting' }), { refusal: { code: 'bad_request', next: 'status= is todo, doing or done.' } })
})

test('editPlan callback order keeps the first refusal when several fields are invalid', () => {
  let calls = []
  assert.deepEqual(edit(editRow, { title: ' ', desc: '', to: 'lee', from: 99, after: ['T3'], status: 'waiting' }, editDeps(calls)), { refusal: { code: 'bad_request', next: 'title= cannot be empty.' } })
  assert.deepEqual(calls, [])
  calls = []
  assert.deepEqual(edit(editRow, { desc: '', to: 'lee', from: 99 }, editDeps(calls)), { refusal: { code: 'bad_request', next: descNext } })
  assert.deepEqual(calls, [])
  calls = []
  assert.deepEqual(edit({ ...editRow, status: 'doing', assignee: 'helper@lee' }, { to: 'lee', from: 99, after: ['T3'] }, editDeps(calls)), { refusal: { code: 'item_taken', next: 'helper@lee is doing T3. To hand it over anyway: todo edit=T3 to=lee force=true, then tell helper@lee.', status: 409 } })
  assert.deepEqual(calls, ['assigneeOf:lee'])
  calls = []
  const missing = editDeps(calls, { messageExists: (seq) => { calls.push(`messageExists:${seq}`); return false } })
  assert.deepEqual(edit(editRow, { to: 'lee', from: 99, after: ['T3'] }, missing), { refusal: { code: 'message_not_found', next: 'from=99: there is no such message.', status: 404 } })
  assert.deepEqual(calls, ['assigneeOf:lee', 'messageExists:99'])
  calls = []
  assert.deepEqual(edit(editRow, { after: ['T3'], status: 'waiting' }, editDeps(calls)), { refusal: { code: 'item_cycle', next: 'T3 cannot wait on T3: that would make it wait on itself.', status: 409 } })
  assert.deepEqual(calls, ['itemNumbers'])
  calls = []
  assert.throws(() => edit(editRow, { to: 'ghost', from: 99 }, editDeps(calls, { assigneeOf: (to) => { calls.push(`assigneeOf:${to}`); throw Error('bad assignee') } })), /bad assignee/)
  assert.deepEqual(calls, ['assigneeOf:ghost'])
})

test('editTitleRefusal preserves the person title rule exactly', () => {
  const row = { n: 3, assignee: 'lee' }
  assert.equal(items.editTitleRefusal(row, undefined, true, 'room-1'), null)
  assert.equal(items.editTitleRefusal(row, 'New', false, 'room-1'), null)
  assert.deepEqual(items.editTitleRefusal(row, 'New', true, 'room-1'), { code: 'bad_request', next: "T3 is lee's: its title changes with a message to them: scorpio send roomId=room-1 replyTo=<seq> text='@lee …' update=T3 title='…'." })
})


test('activePushRecipient accepts only a current human member', () => {
  assert.equal(items.activePushRecipient({ kind: 'human', status: 'active' }), true)
  for (const member of [undefined, { kind: 'human', status: 'left' }, { kind: 'human' }, { kind: 'agent', status: 'active' }, { kind: 'host', status: 'active' }]) {
    assert.equal(items.activePushRecipient(member), false)
  }
})
