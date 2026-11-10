import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { worker } from './helpers/worker.mjs'

// Exporting a topic as a zip (docs/api/export.md), through the whole Worker on Miniflare: the agent route and the web
// route, the parameters, the refusals before the first byte, and the zip itself, opened with a reference reader
// (Python's zipfile, which checks every CRC).

/** The zip's entries and their text, checked by Python. */
function unzip(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-export-'))
  const file = path.join(dir, 'x.zip')
  fs.writeFileSync(file, bytes)
  const out = execFileSync('python3', ['-I', '-c', `
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "entries": {i.filename: z.read(i).decode("utf-8", "replace") for i in z.infolist()}}))
`, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  fs.rmSync(dir, { recursive: true, force: true })
  const z = JSON.parse(out)
  assert.equal(z.bad, null, 'a CRC failed')
  return z.entries
}
const names = (entries) => Object.keys(entries).sort()
const expectError = async (res, status, error) => {
  const body = await res.json()
  assert.equal(res.status, status, JSON.stringify(body))
  assert.equal(body.error, error)
  return body
}

/** A topic with one of everything: messages (a reply, buttons pressed, a card, a schedule's message), a task, a file, a handoff, a schedule, memos. */
async function fixture(w) {
  const kai = await w.person('kai')
  const room = await w.topic(kai)
  await w.join(kai, room, 'api')
  const api = (path, init, role = 'api') => kai.api(path, init, role)
  const post = async (path, body, role = 'api') => w.json(await kai.apiPost(path, body, role))
  const first = await post(`/rooms/${room}/send`, { text: '@kai hello from api', add: 'Write the export', to: 'api@kai' })
  assert.ok(first.seq, JSON.stringify(first))
  const task = first.item.id
  const upload = await w.json(await kai.web(`/r/${room}/files`, { method: 'POST', body: '# Notes\nline', headers: { 'content-type': 'text/markdown', 'x-file-name': 'notes 1/2.md' } }))
  assert.ok(upload.id, JSON.stringify(upload))
  const withFile = await w.json(await kai.post(`/r/${room}/send`, { text: 'the notes', files: [upload.id] }))
  assert.ok(withFile.seq, JSON.stringify(withFile))
  const asked = await post(`/rooms/${room}/send`, { text: '@kai pick one', replyTo: first.seq, buttons: ['Yes', 'No'], card: { kind: 'html', summary: 'Revenue 610', html: '<p>x</p>' } })
  assert.ok(asked.seq, JSON.stringify(asked))
  const pressed = await w.json(await kai.post(`/r/${room}/press`, { seq: asked.seq, index: 0 }))
  assert.equal(pressed.status, 200, JSON.stringify(pressed))
  const delivered = await post(`/rooms/${room}/send`, { text: '@kai done', done: task })
  assert.ok(delivered.seq, JSON.stringify(delivered))
  const handoff = await w.json(await api(`/rooms/${room}/handoff`, { method: 'PUT', body: '# Where things stand\n\nAll done.\n', headers: { 'content-type': 'text/markdown; charset=utf-8', 'x-scorpio-computer': 'box' } }))
  assert.equal(handoff.status, 200, JSON.stringify(handoff))
  const schedule = await post(`/rooms/${room}/schedules`, { op: 'add', text: '@kai daily check', rule: { kind: 'daily', time: '09:00', tz: 'Asia/Shanghai' }, calendar: true })
  assert.ok(schedule.item, JSON.stringify(schedule))
  const memo = await post(`/rooms/${room}/memo`, { op: 'add', text: 'The export reads messages twice', from: `#${first.seq}` })
  assert.equal(memo.status, 200, JSON.stringify(memo))
  const long = await post(`/rooms/${room}/memo`, { op: 'long', slot: 'L1', version: 0, text: 'First principles of the test topic' })
  assert.equal(long.status, 200, JSON.stringify(long))
  return { kai, room, task, fileId: upload.id, seqs: { first: first.seq, file: withFile.seq, asked: asked.seq } }
}

test('export', async (t) => {
  const w = await worker({ TEST_LIMITS: JSON.stringify({ self: { msgsPerRoomMinute: 1000 } }) })
  t.after(() => w.dispose())
  const { kai, room, task, fileId, seqs } = await fixture(w)
  const api = (q = '', role = 'api') => kai.api(`/rooms/${room}/export${q}`, {}, role)

  await t.test('parameters are checked before anything is read', async () => {
    await expectError(await api('?include=messages,photos'), 400, 'bad_request')
    await expectError(await api('?tz=Mars/Olympus'), 400, 'bad_request')
    await expectError(await api('', 'ghost'), 403, 'not_member')
  })

  await t.test('dry=1 answers the counts and takes no lock', async () => {
    const dry = await w.json(await api('?dry=1'))
    assert.deepEqual(dry, { status: 200, roomId: room, include: ['messages', 'tasks', 'files', 'handoffs', 'memo'], counts: { messages: dry.counts.messages, files: 1, bytes: 12 } })
    assert.ok(dry.counts.messages >= 5)
    const again = await w.json(await api('?dry=1&include=messages'))
    assert.deepEqual([again.include, again.counts.files], [['messages'], 0])
    assert.equal((await w.kv.get(`export:${kai.id}`)), null)
  })

  let full
  await t.test('the whole topic, as the agent downloads it', async () => {
    const res = await api('?tz=Asia/Shanghai')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/zip')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const base = `Route test topic-${date}`
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${base}.zip"; filename*=UTF-8''${encodeURIComponent(`${base}.zip`)}`)
    full = unzip(Buffer.from(await res.arrayBuffer()))
    assert.deepEqual(names(full), [`${base}/data.json`, `${base}/files/${fileId}-notes 1_2.md`, `${base}/handoffs/api@kai.md`, `${base}/topic.md`])
    assert.equal(full[`${base}/files/${fileId}-notes 1_2.md`], '# Notes\nline')
    assert.equal(full[`${base}/handoffs/api@kai.md`], '# Where things stand\n\nAll done.\n')
    const md = full[`${base}/topic.md`]
    // One line of each kind, English labels on the API.
    assert.match(md, /^# Route test topic\n/)
    assert.match(md, /^- Exported at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Asia\/Shanghai\)$/m)
    assert.match(md, /^- Exported by: api@kai$/m)
    assert.match(md, /^- Includes: messages, tasks, files, handoffs, memo$/m)
    assert.match(md, /^- kai · person · present$/m)
    assert.match(md, /^- api@kai · agent · present$/m)
    assert.match(md, new RegExp(`^#${seqs.first} · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} · api@kai\\n@kai hello from api$`, 'm'))
    assert.match(md, new RegExp(`^↩ #${seqs.first} \\(api@kai\\)$`, 'm'))
    assert.match(md, new RegExp(`^Attachment: notes 1_2.md \\(12 B\\) → files/${fileId}-notes 1_2.md$`, 'm'))
    assert.match(md, /^Card: Revenue 610$/m)
    assert.match(md, /^Buttons: Yes \(kai\), No$/m)
    assert.match(md, new RegExp(`^### ${task} · Write the export · delivered · api@kai · api@kai · Opened #${seqs.first} · Delivered #\\d+$`, 'm'))
    assert.match(md, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · api@kai · add/m)
    assert.match(md, /^- S1 · every day 09:00 · Asia\/Shanghai · @kai · @kai daily check · In calendar · Status: On · Set by: api@kai$/m)
    assert.match(md, /^### L1 · v1 · api@kai\n\nFirst principles of the test topic$/m)
    assert.match(md, /^- M1 · api@kai · #\d+ · The export reads messages twice$/m)
    assert.match(md, /^- api@kai · Body in handoffs\/api@kai.md$/m)
    assert.doesNotMatch(md, /screen/)
    // data.json is the API's own shapes.
    const data = JSON.parse(full[`${base}/data.json`])
    assert.deepEqual(Object.keys(data).sort(), ['exportedAt', 'exportedBy', 'handoffs', 'include', 'members', 'memo', 'messages', 'schedules', 'tasks', 'topic', 'tz'])
    assert.deepEqual([data.exportedBy, data.tz, data.include, data.topic.roomId, data.topic.status, data.topic.owner, data.topic.public], ['api@kai', 'Asia/Shanghai', ['messages', 'tasks', 'files', 'handoffs', 'memo'], room, 'active', 'kai', true]) // no passcode: a public topic
    assert.deepEqual(data.handoffs, [{ name: 'api@kai', computer: null, size: 32, updatedAt: data.handoffs[0].updatedAt, path: 'handoffs/api@kai.md' }])
    const members = await w.json(await kai.api(`/rooms/${room}/members`, {}, 'api'))
    const timeless = (list) => list.map(({ lastActive, online, ...m }) => m)
    assert.deepEqual(timeless(data.members), timeless(members.members))
    const messages = await w.json(await kai.api(`/rooms/${room}/messages?order=asc&limit=100`, {}, 'api'))
    assert.deepEqual(data.messages, messages.messages)
    assert.ok(data.messages.every((m) => !('screen' in m)))
    const shown = await w.json(await kai.api(`/rooms/${room}/todo/${task}`, {}, 'api'))
    const { roomId: _r, status: _s, ...body } = shown
    assert.deepEqual(data.tasks, [body]) // GET /todo/<id> without roomId: item, source, history; never the thread's messages
    const schedules = await w.json(await kai.api(`/rooms/${room}/schedules`, {}, 'api'))
    assert.deepEqual(data.schedules, schedules.items)
    const memo = await w.json(await kai.api(`/rooms/${room}/memo`, {}, 'api'))
    const { roomId: _m, status: _t, ...memoBody } = memo
    assert.deepEqual(data.memo, memoBody)
    assert.equal(await w.kv.get(`export:${kai.id}`), null, 'the lock is released')
  })

  await t.test('without files: links instead of paths, no files/; messages only: only topic, members and messages', async () => {
    const res = await api('?include=messages,tasks,handoffs,memo')
    assert.equal(res.status, 200)
    const z = unzip(Buffer.from(await res.arrayBuffer()))
    const base = names(z)[0].split('/')[0]
    assert.deepEqual(names(z), [`${base}/data.json`, `${base}/handoffs/api@kai.md`, `${base}/topic.md`])
    assert.match(z[`${base}/topic.md`], new RegExp(`^Attachment: notes 1_2.md \\(12 B\\) → https://scorpio.test/v/${fileId}$`, 'm'))
    const only = await api('?include=messages')
    const o = unzip(Buffer.from(await only.arrayBuffer()))
    assert.deepEqual(names(o), [`${base}/data.json`, `${base}/topic.md`])
    const data = JSON.parse(o[`${base}/data.json`])
    assert.deepEqual(Object.keys(data).sort(), ['exportedAt', 'exportedBy', 'include', 'members', 'messages', 'topic', 'tz'])
    assert.doesNotMatch(o[`${base}/topic.md`], /^## Tasks$/m)
  })

  await t.test('the web route: the session, the page language, the same zip', async () => {
    const res = await kai.web(`/r/${room}/export?tz=UTC`, { headers: { cookie: `${kai.cookie}; lang=zh` } })
    assert.equal(res.status, 200)
    const z = unzip(Buffer.from(await res.arrayBuffer()))
    const base = names(z)[0].split('/')[0]
    const md = z[`${base}/topic.md`]
    assert.match(md, /^- 导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（UTC）$/m)
    assert.match(md, /^- 导出者：kai$/m)
    assert.match(md, /^- kai · 人 · 在场$/m)
    assert.match(md, /^## 消息$/m)
    assert.match(md, new RegExp(`^↩ #${seqs.first}（api@kai）$`, 'm'))
    assert.match(md, new RegExp(`^附件：notes 1_2.md（12 B）→ files/${fileId}-notes 1_2.md$`, 'm'))
    assert.match(md, /^按钮：Yes（kai）、No$/m)
    assert.match(md, /^### L1 · v1 · api@kai$/m)
    const dry = await w.json(await kai.web(`/r/${room}/export?dry=1&include=files`))
    assert.deepEqual([dry.status, dry.counts], [200, { messages: dry.counts.messages, files: 1, bytes: 12 }])
    assert.equal(JSON.parse(z[`${base}/data.json`]).exportedBy, 'kai')
  })

  await t.test('while the account has an export streaming, another is export_busy; the lease goes with the stream', async () => {
    // The lease as a streaming export leaves it (the small zips here finish before a second request could race them).
    await w.kv.put(`export:${kai.id}`, String(Date.now()), { expirationTtl: 120 })
    await expectError(await api('?dry=1'), 409, 'export_busy')
    await expectError(await api(''), 409, 'export_busy')
    // The person of the same account is in the same lease.
    await expectError(await kai.web(`/r/${room}/export`), 409, 'export_busy')
    await w.kv.delete(`export:${kai.id}`)
    const res = await api('?include=messages')
    assert.equal(res.status, 200)
    await res.arrayBuffer()
    assert.equal(await w.kv.get(`export:${kai.id}`), null)
  })

  await t.test('a visitor of a public topic is not a member; an archived topic exports; a deleted one is room_deleted', async () => {
    const mei = await w.person('mei')
    await expectError(await mei.web(`/r/${room}/export`), 403, 'not_member')
    const pub = await w.json(await kai.post(`/r/${room}/visibility`, { public: true }))
    assert.equal(pub.status, 200, JSON.stringify(pub))
    assert.equal((await mei.web(`/r/${room}`)).status, 200) // a viewer
    await expectError(await mei.web(`/r/${room}/export?dry=1`), 403, 'not_member')
    const archived = await w.json(await kai.post(`/r/${room}/archive`, { archived: true }))
    assert.equal(archived.status, 200, JSON.stringify(archived))
    const res = await api('?include=messages')
    assert.equal(res.status, 200)
    const z = unzip(Buffer.from(await res.arrayBuffer()))
    const base = names(z)[0].split('/')[0]
    assert.match(z[`${base}/topic.md`], /^- Public · Archived$/m)
    assert.equal(JSON.parse(z[`${base}/data.json`]).topic.status, 'archived')
    // The web's delete purges the topic at once, so what follows is room_not_found; room_deleted (410) is the object's
    // own answer while a deletion is still pending, the same refusal every read gives.
    assert.equal((await w.json(await kai.post(`/r/${room}/delete`, {}))).status, 200)
    await expectError(await api(''), 404, 'room_not_found')
  })
})

test('export_too_large: over a limit, with the limits and the counts, before any byte', async (t) => {
  const w = await worker({ TEST_EXPORT_LIMITS: JSON.stringify({ messages: 8, bytes: 5 }) })
  t.after(() => w.dispose())
  const kai = await w.person('kai')
  const room = await w.topic(kai)
  await w.join(kai, room, 'api')
  for (let i = 0; i < 2; i++) assert.ok((await w.json(await kai.apiPost(`/rooms/${room}/send`, { text: `@kai m${i}` }, 'api'))).seq)
  const upload = await w.json(await kai.web(`/r/${room}/files`, { method: 'POST', body: '1234567890', headers: { 'content-type': 'text/plain', 'x-file-name': 'ten.txt' } }))
  assert.ok((await w.json(await kai.post(`/r/${room}/send`, { text: 'ten bytes', files: [upload.id] }))).seq)
  const api = (q) => kai.api(`/rooms/${room}/export${q}`, {}, 'api')
  // Under the message limit without files (system lines count as messages too).
  const dry = await w.json(await api('?dry=1&include=messages'))
  assert.equal(dry.status, 200, JSON.stringify(dry))
  const over = await expectError(await api('?dry=1'), 413, 'export_too_large')
  assert.deepEqual(over.limits, { messages: 8, files: 1000, bytes: 5 })
  assert.deepEqual(over.counts, { messages: dry.counts.messages, files: 1, bytes: 10 })
  await expectError(await api(''), 413, 'export_too_large')
  for (let i = dry.counts.messages; i <= 8; i++) assert.ok((await w.json(await kai.apiPost(`/rooms/${room}/send`, { text: `@kai more ${i}` }, 'api'))).seq)
  const many = await expectError(await api('?include=messages'), 413, 'export_too_large')
  assert.ok(many.counts.messages > 8)
  assert.equal(await w.kv.get(`export:${kai.id}`), null)
})
