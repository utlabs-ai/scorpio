import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
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
      return Response.json(body.view ? await this.viewFile(body.actor, body.view) : await this.listFiles(body.actor, body.query));
    }
  }
  export { Probe };
  export default { fetch(req, env) { return env.PROBE.get(env.PROBE.idFromName('topic')).fetch(req); } };`
const actor = { kind: 'human', account: 'kai', name: 'kai' }
const golden = new URL('./room-files-equal.golden.json', import.meta.url)

test('file listing and file pages equal the pre-move answers', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, bindings: { PUBLIC_URL: 'https://scorpio.test' },
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
  }))
  const call = async (body) => {
    const res = await mf.dispatchFetch('http://localhost/', { method: 'POST', body: JSON.stringify(body) })
    assert.equal(res.status, 200)
    return res.json()
  }
  const sql = async (...statements) => call({ sql: statements })
  const list = async (query) => call({ actor, query })
  const file = (id, name, type, seq, by = 'kai', deleted = null) => [
    'INSERT INTO files (id, name, type, size, uploaded_by, ts, seq, hash, deleted_at, charged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, type, 42, by, 100, seq, `hash-${id}`, deleted, 42],
  ]
  try {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `f${8 - i}`, name: `note-${8 - i}.txt`, type: 'text/plain', size: 42 }))
    await sql(
      ['INSERT INTO room (id, name, topic, owner, created_at, public) VALUES (?, ?, ?, ?, ?, ?)', ['topic1', 'Topic', '', 'kai', 1, 0]],
      ['INSERT INTO members (name, kind, owner, joined_at, display_name) VALUES (?, ?, ?, ?, ?)', ['kai', 'human', 'kai', 1, 'Kai']],
      ['INSERT INTO members (name, kind, owner, joined_at) VALUES (?, ?, ?, ?)', ['ghost', 'human', 'ghost', 1]],
      ['INSERT INTO messages (seq, from_name, from_kind, text, ts, files) VALUES (?, ?, ?, ?, ?, ?)', [10, 'kai', 'human', 'nine', 1000, JSON.stringify([...nine, nine[0]])]],
      ['INSERT INTO messages (seq, from_name, from_kind, text, ts, files) VALUES (?, ?, ?, ?, ?, ?)', [11, 'ghost', 'human', 'picture', 2000, JSON.stringify([{ id: 'pic', name: '珍珠.png', type: 'image/png', size: 42 }])]],
      ['INSERT INTO messages (seq, from_name, from_kind, text, ts) VALUES (?, ?, ?, ?, ?)', [12, 'kai', 'human', 'null files', 3000]],
      ['INSERT INTO messages (seq, from_name, from_kind, text, ts, files) VALUES (?, ?, ?, ?, ?, ?)', [13, 'kai', 'human', 'gone', 4000, JSON.stringify([{ id: 'gone', name: 'gone.pdf', type: 'application/pdf', size: 42, deleted: 444 }])]],
      ...Array.from({ length: 9 }, (_, i) => file(`f${i}`, `note-${i}.txt`, 'text/plain', 10)),
      file('pic', '珍珠.png', 'image/png', 11, 'ghost'),
      file('orphan', 'null.txt', 'text/plain', 12),
      file('unsent', 'draft.zip', 'application/zip', null),
      file('deleted', 'old.txt', 'text/plain', 10, 'kai', 333),
      ['INSERT INTO gone_files (id, seq) VALUES (?, ?)', ['gone', 13]],
      ['INSERT INTO gone_files (id, seq) VALUES (?, ?)', ['deleted', 10]],
      ['INSERT INTO gone_files (id, seq) VALUES (?, ?)', ['unsent-gone', null]],
    )
    const records = []
    for (const kind of [undefined, 'files', 'pics']) {
      for (const q of [undefined, 'note', '珍', 'zz']) {
        for (const from of [undefined, 'kai', 'ghost']) {
          for (const limit of [1, 3, 8]) {
            const query = { ...(kind ? { kind } : {}), ...(q ? { q } : {}), ...(from ? { from } : {}), limit }
            records.push({ query, result: await list(query) })
          }
        }
      }
    }
    for (const kind of [undefined, 'files', 'pics']) {
      for (const limit of [1, 2, 4]) {
        const pages = []
        let query = { ...(kind ? { kind } : {}), limit }
        for (let i = 0; i < 20; i++) {
          const result = await list(query)
          pages.push(result)
          if (!result.ok?.hasMore) break
          const last = result.ok.files.at(-1)
          assert.ok(last, 'a nonempty page must advance the cursor')
          query = { ...query, before: last.seq, beforeId: last.id }
        }
        assert.equal(pages.at(-1).ok?.hasMore, false, 'page walk must finish')
        records.push({ walk: { kind: kind ?? null, limit }, pages })
      }
    }
    for (const id of ['f8', 'unsent', 'gone']) records.push({ view: id, result: await call({ actor, view: id }) })
    const actual = `${JSON.stringify(records, null, 2)}\n`
    if (process.env.RECORD_FILE_GOLDEN === '1') writeFileSync(golden, actual)
    assert.deepEqual(records, JSON.parse(readFileSync(golden, 'utf8')))
  } finally { await mf.dispose() }
})
