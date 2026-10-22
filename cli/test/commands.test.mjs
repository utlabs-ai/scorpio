import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'

const bin = fileURLToPath(new URL('../bin/scorpio.mjs', import.meta.url))
const ROOM = 'AbCdEf0123456789_-ghIJ'

test('join, wait, leave and logout work through the bin with isolated local state', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-commands-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, 'token'), 'test-token\n')
  const seen = []
  const joins = []
  let wake = true
  const server = http.createServer(async (req, res) => {
    if (req.url === `/api/v1/rooms/${ROOM}/join`) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      joins.push(JSON.parse(Buffer.concat(chunks).toString()))
    }
    seen.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    if (req.url === `/api/v1/rooms/${ROOM}/join`) return res.end(JSON.stringify({ roomId: ROOM, roomName: 'Test', topic: '', owner: 'kai', ownerDisplayName: 'Kai', name: 'api@kai', kind: 'agent' }))
    if (req.url === `/api/v1/rooms/${ROOM}/leave`) return res.end(JSON.stringify({ roomId: ROOM, name: 'api@kai', status: 'left' }))
    if (req.url === `/api/v1/rooms/${ROOM}/listen`) return res.end(JSON.stringify({
      me: 'api@kai', room: { name: 'Test', topic: '', owner: 'kai' }, members: [], items: [],
      mentions: wake ? [{ seq: 7, from: 'kai', fromKind: 'human', kind: 'text', text: '@api@kai hello', ts: 1 }] : [], broadcasts: [],
    }))
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not_found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = testEnv(home, {
    SCORPIO_HOME: home, SCORPIO_SERVER: `http://127.0.0.1:${server.address().port}`,
    CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '',
    PATH: '', HERDR_BIN_PATH: '', HERDR_ENV: '', HERDR_PANE_ID: '', HERDR_TAB_ID: '', HERDR_WORKSPACE_ID: '',
  })
  const run = (...args) => new Promise((resolve) => {
    const nodeArgs = args[0] === '--no-experimental-websocket' ? [args.shift()] : []
    execFile(process.execPath, [...nodeArgs, bin, ...args], { env, timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr })
    })
  })
  const join = await run('join', `topicId=${ROOM}`, 'role=api')
  assert.equal(join.status, 0, join.stderr || join.stdout)
  const joined = JSON.parse(join.stdout)
  assert.equal(joined.name, 'api@kai')
  assert.equal(joined.ownerDisplayName, 'Kai')
  assert.ok(joined.next.includes('Your owner is kai (nickname: Kai); report in to @kai with send'))
  assert.equal(joined.reason, 'no-herdr')
  assert.equal(joined.registered, false)
  assert.equal(joined.workspace, path.join(home, 'topics', ROOM, 'workspace'))
  assert.equal(joined.files, path.join(home, 'topics', ROOM, 'files'))
  assert.ok(fs.statSync(joined.workspace).isDirectory())
  assert.ok(fs.statSync(joined.files).isDirectory())
  assert.ok(seen.includes(`POST /api/v1/rooms/${ROOM}/join`))
  assert.equal(Object.hasOwn(joins[0], 'machine_id'), false)
  const sessions = fs.readdirSync(path.join(home, 'sessions'))
  assert.equal(sessions.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'sessions', sessions[0]), 'utf8')).rooms[ROOM].role, 'api')

  await t.test('join still binds and registers when local topic directories cannot be made', async () => {
    fs.rmSync(joined.workspace, { recursive: true })
    fs.writeFileSync(joined.workspace, 'blocked')
    const second = await run('join', `topicId=${ROOM}`, 'role=api', 'resume=true')
    assert.equal(second.status, 0, second.stderr || second.stdout)
    const out = JSON.parse(second.stdout)
    assert.equal(out.name, 'api@kai')
    assert.equal(out.workspace, null)
    assert.equal(out.files, null)
    assert.match(out.warn, /could not prepare local topic directories.*Not a directory/)
    assert.equal(out.reason, 'no-herdr', 'local registration still ran')
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'sessions', sessions[0]), 'utf8')).rooms[ROOM].role, 'api')
  })

  const delivered = await run('wait', `topicId=${ROOM}`, 'timeout=1')
  assert.equal(delivered.status, 0, delivered.stderr || delivered.stdout)
  assert.match(delivered.stdout, /#7 from kai \(human\)/)
  assert.match(delivered.stdout, /@api@kai hello/)
  assert.ok(seen.includes(`GET /api/v1/rooms/${ROOM}/listen`))

  wake = false
  const idle = await run('--no-experimental-websocket', 'wait', `topicId=${ROOM}`, 'timeout=1')
  assert.equal(idle.status, 0, idle.stderr || idle.stdout)
  assert.ok(idle.stdout.includes(`Scorpio topic "Test" (${ROOM}): no new messages for you.`))

  const leave = await run('leave', `topicId=${ROOM}`)
  assert.equal(leave.status, 0, leave.stderr || leave.stdout)
  assert.equal(JSON.parse(leave.stdout).status, 'left')
  assert.ok(seen.includes(`POST /api/v1/rooms/${ROOM}/leave`))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'sessions', sessions[0]), 'utf8')).rooms, {})

  fs.writeFileSync(path.join(home, 'device.json'), '{}')
  const confirm = await run('logout')
  assert.equal(confirm.status, 0, confirm.stderr || confirm.stdout)
  assert.equal(JSON.parse(confirm.stdout).status, 'confirm')
  assert.equal(fs.existsSync(path.join(home, 'token')), true)
  const logout = await run('logout', 'yes=true')
  assert.equal(logout.status, 0, logout.stderr || logout.stdout)
  assert.equal(JSON.parse(logout.stdout).status, 'logged_out')
  assert.equal(fs.existsSync(path.join(home, 'token')), false)
  assert.equal(fs.existsSync(path.join(home, 'device.json')), false)
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(home, 'state', 'logged-out'))).at, 'number')
})

test('login stops on device_limit and keeps the code for approval after a device is revoked', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-device-limit-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  let polls = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/oauth/token') {
      polls += 1
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'device_limit', current: 1, limit: 1, url: 'https://scorpio.test/settings#devices', next: '1/1 computers. Revoke one at https://scorpio.test/settings#devices or upgrade.' }))
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}`
  const deviceFile = path.join(home, 'device.json')
  fs.writeFileSync(deviceFile, JSON.stringify({ server: url, device_code: 'dc_test', user_code: 'BCDF-GHJK', interval: 5, expires_at: Date.now() + 60_000 }))
  const result = await new Promise((resolve) => execFile(process.execPath, [bin, 'login'], { env: testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: url }), timeout: 3_000 }, (error, stdout) => resolve({ code: error?.code ?? 0, out: JSON.parse(stdout || '{}') })))
  assert.equal(result.code, 1)
  assert.deepEqual(result.out, { error: 'device_limit', next: '1/1 computers. Revoke one at https://scorpio.test/settings#devices or upgrade.' })
  assert.equal(polls, 1)
  assert.ok(fs.existsSync(deviceFile))
})

test('login still sends the machine hash at computer authorization', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-login-machine-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  let sent
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    sent = { path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ device_code: 'device-test', user_code: 'TEST-CODE', verification_uri: 'https://scorpio.example.com/activate', expires_in: 900 }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const run = await new Promise((resolve) => execFile(process.execPath, [bin, 'login'], {
    env: testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: `http://127.0.0.1:${server.address().port}` }), timeout: 10_000,
  }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))
  assert.equal(run.code, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).status, 'authorization_pending')
  assert.equal(sent.path, '/oauth/device/code')
  const { machineId } = await import('../src/machine-id.mjs')
  const expected = machineId()
  if (expected) assert.equal(sent.body.machine_id, expected)
  else assert.equal(Object.hasOwn(sent.body, 'machine_id'), false)
})
