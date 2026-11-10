import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const built = await build({ entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', external: ['cloudflare:workers'] })
const script = `${built.outputFiles[0].text}
export default { async fetch(req, env) {
  const { method, args = [], room = 't' } = await req.json();
  return Response.json(await env.ROOMS.getByName(room)[method](...args));
} };`
const kai = { kind: 'human', account: 'kai', name: 'kai' }
const lee = { kind: 'human', account: 'lee', name: 'lee' }
const helper = { kind: 'agent', account: 'ash', name: 'helper@ash' }

test('indexState reads room fields and account presence without changing them', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOMS: { className: 'RoomDO', useSQLite: true } },
    d1Databases: { DB: 'db' }, kvNamespaces: ['KV'], r2Buckets: ['FILES'],
  }))
  async function call(method, args = [], room = 't') {
    const res = await mf.dispatchFetch('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args, room }),
    })
    assert.equal(res.status, 200)
    return res.json()
  }
  async function ok(method, args = [], room = 't') {
    const out = await call(method, args, room)
    assert.ok(out.ok, `${method}: ${JSON.stringify(out)}`)
    return out.ok
  }
  const current = () => ok('indexState')
  try {
    await call('init', [{ id: 't', name: 'Topic', topic: 'First', owner: 'kai', code: '234-567-89A' }])
    assert.deepEqual(await current(), { topic: 'First', public: false, archivedAt: null, archivedReason: null, deletedAt: null,
      accounts: [{ account: 'kai', active: true, human: true }] })
    await ok('setTopic', [kai, 'Second'])
    assert.equal((await current()).topic, 'Second')
    await ok('setVisibility', [kai, true, '234-567-89A'])
    assert.equal((await current()).public, true)
    await ok('setArchived', [kai, true])
    assert.ok((await current()).archivedAt)
    await ok('setArchived', [kai, false])
    await ok('enterHuman', [lee, undefined, 'Lee'])
    assert.deepEqual((await current()).accounts.find((a) => a.account === 'lee'), { account: 'lee', active: true, human: true })
    await ok('leaveAccount', [lee])
    assert.deepEqual((await current()).accounts.find((a) => a.account === 'lee'), { account: 'lee', active: false, human: true })
    await ok('join', [helper, { role: 'helper' }])
    await ok('leave', [helper])
    assert.deepEqual((await current()).accounts.find((a) => a.account === 'ash'), { account: 'ash', active: false, human: false })

    await call('init', [{ id: 't2', name: 'Other', topic: '', owner: 'kai', code: null }], 't2')
    await ok('enterHuman', [lee, undefined, 'Lee'], 't2')
    await ok('removeAccount', [kai, 'lee'], 't2')
    assert.equal((await ok('indexState', [], 't2')).accounts.some((a) => a.account === 'lee'), false)
  } finally {
    await mf.dispose()
  }
})
