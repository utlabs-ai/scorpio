// Run with node --test from cli/ (no dependencies; local sockets only)
// The daemon's relay for the CLI's requests, and the time-budget retries.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-relay-'))
process.env.SCORPIO_HOME = home
const { createRelay, WARM_EVERY_MS, WARM_FOR_MS, BUSY_MAX_MS } = await import('../src/daemon/relay.mjs')
const { RELAY_SOCKET } = await import('../src/daemon/paths.mjs')
const { tryFor } = await import('../src/net.mjs')
const { createApi } = await import('../src/daemon/api.mjs')
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'scorpio.mjs')

/** The server, played by a local HTTP server that records what reached it. */
async function upstream(handler = (req, res, body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, echo: body.toString() })) }) {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    seen.push({ method: req.method, url: req.url, headers: req.headers, body })
    handler(req, res, body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); server.close() } }
}

const Agent = (() => { void globalThis.Headers; return globalThis[Symbol.for('undici.globalDispatcher.1')].constructor })()
const viaSocket = (socketPath) => new Agent({ connect: { socketPath } })

/** One raw HTTP/1.1 request line to the socket: fetch would never send an absolute URL as the target. */
function raw(socketPath, text) {
  return new Promise((resolve) => {
    const s = net.connect(socketPath, () => s.end(text))
    let out = ''
    s.on('data', (d) => { out += d })
    s.on('close', () => resolve(out))
  })
}

test('the relay forwards to its server: method, path, body, the CLI\'s token, role and user agent; the answer back as it was', async (t) => {
  const up = await upstream((req, res, body) => {
    res.writeHead(req.url.startsWith('/img') ? 200 : 404, { 'content-type': req.url.startsWith('/img') ? 'image/png' : 'application/json' })
    res.end(req.url.startsWith('/img') ? body : JSON.stringify({ error: 'message_not_found', next: 'No such message.' }))
  })
  const socketPath = path.join(home, 'r1.sock')
  const relay = createRelay({ socketPath, server: () => up.url })
  await relay.start()
  t.after(() => { relay.stop(); up.close() })
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600)
  const dispatcher = viaSocket(socketPath)

  const res = await fetch('http://relay/api/v1/rooms/R/messages/9?x=1', {
    dispatcher, headers: { Authorization: 'Bearer tok', 'X-Scorpio-Role': 'api', 'User-Agent': 'scorpio-cli/9.9.9', 'X-Scorpio-Server': up.url, 'X-Scorpio-Safe': '1' },
  })
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: 'message_not_found', next: 'No such message.' })
  const got = up.seen.at(-1)
  assert.equal(got.url, '/api/v1/rooms/R/messages/9?x=1')
  assert.equal(got.headers.authorization, 'Bearer tok')
  assert.equal(got.headers['x-scorpio-role'], 'api')
  assert.equal(got.headers['user-agent'], 'scorpio-cli/9.9.9', 'the server still sees which CLI it is')
  assert.equal(got.headers['x-scorpio-server'], undefined, 'the relay\'s own headers stay here')

  const image = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 256))
  const back = await fetch('http://relay/img', { method: 'POST', body: image, dispatcher, headers: { 'Content-Type': 'image/png' } })
  assert.equal(back.headers.get('content-type'), 'image/png')
  assert.ok(Buffer.from(await back.arrayBuffer()).equals(image))
})

test('a CLI that hangs up before the server answers ends its request: busy goes back to false, so an update can restart the daemon', async (t) => {
  // The server answers the first request only when told to, and streams a body that never ends for the second.
  let answer, streaming = null
  const up = await upstream((req, res) => {
    if (req.url === '/slow') { answer = () => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}') }; return }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.write(Buffer.alloc(64 * 1024))
    streaming = res
  })
  const socketPath = path.join(home, 'r-hangup.sock')
  const relay = createRelay({ socketPath, server: () => up.url })
  await relay.start()
  t.after(() => { relay.stop(); up.close() })
  const hangUp = async (p, until) => {
    const req = http.request({ socketPath, path: p })
    req.on('error', () => {})
    req.on('response', (res) => res.resume())
    req.end()
    for (let i = 0; i < 100 && !until(); i += 1) await new Promise((r) => setTimeout(r, 10))
    assert.equal(relay.busy(), true)
    req.destroy() // killed by its shell at 2 minutes, or out of budget
  }
  const settled = async () => { for (let i = 0; i < 100 && relay.busy(); i += 1) await new Promise((r) => setTimeout(r, 10)) }
  // Gone while the server still thinks: the answer comes to a closed socket.
  await hangUp('/slow', () => answer)
  await new Promise((r) => setTimeout(r, 50))
  answer()
  await settled()
  assert.equal(relay.busy(), false)
  assert.equal(relay.inflight(), 0)
  // Gone in the middle of a body: the relay stops reading it.
  await hangUp('/stream', () => streaming)
  await settled()
  assert.equal(relay.busy(), false)
  assert.equal(relay.inflight(), 0)
})

test('a forwarded request stuck past BUSY_MAX_MS holds no restart, and is still counted', async (t) => {
  let clock = 1_000_000
  const socketPath = path.join(home, 'r-stuck.sock')
  const relay = createRelay({ socketPath, server: () => 'http://127.0.0.1:9', now: () => clock, fetchImpl: () => new Promise(() => {}) })
  await relay.start()
  const req = http.request({ socketPath, path: '/api/v1/whoami' })
  req.on('error', () => {})
  req.end()
  t.after(() => { req.destroy(); relay.stop() })
  for (let i = 0; i < 100 && !relay.inflight(); i += 1) await new Promise((r) => setTimeout(r, 10))
  assert.equal(relay.busy(), true)
  clock += BUSY_MAX_MS - 1
  assert.equal(relay.busy(), true)
  clock += 1
  assert.equal(relay.busy(), false)
  assert.equal(relay.inflight(), 1)
})

test('the relay only goes to its own server', async (t) => {
  const up = await upstream()
  const socketPath = path.join(home, 'r2.sock')
  const relay = createRelay({ socketPath, server: () => up.url })
  await relay.start()
  t.after(() => { relay.stop(); up.close() })
  const res = await fetch('http://relay/api/v1/whoami', { dispatcher: viaSocket(socketPath), headers: { 'X-Scorpio-Server': 'https://elsewhere.example' } })
  assert.equal(res.status, 421)
  assert.equal(res.headers.get('x-scorpio-relay'), 'other-server')
  for (const target of ['http://evil.example/x', '//evil.example/x', '@evil.example/x']) {
    assert.match(await raw(socketPath, `GET ${target} HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400/, target)
  }
  assert.equal(up.seen.length, 0)
})

test('the server out of reach: tried within the budget, then 502 with what is known', async (t) => {
  const closed = await upstream()
  closed.close() // nothing listens on that port any more: connection refused, never sent
  const socketPath = path.join(home, 'r3.sock')
  const pauses = []
  const relay = createRelay({ socketPath, server: () => closed.url, sleep: async (ms) => { pauses.push(ms) } })
  await relay.start()
  t.after(() => relay.stop())
  const res = await fetch('http://relay/api/v1/rooms/R/plan', { method: 'POST', body: '{}', dispatcher: viaSocket(socketPath), headers: { 'X-Scorpio-Budget': '20000' } })
  assert.equal(res.status, 502)
  assert.equal(res.headers.get('x-scorpio-relay'), 'failed')
  const body = await res.json()
  assert.equal(body.error, 'network')
  assert.equal(body.sent, false, 'refused: it never left, so even a write was tried again')
  assert.equal(body.cause, 'ECONNREFUSED')
  assert.ok(body.tries >= 2, `tries: ${body.tries}`)
})

test('keeping a connection warm: only while the CLI used the relay lately, every 3 idle minutes', async () => {
  let clock = 0
  const fetched = []
  const relay = createRelay({
    socketPath: path.join(home, 'r4.sock'), server: () => 'https://s.example/', now: () => clock,
    fetchImpl: async (url) => { fetched.push(String(url)); return new Response('{}', { status: 200 }) },
  })
  relay.tick()
  assert.deepEqual(fetched, [], 'never used: nothing')
  await relay.start()
  await fetch('http://relay/api/v1/whoami', { dispatcher: viaSocket(path.join(home, 'r4.sock')) })
  assert.deepEqual(fetched, ['https://s.example/api/v1/whoami'])
  clock += WARM_EVERY_MS - 1
  relay.tick()
  assert.equal(fetched.length, 1)
  clock += 1
  relay.tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(fetched.at(-1), 'https://s.example/dl/latest.json')
  clock += WARM_FOR_MS
  relay.tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(fetched.length, 2, 'not used for half an hour: let it go')
  relay.stop()
  assert.equal(fs.existsSync(path.join(home, 'r4.sock')), false)
  // A path too long for a unix socket would be cut short silently: refused instead.
  await assert.rejects(createRelay({ socketPath: path.join(home, 'x'.repeat(120), 'relay.sock') }).start(), { code: 'path_too_long' })
})

test('tryFor: tries again while safe or never sent and the budget leaves room; says what is known', async () => {
  let clock = 0
  const opts = { now: () => clock, sleep: async (ms) => { clock += ms }, budgetMs: 100_000 }
  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
  const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
  // Each failure costs the 11 s a reset handshake takes on a bad network.
  let n = 0
  let e = await tryFor(async () => { n += 1; clock += 11_000; throw refused() }, opts).catch((x) => x)
  assert.equal(e.sent, false)
  assert.equal(e.tries, n)
  assert.ok(n >= 5 && clock <= 100_000, `${n} tries in ${clock} ms`)
  // A write that broke after it may have been sent: once only.
  n = 0; clock = 0
  e = await tryFor(async () => { n += 1; throw reset() }, opts).catch((x) => x)
  assert.equal(n, 1)
  assert.equal(e.sent, null)
  // A read: again, and the third try answers.
  n = 0; clock = 0
  assert.equal(await tryFor(async () => { n += 1; if (n < 3) throw reset(); return 'ok' }, { ...opts, safe: true }), 'ok')
})

/** Run the CLI with its own home and server; resolves to its JSON output. */
function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: testEnv(env.SCORPIO_HOME, env), timeout: 30_000 }, (err, stdout) => resolve(JSON.parse(stdout || '{}')))
  })
}

test('the CLI goes through the daemon when it listens, and straight to the server when not', async (t) => {
  const up = await upstream((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ roomId: 'R', messages: [] })) })
  t.after(() => up.close())
  fs.writeFileSync(path.join(home, 'token'), 'tok')
  const env = { SCORPIO_HOME: home, SCORPIO_SERVER: up.url }
  let relayed = 0
  const relay = createRelay({ server: () => up.url, fetchImpl: (...a) => { relayed += 1; return globalThis.fetch(...a) } })
  await relay.start()
  assert.equal(RELAY_SOCKET, path.join(home, 'state', 'relay.sock'))
  assert.deepEqual(await cli(['messages', 'roomId=R', 'role=api'], env), { topicId: 'R', messages: [] }) // the server's roomId, renamed for the agent (names.mjs)
  assert.equal(relayed, 1)
  assert.equal(up.seen.at(-1).headers['user-agent'].split('/')[0], 'scorpio-cli')
  assert.equal(up.seen.at(-1).headers['x-scorpio-cli'], JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, 'which package, for the server\'s minimum version')
  // Another server than the daemon's: straight there.
  const other = await upstream((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"roomId":"R","messages":[]}') })
  t.after(() => other.close())
  await cli(['messages', 'roomId=R', 'role=api'], { ...env, SCORPIO_SERVER: other.url })
  assert.equal(relayed, 1)
  assert.equal(other.seen.length, 1)
  relay.stop()
  // No daemon: straight to the server.
  await cli(['messages', 'roomId=R', 'role=api'], env)
  assert.equal(up.seen.length, 2)
  // A socket file left by a daemon that died: refused, so straight to the server too.
  await new Promise((resolve) => execFile(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(RELAY_SOCKET)}, () => process.exit(0))`], resolve))
  assert.ok(fs.statSync(RELAY_SOCKET).isSocket())
  await cli(['messages', 'roomId=R', 'role=api'], env)
  assert.equal(up.seen.length, 3)
})

test('upgrade_required from the server: the daemon is told at once, from its own calls and from the CLI\'s through the relay', async (t) => {
  const old = await upstream((req, res) => { res.writeHead(426, { 'content-type': 'application/json' }); res.end('{"error":"upgrade_required","next":"update"}') })
  t.after(() => old.close())
  let asked = 0
  const api = createApi({ server: old.url, token: () => 'tok', onUpgradeRequired: () => { asked += 1 } })
  await assert.rejects(api.listen('R', 'api'), { code: 'upgrade_required' })
  assert.equal(asked, 1)
  const socketPath = path.join(home, 'r5.sock')
  const relay = createRelay({ socketPath, server: () => old.url, onUpgradeRequired: () => { asked += 1 } })
  await relay.start()
  t.after(() => relay.stop())
  const res = await fetch('http://relay/api/v1/rooms/R/listen', { dispatcher: viaSocket(socketPath) })
  assert.equal(res.status, 426, 'the CLI still gets the answer itself')
  assert.equal((await res.json()).error, 'upgrade_required')
  assert.equal(asked, 2)
})
