import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
  } }] })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const { RoomDO } = await load('room-do.ts')

test('isPublicRoom requires a live public row and stays false on missing tables', () => {
  const check = (row) => RoomDO.prototype.isPublicRoom.call({ sql: { exec: () => ({ toArray: () => row ? [row] : [] }) } })
  assert.equal(check({ public: 1, deleted_at: null }), true)
  assert.equal(check({ public: 0, deleted_at: null }), false)
  assert.equal(check({ public: 1, deleted_at: 12 }), false)
  assert.equal(check(null), false)
  assert.equal(RoomDO.prototype.isPublicRoom.call({ sql: { exec: () => { throw Error('no table') } } }), false)
})

test('writeSnapshot keeps the public KV object, message order, display and live files exactly', async () => {
  const calls = []
  const puts = []
  let messagesQuery = ''
  const newestFirst = [
    { seq: 2, from_name: 'bot@ana', from_kind: 'agent', text: 'second', files: null, ts: 20 },
    { seq: 1, from_name: 'ana', from_kind: 'human', text: 'first', files: JSON.stringify([{ name: 'a.png', size: 3 }, { name: 'old.txt', size: 4, deleted: 10 }]), ts: 10 },
  ]
  const room = {
    isPublicRoom: () => true,
    room: () => ({ id: 'room-1', name: 'The room', topic: 'Hello', archived_at: null }),
    lastSeq: () => 9,
    env: { KV: { get: async (...args) => { calls.push(['get', ...args]); return '2' }, put: async (...args) => { calls.push(['put', ...args]) } } },
    ctx: { storage: { kv: { put: (...args) => puts.push(args) } } },
    sql: { exec: (sql, ...args) => {
      if (sql.startsWith('SELECT seq,')) { messagesQuery = sql; calls.push(['sql', ...args]); return { toArray: () => newestFirst } }
      if (sql.startsWith('SELECT name,')) return { toArray: () => [{ name: 'ana', display_name: 'Ana' }] }
      throw Error(`unexpected SQL: ${sql}`)
    } },
  }
  await RoomDO.prototype.writeSnapshot.call(room)
  assert.deepEqual(calls[0], ['get', 'config:public_snapshot', { cacheTtl: 300 }])
  assert.deepEqual(calls[1], ['sql', 2])
  assert.match(messagesQuery, /\bscheduled\b/)
  assert.deepEqual(JSON.parse(calls[2][2]), {
    name: 'The room', topic: 'Hello', archived: false, total: 9,
    messages: [
      { seq: 1, from: 'ana', display: 'Ana', fromKind: 'human', text: 'first', files: [{ name: 'a.png', size: 3 }], ts: 10 },
      { seq: 2, from: 'bot@ana', fromKind: 'agent', text: 'second', files: [], ts: 20 },
    ],
  })
  assert.deepEqual(calls[2].slice(0, 2), ['put', 'public:room-1'])
  assert.deepEqual(puts, [['publicSnap', 1]])
})

const snapshot = await load('room-snapshot.ts')

test('isPublic requires a live public row', () => {
  assert.equal(snapshot.isPublic({ public: 1, deleted_at: null }), true)
  assert.equal(snapshot.isPublic({ public: 0, deleted_at: null }), false)
  assert.equal(snapshot.isPublic({ public: 1, deleted_at: 12 }), false)
  assert.equal(snapshot.isPublic(undefined), false)
})

test('snapshotOf reproduces every visitor field, message order and live file', () => {
  const room = { name: 'The room', topic: 'Hello', archived_at: null }
  const members = [{ name: 'ana', display_name: 'Ana' }]
  const messages = [
    { seq: 1, from_name: 'ana', from_kind: 'human', text: 'first', files: JSON.stringify([{ name: 'a.png', size: 3 }, { name: 'old.txt', size: 4, deleted: 10 }]), ts: 10 },
    { seq: 2, from_name: 'bot@ana', from_kind: 'agent', text: 'second', files: null, ts: 20 },
  ]
  assert.deepEqual(snapshot.snapshotOf(room, members, messages, 9), {
    name: 'The room', topic: 'Hello', archived: false, total: 9,
    messages: [
      { seq: 1, from: 'ana', display: 'Ana', fromKind: 'human', text: 'first', files: [{ name: 'a.png', size: 3 }], ts: 10 },
      { seq: 2, from: 'bot@ana', fromKind: 'agent', text: 'second', files: [], ts: 20 },
    ],
  })
  assert.equal(snapshot.snapshotOf({ ...room, archived_at: 50 }, members, [], 9).archived, true)
})

test('public snapshot retains scheduled attribution on a posted message', () => {
  const scheduled = { id: 'S3', by: 'coach@ana', at: 10 }
  const result = snapshot.snapshotOf({ name: 'Room', topic: '', archived_at: null }, [], [
    { seq: 1, from_name: 'scheduled', from_kind: 'scheduled', text: '@ana hello', files: null, scheduled: JSON.stringify(scheduled), ts: 20 },
  ], 1)
  assert.deepEqual(result.messages[0].scheduled, scheduled)
  assert.equal(result.messages[0].fromKind, 'scheduled')
})

test('public snapshot shows a plain multiline topic and a one-line plain meta description', async () => {
  const { snapshotPage } = await load('snapshot-page.ts')
  const topic = '\n## 标题\n\n\n- 第一项 `code`\n- 第二项 *强调*\n| 字段 | 值 |\n| --- | --- |\n| 示例 | 中文 |\n\n> 说明 & <safe>\n[链接](https://scorpio.utlabs.ai/path)\n'
  const response = snapshotPage('zh', 'https://scorpio.utlabs.ai', 'room-1', {
    name: '主题', topic, archived: false, total: 0, messages: [],
  })
  const html = await response.text()
  assert.match(html, /<meta property="og:description" content="标题">/)
  assert.match(html, /<meta name="description" content="标题">/)
  assert.match(html, /<p class="sx-intro">标题\n\n第一项 code\n第二项 强调\n\| 字段 \| 值 \|\n\| 示例 \| 中文 \|\n\n说明 &amp; &lt;safe\n链接<\/p>/)
  assert.doesNotMatch(html, /<p class="sx-intro">\s*##/)
  assert.doesNotMatch(html, /\| --- \| --- \|/)
})

const { Snapshot: SnapshotDomain } = await load('room/snapshot.ts')

function cleanupHarness({ deleteFailures = 0, indexFailures = 0, written = true } = {}) {
  const saved = new Map(written ? [['publicSnap', 1]] : [])
  const waited = [], errors = []
  const state = { public: true, kvExists: written, visibility: 'link', deletes: 0, indexWrites: 0 }
  const domain = new SnapshotDomain({
    ctx: () => ({ storage: { kv: { get: (k) => saved.get(k), put: (k, v) => saved.set(k, v), delete: (k) => saved.delete(k) } }, waitUntil: (p) => waited.push(p) }),
    env: () => ({
      KV: { delete: async () => { state.deletes++; if (deleteFailures-- > 0) throw Error('KV unavailable'); state.kvExists = false } },
      DB: { prepare: () => ({ bind: (visibility) => ({ run: async () => { state.indexWrites++; if (indexFailures-- > 0) throw Error('D1 unavailable'); state.visibility = visibility } }) }) },
    }),
    schedule: async (k, delay) => { if (!saved.has(k)) saved.set(k, Date.now() + delay) },
    room: { isPublic: () => state.public, idOrNull: () => 'room-1' },
  })
  return { domain, saved, state, errors, flush: async () => { while (waited.length) await waited.shift() } }
}

test('failed snapshot deletion retains its marker and the alarm retries KV and the private index', async (t) => {
  t.mock.method(console, 'error', () => {})
  const h = cleanupHarness({ deleteFailures: 2, indexFailures: 1 })
  h.state.public = false
  h.domain.publicChanged()
  await h.flush()
  assert.equal(h.state.kvExists, true)
  assert.equal(h.saved.get('publicSnap'), 1, 'failed delete must retain its marker')
  h.domain.madePrivate()
  assert.ok(Number.isFinite(h.domain.nextDue()))
  await h.domain.alarm(h.domain.nextDue())
  assert.equal(h.state.kvExists, true)
  assert.equal(h.state.visibility, 'link')
  assert.ok(Number.isFinite(h.domain.nextDue()), 'both failures leave due work')
  await h.domain.alarm(h.domain.nextDue())
  assert.equal(h.state.kvExists, false)
  assert.equal(h.state.visibility, 'private')
  assert.equal(h.saved.has('publicSnap'), false)
  assert.equal(h.domain.nextDue(), Infinity, 'successful cleanup stops waking the topic')
  assert.ok(console.error.mock.calls.some(({ arguments: args }) => args[0].includes('KV unavailable')))
  assert.ok(console.error.mock.calls.some(({ arguments: args }) => args[0].includes('D1 unavailable')))
})

test('making a topic private before its first snapshot still repairs D1 on the alarm', async () => {
  const h = cleanupHarness({ written: false })
  h.state.public = false
  h.domain.madePrivate()
  h.domain.publicChanged()
  await h.flush()
  await h.domain.alarm(h.domain.nextDue())
  assert.equal(h.state.visibility, 'private')
  assert.equal(h.domain.nextDue(), Infinity)
})

test('a private cleanup interrupted by a restart is rearmed, but an ordinary private topic is idle', async () => {
  const pending = cleanupHarness()
  pending.state.public = false
  await pending.domain.wake()
  assert.ok(Number.isFinite(pending.domain.nextDue()))
  const idle = cleanupHarness({ written: false })
  idle.state.public = false
  await idle.domain.wake()
  assert.equal(idle.domain.nextDue(), Infinity)
  assert.equal(idle.state.deletes, 0)
  assert.equal(idle.state.indexWrites, 0)
})
