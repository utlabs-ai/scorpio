// Run with node --test from cli/ (no dependencies; a local HTTP server plays the Scorpio server)
// `scorpio handoff`: storing a seat's handoff, and reading one.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { testEnv } from './env.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'scorpio.mjs')
const ROOM = 'AbCdEf0123456789_-ghIJ'
const UPDATED = Date.UTC(2026, 9, 16, 18, 20)
const { machineName } = await import('../src/daemon/commands.mjs')

const newHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-hand-'))
  fs.writeFileSync(path.join(home, 'token'), 'tok')
  return home
}
const home = newHome()
const fallback = (role, h = home) => path.join(h, 'topics', ROOM, 'handoffs', `${role}.md`)

// The server's answers to PUT, by the writing role.
const REFUSE = {
  local: [409, { error: 'handoff_local_only', next: 'This account keeps handoffs on its computers.' }],
  big: [413, { error: 'handoff_too_large', next: 'Over 256 KB.' }],
  text: [415, { error: 'handoff_not_text', next: 'Not text.' }],
  full: [409, { error: 'handoff_space_full', next: "This account's handoffs in this topic are 2.6 MB of 2.5 MB." }],
  arch: [409, { error: 'room_archived', next: 'This topic is archived.' }],
  boom: [500, { error: 'server_error', next: 'The server failed.' }],
  gone: [403, { error: 'not_member', next: 'Not a member.' }],
}
let reads = 0
const seen = []
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  seen.push({ method: req.method, url: req.url, headers: req.headers, body })
  const role = req.headers['x-scorpio-role']
  const json = (status, data) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
  if (req.method === 'PUT' && req.url === `/api/v1/rooms/${ROOM}/handoff`) {
    if (role === 'old') { res.statusCode = 404; return res.end('Not found') } // a server without the route
    if (REFUSE[role]) return json(...REFUSE[role])
    if (body.length > 256 * 1024) return json(413, { error: 'handoff_too_large', next: 'Over 256 KB.' })
    const name = `${role}@kai`
    return json(200, { roomId: ROOM, name, size: body.length, updatedAt: UPDATED, computer: req.headers['x-scorpio-computer'] || null, link: `https://scorpio.test/r/${ROOM}/handoff?name=${encodeURIComponent(name)}` })
  }
  const get = new RegExp(`^/api/v1/rooms/${ROOM}/handoff\\?name=(.*)$`).exec(req.url)
  if (req.method === 'GET' && get) {
    const name = decodeURIComponent(get[1])
    if (name === 'none@kai') return json(404, { error: 'handoff_not_found', next: 'none' })
    if (name === 'ghost@kai') return json(404, { error: 'seat_not_found', next: 'ghost' })
    reads += 1
    return json(200, { roomId: ROOM, name, size: 9, updatedAt: UPDATED, computer: 'box', body: `# read ${reads}\n` })
  }
  json(404, { error: 'bad_request', next: `unexpected ${req.method} ${req.url}` })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

/** Run the CLI; {code, out, sent}: sent is the last request that reached the server, or null. */
function cli(args, { h = home, session = randomUUID() } = {}) {
  const before = seen.length
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'handoff', ...args], {
      env: testEnv(h, { SCORPIO_HOME: h, SCORPIO_SERVER: url, CLAUDE_CODE_SESSION_ID: session, CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' }), timeout: 30_000,
    }, (err, stdout) => resolve({ code: err ? err.code : 0, out: JSON.parse(stdout || '{}'), sent: seen.length > before ? seen.at(-1) : null }))
  })
}
const write = (file, body = '# Where things stand\n\nAll done.\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return file
}

test('file=: stored in the cloud; the fallback file is deleted; the headers say where it was written', async () => {
  const file = write(fallback('api'))
  const at = new Date(Date.UTC(2026, 9, 16, 18, 19, 30, 250))
  fs.utimesSync(file, at, at)
  const r = await cli([`topicId=${ROOM}`, 'role=api', `file=${file}`])
  assert.equal(r.code, 0)
  const link = `https://scorpio.test/r/${ROOM}/handoff?name=api%40kai`
  assert.deepEqual(r.out, { topicId: ROOM, name: 'api@kai', stored: 'cloud', size: 32, updatedAt: UPDATED, link, next: `Uploaded (1 KB). Put this link in your takeover message: ${link}. The copy on this computer was removed; the cloud copy is the one your successor reads.` })
  assert.equal(r.sent.method, 'PUT')
  assert.equal(r.sent.headers['content-type'], 'text/markdown; charset=utf-8')
  assert.equal(r.sent.headers['x-scorpio-role'], 'api')
  assert.equal(r.sent.headers['x-handoff-written'], undefined, 'no X-Handoff-Written')
  assert.equal(r.sent.headers['x-scorpio-computer'], machineName())
  assert.equal(r.sent.headers.authorization, 'Bearer tok')
  assert.equal(r.sent.body.toString(), '# Where things stand\n\nAll done.\n')
  assert.ok(!fs.existsSync(file), 'the fallback is gone: the cloud copy is the one')
})

test('file=: another path is uploaded and left where it is', async () => {
  const file = write(path.join(home, 'notes', 'api-handoff.md'))
  write(fallback('api2'), 'an older fallback')
  const r = await cli([`topicId=${ROOM}`, 'role=api2', `file=${file}`])
  assert.equal(r.code, 0)
  assert.equal(r.out.stored, 'cloud')
  assert.match(r.out.next, /^Uploaded \(1 KB\)\. Put this link in your takeover message: \S+\. The cloud copy is the one your successor reads\.$/)
  assert.ok(fs.existsSync(file))
  assert.ok(fs.existsSync(fallback('api2')), 'only the path given is ever deleted, and only when it is the fallback')
})

test('file=: the size is the server\'s to check: 256 KB is stored, more is sent and answered handoff_too_large', async () => {
  const exact = write(fallback('api3'), 'x'.repeat(256 * 1024))
  const ok = await cli([`topicId=${ROOM}`, 'role=api3', `file=${exact}`])
  assert.equal(ok.out.stored, 'cloud')
  assert.equal(ok.out.next.slice(0, 18), 'Uploaded (256 KB).')
  const big = write(fallback('api3'), `${'x'.repeat(256 * 1024 - 1)}éé`) // two bytes each: 262,147
  const r = await cli([`topicId=${ROOM}`, 'role=api3', `file=${big}`])
  assert.equal(r.code, 1)
  assert.equal(r.sent.body.length, 262_147, 'sent: the server refuses it')
  assert.deepEqual(r.out, { error: 'handoff_too_large', next: `The handoff is 257 KB; the limit is 256 KB. Shorten it (keep facts and decisions, drop logs and pasted output), save it to ${big}, and run this command again. Until it is uploaded it exists only on this computer.`, path: big })
  assert.ok(fs.existsSync(big))
})

test('file=: the account keeps handoffs on agents\' computers: stored local, exit 0, the file kept', async () => {
  const file = write(fallback('local'))
  const r = await cli([`topicId=${ROOM}`, 'role=local', `file=${file}`])
  assert.equal(r.code, 0)
  assert.deepEqual(r.out, { topicId: ROOM, role: 'local', stored: 'local', path: file, next: `Cloud handoffs are off for this account (Settings → Keep handoffs on agents' computers), so the handoff stays here at ${file}. Post your takeover command as usual; nothing to say about this.` })
  assert.ok(fs.existsSync(file))
})

test('file=: every failure keeps the file and says what to do next', async () => {
  const cases = {
    big: (f) => `The handoff is 1 KB; the limit is 256 KB. Shorten it (keep facts and decisions, drop logs and pasted output), save it to ${f}, and run this command again. Until it is uploaded it exists only on this computer.`,
    text: (f) => `${f} is not plain text (not UTF-8, or it has control characters). Write the handoff as plain Markdown text and run this command again.`,
    full: (f) => `Your account's handoffs in this topic already add up to 2.5 MB, the limit, so this one was not uploaded; it stays on this computer at ${f}. Post your takeover command as usual, and add this line for your owner: "Cloud handoffs for this account in this topic are full (2.5 MB), so this handoff was not uploaded. Delete handoffs of seats you no longer need from their member cards; the next handoff will then upload."`,
    arch: (f) => `This topic is archived, so nothing can be stored or posted in it. The handoff stays on this computer at ${f}.`,
    boom: (f) => `The handoff was not uploaded (server_error), so it stays on this computer at ${f}. Try this command once more; if it fails again, post your takeover command as usual and say nothing about it: the next takeover on this computer uses this copy, and the daemon says so then.`,
    old: (f) => `The handoff was not uploaded (server_error), so it stays on this computer at ${f}. Try this command once more; if it fails again, post your takeover command as usual and say nothing about it: the next takeover on this computer uses this copy, and the daemon says so then.`,
    gone: (f) => `The handoff was not uploaded (not_member), so it stays on this computer at ${f}. Try this command once more; if it fails again, post your takeover command as usual and say nothing about it: the next takeover on this computer uses this copy, and the daemon says so then.`,
  }
  const codes = { big: 'handoff_too_large', text: 'handoff_not_text', full: 'handoff_space_full', arch: 'room_archived', boom: 'server_error', old: 'server_error', gone: 'not_member' }
  for (const [role, next] of Object.entries(cases)) {
    const file = write(fallback(role))
    const r = await cli([`topicId=${ROOM}`, `role=${role}`, `file=${file}`])
    assert.equal(r.code, 1, role)
    assert.deepEqual(r.out, { error: codes[role], next: next(file), path: file }, role)
    assert.ok(fs.existsSync(file), `${role}: the file is kept`)
  }
  assert.ok(!/Try|again/.test(cases.arch('/f')), 'archived: no retry')
})

test('file=: role= is taken as given; file= missing, a directory or empty; file= with name=, or neither', async () => {
  const session = randomUUID()
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'sessions', `${session}.json`), JSON.stringify({ rooms: { [ROOM]: { role: 'api' } } }))
  const other = write(fallback('lead'))
  const r = await cli([`topicId=${ROOM}`, 'role=lead', `file=${other}`], { session })
  assert.equal(r.code, 0, 'another role than the session joined as is not refused')
  assert.equal(r.sent.headers['x-scorpio-role'], 'lead')
  const joined = randomUUID()
  fs.writeFileSync(path.join(home, 'sessions', `${joined}.json`), JSON.stringify({ rooms: { [ROOM]: { role: 'api' } } }))
  const mine = write(fallback('api'))
  assert.equal((await cli([`topicId=${ROOM}`, `file=${mine}`], { session: joined })).out.name, 'api@kai', 'without role=: the session\'s')

  const bad = async (args, next) => {
    const x = await cli(args)
    assert.equal(x.code, 1, args.join(' '))
    assert.equal(x.sent, null)
    assert.equal(x.out.error, 'bad_request')
    if (next) assert.match(x.out.next, next)
  }
  await bad([`topicId=${ROOM}`, 'role=api', `file=${path.join(home, 'nope.md')}`], /^No file .*nope\.md\. file= is the handoff you wrote/)
  await bad([`topicId=${ROOM}`, 'role=api', `file=${home}`], /is not a file\./)
  await bad([`topicId=${ROOM}`, 'role=api', `file=${write(path.join(home, 'blank.md'), ' \n\t\n')}`], /is empty\./)
  await bad([`topicId=${ROOM}`, 'role=api', `file=${mine}`, 'name=api@kai'], /^Give file= .* or name= .*, not both\.$/)
  await bad([`topicId=${ROOM}`, 'role=api'], /^Give file=/)
  await bad([`topicId=${ROOM}`, 'role=api', 'name=api'], /role@account/)
  await bad(['topicId=../x', 'role=api', `file=${mine}`], /topic id/)
})

test('file=: through this computer\'s daemon (the relay), and a network failure there', async (t) => {
  const { createRelay } = await import('../src/daemon/relay.mjs')
  const h = newHome()
  const socketPath = path.join(h, 'state', 'relay.sock')
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  const relay = createRelay({ socketPath, server: () => url })
  await relay.start()
  t.after(() => relay.stop())
  const file = write(fallback('api', h))
  const before = seen.length
  const r = await cli([`topicId=${ROOM}`, 'role=api', `file=${file}`], { h })
  assert.equal(r.code, 0)
  assert.equal(r.out.stored, 'cloud')
  const sent = seen.slice(before).find((x) => x.method === 'PUT')
  assert.equal(sent.headers['x-scorpio-computer'], machineName())
  assert.equal(sent.body.toString(), '# Where things stand\n\nAll done.\n')
  assert.ok(!fs.existsSync(file))

  // A relay whose every try failed answers 502 X-Scorpio-Relay: failed.
  const h2 = newHome()
  const dead = path.join(h2, 'state', 'relay.sock')
  fs.mkdirSync(path.dirname(dead), { recursive: true, mode: 0o700 })
  const failing = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => { res.writeHead(502, { 'content-type': 'application/json', 'x-scorpio-relay': 'failed' }); res.end(JSON.stringify({ error: 'network', sent: null, tries: 3, cause: 'ECONNRESET' })) })
  })
  await new Promise((r2) => failing.listen(dead, r2))
  t.after(() => failing.close())
  const kept = write(fallback('api', h2))
  const n = await cli([`topicId=${ROOM}`, 'role=api', `file=${kept}`], { h: h2 })
  assert.equal(n.code, 1)
  assert.deepEqual(n.out, { error: 'network', next: `Could not reach Scorpio (network), so the handoff stays on this computer at ${kept}. Try this command once more; if it fails again, post your takeover command as usual and say nothing about it: the next takeover on this computer uses this copy, and the daemon says so then.`, path: kept })
  assert.ok(fs.existsSync(kept))
})

test('name=: read into files/handoff-<name>.md, 0600, overwritten next time; none and no such seat apart', async () => {
  const r = await cli([`topicId=${ROOM}`, 'role=api', 'name=reader@kai'])
  assert.equal(r.code, 0)
  const out = path.join(home, 'topics', ROOM, 'files', 'handoff-reader@kai.md')
  assert.deepEqual(r.out, { topicId: ROOM, name: 'reader@kai', size: 9, updatedAt: UPDATED, computer: 'box', path: out })
  assert.equal(r.sent.method, 'GET')
  assert.equal(r.sent.url, `/api/v1/rooms/${ROOM}/handoff?name=reader%40kai`)
  assert.equal(r.sent.headers['x-scorpio-role'], 'api')
  const first = fs.readFileSync(out, 'utf8')
  assert.equal(fs.statSync(out).mode & 0o777, 0o600)
  await cli([`topicId=${ROOM}`, 'role=api', 'name=@reader@kai'])
  assert.notEqual(fs.readFileSync(out, 'utf8'), first, 'overwritten')
  assert.ok(!fs.existsSync(path.join(home, 'topics', ROOM, 'handoffs', 'reader.md')), 'never into the fallback directory')

  const none = await cli([`topicId=${ROOM}`, 'role=api', 'name=none@kai'])
  assert.equal(none.code, 1)
  assert.deepEqual(none.out, { error: 'handoff_not_found', next: 'none@kai has no handoff in the cloud in this topic. If it was handed off on another computer, that copy was not uploaded.' })
  const ghost = await cli([`topicId=${ROOM}`, 'role=api', 'name=ghost@kai'])
  assert.deepEqual(ghost.out, { error: 'seat_not_found', next: 'ghost@kai is not a member of this topic.' })
})

test('the daemon\'s read of a handoff when taking over: as its seat, bounded, its codes kept apart', async () => {
  const { createApi } = await import('../src/daemon/api.mjs')
  const calls = []
  const answer = (status, data) => async (u, opts) => { calls.push({ u, opts }); return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status }) }
  const found = createApi({ server: 'https://s.test', token: () => 'tok', fetchImpl: answer(200, { name: 'arch@kai', body: 'x', updatedAt: 1 }) })
  assert.equal((await found.handoff(ROOM, 'daemon', 'arch@kai', { budgetMs: 20_000 })).body, 'x')
  assert.equal(calls[0].u, `https://s.test/api/v1/rooms/${ROOM}/handoff?name=arch%40kai`)
  assert.equal(calls[0].opts.headers['X-Scorpio-Role'], 'daemon')
  const code = async (api) => { try { await api.handoff(ROOM, 'daemon', 'arch@kai', { budgetMs: 60 }); return 'ok' } catch (e) { return e.code } }
  assert.equal(await code(createApi({ token: () => 'tok', fetchImpl: answer(404, { error: 'handoff_not_found' }) })), 'handoff_not_found')
  assert.equal(await code(createApi({ token: () => 'tok', fetchImpl: answer(404, 'Not found') })), 'not_found')
  const hang = (u, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)))
  const started = Date.now()
  assert.equal(await code(createApi({ token: () => 'tok', fetchImpl: hang })), 'timeout')
  assert.ok(Date.now() - started < 2_000, 'stops at its budget')
})
