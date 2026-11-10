import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const built = await build({
  entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  external: ['cloudflare:workers'],
})
// Freeze only the rate-limit phase; earlier golden steps need distinct timestamps for their ordering.
const script = `let testNow = null;
const Date = class extends globalThis.Date { static now() { return testNow ?? globalThis.Date.now(); } };
${built.outputFiles[0].text}
export default { async fetch(req, env) {
  const { method, args = [], room = 't' } = await req.json();
  if (method === '__testClock') { testNow = args[0]; return Response.json({ now: testNow }); }
  return Response.json(await env.ROOMS.getByName(room)[method](...args));
} };`
const golden = new URL('./room-todo.golden.json', import.meta.url)
const timeKeys = new Set(['ms', 'ts', 'createdMs', 'updatedMs', 'doneMs', 'openedMs', 'createdAt', 'since'])
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, timeKeys.has(key) ? 0 : stable(item)]))
  }
  return value
}

const kai = { kind: 'human', account: 'kai', name: 'kai' }
const lee = { kind: 'human', account: 'lee', name: 'lee' }
const api = { kind: 'agent', account: 'kai', name: 'api@kai' }
const helper = { kind: 'agent', account: 'lee', name: 'helper@lee' }

test('RoomDO task actions and refusals keep the committed golden', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script,
    compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOMS: { className: 'RoomDO', useSQLite: true } },
    d1Databases: { DB: 'db' }, kvNamespaces: ['KV'], r2Buckets: ['FILES'],
    bindings: { TEST_LIMITS: JSON.stringify({ self: { todoWritesPerRoomMinute: 40 } }) },
  }))
  const records = []
  let mainWrites = 0
  async function call(step, method, args, room = 't') {
    if (room === 't' && (method === 'todo' || (method === 'send' && ['add', 'done', 'update'].some((key) => args[1]?.[key] !== undefined)))) mainWrites++
    const response = await mf.dispatchFetch('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args, room }),
    })
    const body = await response.text()
    assert.equal(response.status, 200, `${step}: ${body}`)
    const result = JSON.parse(body)
    records.push({ step, result })
    return result
  }
  async function ok(step, method, args, room) {
    const result = await call(step, method, args, room)
    assert.ok(result.ok, `${step}: ${JSON.stringify(result)}`)
    return result.ok
  }
  async function err(step, actor, op, code, nextPart, room) {
    const result = await call(step, 'todo', [actor, op], room)
    assert.equal(result.err?.code, code, `${step}: ${JSON.stringify(result)}`)
    assert.ok(result.err.next.includes(nextPart), `${step}: ${result.err.next}`)
    return result.err
  }
  try {
    await call('init', 'init', [{ id: 'todo-golden', name: 'Golden', topic: 'Task behavior', owner: 'kai', code: null }])
    await ok('enter lee', 'enterHuman', [lee, undefined, 'Lee'])
    await ok('join api', 'join', [api, { role: 'api' }])
    await ok('join helper', 'join', [helper, { role: 'helper' }])

    const first = await ok('send add person', 'send', [api, { text: '@lee Review this', add: 'Review this', to: 'lee' }])
    const t1 = first.item.id
    const second = await ok('send add after', 'send', [api, { text: '@kai Implement after review', add: 'Implement', to: api.name, after: [t1] }])
    const t2 = second.item.id
    const third = await ok('send add agent', 'send', [api, { text: '@helper@lee Third task', add: 'Third', to: helper.name }])
    const t3 = third.item.id

    await err('take blocked', api, { op: 'take', id: t2 }, 'item_blocked', 'waits for')
    await ok('take blocked force', 'todo', [api, { op: 'take', id: t2, force: true }])
    await err('take taken', helper, { op: 'take', id: t2 }, 'item_taken', 'To take it over anyway')
    await ok('take taken force', 'todo', [helper, { op: 'take', id: t2, force: true }])
    await err('delete taken', api, { op: 'delete', id: t2 }, 'item_taken', 'To delete it anyway')
    await err('edit taken to', api, { op: 'edit', id: t2, to: 'lee' }, 'item_taken', 'To hand it over anyway')

    const update = await ok('send update to and title', 'send', [api, { text: '@lee Updated source', update: t1, to: api.name, title: 'Review v2' }])
    assert.equal(update.item.id, t1)
    const delivered = await ok('send done', 'send', [api, { text: '@kai Review delivered', done: t1 }])
    assert.equal(delivered.item.id, t1)
    await ok('delete taken force', 'todo', [api, { op: 'delete', id: t2, force: true }])
    await err('take closed', api, { op: 'take', id: t1 }, 'item_closed', 'already delivered')

    const humanSource = await ok('human source message', 'send', [lee, { text: 'A note for my task\nSecond line' }])
    const source = humanSource.seq
    const fifth = await ok('human add from implicit title', 'todo', [lee, { op: 'add', from: source }])
    const t5 = fifth.item.id
    await ok('human done', 'todo', [lee, { op: 'done', id: t5 }])
    const sixth = await ok('human add from explicit title', 'todo', [lee, { op: 'add', from: source, title: 'Manual title' }])
    const t6 = sixth.item.id
    await ok('agent add from', 'todo', [api, { op: 'add', from: source, title: 'Agent sourced', to: api.name }])
    await err('human forbidden delete', lee, { op: 'delete', id: t6 }, 'forbidden', 'On the web you mark tasks')
    await err('agent edits person title', api, { op: 'edit', id: t5, title: 'Wrong title' }, 'bad_request', 'its title changes with a message')

    await ok('edit title', 'todo', [api, { op: 'edit', id: t3, title: 'Third renamed' }])
    await ok('edit to', 'todo', [api, { op: 'edit', id: t3, to: api.name }])
    await ok('edit after', 'todo', [api, { op: 'edit', id: t3, after: [t5] }])
    await ok('edit from', 'todo', [api, { op: 'edit', id: t3, from: source }])
    await err('edit cycle', api, { op: 'edit', id: t3, after: [t3] }, 'item_cycle', 'would make it wait on itself')
    await ok('edit status doing', 'todo', [api, { op: 'edit', id: t3, status: 'doing' }])
    await ok('edit status todo', 'todo', [api, { op: 'edit', id: t3, status: 'todo' }])
    await ok('edit status done', 'todo', [api, { op: 'edit', id: t3, status: 'done' }])

    await ok('todo list before delete', 'todoList', [api])
    await ok('todo brief mine', 'todoBrief', [api, { mine: true }])
    await ok('todo brief open', 'todoBrief', [api, { to: null }])
    await ok('todo brief to person', 'todoBrief', [api, { to: 'lee' }])
    await ok('todo show', 'todoShow', [api, t3, false])
    await ok('todo show full', 'todoShow', [api, t3, true])

    await err('missing item', api, { op: 'take', id: 'T999' }, 'item_not_found', 'There is no task')
    await err('missing source', api, { op: 'add', title: 'No source' }, 'source_required', 'A task comes from a message')
    await err('missing message prepareAdd', api, { op: 'add', title: 'Bad source', from: 99999 }, 'message_not_found', 'from=99999')
    await err('missing message titleFrom', lee, { op: 'add', from: 99999 }, 'message_not_found', 'from=99999')
    await err('missing message editItem', api, { op: 'edit', id: t6, from: 99999 }, 'message_not_found', 'from=99999')
    await err('bad to', api, { op: 'add', title: 'Bad to', from: source, to: 'ghost' }, 'bad_request', 'to=ghost')
    await err('bad title', api, { op: 'add', title: '   ', from: source }, 'bad_request', "add='<title>' is required")
    await err('bad delete', api, { op: 'delete' }, 'bad_request', 'delete=T3')
    await err('bad from', api, { op: 'edit', id: t6, from: 0 }, 'bad_request', 'from= is the seq')
    await err('bad status', api, { op: 'edit', id: t6, status: 'waiting' }, 'bad_request', 'status= is todo')
    await err('bad operation', api, { op: 'unknown', id: t6 }, 'bad_request', 'A task change is one of')
    await ok('delete multiple', 'todo', [api, { op: 'delete', ids: [t5, t6] }])
    await ok('todo list after delete', 'todoList', [api])
    assert.ok(mainWrites < 40, `main room had ${mainWrites} task writes`)

    const clock = await mf.dispatchFetch('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: '__testClock', args: [1_760_000_000_000] }),
    })
    assert.equal(clock.status, 200)
    await call('rate init', 'init', [{ id: 'todo-rate', name: 'Rate', topic: '', owner: 'kai', code: null }], 't2')
    await ok('rate join', 'join', [api, { role: 'api' }], 't2')
    for (let i = 1; i <= 41; i++) {
      await err(`rate ${i}`, api, { op: 'add', title: 'No source' }, i === 41 ? 'rate_limited' : 'source_required', i === 41 ? 'More than 40 task changes' : 'A task comes from a message', 't2')
    }

    const actual = stable(records)
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n')
    else assert.deepEqual(actual, JSON.parse(fs.readFileSync(golden, 'utf8')))
  } finally {
    await mf.dispose()
  }
})
