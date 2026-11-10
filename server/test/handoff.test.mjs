// Handoffs in the cloud (docs/api/files.md), through the whole Worker (src/index.ts,
// bundled as wrangler would) on Miniflare: D1 with every
// migration, KV sessions, agent tokens, the room objects. A test-only route /__test/sql runs SQL in a room object
// (an orphan row, a left seat, reading what a delete left), and /__test/rpc calls a room method the Worker has no
// route for (accountGone, deleteRoom).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import vm from 'node:vm'

const built = await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  external: ['cloudflare:workers', 'node:*'], mainFields: ['module', 'main'], // node:zlib (zip.ts) is workerd's, given by nodejs_compat
})
const script = `${built.outputFiles[0].text.replace(/export\s*\{([^}]*)\bindex_default as default\b([^}]*)\};?\s*$/, 'export {$1$2};')}
class TestRoom extends RoomDO {
  async testSql(query, args) { const c = this.ctx.storage.sql.exec(query, ...args); return /^\\s*SELECT/i.test(query) ? c.toArray() : { rowsWritten: c.rowsWritten }; }
}
export { TestRoom };
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/__test/sql') { const b = await req.json(); return Response.json(await env.ROOMS.getByName(b.room).testSql(b.query, b.args || [])); }
    if (url.pathname === '/__test/rpc') { const b = await req.json(); return Response.json(await env.ROOMS.getByName(b.room)[b.method](...b.args)); }
    return index_default.fetch(req, env, ctx);
  },
};`

const ORIGIN = 'https://scorpio.test'
const CONTENT = 'content.test'
const TICKET_KEY = 'handoff-test-key-0123456789abcdef0123456789'

/** The statements of a migration file (no triggers among them): comments out, split at the semicolons. */
const statements = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)

async function worker() {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
    bindings: { PUBLIC_URL: ORIGIN, CONTENT_DOMAIN: CONTENT, VIEW_TICKET_KEY: TICKET_KEY },
    durableObjects: { ROOMS: { className: 'TestRoom', useSQLite: true } },
    d1Databases: { DB: 'db' }, kvNamespaces: ['KV'], r2Buckets: ['FILES'],
    serviceBindings: { ASSETS: () => new Response('not found', { status: 404 }) },
  }))
  const db = await mf.getD1Database('DB')
  const dir = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    for (const s of statements(fs.readFileSync(new URL(f, dir), 'utf8'))) await db.prepare(s).run()
  }
  const kv = await mf.getKVNamespace('KV')
  const fetch = (path, init = {}) => mf.dispatchFetch(path.startsWith('http') ? path : `${ORIGIN}${path}`, { redirect: 'manual', ...init })

  /** A person: a users row and a signed-in session; `agent()` gives them a computer's token. */
  async function person(handle) {
    const id = `u-${handle}`
    await db.prepare('INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES (?, ?, ?, ?, 0)').bind(id, handle, `${handle}@x.test`, Date.now()).run()
    const sid = `sid-${handle}-0123456789abcdef0123`
    await kv.put(`s:${sid}`, JSON.stringify({ id, handle, email: `${handle}@x.test` }))
    const token = `tok-${handle}-0123456789abcdef`
    const hash = createHash('sha256').update(token).digest('hex')
    await db.prepare('INSERT INTO agent_tokens (id, user_id, hash, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(`t-${handle}`, id, hash, 'box', Date.now(), Date.now() + 86400_000).run()
    const cookie = `sid=${sid}`
    /** The web, signed in; POSTs from our own origin unless `origin` says otherwise. */
    const web = (path, init = {}) => fetch(path, { ...init, headers: { cookie, ...(init.method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json' } : {}), ...(init.headers || {}) } })
    const post = (path, body, headers = {}) => web(path, { method: 'POST', body: JSON.stringify(body), headers })
    /** The agent API as role (no role: the account's calls before one). */
    const apiWith = (tok) => (path, init = {}, role) => fetch(`/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${tok}`, ...(role ? { 'x-scorpio-role': role } : {}), ...(init.headers || {}) } })
    const api = apiWith(token)
    /** Another computer of this account: a token of its own (its own daemon seat), the agent API through it. */
    async function computer(device) {
      const tok = `tok-${handle}-${device}-0123456789abcdef`
      await db.prepare('INSERT INTO agent_tokens (id, user_id, hash, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(`t-${handle}-${device}`, id, createHash('sha256').update(tok).digest('hex'), device, Date.now(), Date.now() + 86400_000).run()
      return { api: apiWith(tok) }
    }
    return { id, handle, cookie, web, post, api, computer }
  }

  async function json(res) {
    const text = await res.text()
    try { return { status: res.status, ...JSON.parse(text) } } catch { return { status: res.status, text } }
  }

  /** A topic made by `owner`'s agent API: `code` '' for a public one. */
  async function topic(owner, code = '') {
    const r = await json(await owner.api('/rooms', { method: 'POST', body: JSON.stringify({ name: 'Handoffs', code }), headers: { 'content-type': 'application/json' } }))
    if (!r.roomId) throw new Error(`create: ${JSON.stringify(r)}`)
    // its creator enters through the page, as on the web
    await owner.web(`/r/${r.roomId}`)
    return r.roomId
  }

  async function join(p, roomId, role, extra = {}) {
    const r = await json(await p.api(`/rooms/${roomId}/join`, { method: 'POST', body: JSON.stringify({ role, ...extra }), headers: { 'content-type': 'application/json' } }))
    if (r.error) throw new Error(`join ${role}: ${JSON.stringify(r)}`)
    return r
  }

  /** PUT a handoff as role@p: body a string, bytes or a stream. */
  const put = (p, roomId, role, body, headers = {}) =>
    p.api(`/rooms/${roomId}/handoff`, { method: 'PUT', body, headers: { 'content-type': 'text/markdown; charset=utf-8', ...headers }, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }, role)

  const sql = async (room, query, args = []) => (await fetch('/__test/sql', { method: 'POST', body: JSON.stringify({ room, query, args }) })).json()
  const rpc = async (room, method, ...args) => (await fetch('/__test/rpc', { method: 'POST', body: JSON.stringify({ room, method, args }) })).json()

  return { mf, db, kv, fetch, person, json, topic, join, put, sql, rpc, dispose: () => mf.dispose() }
}

const KB = 1024
const MAX = 256 * KB
const big = (n, ch = 'a') => ch.repeat(n)

test('writing: the seat itself; then every refusal, in the order the server checks them', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), zoe = await w.person('zoe')
    const room = await w.topic(kai)
    await w.join(kai, room, 'arch')
    await w.join(kai, room, 'gone')
    await w.join(kai, room, 'daemon', { host: true })
    await w.join(zoe, room, 'web')

    const ok = await w.json(await w.put(kai, room, 'arch', '# arch\n', { 'x-scorpio-computer': 'box' }))
    assert.equal(ok.status, 200)
    assert.deepEqual(Object.keys(ok).sort(), ['computer', 'link', 'name', 'roomId', 'size', 'status', 'updatedAt'])
    assert.equal(ok.name, 'arch@kai')
    assert.equal(ok.size, 7)
    assert.equal(ok.computer, null)
    assert.equal(ok.link, `${ORIGIN}/r/${room}/handoff?name=arch%40kai`)

    // the token first
    assert.equal((await w.json(await w.fetch(`/api/v1/rooms/${room}/handoff`, { method: 'PUT', body: 'x', headers: { 'x-scorpio-role': 'arch' } }))).error, 'not_logged_in')
    // the topic
    assert.equal((await w.json(await w.put(kai, 'A'.repeat(22), 'arch', 'x'))).error, 'room_not_found')
    // the writer: unknown, left, a daemon seat, a person's handle as role (no such agent)
    assert.equal((await w.json(await w.put(kai, room, 'nobody', 'x'))).error, 'not_member')
    await w.sql(room, "UPDATE members SET status = 'left' WHERE name = 'gone@kai'")
    assert.equal((await w.json(await w.put(kai, room, 'gone', 'x'))).error, 'not_member')
    const host = (await w.sql(room, "SELECT name FROM members WHERE kind = 'host'"))[0].name
    const daemon = await w.json(await w.put(kai, room, host.split('@')[0], 'x'))
    assert.equal(daemon.error, 'forbidden')
    assert.equal(daemon.status, 403)
    assert.equal((await w.json(await w.put(kai, room, 'kai', 'x'))).error, 'not_member', 'kai@kai is no member; a person never writes through /api/v1')
    // another account cannot write under a seat that is not its own: its token makes the name role@zoe
    assert.equal((await w.json(await w.put(zoe, room, 'arch', 'x'))).error, 'not_member')

    // the account's setting: after the topic and the writer, before the body (an invalid body is never looked at)
    await w.db.prepare("UPDATE users SET handoff_local = 1 WHERE handle = 'kai'").run()
    const local = await w.json(await w.put(kai, room, 'arch', new Uint8Array([0, 0xff])))
    assert.equal(local.error, 'handoff_local_only')
    assert.equal(local.status, 409)
    assert.equal((await w.json(await w.put(kai, room, 'nobody', 'x'))).error, 'not_member', 'a non-member with the setting on')
    assert.equal((await w.json(await w.put(kai, room, 'arch', big(MAX + 1)))).error, 'handoff_local_only', 'before the size')
    await w.db.prepare("UPDATE users SET handoff_local = 0 WHERE handle = 'kai'").run()

    // the body
    assert.equal((await w.json(await w.put(kai, room, 'arch', big(MAX)))).size, MAX, '256 KB exactly is stored')
    const over = await w.json(await w.put(kai, room, 'arch', big(MAX + 1)))
    assert.equal(over.error, 'handoff_too_large')
    assert.equal(over.status, 413)
    assert.equal((await w.json(await w.put(kai, room, 'arch', big(MAX - 3) + '中'))).size, MAX, 'a 3-byte character ending at the limit')
    assert.equal((await w.json(await w.put(kai, room, 'arch', big(MAX - 2) + '中'))).error, 'handoff_too_large', 'and across it')
    // no Content-Length: a stream, cut at the limit
    const chunks = (n, size) => new ReadableStream({ start(c) { for (let i = 0; i < n; i++) c.enqueue(new TextEncoder().encode(big(size))); c.close() } })
    assert.equal((await w.json(await w.put(kai, room, 'arch', chunks(4, 64 * KB)))).size, MAX)
    assert.equal((await w.json(await w.put(kai, room, 'arch', chunks(5, 64 * KB)))).error, 'handoff_too_large')
    assert.equal((await w.json(await w.put(kai, room, 'arch', ''))).error, 'bad_request')
    assert.equal((await w.json(await w.put(kai, room, 'arch', ' \n\t\n'))).error, 'bad_request')
    const notText = await w.json(await w.put(kai, room, 'arch', new Uint8Array([0x61, 0xc3, 0x28])))
    assert.equal(notText.error, 'handoff_not_text')
    assert.equal(notText.status, 415)
    assert.equal((await w.json(await w.put(kai, room, 'arch', 'a\u0000b'))).error, 'handoff_not_text')
    // The caller-supplied computer header is ignored, whatever its shape.
    const dropped = await w.json(await w.put(kai, room, 'arch', 'ok', { 'x-scorpio-computer': 'Not A Name' }))
    assert.equal(dropped.status, 200)
    assert.equal(dropped.computer, null)

    // archived: refused; deleted: refused
    assert.equal((await w.json(await kai.post(`/r/${room}/archive`, { archived: true }))).status, 200)
    const archived = await w.json(await w.put(kai, room, 'arch', 'x'))
    assert.equal(archived.error, 'room_archived')
    assert.equal(archived.status, 409)
    await w.rpc(room, 'deleteRoom', { kind: 'human', account: 'kai', name: 'kai' })
    assert.equal((await w.json(await w.put(kai, room, 'arch', 'x'))).error, 'room_deleted')
  } finally { await w.dispose() }
})

test('order: two writes in a row, the second wins; reading by API as a member and as a daemon seat', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), zoe = await w.person('zoe')
    const room = await w.topic(kai)
    await w.join(kai, room, 'arch')
    await w.join(zoe, room, 'web')
    await w.join(zoe, room, 'daemon', { host: true })
    const host = (await w.sql(room, "SELECT name FROM members WHERE kind = 'host'"))[0].name.split('@')[0]
    const first = await w.json(await w.put(kai, room, 'arch', 'first'))
    const second = await w.json(await w.put(kai, room, 'arch', 'second'))
    assert.ok(second.updatedAt > first.updatedAt)
    for (const [p, role] of [[kai, 'arch'], [zoe, 'web'], [zoe, host]]) {
      const got = await w.json(await p.api(`/rooms/${room}/handoff?name=arch@kai`, {}, role))
      assert.equal(got.body, 'second', role)
      assert.deepEqual(Object.keys(got).sort(), ['body', 'computer', 'name', 'roomId', 'size', 'status', 'updatedAt'])
    }
    const none = await w.json(await zoe.api(`/rooms/${room}/handoff?name=web@zoe`, {}, 'web'))
    assert.equal(none.error, 'handoff_not_found')
    assert.equal(none.status, 404)
    const unknown = await w.json(await zoe.api(`/rooms/${room}/handoff?name=nobody@kai`, {}, 'web'))
    assert.equal(unknown.error, 'seat_not_found')
    assert.equal(unknown.next, 'nobody@kai is not a member of this topic.')
    assert.equal((await w.json(await zoe.api(`/rooms/${room}/handoff`, {}, 'web'))).error, 'bad_request', 'no name=')
    assert.equal((await w.json(await zoe.api(`/rooms/${room}/handoff?name=arch`, {}, 'web'))).error, 'bad_request')
    // someone not in the topic reads nothing
    const ann = await w.person('ann')
    assert.equal((await w.json(await ann.api(`/rooms/${room}/handoff?name=arch@kai`, {}, 'x'))).error, 'not_member')
    // an orphan row (no member) is never answered, never shown, never counted
    await w.sql(room, "INSERT INTO handoffs (name, body, size, updated_at) VALUES ('ghost@kai', 'ORPHAN-TEXT', 11, 1)")
    assert.equal((await w.json(await kai.api(`/rooms/${room}/handoff?name=ghost@kai`, {}, 'arch'))).error, 'seat_not_found')
    const members = (await w.json(await kai.api(`/rooms/${room}/members`, {}, 'arch'))).members
    assert.ok(!members.some((m) => m.name === 'ghost@kai'))
    // Member.handoff: never the text
    const arch = members.find((m) => m.name === 'arch@kai')
    assert.deepEqual(Object.keys(arch.handoff).sort(), ['computer', 'size', 'updatedAt'])
    assert.equal(arch.handoff.updatedAt, second.updatedAt)
    assert.equal(members.find((m) => m.name === 'web@zoe').handoff, null)
    assert.equal(members.find((m) => m.name === 'kai').handoff, null)
    assert.equal((await kai.web(`/r/${room}/handoff?name=ghost@kai`).then((r) => r.text())).includes('ORPHAN'), false)
  } finally { await w.dispose() }
})

test('the 2.5 MB sum: per account and topic, counted in the same step as the write', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), zoe = await w.person('zoe')
    const room = await w.topic(kai)
    for (let i = 0; i < 12; i++) await w.join(kai, room, `s${i}`)
    await w.join(zoe, room, 'web')
    assert.equal((await w.json(await w.put(zoe, room, 'web', big(MAX)))).status, 200, "another account's handoff")
    for (let i = 0; i < 10; i++) assert.equal((await w.json(await w.put(kai, room, `s${i}`, big(MAX)))).status, 200, `s${i}`)
    // 10 × 256 KB = 2.5 MB exactly: full. Another seat is refused; an overwrite that keeps the total is stored.
    const full = await w.json(await w.put(kai, room, 's10', 'x'))
    assert.equal(full.error, 'handoff_space_full')
    assert.equal(full.status, 409)
    assert.match(full.next, /2\.5 MB/)
    assert.equal((await w.json(await w.put(kai, room, 's3', big(MAX)))).status, 200, 'the same size again')
    assert.equal((await w.json(await w.put(kai, room, 's3', big(MAX - 100)))).status, 200, 'smaller')
    assert.equal((await w.json(await w.put(kai, room, 's10', big(100)))).status, 200, 'what the smaller one freed')
    assert.equal((await w.json(await w.put(kai, room, 's11', 'x'))).error, 'handoff_space_full')
    // Two seats at once, each fitting alone but not both: exactly one is stored.
    await kai.post(`/r/${room}/handoffDelete`, { name: 's0@kai' })
    await kai.post(`/r/${room}/handoffDelete`, { name: 's10@kai' })
    const both = await Promise.all([w.put(kai, room, 's10', big(200 * KB)), w.put(kai, room, 's11', big(200 * KB))].map((r) => r.then(w.json)))
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409])
    const rows = await w.sql(room, "SELECT name FROM handoffs WHERE name IN ('s10@kai', 's11@kai')")
    assert.equal(rows.length, 1)
  } finally { await w.dispose() }
})

test('the web: page, download, empty state, viewers, passcode and sign-in round trips, cross-site posts, the setting', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), zoe = await w.person('zoe'), ann = await w.person('ann')
    const priv = await w.topic(kai, '234-567-89A')
    const pub = await w.topic(kai, '')
    for (const r of [priv, pub]) await w.join(kai, r, 'arch')
    await w.put(kai, priv, 'arch', '# 交接\n\nT5 done, see #12.\n\n</script><script>alert(1)</script>\n', { 'x-scorpio-computer': 'box' })
    await w.put(kai, pub, 'arch', '# public\n')
    const page = (p, r, name = 'arch@kai', lang = 'zh') => p.web(`/r/${r}/handoff?name=${encodeURIComponent(name)}`, { headers: { cookie: `${p.cookie}; lang=${lang}` } })

    // a member: the page, the bar's words, the frame, Delete for the seat's own person only
    const mine = await page(kai, priv)
    assert.equal(mine.status, 200)
    const html = await mine.text()
    for (const s of ['arch 的交接', '只留最新一份，下次交接会覆盖', '下载 .md', '删除', '主题里能看到聊天的人都能看到这份交接。', 'id="ho-doc"', 'data-fmt="handoff"', '/static/md.js']) assert.ok(html.includes(s), s)
    // the text goes to md.js as data: no tag of it reaches the page, the script element cannot be closed from inside it
    const boot = JSON.parse(/<script type="application\/json" id="ho-boot">([^<]*)<\/script>/.exec(html)[1])
    assert.equal(boot.text, '# 交接\n\nT5 done, see #12.\n\n</script><script>alert(1)</script>\n')
    assert.equal(boot.room, priv)
    assert.ok(!html.includes('<script>alert(1)'))
    // the room page's CSP: no content domain, no inline script
    const csp = mine.headers.get('content-security-policy') || ''
    assert.ok(!csp.includes('content.test'), csp)
    assert.match(csp, /script-src 'self'/)
    // download=1
    const dl = await kai.web(`/r/${priv}/handoff?name=arch%40kai&download=1`)
    assert.equal(dl.status, 200)
    assert.equal(dl.headers.get('content-type'), 'text/markdown; charset=utf-8')
    assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="arch.md"')
    assert.equal(dl.headers.get('cache-control'), 'private, no-store')
    assert.equal(await dl.text(), '# 交接\n\nT5 done, see #12.\n\n</script><script>alert(1)</script>\n')

    // a signed-in viewer of a public topic reads it (and gets no Delete); English words
    const viewer = await page(zoe, pub, 'arch@kai', 'en')
    assert.equal(viewer.status, 200)
    const vh = await viewer.text()
    assert.ok(vh.includes("arch&#39;s handoff") && vh.includes('Download .md') && vh.includes('Everyone who can read this topic can read this handoff.'))
    assert.ok(!vh.includes('id="ho-del"'))
    assert.equal((await zoe.web(`/r/${pub}/handoff?name=arch%40kai&download=1`)).status, 200)

    // a signed-in non-member of a private topic: the passcode form, then back here
    const form = await page(ann, priv)
    const fh = await form.text()
    assert.ok(fh.includes(`action="/r/${priv}/enter"`))
    assert.ok(fh.includes(`name="next" value="/r/${priv}/handoff?name=arch%40kai"`))
    const entered = await ann.web(`/r/${priv}/enter`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, body: `code=234-567-89A&next=${encodeURIComponent(`/r/${priv}/handoff?name=arch%40kai`)}` })
    assert.equal(entered.status, 303)
    assert.equal(entered.headers.get('location'), `/r/${priv}/handoff?name=arch%40kai`)
    assert.equal((await page(ann, priv)).status, 200)
    // a next= elsewhere is not followed
    const away = await ann.web(`/r/${priv}/enter`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, body: `code=234-567-89A&next=${encodeURIComponent('//evil.test/r/x/handoff?name=a@b')}` })
    assert.equal(away.headers.get('location'), `/r/${priv}`)

    // signed out: to sign-in, and back with ?name=
    const out = await w.fetch(`/r/${priv}/handoff?name=arch%40kai`)
    assert.equal(out.status, 303)
    assert.equal(out.headers.get('location'), `/login?next=${encodeURIComponent(`/r/${priv}/handoff?name=arch%40kai`)}`)

    // no handoff, and no such seat: 200 pages that say so
    await w.join(kai, priv, 'impl')
    const none = await page(kai, priv, 'impl@kai')
    assert.equal(none.status, 200)
    const nh = await none.text()
    assert.ok(nh.includes('impl 现在没有云端交接') && nh.includes('可能被删了，或者上次交接没有上云。'))
    assert.ok(!nh.includes('下载 .md'))
    const gone = await page(kai, priv, 'old@kai')
    assert.equal(gone.status, 200)
    assert.ok((await gone.text()).includes('old 已不在这个主题里，它的交接也一起没了。'))
    assert.equal((await kai.web(`/r/${priv}/handoff?name=impl%40kai&download=1`)).status, 303, 'nothing to download: the page')

    // the page's own calls answer JSON errors
    assert.equal((await w.json(await kai.post(`/r/${priv}/handoffDelete`, { name: 'impl@kai' }))).error, 'handoff_not_found')
    assert.equal((await w.json(await kai.post(`/r/${priv}/handoffDelete`, { name: 'old@kai' }))).error, 'seat_not_found')
    // JSON whatever the request's headers say (the route list for errors): the delete, and removeComputer
    for (const [sub, body] of [['handoffDelete', { name: 'old@kai' }], ['removeComputer', { name: 'daemon-9@kai' }]]) {
      const r = await kai.post(`/r/${priv}/${sub}`, body, { 'content-type': 'text/plain', accept: '*/*' })
      assert.match(r.headers.get('content-type'), /^application\/json/, sub)
      assert.ok((await r.json()).error, sub)
    }

    // cross-site posts are refused
    for (const [path, body] of [[`/r/${priv}/handoffDelete`, { name: 'arch@kai' }], ['/settings/handoff', { local: true }]]) {
      const r = await kai.post(path, body, { origin: 'https://evil.test' })
      assert.equal(r.status, 403, path)
    }
    assert.equal((await w.sql(priv, "SELECT COUNT(*) AS n FROM handoffs WHERE name = 'arch@kai'"))[0].n, 1)

    // the setting: 0 after migration 0028, on and off from Settings, shown there
    assert.equal((await w.db.prepare("SELECT handoff_local FROM users WHERE handle = 'zoe'").first()).handoff_local, 0)
    const settings = (lang) => kai.web('/settings', { headers: { cookie: `${kai.cookie}; lang=${lang}` } }).then((r) => r.text())
    assert.ok((await settings('zh')).includes('id="handoff-local" aria-pressed="false"'))
    assert.deepEqual(await w.json(await kai.post('/settings/handoff', { local: true })), { status: 200, local: true })
    assert.equal((await w.db.prepare("SELECT handoff_local FROM users WHERE handle = 'kai'").first()).handoff_local, 1)
    const zh = await settings('zh')
    assert.ok(zh.includes('id="handoff-local" aria-pressed="true"') && zh.includes('交接只存在 agent 的电脑上') && zh.includes('已保存到 Scorpio 的不会删除；要删除，到成员卡上的「交接」操作。'))
    assert.ok((await settings('en')).includes('Keep handoffs on agents&#39; computers'))
    assert.equal((await w.json(await kai.post('/settings/handoff', { local: false }))).local, false)
  } finally { await w.dispose() }
})

test('auto call-back account preference: default on, persisted toggle, page boot, origin and JSON errors', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), zoe = await w.person('zoe')
    const room = await w.topic(kai)
    assert.equal((await w.db.prepare('SELECT auto_call_back FROM users WHERE id = ?').bind(kai.id).first()).auto_call_back, 1)
    const boot = async () => {
      const html = await (await kai.web(`/r/${room}`)).text()
      return JSON.parse(html.match(/<script type="application\/json" id="boot">(.*?)<\/script>/s)[1])
    }
    assert.equal((await boot()).autoCallBack, true)
    for (const on of [false, true]) {
      assert.deepEqual(await w.json(await kai.post('/settings/call-back', { on })), { status: 200, on })
      assert.equal((await boot()).autoCallBack, on)
      const html = await (await kai.web('/settings')).text()
      assert.ok(html.includes(`id="auto-call-back" aria-pressed="${on}"`))
    }
    assert.equal((await w.db.prepare('SELECT auto_call_back FROM users WHERE id = ?').bind(zoe.id).first()).auto_call_back, 1)
    assert.equal((await kai.post('/settings/call-back', { on: false }, { origin: 'https://evil.test' })).status, 403)
    assert.equal((await boot()).autoCallBack, true)
    const invalid = await kai.web('/settings/call-back', { method: 'POST', body: '{' })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error, 'bad_request')
    assert.equal((await w.fetch('/settings/call-back', { method: 'POST', headers: { origin: ORIGIN }, body: '{}' })).status, 401)
  } finally { await w.dispose() }
})

// md.js as the page loads it (a browser script: window.renderMarkdown), for what the handoff page shows.
function mdjs() {
  const ctx = { window: {} }
  vm.runInNewContext(fs.readFileSync(new URL('../../web/public/static/md.js', import.meta.url), 'utf8'), ctx)
  return ctx.window.renderMarkdown
}

test('the page\'s renderer: hostile HTML stays text, #1234 is a message link, a handoff near 256 KB renders in reasonable time', () => {
  const render = mdjs()
  const html = render('# Notes\n\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n[x](javascript:alert(3))\nsee #1234\n', [], '')
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script'))
  assert.ok(!/<img/.test(html) && !html.includes('href="javascript:'))
  assert.match(html, /<a class="ref" href="#m1234" data-jump="1234">#1234<\/a>/, 'handoff-page.js points it at /r/<id>?jump=1234')
  // about 256 KB of what handoffs hold: headings, lists, code, tables, prose with #refs and `code`
  const part = '## T777 done\n\n- step one with `code` and **bold**, see #1234\n- step two [link](https://scorpio.utlabs.ai/r/x)\n\n' +
    '```\n$ npm test\nok 1 - a test line that is long enough to matter\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n' + '这是一段说明文字，记下了做过的决定和理由。'.repeat(8) + '\n\n'
  const text = part.repeat(Math.floor(MAX / Buffer.byteLength(part)))
  assert.ok(Buffer.byteLength(text) > MAX - Buffer.byteLength(part) && Buffer.byteLength(text) <= MAX)
  const timed = (t) => {
    const t0 = process.cpuUsage()
    const out = render(t, [], '')
    const cpu = process.cpuUsage(t0)
    return { out, ms: (cpu.user + cpu.system) / 1000 }
  }
  const r = timed(text)
  assert.ok(r.out.length > text.length / 2)
  assert.ok(r.ms < 1500, `${Math.round(r.ms)} ms`)
  // one long paragraph and one long code block: the cases a line-by-line renderer could choke on
  for (const worst of ['word '.repeat(MAX / 5 - 1), '```\n' + 'x = 1\n'.repeat(MAX / 6 - 2) + '```\n']) {
    const w = timed(worst)
    assert.ok(w.ms < 1500, `${Math.round(w.ms)} ms`)
  }
})

test('deleting: by the seat\'s own person (also left, also archived); not by the topic\'s creator; with the seat; with the topic', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), zoe = await w.person('zoe')
    const room = await w.topic(kai, '')
    await w.join(kai, room, 'arch')
    await w.join(zoe, room, 'web')
    await w.join(zoe, room, 'old')
    await w.put(kai, room, 'arch', 'a')
    await w.put(zoe, room, 'web', 'w')
    await w.put(zoe, room, 'old', 'o')
    // zoe's agents are in; zoe herself is a viewer of this public topic until she joins, and deletes once she has
    assert.equal((await w.json(await zoe.post(`/r/${room}/handoffDelete`, { name: 'web@zoe' }))).error, 'not_member')
    assert.ok(!(await zoe.web(`/r/${room}/handoff?name=web%40zoe`).then((r) => r.text())).includes('id="ho-del"'), 'no Delete for a viewer')
    await zoe.post(`/r/${room}/enter`, {})
    assert.ok((await zoe.web(`/r/${room}/handoff?name=web%40zoe`).then((r) => r.text())).includes('id="ho-del"'))
    // the creator cannot delete another account's
    const refused = await w.json(await kai.post(`/r/${room}/handoffDelete`, { name: 'web@zoe' }))
    assert.equal(refused.error, 'forbidden')
    assert.equal(refused.status, 403)
    // the seat's own person, while the seat has left
    await w.sql(room, "UPDATE members SET status = 'left' WHERE name = 'old@zoe'")
    assert.deepEqual(await w.json(await zoe.post(`/r/${room}/handoffDelete`, { name: 'old@zoe' })), { status: 200, roomId: room, name: 'old@zoe', deleted: true })
    // in an archived topic
    await kai.post(`/r/${room}/archive`, { archived: true })
    assert.equal((await w.json(await kai.post(`/r/${room}/handoffDelete`, { name: 'arch@kai' }))).deleted, true)
    await kai.post(`/r/${room}/archive`, { archived: false })
    const left = await w.sql(room, 'SELECT name FROM handoffs ORDER BY name')
    assert.deepEqual(left.map((r) => r.name), ['web@zoe'])

    // leaving keeps them; removing the account takes them; joining again starts with none
    await w.put(kai, room, 'arch', 'a2')
    assert.equal((await w.json(await zoe.post(`/r/${room}/leave`, {}))).status, 200)
    assert.equal((await w.sql(room, "SELECT COUNT(*) AS n FROM handoffs WHERE name = 'web@zoe'"))[0].n, 1, 'leaveAccount keeps')
    await zoe.post(`/r/${room}/enter`, {})
    assert.equal((await w.json(await kai.post(`/r/${room}/remove`, { account: 'zoe' }))).status, 200)
    assert.equal((await w.sql(room, "SELECT COUNT(*) AS n FROM handoffs WHERE name LIKE '%@zoe'"))[0].n, 0, 'removeAccount takes')
    await w.join(zoe, room, 'web')
    assert.equal((await w.json(await zoe.api(`/rooms/${room}/handoff?name=web@zoe`, {}, 'web'))).error, 'handoff_not_found', 'back without one')
  } finally { await w.dispose() }
})

test('removing a computer: its agents leave and keep their handoffs, read by a takeover on another computer; a deleted account\'s and a purged topic\'s go', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), lee = await w.person('lee')
    const room = await w.topic(kai, '')
    await w.join(kai, room, 'daemon', { host: true })
    const host = (await w.sql(room, "SELECT name FROM members WHERE kind = 'host'"))[0].name
    await w.join(kai, room, 'arch')
    await w.join(kai, room, 'old')
    await w.join(kai, room, 'other')
    // arch and old are this computer's; old has left already; other is another computer's
    await w.sql(room, "UPDATE members SET seat_id = ?, host_id = ? WHERE name IN ('arch@kai', 'old@kai')", [host, host])
    await w.sql(room, "UPDATE members SET seat_id = 'daemon-5@kai' WHERE name = 'other@kai'")
    for (const r of ['arch', 'old', 'other']) await w.put(kai, room, r, `${r} notes`)
    await w.sql(room, "UPDATE members SET status = 'left' WHERE name = 'old@kai'")
    const lastSeq = (await w.sql(room, 'SELECT MAX(seq) AS s FROM messages'))[0].s
    const out = await w.json(await kai.post(`/r/${room}/removeComputer`, { name: host }))
    assert.equal(out.status, 200)
    assert.deepEqual(out.removed, [host])
    assert.deepEqual(out.left.sort(), ['arch@kai', 'old@kai'])
    const rows = await w.sql(room, "SELECT name, status, host_id FROM members WHERE kind != 'human' ORDER BY name")
    assert.deepEqual(rows.map((r) => [r.name, r.status, r.host_id]), [['arch@kai', 'left', null], ['old@kai', 'left', null], ['other@kai', 'active', null]], 'the daemon seat row gone')
    const lines = await w.sql(room, 'SELECT event FROM messages WHERE seq > ?', [lastSeq])
    assert.deepEqual(lines.map((m) => JSON.parse(m.event)), [{ type: 'leave', name: 'arch@kai' }], 'one left line, for the one that was active')
    assert.deepEqual((await w.sql(room, 'SELECT name FROM handoffs ORDER BY name')).map((r) => r.name), ['arch@kai', 'old@kai', 'other@kai'])
    // that computer stays out; the same name taken over on another computer reads its handoff
    const back = await w.json(await kai.api(`/rooms/${room}/join`, { method: 'POST', body: JSON.stringify({ role: 'arch', resume: true }), headers: { 'content-type': 'application/json' } }))
    assert.equal(back.error, 'computer_removed')
    const laptop = await kai.computer('laptop')
    await w.join(laptop, room, 'daemon', { host: true })
    await w.join(laptop, room, 'arch', { resume: true })
    const read = await w.json(await laptop.api(`/rooms/${room}/handoff?name=arch@kai`, {}, 'arch'))
    assert.equal(read.body, 'arch notes')

    // the account deleted: its seats' rows and handoffs; back later without one
    await w.join(lee, room, 'web')
    await w.put(lee, room, 'web', 'w')
    await w.rpc(room, 'accountGone', 'lee')
    assert.equal((await w.sql(room, "SELECT COUNT(*) AS n FROM handoffs WHERE name = 'web@lee'"))[0].n, 0)
    await w.join(lee, room, 'web')
    assert.equal((await w.json(await lee.api(`/rooms/${room}/handoff?name=web@lee`, {}, 'web'))).error, 'handoff_not_found')

    // the topic deleted for good: everything goes
    const files = async () => Promise.all(['account_files', 'storage_usage', 'upload_usage'].map(async (t) => (await w.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n))
    const counts = await files()
    assert.equal((await w.json(await kai.post(`/r/${room}/delete`, {}))).status, 200)
    assert.equal((await w.sql(room, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'handoffs'"))[0].n, 0, 'the table went with the rest')
    assert.deepEqual(await files(), counts)
  } finally { await w.dispose() }
})

test('writing and deleting handoffs leaves the file space, the upload counts and the files alone', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai')
    const room = await w.topic(kai, '')
    await w.join(kai, room, 'arch')
    const state = async () => ({
      d1: await Promise.all(['account_files', 'storage_usage', 'upload_usage', 'file_rooms'].map(async (t) => (await w.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n)),
      files: (await w.sql(room, 'SELECT COUNT(*) AS n FROM files'))[0].n,
      messages: (await w.sql(room, 'SELECT COUNT(*) AS n FROM messages'))[0].n,
    })
    const before = await state()
    await w.put(kai, room, 'arch', big(100 * KB))
    await w.put(kai, room, 'arch', big(200 * KB))
    assert.deepEqual(await state(), before, 'nothing posted in the topic, nothing counted as a file')
    await kai.post(`/r/${room}/handoffDelete`, { name: 'arch@kai' })
    assert.deepEqual(await state(), before)
  } finally { await w.dispose() }
})
