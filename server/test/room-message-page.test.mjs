import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const built = await build({
  entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  external: ['cloudflare:workers'],
})
const script = `${built.outputFiles[0].text}
export class Probe extends RoomDO {
  setScheduled(seq, by) {
    this.sql.exec('UPDATE messages SET scheduled = ? WHERE seq = ?', JSON.stringify({ id: 's1', by, at: 1 }), seq);
    return true;
  }
  pageQueryCount(actor, limit) {
    const rows = this.sql.exec('SELECT * FROM messages ORDER BY seq DESC LIMIT ?', limit).toArray();
    const original = this.sql;
    let count = 0;
    this.sql = new Proxy(original, { get(target, key) {
      const value = target[key];
      if (key === 'exec') return (...args) => { count++; return value.apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try { const messages = this.messagesOf(rows, actor); return { count, messages }; }
    finally { this.sql = original; }
  }
}
export default { async fetch(req, env) {
  const { method, args = [] } = await req.json();
  return Response.json(await env.ROOMS.getByName('page')[method](...args));
} };`

const kai = { kind: 'human', account: 'kai', name: 'kai' }
const lee = { kind: 'human', account: 'lee', name: 'lee' }
const api = { kind: 'agent', account: 'kai', name: 'api@kai' }

test('message pages preserve single-message output with two hydration queries', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script,
    compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOMS: { className: 'Probe', useSQLite: true } },
    d1Databases: { DB: 'db' }, kvNamespaces: ['KV'], r2Buckets: ['FILES'],
  }))
  async function call(method, ...args) {
    const response = await mf.dispatchFetch('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }),
    })
    const body = await response.text()
    assert.equal(response.status, 200, `${method}: ${body}`)
    return JSON.parse(body)
  }
  try {
    await call('init', { id: 'page', name: 'Page', topic: '', owner: 'kai', code: null })
    await call('enterHuman', lee, undefined, 'Lee')
    await call('join', api, { role: 'api' })
    const source = (await call('send', api, { text: '@lee Please review', add: 'Review', to: 'lee' })).ok
    await call('setScheduled', source.seq, 'scheduler@kai')
    const reply = (await call('send', lee, { text: '@api@kai Reviewed', replyTo: source.seq })).ok
    for (let i = 0; i < 18; i++) await call('send', kai, { text: `note ${i}` })

    for (const viewer of [kai, api]) {
      const page = (await call('messages', viewer, { limit: 50 })).ok.messages
      for (const message of page) {
        const one = (await call('message', viewer, message.seq)).ok.message
        assert.deepEqual(message, one)
      }
      assert.deepEqual((await call('history', viewer, 9999, 100)).ok.messages, page)
      const around = (await call('around', viewer, reply.seq)).ok.messages
      assert.deepEqual(around, page)
    }
    const replyInPage = (await call('messages', kai, { limit: 50 })).ok.messages.find((m) => m.seq === reply.seq)
    assert.equal(replyInPage.reply.seq, source.seq)
    assert.equal(replyInPage.todo[0].closer, 'scheduler@kai')
    assert.equal((await call('pageQueryCount', kai, 1)).count, 2)
    assert.equal((await call('pageQueryCount', kai, 20)).count, 2)
  } finally {
    await mf.dispose()
  }
})
