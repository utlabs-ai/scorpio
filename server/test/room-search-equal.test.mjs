import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

// Search (split by domain, S8b): every group, term kind, in= and before= on a topic seeded through SQL, with the
// statements each query ran and the rows they read, recorded once on the code from before search left RoomDO. Moving
// search into each domain (S8b) changes neither this file nor its golden; RECORD_SEARCH_GOLDEN=1 is only for that first
// recording.
const golden = new URL('./room-search-equal.golden.json', import.meta.url)

const bundled = await build({
  entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  external: ['cloudflare:workers'],
})
// The probe counts every statement search runs on this.sql (each domain reads it at call time) and adds up rowsRead
// once the cursors are read.
const script = `function assertEmptyMemo(out) { if (out.groups.memo.length || out.hasMore.memo) throw new Error("legacy groups unexpectedly searched memo"); }
${bundled.outputFiles[0].text}
  class Probe extends RoomDO {
    async fetch(req) {
      const body = await req.json();
      if (body.sql) {
        for (const [query, args] of body.sql) this.ctx.storage.sql.exec(query, ...args);
        return Response.json({ ok: true });
      }
      const original = this.sql;
      const cursors = [];
      this.sql = new Proxy(original, { get(target, key) {
        const value = target[key];
        if (key === 'exec') return (...args) => { const cursor = value.apply(target, args); cursors.push(cursor); return cursor; };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      try {
        const result = await this.search(body.actor, { ...body.query, groups: ["messages", "todo", "files"] });
        if (result.ok) {
          assertEmptyMemo(result.ok);
          delete result.ok.groups.memo; delete result.ok.hasMore.memo;
        }
        return Response.json({ result, queries: cursors.length, rowsRead: cursors.reduce((n, c) => n + c.rowsRead, 0) });
      } finally {
        this.sql = original;
      }
    }
  }
  export { Probe };
  export default { fetch(req, env) { return env.PROBE.get(env.PROBE.idFromName(new URL(req.url).pathname)).fetch(req); } };`

const kai = { kind: 'human', account: 'kai', name: 'kai' }
const api = { kind: 'agent', account: 'kai', name: 'api@kai' }
const guest = { kind: 'human', account: 'guest', name: 'guest' }
const bot = { kind: 'agent', account: 'zed', name: 'bot@zed' }

// One line per hit (and per small object) in the golden file, so a diff points at the hit.
function pretty(v, depth = 0) {
  const flat = (x) => x === null || typeof x !== 'object' || (!Array.isArray(x) && Object.values(x).every((y) => y === null || typeof y !== 'object'))
  if (flat(v) || (Array.isArray(v) && !v.length)) return JSON.stringify(v)
  const pad = '  '.repeat(depth + 1)
  const end = '  '.repeat(depth)
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + pretty(x, depth + 1)).join(',\n')}\n${end}]`
  return `{\n${Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pretty(x, depth + 1)}`).join(',\n')}\n${end}}`
}

test('search answers, statements and rows read equal the pre-move recording', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, bindings: { PUBLIC_URL: 'https://scorpio.test' },
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
  }))
  const call = async (topic, body) => {
    const res = await mf.dispatchFetch(`http://localhost/${topic}`, { method: 'POST', body: JSON.stringify(body) })
    const text = await res.text()
    assert.equal(res.status, 200, text)
    return JSON.parse(text)
  }
  const sql = (topic, ...statements) => call(topic, { sql: statements })
  const room = (id, pub, deleted = null) => ['INSERT INTO room (id, name, topic, owner, code, public, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, id, '', 'kai', pub ? null : 'ABC-123', pub ? 1 : 0, 1, deleted]]
  const member = (name, kind, owner, display = null) => ['INSERT INTO members (name, kind, owner, joined_at, display_name) VALUES (?, ?, ?, ?, ?)', [name, kind, owner, 1, display]]
  const message = (seq, from, kind, text, ts) => ['INSERT INTO messages (seq, from_name, from_kind, text, ts) VALUES (?, ?, ?, ?, ?)', [seq, from, kind, text, ts]]
  const item = (n, title, descr, status, assignee, by, seq, ms) => [
    'INSERT INTO items (n, title, descr, status, assignee, created_by, created_seq, created_ms, updated_by, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [n, title, descr, status, assignee, by, seq, ms, by, ms],
  ]
  const file = (id, name, seq, by = 'kai', deleted = null) => [
    'INSERT INTO files (id, name, type, size, uploaded_by, ts, seq, hash, deleted_at, charged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, 'text/plain', 42, by, 100, seq, `hash-${id}`, deleted, 42],
  ]
  try {
    // A public topic: kai (display name Kai), lee (no display name), api@kai; ghost sent and uploaded without a member
    // row. Equal times break ties by seq (messages), n (tasks) and id (files); seq 12 and T8 are later rows with
    // earlier times. Tasks T3 and T6 have no source message; fd is deleted, fu was never sent.
    await sql('pub',
      room('pub', true),
      member('kai', 'human', 'kai', 'Kai'),
      member('lee', 'human', 'lee'),
      member('api@kai', 'agent', 'kai'),
      message(1, 'system', 'system', 'deploy@kai joined', 500),
      message(2, 'kai', 'human', 'deploy plan for the 珍珠 shop', 1000),
      message(3, 'lee', 'human', 'deploy done on staging', 2000),
      message(4, 'ghost', 'human', 'ghost says deploy', 2000),
      message(5, 'api@kai', 'agent', '珍珠奶茶 deploy ok', 2000),
      message(6, 'kai', 'human', 'literal a%_b here', 3000),
      message(7, 'lee', 'human', 'decoys axyb a%xb a_%b', 3000),
      message(8, 'kai', 'human', 'three files', 4000),
      message(9, 'ghost', 'human', 'ghost file', 4000),
      message(10, 'lee', 'human', 'DEPLOY in capitals', 5000),
      message(11, 'kai', 'human', '珍 alone', 5000),
      message(12, 'api@kai', 'agent', 'deploy again, 珍珠 too', 1500),
      message(13, 'kai', 'human', 'a%_b again, then deploy', 6000),
      item(1, 'Deploy the shop', null, 'todo', 'lee', 'kai', 2, 1000),
      item(2, '珍珠 menu', 'deploy later', 'doing', 'api@kai', 'lee', 3, 2000),
      item(3, 'Ghost task: deploy', null, 'todo', null, 'ghost', null, 2000),
      item(4, 'Literal a%_b task', 'nothing here', 'done', 'kai', 'kai', 6, 3000),
      item(5, 'Plain title', 'deploy in the description', 'todo', 'kai', 'api@kai', 10, 3000),
      item(6, 'Another 珍珠', null, 'todo', null, 'kai', null, 4000),
      item(7, 'decoy axyb', 'a%xb', 'todo', null, 'lee', 7, 4000),
      item(8, 'deploy 珍珠 both', 'x', 'todo', 'lee', 'lee', 12, 1500),
      file('fa', 'deploy-a.txt', 8),
      file('fb', 'deploy-b.txt', 8),
      file('fc', '珍珠.png', 8),
      file('fd', 'deploy-old.txt', 8, 'kai', 700),
      file('fg', 'deploy-ghost.log', 9, 'ghost'),
      file('fl', 'a%_b.csv', 6),
      file('fx', 'axyb.csv', 7, 'lee'),
      file('fu', 'deploy-unsent.txt', null),
      file('fz', 'deploy-珍珠.zip', 12, 'api@kai'),
    )
    // A private topic kai is alone in, and a deleted private one.
    await sql('priv', room('priv', false), member('kai', 'human', 'kai', 'Kai'), message(1, 'kai', 'human', 'deploy here', 1000))
    await sql('gone', room('gone', false, 900), member('kai', 'human', 'kai', 'Kai'), message(1, 'kai', 'human', 'deploy gone', 1000))

    const records = []
    const search = async (topic, actor, q, opts = {}) => {
      const query = { q, terms: q.split(' '), ...opts, limit: opts.limit ?? 20 }
      const out = await call(topic, { actor, query })
      records.push({ topic, actor: actor.name, query, ...out })
      return out.result
    }
    const groups = ['messages', 'todo', 'files']

    // Terms: short Han (no trigram), a long one (trigram), literal % and _ (no trigram), two terms (AND); each in=.
    const terms = ['珍珠', 'deploy', 'a%_b', '珍珠 deploy']
    const full = {}
    for (const q of terms) {
      await search('pub', kai, q)
      for (const group of groups) full[`${q}/${group}`] = (await search('pub', kai, q, { in: group })).ok.groups[group].length
    }
    // limit at the group's count (hasMore false) and one under it (true).
    for (const q of terms) {
      for (const group of groups) {
        const n = full[`${q}/${group}`]
        if (n >= 1) await search('pub', kai, q, { in: group, limit: n })
        if (n >= 2) await search('pub', kai, q, { in: group, limit: n - 1 })
      }
    }
    // before= for each group, and for all of them at once.
    for (const q of ['deploy', '珍珠']) {
      for (const before of [5, 9, 13]) {
        await search('pub', kai, q, { before })
        for (const group of groups) await search('pub', kai, q, { in: group, before })
      }
    }
    // Readers: an agent member, a viewer of the public topic; refusals: a non-member agent, a non-member of the private
    // topic, and the deleted topic (room_deleted before not_member).
    await search('pub', api, 'deploy')
    await search('pub', guest, 'deploy')
    await search('pub', guest, '珍珠', { in: 'todo' })
    await search('pub', bot, 'deploy')
    await search('priv', guest, 'deploy')
    await search('priv', kai, 'deploy')
    await search('gone', guest, 'deploy')
    await search('gone', kai, 'deploy')

    if (process.env.RECORD_SEARCH_GOLDEN === '1') writeFileSync(golden, `${pretty(records)}\n`)
    assert.deepEqual(records, JSON.parse(readFileSync(golden, 'utf8')))
  } finally { await mf.dispose() }
})
