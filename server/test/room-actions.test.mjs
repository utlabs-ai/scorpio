import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

// room-actions has runtime imports; bundle it as the Worker does before loading it in Node.
const built = await build({ entryPoints: [new URL('../src/room-actions.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const actions = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const agent = { kind: 'agent', account: 'kai', name: 'api@kai' }
const human = { kind: 'human', account: 'kai', name: 'kai' }
function fake(results = {}) {
  const calls = []
  const stub = new Proxy({}, { get: (_, name) => async (...args) => {
    calls.push({ name, args })
    return { ok: Object.hasOwn(results, name) ? results[name] : { name, args } }
  } })
  return { stub, calls }
}
const last = (calls) => calls.at(-1)

test('read actions keep their existing arguments, defaults, and web-only full task view', async () => {
  const { stub, calls } = fake()
  await actions.messages(stub, agent, new URLSearchParams())
  assert.deepEqual(last(calls), { name: 'messages', args: [agent, { q: undefined, limit: 50 }] })
  await actions.messages(stub, agent, new URLSearchParams('from=12&limit=3'))
  assert.deepEqual(last(calls), { name: 'messages', args: [agent, { from: 12, q: undefined, limit: 3 }] })
  await actions.message(stub, agent, 17)
  assert.deepEqual(last(calls), { name: 'message', args: [agent, 17] })
  await actions.search(stub, agent, new URLSearchParams('q=red+blue&in=files&limit=4&before=17'))
  assert.deepEqual(last(calls), { name: 'search', args: [agent, { q: 'red blue', terms: ['red', 'blue'], in: 'files', limit: 4, before: 17, groups: ['messages', 'todo', 'files'] }] })
  await actions.listen(stub, agent)
  assert.deepEqual(last(calls), { name: 'listen', args: [agent] })
  await actions.todoShow(stub, agent, 'T4')
  assert.deepEqual(last(calls), { name: 'todoShow', args: [agent, 'T4'] })
  await actions.todoShow(stub, human, 'T4', true)
  assert.deepEqual(last(calls), { name: 'todoShow', args: [human, 'T4', true] })
  await actions.todoBrief(stub, agent, { mine: true })
  assert.deepEqual(last(calls), { name: 'todoBrief', args: [agent, { mine: true }] })
  await actions.todoBrief(stub, agent, { to: null })
  assert.deepEqual(last(calls), { name: 'todoBrief', args: [agent, { to: null }] })
  await actions.todoList(stub, agent)
  assert.deepEqual(last(calls), { name: 'todoList', args: [agent, undefined] })
  await actions.members(stub, agent)
  assert.deepEqual(last(calls), { name: 'members', args: [agent, { q: undefined, kind: undefined, status: undefined }] })
  await actions.history(stub, human, 0)
  assert.deepEqual(last(calls), { name: 'history', args: [human, 0] })
  await actions.around(stub, human, 3)
  assert.deepEqual(last(calls), { name: 'around', args: [human, 3] })
  await actions.mentions(stub, human, 0, 50)
  assert.deepEqual(last(calls), { name: 'mentions', args: [human, 0, 50, {}] })
  await assert.rejects(() => actions.around(stub, human, 0), (e) => e.code === 'bad_request' && e.next === 'seq= must be a positive message number.')
})

test('send preserves agent-only fields, web echo, file ids, truncation, and replyTo=0 difference', async () => {
  const { stub, calls } = fake()
  const body = { text: 'x'.repeat(40_001), replyTo: 0, nonce: 'n', files: ['good', '!bad'], done: 'D'.repeat(21), add: 'A'.repeat(301), update: 'U'.repeat(21), force: 'true', to: 'T'.repeat(121), desc: 'D'.repeat(8001), title: 'N'.repeat(301), after: '3,T4' }
  const files = actions.filesOf(body.files)
  assert.deepEqual(files, ['good'])
  await actions.send(stub, agent, body, { agent: true, files })
  assert.deepEqual(last(calls).name, 'send')
  const sent = last(calls).args[1]
  assert.equal(sent.text.length, 40_000)
  assert.equal(sent.replyTo, 0)
  assert.equal(sent.nonce, 'n')
  assert.deepEqual(sent.files, ['good'])
  assert.equal(sent.done.length, 20)
  assert.equal(sent.add.length, 300)
  assert.equal(sent.update.length, 20)
  assert.equal(sent.to.length, 120)
  assert.equal(sent.desc.length, 8000)
  assert.equal(sent.title.length, 300)
  assert.deepEqual(sent.after, ['3', 'T4'])
  assert.equal(sent.force, true)
  assert.equal(sent.echo, undefined)
  await actions.send(stub, human, body, { agent: false, files })
  const web = last(calls).args[1]
  assert.equal(web.text.length, 40_000)
  assert.deepEqual({ ...web, text: undefined }, { text: undefined, replyTo: null, nonce: 'n', files: ['good'], echo: true })
  await actions.send(stub, human, { ...body, replyTo: '0' }, { agent: false, files })
  assert.equal(last(calls).args[1].replyTo, 0, 'the string "0" is truthy on both routes')
  await assert.rejects(() => actions.send(stub, agent, { text: 'hi', nonce: 'bad space' }, { agent: true }), (e) => e.code === 'bad_request' && e.next === 'nonce must be 1–64 characters of letters, digits, _ . : -')
})

test('todo, mark, and role cards keep both callers’ validation and payloads', async () => {
  const { stub, calls } = fake()
  await actions.todo(stub, agent, { op: 'add', ids: 'T3, T4', after: ['T1', ''], to: '', from: '7', force: 'true' })
  assert.deepEqual(last(calls), { name: 'todo', args: [agent, { op: 'add', id: undefined, ids: ['T3', 'T4'], title: undefined, desc: undefined, to: '', after: ['T1'], status: undefined, from: 7, force: true }] })
  await assert.rejects(() => actions.mark(stub, agent, {}, { requireUpTo: true }), (e) => e.code === 'bad_request' && e.next === 'upTo=<seq> is required.')
  await actions.mark(stub, human, {}, { requireUpTo: false })
  assert.deepEqual(last(calls), { name: 'mark', args: [human, NaN] })
  await actions.setRoleCard(stub, agent, { roleCard: 'a'.repeat(1001) })
  assert.equal(last(calls).name, 'setRoleCard')
  assert.equal(last(calls).args[1].length, 1000)
  await actions.setRoleCardFor(stub, human, { name: 'api@kai', roleCard: 'hello\nworld' })
  assert.deepEqual(last(calls), { name: 'setRoleCardFor', args: [human, 'api@kai', 'hello\nworld'] })
})

test('listFiles uses one action for both routes and drops browser actions only for agents', async () => {
  const result = { roomId: 'R', kind: null, files: [{ id: 'f1', name: 'a.html', type: 'text/html', size: 2, from: 'kai', displayName: 'Kai', seq: 9, ts: 100, link: 'https://s/v/f1', url: '/f/R/f1', view: true }], hasMore: false, counts: { files: 1, pics: 0, gone: 0 } }
  const { stub, calls } = fake({ listFiles: result })
  const q = new URLSearchParams('kind=files&q=a.html&from=kai&before=9&beforeId=f1&limit=7')
  assert.deepEqual(await actions.listFiles(stub, human, q), result)
  assert.deepEqual(last(calls), { name: 'listFiles', args: [human, { kind: 'files', q: 'a.html', by: ['kai'], before: 9, beforeId: 'f1', limit: 7 }] })
  assert.deepEqual(await actions.listFiles(stub, agent, q), { ...result, files: [{ id: 'f1', name: 'a.html', type: 'text/html', size: 2, from: 'kai', displayName: 'Kai', seq: 9, ts: 100, link: 'https://s/v/f1' }] })
})

test('DO errors retain code, next, and status when an action unwraps them', () => {
  assert.throws(() => actions.unwrap({ err: { code: 'not_member', next: 'Join this topic.', status: 403 } }),
    (e) => e.code === 'not_member' && e.next === 'Join this topic.' && e.status === 403)
})

function dual({ failWrites = 0, leavePublic = false } = {}) {
  const events = [], pending = []
  let remaining = failWrites
  const room = { id: 'R', public: true, archivedAt: 12345 }
  const answers = { setVisibility: room, setArchived: room, leaveAccount: { public: leavePublic }, leave: { accountActive: false }, removeAccount: { account: 'other' }, deleteRoom: { deletedAt: 1 } }
  const stub = new Proxy({}, { get: (_, name) => async (...args) => {
    events.push({ kind: 'do', name, args })
    return { ok: answers[name] ?? { name, args } }
  } })
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => {
      events.push({ kind: 'read', sql, args })
      if (sql.includes('owner_id, status, purge_pending')) return { owner_id: 'u1', status: 'active', purge_pending: 0 }
      if (sql.includes('owner_id, status')) return { owner_id: 'u1', status: 'archived' }
      if (sql.includes('COUNT(*) AS n')) return { n: 0 }
      return null
    },
    all: async () => { events.push({ kind: 'read', sql, args }); return { results: [] } },
    run: async () => {
      const kind = sql.includes('INTO alerts') ? 'alert' : 'write'
      events.push({ kind, sql, args })
      if (kind === 'write' && remaining-- > 0) throw new Error('D1 offline')
      return { meta: { changes: 1 } }
    },
  })
  const env = { DB: { prepare: (sql) => statement(sql) }, ROOMS: { getByName: () => stub }, KV: { get: async () => null }, PLANS: 'hosted', OPS_ACCOUNTS: '' }
  const ctx = { waitUntil: (promise) => pending.push(promise) }
  const settle = async () => {
    while (pending.length) {
      const batch = pending.splice(0)
      const outcomes = await Promise.allSettled(batch)
      assert.deepEqual(outcomes.filter((x) => x.status === 'rejected'), [], 'waitUntil tasks settle')
    }
  }
  return { env, ctx, stub, events, pending, settle }
}

const user = { id: 'u1', handle: 'kai' }
const dualCases = [
  { name: 'setTopic', invoke: (r) => actions.setTopic(r.env, r.ctx, r.stub, human, user, 'R', 'New'), method: 'setTopic', sql: 'UPDATE rooms SET topic = ?', args: ['New', 'R'] },
  { name: 'setName', invoke: (r) => actions.setName(r.env, r.ctx, r.stub, human, user, 'R', ' New name '), method: 'setName', sql: 'UPDATE rooms SET name = ?', args: ['New name', 'R'] },
  { name: 'setVisibility', invoke: (r) => actions.setVisibility(r.env, r.ctx, r.stub, human, user, 'R', true), method: 'setVisibility', sql: 'UPDATE rooms SET visibility = ?', args: ['link', 'R'] },
  { name: 'setArchived', invoke: (r) => actions.setArchived(r.env, r.ctx, r.stub, human, user, 'R', true), method: 'setArchived', sql: "UPDATE rooms SET status = 'archived'", args: [12345, 'R'] },
  { name: 'leaveAccount', invoke: (r) => actions.leaveAccount(r.env, r.ctx, r.stub, human, user, 'R', undefined), method: 'leaveAccount', sql: 'DELETE FROM room_members', args: ['R', 'u1'] },
  { name: 'removeAccount', invoke: (r) => actions.removeAccount(r.env, r.ctx, r.stub, human, user, 'R', 'other'), method: 'removeAccount', sql: 'DELETE FROM room_members', args: ['R', 'other'] },
]

for (const c of dualCases) {
  test(`${c.name}: DO first, then the same D1 write and return value`, async () => {
    const r = dual()
    const out = await c.invoke(r)
    const doCall = r.events.find((e) => e.kind === 'do' && e.name === c.method)
    const write = r.events.find((e) => e.kind === 'write')
    assert.ok(doCall)
    assert.ok(write.sql.includes(c.sql))
    assert.deepEqual(write.args, c.args)
    assert.ok(r.events.indexOf(doCall) < r.events.indexOf(write))
    assert.ok(out)
    await r.settle()
  })
  test(`${c.name}: first D1 failure returns success and retries in waitUntil`, async () => {
    const r = dual({ failWrites: 1 })
    assert.ok(await c.invoke(r))
    assert.equal(r.events.filter((e) => e.kind === 'write').length, 1)
    assert.ok(r.pending.length)
    await r.settle()
    assert.equal(r.events.filter((e) => e.kind === 'write').length, 2)
    assert.equal(r.events.filter((e) => e.kind === 'alert').length, 0)
  })
  test(`${c.name}: initial D1 failure plus three failed retries logs and alerts once, still returns success`, async () => {
    const r = dual({ failWrites: 4 })
    const errors = [], original = console.error
    console.error = (line) => errors.push(String(line))
    try { assert.ok(await c.invoke(r)); await r.settle() } finally { console.error = original }
    assert.equal(r.events.filter((e) => e.kind === 'write').length, 4)
    assert.equal(r.events.filter((e) => e.kind === 'alert').length, 1)
    assert.ok(errors.some((line) => line.includes('room index write failed') && line.includes(c.name)))
  })
}

test('leaveAccount public uses the existing inactive room_members upsert', async () => {
  const r = dual({ leavePublic: true })
  await actions.leaveAccount(r.env, r.ctx, r.stub, human, user, 'R', undefined)
  const write = r.events.find((e) => e.kind === 'write')
  assert.ok(write.sql.includes('INSERT INTO room_members'))
  assert.deepEqual(write.args.slice(0, 3), ['R', 'u1', 0])
  await r.settle()
})

test('an agent leaving keeps its own DO call and updates D1 only when the account has no active names', async () => {
  const r = dual()
  await actions.leaveAccount(r.env, r.ctx, r.stub, agent, user, 'R', undefined)
  assert.equal(r.events.find((e) => e.kind === 'do').name, 'leave')
  const write = r.events.find((e) => e.kind === 'write')
  assert.ok(write.sql.includes('INSERT INTO room_members'))
  assert.deepEqual(write.args.slice(0, 3), ['R', 'u1', 0])
  await r.settle()
})

test('restoring a room checks the owner quota before changing the DO', async () => {
  const r = dual()
  await actions.setArchived(r.env, r.ctx, r.stub, human, user, 'R', false)
  const quota = r.events.findIndex((e) => e.kind === 'read' && e.sql.includes('COUNT(*) AS n'))
  const room = r.events.findIndex((e) => e.kind === 'do' && e.name === 'setArchived')
  assert.ok(quota >= 0 && quota < room)
  assert.ok(r.events.find((e) => e.kind === 'write').sql.includes("status = 'active'"))
  await r.settle()
})

test('rotateCode only changes the DO and returns its generated code', async () => {
  const r = dual()
  const out = await actions.rotateCode(r.env, r.ctx, r.stub, human, user, 'R', undefined)
  assert.match(out.code, /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/)
  assert.deepEqual(r.events.map((e) => e.kind), ['do'])
  assert.equal(r.events[0].name, 'rotateCode')
  assert.equal(r.events[0].args[1], out.code)
})

test('deleteRoom keeps its D1 marker before DO and fails closed if that marker fails', async () => {
  const r = dual()
  await actions.deleteRoom(r.env, r.ctx, r.stub, human, user, 'R', undefined)
  assert.deepEqual(r.events.filter((e) => e.kind !== 'read').map((e) => e.kind), ['write', 'do'])
  assert.ok(r.events.find((e) => e.kind === 'write').sql.includes("status = 'deleted', deleted_at = ?, purge_pending = 1"))
  await r.settle()
  const failed = dual({ failWrites: 1 })
  await assert.rejects(() => actions.deleteRoom(failed.env, failed.ctx, failed.stub, human, user, 'R', undefined), /D1 offline/)
  assert.equal(failed.events.filter((e) => e.kind === 'do').length, 0)
  assert.equal(failed.pending.length, 0)
})
