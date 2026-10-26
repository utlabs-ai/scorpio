// Run with node --test from cli/ (no dependencies; a local HTTP server plays the Scorpio server)
// What the CLI sends for todo and send add=, and the actions it no longer has.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'scorpio.mjs')
const TOPIC_ID = 'AbCdEf0123456789_-ghIJ'
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-cli-'))
fs.writeFileSync(path.join(home, 'token'), 'tok')

const seen = []
// Downloads the fake server hands out: id → [content-type, file name, bytes].
const DOWNLOADS = {
  f1: ['image/png', 'shot.jpg', 'png bytes'],
  f2: ['application/pdf', 'Q3 report.pdf', '%PDF-1.7'],
  f3: ['application/octet-stream', 'Makefile', 'all:'],
}
let uploads = 0
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks)
  const json = String(req.headers['content-type'] || '').startsWith('application/json')
  seen.push({ method: req.method, url: req.url, headers: req.headers, body: json && raw.length ? JSON.parse(raw) : null, raw })
  const file = /\/files\/(\w+)$/.exec(req.url)
  if (req.method === 'GET' && file && DOWNLOADS[file[1]]) {
    const [type, name, bytes] = DOWNLOADS[file[1]]
    res.setHeader('content-type', type)
    if (!type.startsWith('image/')) res.setHeader('content-disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    return res.end(bytes)
  }
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/v1/whoami') return res.end(JSON.stringify({ account: 'kai', displayName: '小凯', email: 'kai@example.com', device: 'd1', tokenExpiresAt: 1, plan: 'pro' }))
  if (req.method === 'GET' && req.url === '/api/v1/rooms') return res.end(JSON.stringify({ freeActiveLimitReached: true, rooms: [{ roomId: 'one', name: 'Scorpio', status: 'active' }, { roomId: 'two', name: 'Archive', status: 'archived' }] }))
  if (req.url.startsWith('/api/v1/rooms/R/search?')) return res.end(JSON.stringify({ roomId: 'R', q: 'creem', groups: { messages: [], todo: [{ type: 'todo', id: 'T40', seq: 365, who: 'kai', ts: 1, snippet: 'Creem' }], files: [] }, hasMore: { messages: false, todo: false, files: false } }))
  if (req.url.startsWith('/api/v1/rooms/R/files?')) return res.end(JSON.stringify({ roomId: 'R', kind: 'pics', files: [{ id: 'f1', name: 'shot.png', type: 'image/png', size: 42, from: 'api@kai', displayName: null, seq: 9, ts: 1000, link: 'https://scorpio.test/v/f1', url: '/f/R/f1', view: false }], hasMore: true, counts: { files: 2, pics: 1, gone: 3 } }))
  if (req.url.startsWith('/api/v1/rooms/full/')) {
    res.statusCode = 429
    return res.end(JSON.stringify(req.url.endsWith('/send') ? { error: 'quota_exceeded', next: 'Opens at 00:00 UTC.' } : { error: 'room_limit' }))
  }
  if (req.method === 'POST' && req.url.endsWith('/files')) { uploads += 1; return res.end(JSON.stringify({ id: `u${uploads}` })) }
  // A hint written the 0.4 way, as the server keeps writing them.
  if (req.url === '/api/v1/rooms/R/todo/T99') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'item_not_found', next: 'There is no task T99 in this topic (or it was deleted). See: scorpio todo roomId=R' })) }
  if (req.url === '/api/v1/rooms/R/topic') return res.end(JSON.stringify({ roomId: 'R', topic: (seen.at(-1).body || {}).topic }))
  res.end(JSON.stringify({ ok: true }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

/** Run the CLI; resolves to {code, out, sent} where sent is what reached the server (or null). */
function cli(...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : null
  const before = seen.length
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args, 'role=api'], { env: testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: url, ...options?.env }), timeout: 30_000 }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: JSON.parse(stdout || '{}'), sent: seen.length > before ? seen.at(-1) : null })
    })
    if (options?.stdin !== undefined) child.stdin.end(options.stdin)
  })
}

test('login: the device code request carries the machine id as a sha256, never the id itself', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-cli-login-'))
  const before = seen.length
  await new Promise((resolve) => execFile(process.execPath, [CLI, 'login'], { env: testEnv(fresh, { SCORPIO_HOME: fresh, SCORPIO_SERVER: url }), timeout: 30_000 }, () => resolve()))
  const sent = seen.slice(before).find((r) => r.url === '/oauth/device/code')
  assert.ok(sent, 'asked for a device code')
  assert.equal(sent.body.cli_version, VERSION)
  let raw = null
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) { try { raw = fs.readFileSync(f, 'utf8').trim() || null } catch {} if (raw) break }
  if (process.platform === 'linux' && raw) {
    const { createHash } = await import('node:crypto')
    assert.equal(sent.body.machine_id, createHash('sha256').update(raw).digest('hex'))
    assert.ok(!JSON.stringify(sent.body).includes(raw), 'the raw id stays here')
  } else assert.ok(sent.body.machine_id === undefined || /^[0-9a-f]{64}$/.test(sent.body.machine_id))
  fs.rmSync(fresh, { recursive: true, force: true })
})

test('whoami: the plan and display name come through', async () => {
  const { code, out } = await cli('whoami')
  assert.equal(code, 0)
  assert.equal(out.account, 'kai')
  assert.equal(out.plan, 'pro')
  assert.equal(out.displayName, '小凯')
})

test('topics: lists this account\'s topic ids, names and states with the Free limit flag', async () => {
  const r = await cli('topics')
  assert.equal(r.code, 0)
  assert.equal(r.sent.url, '/api/v1/rooms')
  assert.deepEqual(r.out, { topics: [{ id: 'one', name: 'Scorpio', status: 'active' }, { id: 'two', name: 'Archive', status: 'archived' }], freeActiveLimitReached: true })
})

test('a limit is its own error, not rate_limited, with the server next or one of ours', async () => {
  const sent = await cli('send', 'roomId=full', "text=@kai hi")
  assert.equal(sent.code, 1)
  assert.deepEqual(sent.out, { error: 'quota_exceeded', next: 'Opens at 00:00 UTC.' })
  const listed = await cli('todo', 'roomId=full')
  assert.equal(listed.out.error, 'room_limit')
  assert.match(listed.out.next, /one active topic/)
})

test('todo: list and show one item', async () => {
  let r = await cli('todo', 'roomId=R')
  assert.equal(r.sent.method, 'GET')
  assert.equal(r.sent.url, '/api/v1/rooms/R/todo')
  assert.equal(r.sent.headers['x-scorpio-cli'], VERSION)
  r = await cli('todo', 'roomId=R', 'show=5')
  assert.equal(r.sent.url, '/api/v1/rooms/R/todo/T5')
})

test('search: sends room filters and returns the grouped JSON', async () => {
  const r = await cli('search', 'roomId=R', 'q=creem', 'in=todo', 'limit=3', 'before=365')
  assert.equal(r.code, 0)
  assert.equal(r.sent.url, '/api/v1/rooms/R/search?q=creem&in=todo&limit=3&before=365')
  assert.equal(r.sent.headers['x-scorpio-role'], 'api')
  assert.equal(r.out.groups.todo[0].id, 'T40')
  const missing = await cli('search', 'roomId=R')
  assert.equal(missing.code, 1)
  assert.equal(missing.sent, null)
})

test('files: defaults to 20, forwards filters and cursor, and prints only the fields agents rely on', async () => {
  const base = await cli('files', 'topicId=R')
  assert.equal(base.code, 0)
  assert.equal(base.sent.url, '/api/v1/rooms/R/files?limit=20')
  const r = await cli('files', 'topicId=R', 'kind=pics', 'q=珍珠', 'from=api@kai', 'before=9', 'beforeId=f1', 'limit=7')
  assert.equal(r.code, 0)
  assert.equal(r.sent.method, 'GET')
  assert.equal(r.sent.headers['x-scorpio-role'], 'api')
  assert.equal(r.sent.url, '/api/v1/rooms/R/files?kind=pics&q=%E7%8F%8D%E7%8F%A0&from=api%40kai&before=9&beforeId=f1&limit=7')
  assert.deepEqual(r.out, { topicId: 'R', kind: 'pics', files: [{ id: 'f1', name: 'shot.png', type: 'image/png', size: 42, from: 'api@kai', displayName: null, seq: 9, ts: 1000, link: 'https://scorpio.test/v/f1' }], hasMore: true, counts: { files: 2, pics: 1, gone: 3 } })
  const bad = await cli('files', 'topicId=R', 'kind=images')
  assert.equal(bad.code, 1)
  assert.equal(bad.sent, null)
})

test('todo: the changes, as the server takes them', async () => {
  const body = async (...a) => (await cli('todo', 'roomId=R', ...a)).sent.body
  assert.deepEqual(await body("add=Refresh token", 'to=kai', 'after=3,P4', 'desc=why', 'from=9'), { op: 'add', title: 'Refresh token', to: 'kai', after: ['T3', 'T4'], desc: 'why', from: 9 })
  assert.deepEqual(await body('take=T3', 'force=true'), { op: 'take', id: 'T3', force: true })
  assert.deepEqual(await body('done=3'), { op: 'done', id: 'T3' })
  assert.deepEqual(await body('edit=T3', 'to=', 'after=', 'status=doing'), { op: 'edit', id: 'T3', to: '', after: [], status: 'doing' }, 'empty to= and after= clear them')
  assert.deepEqual(await body('edit=T3', 'from=17'), { op: 'edit', id: 'T3', from: 17 })
  assert.deepEqual(await body('delete=T3,4', 'force=true'), { op: 'delete', ids: ['T3', 'T4'], force: true })
})

test('todo: mistakes stop before the server', async () => {
  for (const args of [['edit=T3'], ['edit=T3', 'status=cancelled'], ['take=T3', 'done=T4'], ['add='], ['add=Missing source'], ['delete='], ['take=X3']]) {
    const r = await cli('todo', 'roomId=R', ...args)
    assert.equal(r.code, 1, args.join(' '))
    assert.equal(r.out.error, 'bad_request', args.join(' '))
    assert.equal(r.sent, null, args.join(' '))
  }
})

test('send: add= opens an item for to= in the same step; to= alone is a mistake', async () => {
  let r = await cli('send', 'roomId=R', 'text=@kai which quota?', 'add=Decide the free quota', 'to=kai', 'done=P2')
  const { nonce, ...body } = r.sent.body
  assert.ok(nonce)
  assert.deepEqual(body, { text: '@kai which quota?', done: 'T2', add: 'Decide the free quota', to: 'kai' })
  r = await cli('send', 'roomId=R', 'text=@kai hi', 'to=kai')
  assert.equal(r.out.error, 'bad_request')
  assert.equal(r.sent, null)
})

test('send: text= rejects a literal newline escape, while real line breaks and stdin pass through', async () => {
  let r = await cli('send', 'topicId=R', 'text=@kai a\\nb')
  assert.equal(r.code, 1)
  assert.equal(r.out.error, 'bad_request')
  assert.match(r.out.next, /text=- <<'EOF'/)
  assert.equal(r.sent, null)

  r = await cli('send', 'topicId=R', 'text=@kai a\nb\\nc')
  assert.equal(r.code, 0)
  assert.equal(r.sent.body.text, '@kai a\nb\\nc')

  r = await cli('send', 'topicId=R', 'text=-', { stdin: '@kai a\\nb\n' })
  assert.equal(r.code, 0)
  assert.equal(r.sent.body.text, '@kai a\\nb')

  r = await cli('send', 'topicId=R', 'text=@kai plain')
  assert.equal(r.code, 0)
  assert.equal(r.sent.body.text, '@kai plain')
})

test('plan, pin, unpin and pins are gone, and say where to', async () => {
  for (const action of ['plan', 'pin', 'unpin', 'pins']) {
    const r = await cli(action, 'roomId=R')
    assert.equal(r.out.error, 'bad_request')
    assert.match(r.out.next, action === 'plan' ? /scorpio task topicId=/ : /add='<what to decide>' to=/)
    assert.equal(r.sent, null)
  }
})

test('send files=: any file goes up as it is, with its name and a type from its extension; then the message with their ids', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-'))
  for (const [n, body] of [['a.png', 'png'], ['Q3 report.pdf', '%PDF'], ['data.bin', 'x']]) fs.writeFileSync(path.join(dir, n), body)
  const before = seen.length
  const r = await cli('send', 'roomId=R', 'text=@kai here', `files=${['a.png', 'Q3 report.pdf', 'data.bin'].map((n) => path.join(dir, n)).join(',')}`)
  assert.equal(r.code, 0)
  const ups = seen.slice(before).filter((x) => x.url === '/api/v1/rooms/R/files')
  assert.deepEqual(ups.map((x) => [x.headers['content-type'], decodeURIComponent(x.headers['x-file-name']), String(x.raw)]),
    [['image/png', 'a.png', 'png'], ['application/pdf', 'Q3 report.pdf', '%PDF'], ['application/octet-stream', 'data.bin', 'x']])
  assert.equal(r.sent.url, '/api/v1/rooms/R/send')
  assert.equal(r.sent.body.files.length, 3)
})

test('send files=: a file larger than any plan takes stops before anything is uploaded or sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-'))
  const big = path.join(dir, 'big.zip')
  fs.closeSync(fs.openSync(big, 'w')); fs.truncateSync(big, 25 * 1024 * 1024 + 1)
  const r = await cli('send', 'roomId=R', 'text=@kai here', `files=${big}`)
  assert.notEqual(r.code, 0)
  assert.equal(r.out.error, 'file_too_large')
  assert.equal(r.sent, null)
})

test('file: an image is saved under its type, any other file under the extension of its name', async () => {
  const got = async (id) => (await cli('file', `roomId=${TOPIC_ID}`, `id=${id}`)).out
  let o = await got('f1')
  assert.equal(o.path, path.join(home, 'topics', TOPIC_ID, 'files', 'f1.png'), 'png bytes named .jpg: saved as what it is')
  o = await got('f2')
  assert.equal(o.path, path.join(home, 'topics', TOPIC_ID, 'files', 'f2.pdf'))
  assert.equal(o.name, 'Q3 report.pdf')
  assert.equal(fs.readFileSync(o.path, 'utf8'), '%PDF-1.7')
  o = await got('f3')
  assert.equal(o.path, path.join(home, 'topics', TOPIC_ID, 'files', 'f3.bin'), 'no extension in the name')
})

test('file: a blocked topic files directory falls back to the legacy directory with a warning', async () => {
  const dir = path.join(home, 'topics', TOPIC_ID, 'files')
  fs.rmSync(dir, { recursive: true })
  fs.writeFileSync(dir, 'blocked')
  try {
    const result = await cli('file', `topicId=${TOPIC_ID}`, 'id=f1')
    assert.equal(result.code, 0)
    assert.equal(result.out.path, path.join(home, 'files', 'f1.png'))
    assert.match(result.out.warn, /saved to the legacy files directory instead/)
    assert.equal(fs.readFileSync(result.out.path, 'utf8'), 'png bytes')
  } finally {
    fs.rmSync(dir, { force: true })
    fs.mkdirSync(dir)
  }
})

// ---------- 0.5.0: room → topic, TODO → task. Old spellings work forever. ----------

const sameRequest = (a, b) => {
  const strip = (x) => ({ method: x.method, url: x.url, body: x.body && Object.fromEntries(Object.entries(x.body).filter(([k]) => k !== 'nonce')) })
  assert.deepEqual(strip(a), strip(b))
}

test('0.5.0: every new spelling reaches the server exactly as its old spelling does', async () => {
  const pairs = [
    [['send', 'topicId=R', 'text=@kai hi'], ['send', 'roomId=R', 'text=@kai hi']],
    [['task', 'topicId=R'], ['todo', 'roomId=R']],
    [['task', 'topicId=R', 'show=T3'], ['todo', 'roomId=R', 'show=3']],
    [['task', 'topicId=R', 'add=Ship it', 'from=4', 'desc=the details'], ['todo', 'roomId=R', 'add=Ship it', 'from=4', 'desc=the details']],
    [['search', 'topicId=R', 'q=creem', 'in=task'], ['search', 'roomId=R', 'q=creem', 'in=todo']],
    [['topic', 'topicId=R', 'desc=Ship the login'], ['topic', 'roomId=R', 'topic=Ship the login']],
    [['create', 'name=Login', 'desc=Ship it'], ['create', 'name=Login', 'topic=Ship it']],
    [['messages', 'topicId=R', 'limit=5'], ['messages', 'roomId=R', 'limit=5']],
    [['mark', 'topicId=R', 'upTo=9'], ['mark', 'roomId=R', 'upTo=9']],
  ]
  for (const [now, before] of pairs) {
    const a = await cli(...now), b = await cli(...before)
    assert.equal(a.code, 0, JSON.stringify(a.out))
    assert.equal(b.code, 0, JSON.stringify(b.out))
    sameRequest(a.sent, b.sent)
  }
  // desc= on a task is the task's description, not the topic's.
  assert.equal((await cli('send', 'topicId=R', 'text=@kai x', 'add=T', 'desc=why')).sent.body.desc, 'why')
})

test('0.5.0: two spellings that disagree stop before the server', async () => {
  for (const args of [['send', 'topicId=R', 'roomId=S', 'text=@kai hi'], ['topic', 'roomId=R', 'desc=a', 'topic=b']]) {
    const r = await cli(...args)
    assert.equal(r.code, 1)
    assert.equal(r.out.error, 'bad_request')
    assert.match(r.out.next, /mean the same here/)
    assert.equal(r.sent, null)
  }
  const missing = await cli('messages')
  assert.match(missing.out.next, /^Missing topicId=/)
})

test('0.5.0: output in topic names, and the server\'s 0.4 hints in the new syntax', async () => {
  const found = await cli('search', 'topicId=R', 'q=creem')
  assert.equal(found.out.topicId, 'R')
  assert.equal('roomId' in found.out, false)
  assert.equal(found.out.groups.todo[0].id, 'T40', 'inner fields keep the server names')
  const set = await cli('topic', 'topicId=R', 'desc=Ship the login')
  assert.deepEqual(set.out, { topicId: 'R', desc: 'Ship the login' })
  const gone = await cli('task', 'topicId=R', 'show=T99')
  assert.equal(gone.out.error, 'item_not_found')
  assert.equal(gone.out.next, 'There is no task T99 in this topic (or it was deleted). See: scorpio task topicId=R')
  // The command it suggests runs as it is.
  const [action, ...rest] = gone.out.next.split('See: scorpio ')[1].split(' ')
  const again = await cli(action, ...rest)
  assert.equal(again.code, 0)
  assert.equal(again.sent.url, '/api/v1/rooms/R/todo')
  const me = await cli('whoami')
  assert.ok('topics' in me.out && !('rooms' in me.out))
  const help = await new Promise((resolve) => execFile(process.execPath, [CLI, 'help'], { env: testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: url }) }, (e, out) => resolve(out)))
  assert.match(help, /^  task topicId=/m)
  assert.match(help, /Compatibility: roomId= also means topicId=/)
})

test('0.5.0: the commands old handover and spawn files hold still run as written', async () => {
  // Shapes copied from real handovers (~/.scorpio/handoffs) and the 0.4 spawn and handoff prompts.
  const handover = `
1. Join (run it as is): scorpio join roomId=${TOPIC_ID} role=impl resume=true roleCard='impl: server'
2. Report in: scorpio send roomId=${TOPIC_ID} role=impl replyTo=2110 text='@kai back'
0. Close each one you finished: scorpio todo roomId=${TOPIC_ID} role=impl done=T5
Mark them read first: scorpio mark roomId=${TOPIC_ID} role=impl upTo=2105
Read it with: scorpio message roomId=${TOPIC_ID} role=impl seq=12
Attached: shot.png (20 KB) · scorpio file roomId=${TOPIC_ID} role=impl id=f2
scorpio todo roomId=${TOPIC_ID} take=T3
scorpio todo roomId=${TOPIC_ID} add='Refresh endpoint' from=12 to=kai
scorpio search roomId=${TOPIC_ID} q='creem' in=todo
scorpio members roomId=${TOPIC_ID}
scorpio listen roomId=${TOPIC_ID}
scorpio topic roomId=${TOPIC_ID} topic='Ship the login'
scorpio roleCard roomId=${TOPIC_ID} roleCard='impl: server'
4. Leave: scorpio leave roomId=${TOPIC_ID} role=impl`
  const commands = [...handover.matchAll(/scorpio ([a-z][A-Za-z]*)((?: [A-Za-z]+=(?:'[^']*'|\S+))*)/g)].map((m) => [m[1], ...[...m[2].matchAll(/([A-Za-z]+)=('([^']*)'|\S+)/g)].map((a) => `${a[1]}=${a[3] ?? a[2]}`)])
  assert.equal(commands.length, 14)
  for (const [action, ...rest] of commands) {
    if (action === 'join' || action === 'leave') continue // they also touch this computer's delivery roster; the server side is the same
    const r = await cli(action, ...rest)
    assert.equal(r.code, 0, `${action} ${rest.join(' ')} → ${JSON.stringify(r.out)}`)
    assert.ok(r.sent?.url.startsWith(`/api/v1/rooms/${TOPIC_ID}/`), `${action} reached the server: ${r.sent?.url}`)
  }
})

test('send textFile preserves bytes and rejects empty, missing and conflicting text before requests', async () => {
  const file = path.join(home, 'message.md')
  const text = '@kai First line\n`literal $text` and \\n\n'
  fs.writeFileSync(file, text)
  const sent = await cli('send', 'topicId=R', `textFile=${file}`)
  assert.equal(sent.code, 0)
  assert.equal(sent.sent.body.text, text)
  for (const extra of [['text=other', `textFile=${file}`], [`textFile=${file}.missing`]]) {
    const result = await cli('send', 'topicId=R', ...extra)
    assert.equal(result.out.error, 'bad_request'); assert.equal(result.sent, null)
  }
  fs.writeFileSync(file, ' \n')
  const empty = await cli('send', 'topicId=R', `textFile=${file}`)
  assert.equal(empty.out.error, 'bad_request'); assert.equal(empty.sent, null)
})

test('Codex sandbox fails immediately without a server request; local help and version work', async () => {
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-cli-sandbox-'))
  const state = path.join(probeHome, 'state')
  fs.mkdirSync(state, { mode: 0o500 })
  try {
    const before = seen.length
    for (const action of ['send', 'join', 'whoami', 'daemon']) {
      const result = await cli(action, 'topicId=R', 'text=@kai hi', { env: { SCORPIO_HOME: probeHome, CODEX_SANDBOX_NETWORK_DISABLED: '1' } })
      assert.equal(result.code, 1)
      assert.equal(result.out.error, 'sandboxed')
      assert.match(result.out.next, /outside the sandbox/)
      assert.equal(result.sent, null)
    }
    assert.equal(seen.length, before)
  } finally {
    fs.chmodSync(state, 0o700)
    fs.rmSync(probeHome, { recursive: true, force: true })
  }
  for (const action of ['help', 'version']) {
    const result = await new Promise((resolve) => execFile(process.execPath, [CLI, action],
      { env: testEnv(home, { CODEX_SANDBOX_NETWORK_DISABLED: '1' }), timeout: 3000 }, (error, stdout) => resolve({ error, stdout })))
    assert.equal(result.error, null)
    assert.ok(result.stdout.includes(VERSION))
  }
})

test('Codex sandbox marker outside the sandbox allows requests and leaves no probe file', async () => {
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-cli-approved-'))
  const state = path.join(probeHome, 'state')
  fs.mkdirSync(state, { mode: 0o700 })
  fs.writeFileSync(path.join(probeHome, 'token'), 'tok')
  try {
    const before = seen.length
    const result = await cli('topics', { env: { SCORPIO_HOME: probeHome, CODEX_SANDBOX_NETWORK_DISABLED: '1' } })
    assert.equal(result.code, 0)
    assert.equal(result.out.error, undefined)
    assert.equal(seen.length, before + 1)
    assert.equal(result.sent.url, '/api/v1/rooms')
    assert.deepEqual(fs.readdirSync(state), [])
  } finally {
    fs.rmSync(probeHome, { recursive: true, force: true })
  }
})

test('Codex approval hook with sandbox marker and no local socket exits silently', async () => {
  const result = await new Promise((resolve) => execFile(process.execPath, [CLI, 'approval-hook', 'codex'],
    { env: testEnv(home, { SCORPIO_HOME: home, CODEX_SANDBOX_NETWORK_DISABLED: '1', HERDR_PANE_ID: 'w:p1' }), timeout: 3000 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })))
  assert.equal(result.error, null)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
