import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

// The topic's own reads (split by domain, S8b): summary for its owner, a member, a viewer and someone who left;
// indexState, on a deleted topic too; peek. Recorded once on the code from before room left RoomDO. Moving room into
// room/room.ts (S8b) changes neither this file nor its golden; RECORD_SUMMARY_GOLDEN=1 is only for that first recording.
const golden = new URL('./room-summary.golden.json', import.meta.url)

const built = await build({
  entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  external: ['cloudflare:workers'],
})
// carry: a daemon connection that carries these agents, as presence keeps it (the client end stays referenced, so the
// connection stays open while the test runs). Message and topic times are set after the sends, so they are fixed.
const script = `${built.outputFiles[0].text}
export class Probe extends RoomDO {
  seed(statements) {
    for (const [query, args] of statements) this.sql.exec(query, ...args);
    return true;
  }
  carry(host, names) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['host', 'host:' + host]);
    server.serializeAttachment({ kind: 'host', name: host, carry: names });
    this.kept = client;
    return true;
  }
}
export default { async fetch(req, env) {
  const { name, method, args = [] } = await req.json();
  return Response.json(await env.ROOMS.getByName(name)[method](...args));
} };`

const kai = { kind: 'human', account: 'kai', name: 'kai' }
const lee = { kind: 'human', account: 'lee', name: 'lee' }
const ana = { kind: 'human', account: 'ana', name: 'ana' }
const guest = { kind: 'human', account: 'guest', name: 'guest' }
const api = { kind: 'agent', account: 'kai', name: 'api@kai' }
const helper = { kind: 'agent', account: 'lee', name: 'helper@lee' }
const old = { kind: 'agent', account: 'kai', name: 'old@kai' }
const late = { kind: 'agent', account: 'lee', name: 'late@lee' }
const BASE = Date.UTC(2026, 8, 30, 8)
const STEP = 60_000

// Times the clock writes (tasks, archive and delete): message and topic times are fixed above.
const timeKeys = new Set(['createdMs', 'updatedMs', 'doneMs', 'archivedAt', 'deletedAt'])
const norm = (value) => {
  if (Array.isArray(value)) return value.map(norm)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, timeKeys.has(k) && typeof v === 'number' ? 0 : norm(v)]))
  }
  return value
}

function pretty(v, depth = 0) {
  const flat = (x) => x === null || typeof x !== 'object' || (!Array.isArray(x) && Object.values(x).every((y) => y === null || typeof y !== 'object'))
  if (flat(v) || (Array.isArray(v) && !v.length)) return JSON.stringify(v)
  const pad = '  '.repeat(depth + 1)
  const end = '  '.repeat(depth)
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + pretty(x, depth + 1)).join(',\n')}\n${end}]`
  return `{\n${Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pretty(x, depth + 1)}`).join(',\n')}\n${end}}`
}

test('summary, indexState and peek answer as recorded', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script,
    compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
    bindings: { PUBLIC_URL: 'https://scorpio.test', TEST_LIMITS: JSON.stringify({ self: { msgsPerRoomMinute: 1000 } }) },
    durableObjects: { ROOMS: { className: 'Probe', useSQLite: true } },
    d1Databases: { DB: 'db' }, kvNamespaces: ['KV'], r2Buckets: ['FILES'],
  }))
  async function on(name, method, ...args) {
    const response = await mf.dispatchFetch('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, method, args }),
    })
    const body = await response.text()
    assert.equal(response.status, 200, `${method}: ${body}`)
    return JSON.parse(body)
  }
  const ok = async (name, method, ...args) => {
    const r = await on(name, method, ...args)
    assert.ok(r.ok, `${method}: ${JSON.stringify(r)}`)
    return r.ok
  }
  const send = async (actor, p) => (await ok('sum', 'send', actor, p)).seq
  try {
    // A public topic: kai owns it; lee is in it; ana came and left; api@kai and helper@lee are in it, old@kai left,
    // late@lee joins last; daemon seats for kai and for ash (an account with only a seat).
    await on('sum', 'init', { id: 'sum', name: 'Summary', topic: 'The home row', owner: 'kai', code: null })
    await ok('sum', 'enterHuman', lee, undefined, 'Lee')
    await ok('sum', 'enterHuman', ana, undefined, 'Ana')
    for (const [agent, role] of [[api, 'api'], [helper, 'helper'], [old, 'old']]) await ok('sum', 'join', agent, { role })
    await ok('sum', 'leave', old)
    await ok('sum', 'leaveAccount', ana)
    await send(kai, { text: 'Morning.' })
    await send(api, { text: '@lee Please review the draft.', add: 'Review the draft', to: 'lee' })
    await send(lee, { text: '@api@kai Will do.' })
    await send(helper, { text: '@kai @lee The logs are clean.' })
    const leeRead = await send(kai, { text: '@api@kai Write the summary.', add: 'Write the summary', to: 'api@kai' })
    await send(kai, { text: 'A note for me.', add: 'My own task', to: 'kai' })
    await send(lee, { text: '@kai Is T1 still needed?' })
    await send(kai, { text: '@lee Yes.', add: 'Old chore', to: 'lee' })
    await send(lee, { text: '@kai Finished the chore.', done: 'T4' })
    const kaiRead = await send(api, { text: '@kai @lee The summary is up.' })
    await send(helper, { text: '@lee A late note from helper.' })
    await send(lee, { text: '@kai One more thing.' })
    // The last line is a system line: lastMs counts it, unread does not.
    await ok('sum', 'join', late, { role: 'late' })
    assert.ok(await ok('sum', 'mark', lee, leeRead))
    assert.ok(await ok('sum', 'mark', kai, kaiRead))
    await on('sum', 'seed', [
      ["INSERT INTO members (name, kind, owner, cursor, status, joined_at) VALUES ('daemon@kai', 'host', 'kai', 0, 'active', 1)", []],
      ["INSERT INTO members (name, kind, owner, cursor, status, joined_at) VALUES ('daemon@ash', 'host', 'ash', 0, 'active', 1)", []],
      // Working: api@kai (carried below), helper@lee (no daemon carries it), old@kai (left), daemon@kai (a seat).
      ["UPDATE members SET work = 'working', work_since = 1 WHERE name IN ('api@kai', 'helper@lee', 'old@kai', 'daemon@kai')", []],
      ['UPDATE messages SET ts = ? + seq * ?', [BASE, STEP]],
      ['UPDATE room SET created_at = ?', [BASE]],
    ])
    await on('sum', 'carry', 'daemon@kai', ['api@kai', 'old@kai'])

    // A private topic with no messages, archived by its owner; a topic deleted by its owner.
    await on('quiet', 'init', { id: 'quiet', name: 'Quiet', topic: '', owner: 'kai', code: '234-567-89A' })
    await on('quiet', 'seed', [['UPDATE room SET created_at = ?', [7]]])
    await ok('quiet', 'setArchived', kai, true)
    // A private summary must also enforce account membership when called directly, without the D1 prefilter.
    await on('private-accounts', 'init', { id: 'private-accounts', name: 'Private', topic: '', owner: 'kai', code: '234-567-89A' })
    await ok('private-accounts', 'join', helper, { role: 'helper', code: '234-567-89A' })
    assert.ok((await on('private-accounts', 'summary', 'lee')).ok, 'an account with only an active agent may read')
    await ok('private-accounts', 'leave', helper)
    assert.equal((await on('private-accounts', 'summary', 'lee')).err?.code, 'not_member')
    assert.equal((await on('private-accounts', 'summary')).err?.code, 'not_member')
    assert.ok((await on('private-accounts', 'summary', 'kai')).ok)
    await on('gone', 'init', { id: 'gone', name: 'Gone', topic: 'Deleted', owner: 'kai', code: null })
    await ok('gone', 'enterHuman', lee, undefined, 'Lee')
    await ok('gone', 'deleteRoom', kai)

    const records = []
    const record = async (step, name, method, ...args) => records.push({ step, result: norm(await on(name, method, ...args)) })
    for (const [label, handle] of [['owner', 'kai'], ['member', 'lee'], ['viewer', 'guest'], ['left', 'ana'], ['agent', 'api@kai'], ['nobody', undefined]]) {
      await record(`summary sum ${label}`, 'sum', 'summary', ...(handle ? [handle] : []))
    }
    await record('summary quiet owner', 'quiet', 'summary', 'kai')
    await record('summary quiet viewer', 'quiet', 'summary', 'guest')
    await record('summary gone owner', 'gone', 'summary', 'kai')
    for (const name of ['sum', 'quiet', 'gone']) await record(`indexState ${name}`, name, 'indexState')
    for (const actor of [kai, lee, guest, ana, api]) await record(`peek sum ${actor.name}`, 'sum', 'peek', actor)
    await record('peek quiet guest', 'quiet', 'peek', guest)
    await record('peek gone kai', 'gone', 'peek', kai)

    if (process.env.RECORD_SUMMARY_GOLDEN === '1') writeFileSync(golden, `${pretty(records)}\n`)
    assert.deepEqual(records, JSON.parse(readFileSync(golden, 'utf8')))
  } finally {
    await mf.dispose()
  }
})
