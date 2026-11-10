import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const bundled = await build({
  entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  external: ['cloudflare:workers'],
})
const script = `${bundled.outputFiles[0].text}
  class Probe extends RoomDO {
    async fetch(req) {
      const body = await req.json();
      if (body.sql) {
        for (const [query, args] of body.sql) this.ctx.storage.sql.exec(query, ...args);
        return Response.json({ ok: true });
      }
      return Response.json(await this.listFiles(body.actor, body.query || {}));
    }
  }
  export { Probe };
  export default { fetch(req, env) { return env.PROBE.get(env.PROBE.idFromName('topic')).fetch(req); } };`

async function room() {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, bindings: { PUBLIC_URL: 'https://scorpio.test' },
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
  }))
  const call = async (body) => {
    const res = await mf.dispatchFetch('http://localhost/', { method: 'POST', body: JSON.stringify(body) })
    assert.equal(res.status, 200)
    return res.json()
  }
  await call({ sql: [
    ['INSERT INTO room (id, name, topic, owner, created_at, public) VALUES (?, ?, ?, ?, ?, ?)', ['topic1', 'Topic', '', 'kai', 1, 0]],
    ['INSERT INTO members (name, kind, owner, joined_at, display_name) VALUES (?, ?, ?, ?, ?)', ['kai', 'human', 'kai', 1, 'Kai']],
    ['INSERT INTO members (name, kind, owner, joined_at) VALUES (?, ?, ?, ?)', ['agent@kai', 'agent', 'kai', 1]],
    ['INSERT INTO messages (seq, from_name, from_kind, text, ts) VALUES (?, ?, ?, ?, ?)', [10, 'kai', 'human', 'files', 1000]],
    ['INSERT INTO messages (seq, from_name, from_kind, text, ts) VALUES (?, ?, ?, ?, ?)', [11, 'agent@kai', 'agent', 'more files', 2000]],
  ] })
  const sql = (...statements) => call({ sql: statements })
  const list = (query = {}, actor = { kind: 'human', account: 'kai', name: 'kai' }) => call({ actor, query })
  return { mf, sql, list }
}

const file = (id, name, type, seq = 10, by = 'kai', deleted = null) => [
  'INSERT INTO files (id, name, type, size, uploaded_by, ts, seq, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  [id, name, type, 42, by, 100, seq, deleted],
]

test('empty topic, access rules, and archived public readers', async () => {
  const r = await room()
  try {
    const empty = (await r.list()).ok
    assert.deepEqual(empty.files, [])
    assert.deepEqual(empty.counts, { files: 0, pics: 0, gone: 0 })
    assert.equal(empty.hasMore, false)
    const guest = { kind: 'human', account: 'guest', name: 'guest' }
    assert.equal((await r.list({}, guest)).err.code, 'not_member')
    await r.sql(['UPDATE room SET public = 1, archived_at = 1', []])
    assert.deepEqual((await r.list({}, guest)).ok.files, [])
    assert.equal((await r.list({}, { kind: 'agent', account: 'guest', name: 'bot@guest' })).err.code, 'not_member')
  } finally { await r.mf.dispose() }
})

test('sent files, pictures, filters, nine attachments on one message, and deduplicated gone count', async () => {
  const r = await room()
  try {
    await r.sql(
      ...Array.from({ length: 9 }, (_, i) => file(`f${i}`, `v31-${i}.html`, 'text/html')),
      file('pic', '珍珠.png', 'image/png', 11, 'agent@kai'),
      file('unsent', 'draft.zip', 'application/zip', null),
      file('old1', 'old.zip', 'application/zip', 10, 'kai', 123),
      file('old2', 'other.zip', 'application/zip', 10, 'kai', 123),
      ['INSERT INTO gone_files (id, seq) VALUES (?, ?)', ['old1', 10]],
      ['INSERT INTO gone_files (id, seq) VALUES (?, ?)', ['gone3', 11]],
      ['INSERT INTO gone_files (id, seq) VALUES (?, ?)', ['unsentGone', null]],
      ['UPDATE messages SET files = ? WHERE seq = 10', [JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ id: `f${8 - i}` })))]],
      ['UPDATE messages SET files = ? WHERE seq = 11', [JSON.stringify([{ id: 'pic' }])]],
    )
    const first = (await r.list({ limit: 4 })).ok
    assert.deepEqual(first.counts, { files: 9, pics: 1, gone: 3 })
    assert.equal(first.files[0].id, 'pic')
    assert.equal(first.files[0].displayName, null)
    assert.equal(first.files[0].ts, 2000)
    assert.equal(first.files[0].url, '/f/topic1/pic')
    assert.equal(first.files[0].link, 'https://scorpio.test/v/pic')
    assert.equal(first.hasMore, true)
    const seen = [...first.files]
    let page = first
    while (page.hasMore) {
      const last = page.files.at(-1)
      page = (await r.list({ limit: 4, before: last.seq, beforeId: last.id })).ok
      seen.push(...page.files)
    }
    assert.deepEqual(seen.map((f) => f.id), ['pic', ...Array.from({ length: 9 }, (_, i) => `f${8 - i}`)])
    assert.equal(new Set(seen.map((f) => f.id)).size, 10)
    assert.deepEqual((await r.list({ kind: 'pics' })).ok.files.map((f) => f.id), ['pic'])
    assert.equal((await r.list({ kind: 'files' })).ok.files.length, 9)
    assert.equal((await r.list({ kind: 'files', q: 'v31' })).ok.files.length, 9)
    assert.deepEqual((await r.list({ q: '珍' })).ok.files.map((f) => f.id), ['pic'])
    assert.deepEqual((await r.list({ q: 'v31 8' })).ok.files.map((f) => f.id), ['f8'])
    assert.equal((await r.list({ q: 'v' })).ok.files.length, 10, 'too-short q shows all')
    assert.deepEqual((await r.list({ from: 'agent@kai' })).ok.files.map((f) => f.id), ['pic'])
    assert.deepEqual((await r.list({ before: 11 })).ok.files.map((f) => f.id), Array.from({ length: 9 }, (_, i) => `f${8 - i}`))
    assert.equal((await r.list({ kind: 'bad' })).err.code, 'bad_request')
    assert.equal((await r.list({ beforeId: 'f8' })).err.code, 'bad_request')
  } finally { await r.mf.dispose() }
})

test('files in one message follow message order across two pages, not id order', async () => {
  const r = await room()
  try {
    await r.sql(
      ['UPDATE messages SET files = ? WHERE seq = 10', [JSON.stringify([{ id: 'a' }, { id: 'm' }, { id: 'z' }])]],
      file('z', 'third.txt', 'text/plain'),
      file('a', 'first.txt', 'text/plain'),
      file('m', 'second.txt', 'text/plain'),
    )
    const first = (await r.list({ limit: 2 })).ok
    assert.deepEqual(first.files.map((f) => f.id), ['a', 'm'])
    assert.equal(first.hasMore, true)
    const last = first.files.at(-1)
    const second = (await r.list({ limit: 2, before: last.seq, beforeId: last.id })).ok
    assert.deepEqual(second.files.map((f) => f.id), ['z'])
    assert.equal(second.hasMore, false)
    const all = [...first.files, ...second.files].map((f) => f.id)
    assert.deepEqual(all, ['a', 'm', 'z'])
    assert.equal(new Set(all).size, 3)
    assert.deepEqual((await r.list({ before: 10, beforeId: 'not-in-message' })).ok.files, [])
    assert.deepEqual((await r.list({ before: 10 })).ok.files, [])
    assert.deepEqual((await r.list({ before: 10, beforeId: 'a' })).ok.files.map((f) => f.id), ['m', 'z'])
  } finally { await r.mf.dispose() }
})
