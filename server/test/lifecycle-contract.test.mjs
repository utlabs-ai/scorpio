import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { worker, ORIGIN } from './helpers/worker.mjs'

// The lifecycle contract (split by domain, S7): what leaving, removing, deleting an account, removing a computer,
// archiving, deleting a topic, the retention clock and a plan lapse answer, what they put on every socket (frames, then
// the close), and what the tables hold afterwards. Recorded once on the code from before members and presence left
// RoomDO; moving them (S7a) and the lifecycle operations (S7b) change neither this file nor its golden.
// RECORD_LIFECYCLE_GOLDEN=1 is only for that first recording.
const golden = new URL('./lifecycle-contract.golden.json', import.meta.url)

// testSql and testKv read what a case left (testSql cannot read kv); test:plan swaps only the plan, so a lapse can be
// forced while the limits stay those of today's plan.
const append = `
export class TestRoom extends RoomDO {
  async testSql(query, args) { const c = this.ctx.storage.sql.exec(query, ...args); return /^\\s*SELECT/i.test(query) ? c.toArray() : { rowsWritten: c.rowsWritten }; }
  async testFlag(k, v) { if (v) this.ctx.storage.kv.put(k, v); else this.ctx.storage.kv.delete(k); }
  async testKv(k) { return this.ctx.storage.kv.get(k) ?? null; }
  async ownerLimits() { const plan = this.ctx.storage.kv.get('test:plan'); return plan ? { ...await super.ownerLimits(), plan } : super.ownerLimits(); }
}`
// Private topics, as in the send contract: a public one arms its snapshot on every message. Case 5 is public.
const CODE = 'XK7-9QD-4M2'
const DUE = ['roomFrameDue', 'itemsDue', 'publicDue']
const KAI = { kind: 'human', account: 'kai', name: 'kai' }
const timeKey = (k) => /^(ts|at|ms|since)$/.test(k) || /(At|Ms|Since|Active)$/.test(k) || /_(at|ms|ts|since|active)$/.test(k)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(ok, ms) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await sleep(20)
  return ok()
}
async function json(res) {
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
}
async function ok(request, what) {
  const r = await json(await request)
  assert.equal(r.status, 200, `${what}: ${JSON.stringify(r)}`)
  return r.body
}

// A socket the test reads: its frames, and its close. The client answers the server's close frame by itself, so the
// server's webSocketClose runs (once or twice); the close event itself reaches the test only when Miniflare stops, so
// closes are read after the case's worker is disposed. 1006 then means the socket was still open: null.
async function socket(res) {
  assert.equal(res.status, 101, await res.text().catch(() => ''))
  const s = { frames: [], close: undefined, ws: res.webSocket }
  res.webSocket.addEventListener('message', (e) => { try { s.frames.push(JSON.parse(e.data)) } catch {} })
  res.webSocket.addEventListener('close', (e) => { s.close ??= e.code === 1006 ? null : [e.code, e.reason] })
  res.webSocket.accept()
  return s
}

// Whether a close reaches webSocketClose once or twice moves presence frames after it: observers' consecutive members
// frames count as the last of them, and a daemon's consecutive room frames as the last of those.
function collapse(frames, host) {
  const out = []
  for (const f of frames) {
    const last = out.at(-1)
    if (last && last.type === f.type && (f.type === 'members' || (host && f.type === 'room'))) out[out.length - 1] = f
    else out.push(f)
  }
  return out
}

// Topic ids become placeholders; time columns and keys become 0 (null stays null).
function normalizer(placeholders) {
  const norm = (value) => {
    if (Array.isArray(value)) return value.map(norm)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'born_seq').map(([k, v]) => [k, timeKey(k) && typeof v === 'number' ? 0 : norm(v)]))
    }
    if (typeof value === 'string') {
      let s = value
      for (const [id, label] of placeholders) s = s.split(id).join(label)
      return s
    }
    return value
  }
  return norm
}

// One line per frame and per row in the golden file, so a diff points at the frame or the row.
function pretty(v, depth = 0) {
  const flat = (x) => x === null || typeof x !== 'object' || (!Array.isArray(x) && (typeof x.type === 'string' || Object.values(x).every((y) => y === null || typeof y !== 'object')))
  if (flat(v) || (Array.isArray(v) && !v.length)) return JSON.stringify(v)
  const pad = '  '.repeat(depth + 1)
  const end = '  '.repeat(depth)
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + pretty(x, depth + 1)).join(',\n')}\n${end}]`
  return `{\n${Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pretty(x, depth + 1)}`).join(',\n')}\n${end}}`
}

// Nothing left to come from the alarm: the delayed room frame, the todo frame, the snapshot (written, in a public
// topic). Checked twice, a moment apart, so a frame on its way or a close being handled is not missed.
async function settle(t) {
  const end = Date.now() + 30_000
  let quiet = 0
  while (quiet < 2 && Date.now() < end) {
    await sleep(400)
    const due = await Promise.all(DUE.map((k) => t.stub.testKv(k)))
    const snap = !t.public || (await t.stub.testKv('publicSnap')) != null
    quiet = due.every((v) => v == null) && snap ? quiet + 1 : 0
  }
}

// The cast, in a topic of its own on a worker of its own: kai (its creator) and lee, each with a page open; helper@lee
// on its own socket; api@kai and old@kai carried by kai's daemon seat; T1 doing under helper@lee, T2 todo under lee; a
// schedule each by lee and kai (the plan is self: no PLANS binding); a handoff for helper@lee.
async function cast(w, code) {
  const kai = await w.person('kai'), lee = await w.person('lee')
  const room = await w.topic(kai, code)
  const ns = await w.mf.getDurableObjectNamespace('ROOMS')
  const stub = ns.get(ns.idFromName(room))
  await ok(lee.post(`/r/${room}/enter`, code ? { code } : {}), 'lee enters')
  for (const [p, role] of [[kai, 'api'], [kai, 'old'], [lee, 'helper']]) assert.equal((await w.join(p, room, role)).status, 200)
  await ok(kai.apiPost(`/rooms/${room}/join`, { host: true }), 'daemon seat joins')
  const seat = (await stub.testSql("SELECT name FROM members WHERE kind = 'host'", []))[0].name
  const page = (p) => p.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } })
  const sockets = {
    kai: await socket(await page(kai)),
    lee: await socket(await page(lee)),
    helper: await socket(await lee.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, 'helper')),
    daemon: await socket(await kai.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, seat.split('@')[0])),
  }
  sockets.daemon.ws.send(JSON.stringify({ type: 'carry', names: ['api@kai', 'old@kai'] }))
  assert.ok(await until(() => sockets.daemon.frames.some((f) => f.type === 'carried'), 10_000), 'carried')
  const api = (sub, body) => kai.apiPost(`/rooms/${room}/${sub}`, body, 'api')
  const helper = (sub, body) => lee.apiPost(`/rooms/${room}/${sub}`, body, 'helper')
  const kick = await ok(api('send', { text: '@lee Kick-off for the lifecycle case.' }), 'kick-off')
  await ok(helper('todo', { op: 'add', title: 'Check the logs', to: 'helper@lee', from: kick.seq }), 'T1')
  await ok(helper('todo', { op: 'take', id: 'T1' }), 'T1 taken')
  await ok(api('send', { text: '@lee Please check the copy.', add: 'Check the copy', to: 'lee' }), 'T2')
  await ok(lee.post(`/r/${room}/schedules`, { op: 'add', text: 'Weekly notes', rule: { kind: 'once', at: Date.UTC(2030, 0, 1, 9) } }), 'lee schedule')
  await ok(kai.post(`/r/${room}/schedules`, { op: 'add', text: 'Monthly review', rule: { kind: 'once', at: Date.UTC(2030, 1, 1, 9) } }), 'kai schedule')
  await ok(lee.api(`/rooms/${room}/handoff`, { method: 'PUT', body: '# helper notes\n', headers: { 'content-type': 'text/markdown; charset=utf-8' } }, 'helper'), 'handoff')
  const t = { kai, lee, room, stub, seat, sockets, public: !code }
  await settle(t)
  return t
}

// The rows after a case.
async function rows(t, since) {
  const q = (query, args = []) => t.stub.testSql(query, args)
  return {
    members: await q('SELECT * FROM members ORDER BY name'),
    removed_computers: await q('SELECT * FROM removed_computers ORDER BY name'),
    items: await q('SELECT n, status, assignee FROM items ORDER BY n'),
    item_log: await q('SELECT * FROM item_log WHERE id > ? ORDER BY id', [since.log]),
    schedules: await q('SELECT * FROM schedules ORDER BY n'),
    handoffs: (await q('SELECT name FROM handoffs ORDER BY name')).map((r) => r.name),
    room: (await q('SELECT archived_at, archived_reason, deleted_at, public FROM room'))[0],
    messages: await q('SELECT from_kind, text, event FROM messages WHERE seq > ? ORDER BY seq', [since.seq]),
    kv: { roomFrameDue: (await t.stub.testKv('roomFrameDue')) != null, publicSnap: (await t.stub.testKv('publicSnap')) != null },
  }
}

/**
 * One case: the cast, what `before` adds to it, then the recording. Each step is its answer and, per socket of the
 * case, the frames it brought; then each socket's close and the rows. `before` may take sockets out of the case.
 */
async function run(name, { code = CODE, before, steps }) {
  const w = await worker({}, { append, className: 'TestRoom' })
  let t, out
  try {
    t = await cast(w, code)
    if (before) await before(t)
    await settle(t)
    const since = {
      seq: (await t.stub.testSql('SELECT COALESCE(MAX(seq), 0) AS s FROM messages', []))[0].s,
      log: (await t.stub.testSql('SELECT COALESCE(MAX(id), 0) AS id FROM item_log', []))[0].id,
    }
    const done = []
    for (const [call, request] of steps(t)) {
      for (const s of Object.values(t.sockets)) s.frames.length = 0
      const r = await request()
      const answer = typeof r?.text === 'function' ? await json(r) : (r ?? null)
      await sleep(1000)
      await settle(t)
      done.push({ call, answer, frames: Object.fromEntries(Object.entries(t.sockets).map(([n, s]) => [n, collapse(s.frames, n === 'daemon')])) })
    }
    // A copy: what the runtime answered cannot be read once the worker is disposed.
    out = JSON.parse(JSON.stringify({ case: name, steps: done, rows: await rows(t, since) }))
  } finally {
    await w.dispose()
  }
  await until(() => Object.values(t.sockets).every((s) => s.close !== undefined), 10_000)
  out.closes = Object.fromEntries(Object.entries(t.sockets).map(([n, s]) => [n, s.close ?? null]))
  return normalizer(new Map([[t.room, '<topic>']]))(out)
}

const web = (p, t, sub, body) => () => p.post(`/r/${t.room}/${sub}`, body)

test('leaving, removing, archiving, deleting and a plan lapse keep their answers, frames, closes and rows', async () => {
  const records = []

  // 1. An agent leaves on its own; its doing task goes back to todo, its handoff stays.
  records.push(await run('1 leave helper@lee', { steps: (t) => [['helper@lee leaves', () => t.lee.apiPost(`/rooms/${t.room}/leave`, {}, 'helper')]] }))

  // 2. A carried agent leaves: no socket of its own, its daemon still holds it.
  records.push(await run('2 leave carried api@kai', { steps: (t) => [['api@kai leaves', () => t.kai.apiPost(`/rooms/${t.room}/leave`, {}, 'api')]] }))

  // 3. A person leaves on the web, their agent with them; the daemons' delayed room frame is waited for.
  records.push(await run('3 leaveAccount lee', { steps: (t) => [['lee leaves on the web', web(t.lee, t, 'leave', {})]] }))

  // 4. The creator asks lee to leave, after the two refusals.
  records.push(await run('4 removeAccount lee', { steps: (t) => [
    ['kai removes kai', web(t.kai, t, 'remove', { account: 'kai' })],
    ['kai removes zoe, who has nobody here', web(t.kai, t, 'remove', { account: 'zoe' })],
    ['kai removes lee', web(t.kai, t, 'remove', { account: 'lee' })],
  ] }))

  // 5. lee's account is deleted while lee, who left this public topic, watches it as a viewer.
  records.push(await run('5 accountGone lee, a viewer', {
    code: '',
    before: async (t) => {
      await ok(t.lee.post(`/r/${t.room}/leave`, {}), 'lee leaves')
      delete t.sockets.lee
      delete t.sockets.helper
      t.sockets.viewer = await socket(await t.lee.web(`/r/${t.room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } }))
    },
    steps: (t) => [['accountGone lee', () => t.stub.accountGone('lee')]],
  }))

  // 6. kai removes the daemon's computer, after lee is refused.
  records.push(await run('6 removeOwnComputer', { steps: (t) => [
    ['lee removes kai\'s computer', web(t.lee, t, 'removeComputer', { name: t.seat })],
    ['kai removes the computer', web(t.kai, t, 'removeComputer', { name: t.seat })],
  ] }))

  // 7. Archived and restored by its creator, by a plan lapse, and archived by the retention clock.
  records.push(await run('7 archive and restore', { steps: (t) => [
    ['kai archives', web(t.kai, t, 'archive', { archived: true })],
    ['kai restores', web(t.kai, t, 'archive', { archived: false })],
    ['planArchive true', () => t.stub.planArchive(true, 'downgrade')],
    ['planArchive false', () => t.stub.planArchive(false, 'downgrade')],
    ['quietArchive', () => t.stub.quietArchive(Date.now() + 60_000)],
  ] }))

  // 8. Deleted by its creator (the RPC: the HTTP route purges the storage too); then, in another topic archived first,
  // marked for purging by the retention clock with a cutoff after the archive.
  records.push(await run('8a deleteRoom', { steps: (t) => [['deleteRoom', () => t.stub.deleteRoom(KAI)]] }))
  records.push(await run('8b retentionPurge', {
    before: (t) => ok(t.kai.post(`/r/${t.room}/archive`, { archived: true }), 'archived first'),
    steps: (t) => [['retentionPurge', () => t.stub.retentionPurge(Date.now() + 1000)]],
  }))

  // 9. The owner's plan lapses to free.
  records.push(await run('9 planChanged to free', {
    before: (t) => t.stub.testFlag('test:plan', 'free'),
    steps: (t) => [['planChanged', () => t.stub.planChanged()]],
  }))

  if (process.env.RECORD_LIFECYCLE_GOLDEN === '1') fs.writeFileSync(golden, `${pretty(records)}\n`)
  assert.deepEqual(records, JSON.parse(fs.readFileSync(golden, 'utf8')))
})
