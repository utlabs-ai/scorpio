import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-logout-test-'))
process.env.SCORPIO_HOME = home
process.env.SCORPIO_SERVER = 'http://127.0.0.1:1'
const { api, forgetRejectedToken, requestDeviceCode, TOKEN_FILE, DEVICE_FILE, LOGGED_OUT_FILE } = await import('../src/client.mjs')
const { binary } = await import('../src/actions/file.mjs')
const { createApi } = await import('../src/daemon/api.mjs')
const { createLinks } = await import('../src/daemon/links.mjs')
const { createLogoutMonitor, NEW_CODE_MS } = await import('../src/daemon/logout.mjs')
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'scorpio.mjs')
test.after(() => fs.rmSync(home, { recursive: true, force: true }))

const run = (args, cliHome, server, nodeArgs = [], timeout = 30_000) => new Promise((resolve, reject) => {
  execFile(process.execPath, [...nodeArgs, CLI, ...args], { env: testEnv(cliHome, { SCORPIO_HOME: cliHome, SCORPIO_SERVER: server, HERDR_BIN_PATH: path.join(cliHome, 'no-herdr') }), timeout }, (error, stdout) => {
    try { resolve({ code: error?.code || 0, output: JSON.parse(stdout) }) } catch (e) { reject(e) }
  })
})

test('an old 401 keeps a newer token and exposes its reason', async () => {
  fs.writeFileSync(TOKEN_FILE, 'old\n')
  let release, requested
  const entered = new Promise((resolve) => { requested = resolve })
  const waiting = new Promise((resolve) => { release = resolve })
  const previous = globalThis.fetch
  globalThis.fetch = async () => {
    requested()
    await waiting
    return new Response(JSON.stringify({ error: 'unauthorized', reason: 'replaced' }), { status: 401 })
  }
  try {
    const pending = api('GET', '/whoami')
    await entered
    fs.writeFileSync(TOKEN_FILE, 'new\n')
    release()
    await assert.rejects(pending, { error: 'unauthorized', reason: 'replaced' })
    assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8').trim(), 'new')
  } finally { globalThis.fetch = previous }
})

test('a 401 removes only the token that the server refused', async () => {
  fs.writeFileSync(TOKEN_FILE, 'refused\n')
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'unauthorized', reason: 'expired' }), { status: 401 })
  try {
    await assert.rejects(api('GET', '/whoami'), { error: 'unauthorized', reason: 'expired' })
    assert.equal(fs.existsSync(TOKEN_FILE), false)
  } finally { globalThis.fetch = previous }
})

test('an attachment request refused late also keeps a newer token', async () => {
  fs.writeFileSync(TOKEN_FILE, 'old\n')
  let release, requested
  const entered = new Promise((resolve) => { requested = resolve })
  const waiting = new Promise((resolve) => { release = resolve })
  const previous = globalThis.fetch
  globalThis.fetch = async () => {
    requested()
    await waiting
    return new Response(JSON.stringify({ error: 'unauthorized', reason: 'replaced' }), { status: 401 })
  }
  try {
    const pending = binary('GET', '/rooms/example/files/one', { role: 'api' })
    await entered
    fs.writeFileSync(TOKEN_FILE, 'new\n')
    release()
    await assert.rejects(pending, { error: 'unauthorized', reason: 'replaced' })
    assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8').trim(), 'new')
  } finally { globalThis.fetch = previous }
})

test('logout asks first and writes the mark before deleting the token', async () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-logout-cli-'))
  fs.writeFileSync(path.join(local, 'token'), 'current\n')
  fs.writeFileSync(path.join(local, 'device.json'), '{}')
  try {
    const refused = await run(['logout'], local, 'http://127.0.0.1:1')
    assert.equal(refused.code, 0)
    assert.equal(refused.output.status, 'confirm')
    assert.match(refused.output.next, /scorpio logout yes=true/)
    assert.equal(fs.readFileSync(path.join(local, 'token'), 'utf8'), 'current\n')
    assert.equal(fs.existsSync(path.join(local, 'state', 'logged-out')), false)
    const confirmed = await run(['logout', 'yes=true'], local, 'http://127.0.0.1:1')
    assert.equal(confirmed.output.status, 'logged_out')
    assert.equal(fs.existsSync(path.join(local, 'token')), false)
    assert.equal(fs.existsSync(path.join(local, 'device.json')), false)
    assert.equal(typeof JSON.parse(fs.readFileSync(path.join(local, 'state', 'logged-out'))).at, 'number')
  } finally { fs.rmSync(local, { recursive: true, force: true }) }
})

test('successful login clears the logout mark', async () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-login-mark-'))
  fs.mkdirSync(path.join(local, 'state'))
  fs.writeFileSync(path.join(local, 'token'), 'valid\n')
  fs.writeFileSync(path.join(local, 'state', 'logged-out'), JSON.stringify({ at: 1 }))
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ account: 'kai', device: 'box' })) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await run(['login'], local, `http://127.0.0.1:${server.address().port}`)
    assert.equal(result.output.status, 'logged_in')
    assert.equal(fs.existsSync(path.join(local, 'state', 'logged-out')), false)
  } finally { server.close(); fs.rmSync(local, { recursive: true, force: true }) }
})

test('daemon requests relogin only when an existing device lacks a local logout mark', async () => {
  for (const marked of [false, true]) {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-daemon-auth-'))
    fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ device_id: 'existing-device-123' }))
    if (marked) {
      fs.mkdirSync(path.join(local, 'state'))
      fs.writeFileSync(path.join(local, 'state', 'logged-out'), JSON.stringify({ at: 1 }))
    }
    let request = null
    const server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      request = JSON.parse(body)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ device_code: 'device-code', user_code: 'ABCD', verification_uri: 'https://scorpio.test/activate', verification_uri_complete: 'https://scorpio.test/activate?code=ABCD', interval: 5, expires_in: 900 }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const result = await run(['daemon'], local, `http://127.0.0.1:${server.address().port}`)
      assert.equal(result.output.status, 'authorization_pending')
      assert.equal(request.device_id, 'existing-device-123')
      assert.equal(request.relogin, marked ? undefined : true)
    } finally { server.close(); fs.rmSync(local, { recursive: true, force: true }) }
  }
})

test('daemon API reports success and 401 reason to the shared counter', async () => {
  const seen = []
  let status = 200
  const client = createApi({ token: () => 'old', server: 'https://example.test', onResult: (r) => seen.push(r), fetchImpl: async () => new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'unauthorized', reason: 'plan' }), { status }) })
  await client.whoami()
  status = 401
  await assert.rejects(client.whoami(), { code: 'unauthorized', reason: 'plan' })
  assert.deepEqual(seen.map((r) => [r.code, r.reason || null]), [['ok', null], ['unauthorized', 'plan']])
})

test('daemon checks a revoked token once before requesting an ordinary approval code', async () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-revoked-start-'))
  fs.writeFileSync(path.join(local, 'token'), 'refused\n')
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ device_id: 'existing-device-123' }))
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/whoami') {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'unauthorized', reason: 'revoked' }))
    } else {
      res.end(JSON.stringify({ device_code: 'device-code', user_code: 'ABCD', verification_uri: 'https://scorpio.example.com/activate', verification_uri_complete: 'https://scorpio.example.com/activate?code=ABCD', expires_in: 900 }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await run(['daemon'], local, `http://127.0.0.1:${server.address().port}`)
    assert.equal(result.output.status, 'authorization_pending')
    assert.equal(result.output.user_code, 'ABCD')
    assert.equal(fs.existsSync(path.join(local, 'token')), false)
    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [['GET', '/api/v1/whoami'], ['POST', '/oauth/device/code']])
    assert.equal(requests[1].body.relogin, true)
    assert.equal(requests[1].body.device_id, 'existing-device-123')
  } finally { server.close(); fs.rmSync(local, { recursive: true, force: true }) }
})

test('daemon attempts startup after a valid token, a network failure or a server error', async () => {
  for (const outcome of ['ok', 'network', 'server_error']) {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-start-check-'))
    fs.writeFileSync(path.join(local, 'token'), 'current\n')
    const preload = path.join(local, 'fetch.mjs')
    fs.writeFileSync(preload, `
      import fs from 'node:fs'
      import path from 'node:path'
      globalThis.fetch = async (url) => {
        fs.appendFileSync(path.join(process.env.SCORPIO_HOME, 'requests'), String(url) + '\\n')
        if (${JSON.stringify(outcome)} === 'network') throw Object.assign(new Error('connection timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
        return new Response(JSON.stringify(${JSON.stringify(outcome)} === 'ok' ? { account: 'kai' } : { error: 'server_error' }), { status: ${outcome === 'ok' ? 200 : 503} })
      }
    `)
    try {
      const result = await run(['daemon'], local, 'https://scorpio.example.com', ['--import', preload])
      assert.equal(result.output.error, 'no_herdr')
      assert.deepEqual(fs.readFileSync(path.join(local, 'requests'), 'utf8').trim().split('\n'), ['https://scorpio.example.com/api/v1/whoami'])
      assert.equal(fs.readFileSync(path.join(local, 'token'), 'utf8'), 'current\n')
    } finally { fs.rmSync(local, { recursive: true, force: true }) }
  }
})

test('expected exits remove the refused token but preserve a newer token', () => {
  for (const reason of ['revoked', 'plan']) {
    for (const current of ['refused', 'new']) {
      fs.writeFileSync(TOKEN_FILE, current + '\n')
      const monitor = createLogoutMonitor({
        marked: () => false,
        onExpected: (cause, refusedToken) => {
          assert.equal(cause, reason)
          assert.equal(refusedToken, 'refused')
          forgetRejectedToken(refusedToken)
        },
      })
      for (let i = 0; i < 3; i += 1) monitor.observe({ code: 'unauthorized', reason, token: 'refused' })
      assert.equal(monitor.state(), 'expected')
      assert.equal(fs.existsSync(TOKEN_FILE), current === 'new')
      if (current === 'new') assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8'), 'new\n')
    }
  }
})

test('revoked and plan stop; replaced reloads the new local token', () => {
  for (const expectedReason of ['revoked', 'plan']) {
    const exits = []
    const monitor = createLogoutMonitor({ token: () => 'old', marked: () => false, onExpected: (reason) => exits.push(reason) })
    for (let i = 0; i < 3; i += 1) monitor.observe({ code: 'unauthorized', reason: expectedReason, token: 'old' })
    assert.deepEqual(exits, [expectedReason])
    assert.equal(monitor.state(), 'expected')
  }
  let reloads = 0
  const replaced = createLogoutMonitor({ token: () => 'new', marked: () => false, onReload: () => { reloads += 1 } })
  for (let i = 0; i < 3; i += 1) replaced.observe({ code: 'unauthorized', reason: 'replaced', token: 'old' })
  assert.equal(reloads, 1)
  assert.equal(replaced.state(), 'online')
})

test('network failures do not count, successes reset, and a 401 reason survives later missing-token answers', () => {
  const exits = []
  const monitor = createLogoutMonitor({ token: () => null, marked: () => false, onExpected: (reason) => exits.push(reason) })
  monitor.observe({ code: 'unauthorized', reason: 'revoked', token: 'old' })
  monitor.observe({ code: 'network' })
  monitor.observe({ code: 'not_logged_in' })
  assert.deepEqual(exits, [])
  monitor.observe({ code: 'ok' })
  monitor.observe({ code: 'unauthorized', reason: 'revoked', token: 'old' })
  monitor.observe({ code: 'not_logged_in' })
  assert.deepEqual(exits, [])
  monitor.observe({ code: 'not_logged_in' })
  assert.deepEqual(exits, ['revoked'])
})

test('an explicit local logout stops the daemon even if its WebSocket stays open', () => {
  const exits = []
  const monitor = createLogoutMonitor({ token: () => null, marked: () => true, onExpected: (reason) => exits.push(reason) })
  assert.equal(monitor.checkLocalLogout(), true)
  assert.deepEqual(exits, ['local logout'])
})

test('missing token without a mark requests a code and resumes after approval', async () => {
  let current = null, requested = 0, saved = 0, offline = 0, online = 0
  const monitor = createLogoutMonitor({
    token: () => current, marked: () => false, cache: () => null,
    requestCode: async () => { requested += 1; return { device_code: 'code', server: process.env.SCORPIO_SERVER, interval: 5, created_at: Date.now(), expires_at: Date.now() + 900_000 } },
    pollCode: async () => ({ status: 200, data: { access_token: 'new' } }),
    saveToken: (value) => { current = value; saved += 1 },
    onOffline: () => { offline += 1 }, onOnline: () => { online += 1 },
  })
  for (let i = 0; i < 3; i += 1) monitor.observe({ code: 'not_logged_in' })
  await monitor.settle()
  assert.deepEqual({ requested, saved, offline, online, state: monitor.state() }, { requested: 1, saved: 1, offline: 1, online: 1, state: 'online' })
})

test('an expired code is not replaced before ten minutes', async () => {
  let clock = 1000, current = null, requests = 0, clear = 0, resumeSleep
  const sleeps = []
  const monitor = createLogoutMonitor({
    token: () => current, marked: () => false, cache: () => null, now: () => clock,
    requestCode: async () => ({ device_code: `code-${++requests}`, server: process.env.SCORPIO_SERVER, interval: 5, created_at: clock, expires_at: clock + 900_000 }),
    pollCode: async () => requests === 1 ? { status: 400, data: { error: 'expired_token' } } : { status: 200, data: { access_token: 'new' } },
    saveToken: (value) => { current = value }, clearCode: () => { clear += 1 },
    sleep: (ms) => new Promise((resolve) => { sleeps.push(ms); resumeSleep = resolve }),
  })
  for (let i = 0; i < 3; i += 1) monitor.observe({ code: 'not_logged_in' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests, 1)
  assert.equal(clear, 1)
  assert.equal(sleeps[0], 5_000)
  clock += NEW_CODE_MS
  resumeSleep()
  await monitor.settle()
  assert.equal(requests, 2)
  assert.equal(monitor.state(), 'online')
})

test('unchanged token metadata does not read the token or request whoami', async () => {
  fs.writeFileSync(TOKEN_FILE, 'current\n')
  let reads = 0, checks = 0
  const monitor = createLogoutMonitor({ token: () => { reads += 1; return 'current' } })
  monitor.observe({ code: 'ok', token: 'current' })
  reads = 0
  const whoami = async () => { checks += 1 }
  for (let i = 0; i < 5; i += 1) await monitor.checkTokenFile(whoami)
  assert.deepEqual({ reads, checks }, { reads: 0, checks: 0 })
  fs.appendFileSync(TOKEN_FILE, '\n')
  await monitor.checkTokenFile(whoami)
  assert.deepEqual({ reads, checks }, { reads: 1, checks: 0 })
})

test('a deleted token makes one decisive whoami and requests relogin immediately', async () => {
  fs.writeFileSync(TOKEN_FILE, 'current\n')
  let checks = 0, requests = 0, fetches = 0, approve
  const monitor = createLogoutMonitor({
    marked: () => false, cache: () => null,
    requestCode: async () => { requests += 1; return { device_code: 'code', interval: 5 } },
    pollCode: () => new Promise((resolve) => { approve = resolve }),
    saveToken: (value) => fs.writeFileSync(TOKEN_FILE, value + '\n'),
  })
  const client = createApi({ onResult: monitor.observe, fetchImpl: async () => { fetches += 1; throw new Error('no token must not be sent') } })
  monitor.observe({ code: 'ok', token: 'current' })
  fs.unlinkSync(TOKEN_FILE)
  const whoami = (options) => { checks += 1; return client.whoami(options) }
  await assert.rejects(monitor.checkTokenFile(whoami), { code: 'not_logged_in' })
  await monitor.checkTokenFile(whoami)
  assert.deepEqual({ checks, requests, fetches, state: monitor.state() }, { checks: 1, requests: 1, fetches: 0, state: 'offline' })
  approve({ status: 200, data: { access_token: 'approved' } })
  await monitor.settle()
  await monitor.checkTokenFile(whoami)
  assert.equal(checks, 1)
  assert.equal(monitor.state(), 'online')
})

test('a new valid token is checked once and becomes the last good token', async () => {
  fs.writeFileSync(TOKEN_FILE, 'old\n')
  let requests = 0
  const monitor = createLogoutMonitor({ marked: () => false })
  const client = createApi({ onResult: monitor.observe, fetchImpl: async (_url, options) => {
    requests += 1
    assert.equal(options.headers.Authorization, 'Bearer new-valid')
    return new Response(JSON.stringify({ account: 'kai' }))
  } })
  monitor.observe({ code: 'ok', token: 'old' })
  fs.writeFileSync(TOKEN_FILE, 'new-valid\n')
  await monitor.checkTokenFile(client.whoami)
  await monitor.checkTokenFile(client.whoami)
  fs.appendFileSync(TOKEN_FILE, '\n')
  await monitor.checkTokenFile(client.whoami)
  assert.equal(requests, 1)
  assert.equal(monitor.state(), 'online')
})

test('a changed revoked or plan token exits on one answer and keeps a token written meanwhile', async () => {
  for (const reason of ['revoked', 'plan']) {
    for (const newer of [false, true]) {
      fs.writeFileSync(TOKEN_FILE, 'old\n')
      const exits = []
      const monitor = createLogoutMonitor({ marked: () => false, onExpected: (cause, refused) => { exits.push(cause); forgetRejectedToken(refused) } })
      const client = createApi({ onResult: monitor.observe, fetchImpl: async () => {
        if (newer) fs.writeFileSync(TOKEN_FILE, 'newer\n')
        return new Response(JSON.stringify({ error: 'unauthorized', reason }), { status: 401 })
      } })
      monitor.observe({ code: 'ok', token: 'old' })
      fs.writeFileSync(TOKEN_FILE, 'refused\n')
      await assert.rejects(monitor.checkTokenFile(client.whoami), { code: 'unauthorized', reason })
      assert.deepEqual(exits, [reason])
      assert.equal(monitor.state(), 'expected')
      assert.equal(fs.existsSync(TOKEN_FILE), newer)
      if (newer) assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8'), 'newer\n')
    }
  }
})

test('a decisive replaced answer reloads a newer token without waiting for three failures', async () => {
  fs.writeFileSync(TOKEN_FILE, 'old\n')
  let reloads = 0
  const monitor = createLogoutMonitor({ marked: () => false, onReload: () => { reloads += 1 } })
  const client = createApi({ onResult: monitor.observe, fetchImpl: async () => {
    fs.writeFileSync(TOKEN_FILE, 'new-valid\n')
    return new Response(JSON.stringify({ error: 'unauthorized', reason: 'replaced' }), { status: 401 })
  } })
  monitor.observe({ code: 'ok', token: 'old' })
  fs.writeFileSync(TOKEN_FILE, 'refused\n')
  await assert.rejects(monitor.checkTokenFile(client.whoami), { code: 'unauthorized', reason: 'replaced' })
  assert.equal(reloads, 1)
  assert.equal(monitor.state(), 'online')
})

test('a file change has one in-flight check; a network error does not change logout state', async () => {
  fs.writeFileSync(TOKEN_FILE, 'old\n')
  const monitor = createLogoutMonitor({ marked: () => false })
  monitor.observe({ code: 'ok', token: 'old' })
  fs.writeFileSync(TOKEN_FILE, 'new-valid\n')
  let checks = 0, fail
  const whoami = () => { checks += 1; return new Promise((_resolve, reject) => { fail = reject }) }
  const pending = monitor.checkTokenFile(whoami)
  await monitor.checkTokenFile(whoami)
  fail(Object.assign(new Error('network unavailable'), { code: 'network' }))
  await assert.rejects(pending, { code: 'network' })
  await monitor.checkTokenFile(whoami)
  assert.equal(checks, 1)
  assert.equal(monitor.state(), 'online')
})

test('4011 closes check whoami once immediately and exit on a revoked answer', async () => {
  fs.writeFileSync(TOKEN_FILE, 'current\n')
  const sockets = [], checks = [], exits = []
  let requests = 0
  class Socket extends EventTarget {
    constructor() { super(); sockets.push(this) }
    close() {}
    closed(code) { this.dispatchEvent(Object.assign(new Event('close'), { code })) }
  }
  const monitor = createLogoutMonitor({ marked: () => false, onExpected: (reason, refused) => { exits.push(reason); forgetRejectedToken(refused) } })
  const client = createApi({ onResult: monitor.observe, fetchImpl: async () => {
    requests += 1
    return new Response(JSON.stringify({ error: 'unauthorized', reason: 'revoked' }), { status: 401 })
  } })
  monitor.observe({ code: 'ok', token: 'current' })
  const links = createLinks({ api: client, WebSocketImpl: Socket, onFrame: () => {},
    onTokenRejected: () => { checks.push(monitor.checkToken(client.whoami)) },
  })
  try {
    links.sync([0, 1, 2].map((i) => ({ key: `h|topic-${i}`, roomId: `topic-${i}`, role: 'daemon', host: true })))
    sockets[0].closed(1006)
    assert.equal(requests, 0)
    sockets[1].closed(4011)
    sockets[2].closed(4011)
    assert.equal(requests, 1)
    await assert.rejects(checks[0], { code: 'unauthorized', reason: 'revoked' })
    await checks[1]
    assert.deepEqual(exits, ['revoked'])
    assert.equal(monitor.state(), 'expected')
    assert.equal(fs.existsSync(TOKEN_FILE), false)
  } finally { links.closeAll() }
})

test('offline cause distinguishes a missing token from a refused token without a reason', async () => {
  for (const current of [null, 'refused']) {
    let cause
    const monitor = createLogoutMonitor({
      token: () => current, marked: () => false, cache: () => null,
      requestCode: async () => ({ device_code: 'code' }),
      pollCode: async () => ({ status: 200, data: { access_token: 'new' } }), saveToken: () => {},
      onOffline: (value) => { cause = value },
    })
    monitor.observe({ code: current ? 'unauthorized' : 'not_logged_in', token: current, decisive: true })
    await monitor.settle()
    assert.equal(cause, current ? 'token refused' : 'token missing')
  }
})

test('recovery through the token file clears a code cached by requestDeviceCode', async () => {
  let current = null, wake
  const previousFetch = globalThis.fetch
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ device_id: 'existing-device-123' }))
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).relogin, true)
    return new Response(JSON.stringify({ device_code: 'code', user_code: 'BCDF-GHJK', verification_uri_complete: 'https://scorpio.example.com/activate?code=BCDF-GHJK', expires_in: 900 }))
  }
  try { await requestDeviceCode({ relogin: true }) }
  finally { globalThis.fetch = previousFetch }
  const cached = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'))
  assert.equal(Object.hasOwn(cached, 'relogin'), false)
  const monitor = createLogoutMonitor({
    token: () => current, marked: () => false,
    pollCode: async () => ({ status: 400, data: { error: 'authorization_pending' } }),
    sleep: () => new Promise((resolve) => { wake = resolve }),
    saveToken: () => assert.fail('file recovery does not redeem a code'),
    onOnline: () => assert.equal(fs.existsSync(DEVICE_FILE), false),
  })
  monitor.observe({ code: 'not_logged_in', decisive: true })
  await new Promise((resolve) => setImmediate(resolve))
  current = 'restored'
  wake()
  await monitor.settle()
  assert.equal(monitor.state(), 'online')
  assert.equal(fs.existsSync(DEVICE_FILE), false)
})

test('expected exits clear cached codes before the exit callback, including a local logout mark', () => {
  for (const cause of ['revoked', 'plan', 'mark', 'local']) {
    fs.writeFileSync(DEVICE_FILE, JSON.stringify({ device_code: 'old-code' }))
    let exited = false
    const monitor = createLogoutMonitor({ token: () => cause === 'local' ? null : 'refused', marked: () => ['mark', 'local'].includes(cause),
      onExpected: () => { exited = true; assert.equal(fs.existsSync(DEVICE_FILE), false) },
    })
    if (cause === 'local') monitor.checkLocalLogout()
    else monitor.observe({ code: 'unauthorized', token: 'refused', reason: ['mark'].includes(cause) ? null : cause, decisive: true })
    assert.equal(exited, true)
  }
})

test('daemon polls a cached pending code once immediately, then redeems it on a rerun after approval', async () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-cached-approval-'))
  let approved = false, polls = 0
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/oauth/token')
    polls += 1
    res.setHeader('content-type', 'application/json')
    res.writeHead(approved ? 200 : 400)
    res.end(JSON.stringify(approved ? { access_token: 'approved' } : { error: 'authorization_pending' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  const url = 'https://scorpio.example.com/activate?code=BCDF-GHJK'
  fs.writeFileSync(path.join(local, 'device.json'), JSON.stringify({ server: address, device_code: 'code', user_code: 'BCDF-GHJK', verification_uri_complete: url, interval: 5, expires_at: Date.now() + 900_000 }))
  try {
    const result = await run(['daemon'], local, address, [], 5000)
    assert.equal(result.output.status, 'authorization_pending')
    assert.equal(result.output.user_code, 'BCDF-GHJK')
    assert.equal(result.output.verification_uri_complete, url)
    assert.equal(polls, 1)
    approved = true
    const rerun = await run(['daemon'], local, address, [], 5000)
    assert.equal(rerun.output.error, 'no_herdr')
    assert.equal(polls, 2)
    assert.equal(fs.readFileSync(path.join(local, 'token'), 'utf8').trim(), 'approved')
    assert.equal(fs.existsSync(path.join(local, 'device.json')), false)
  } finally { server.close(); fs.rmSync(local, { recursive: true, force: true }) }
})

test('login keeps polling a pending cached code before redeeming it', async () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-login-poll-'))
  let polls = 0
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/oauth/token') {
      polls += 1
      res.writeHead(polls === 1 ? 400 : 200)
      res.end(JSON.stringify(polls === 1 ? { error: 'authorization_pending' } : { access_token: 'approved' }))
    } else res.end(JSON.stringify({ account: 'kai', device: 'box' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  fs.writeFileSync(path.join(local, 'device.json'), JSON.stringify({ server: address, device_code: 'code', interval: 0.01, expires_at: Date.now() + 900_000 }))
  try {
    const result = await run(['login'], local, address, [], 5000)
    assert.equal(result.output.status, 'logged_in')
    assert.equal(polls, 2)
  } finally { server.close(); fs.rmSync(local, { recursive: true, force: true }) }
})
