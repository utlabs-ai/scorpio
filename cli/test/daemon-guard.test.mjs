import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'
import { awakeDelta, advanceHangClock } from '../src/daemon/guard.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'src', 'daemon')
const fakeMain = `
// R2 health reporter: createHealth(
import fs from 'node:fs'
import path from 'node:path'
const home = process.env.SCORPIO_HOME
const app = path.join(home, 'app')
const state = path.join(home, 'state')
fs.mkdirSync(state, { recursive: true })
const build = fs.readFileSync(path.join(app, '.build'), 'utf8').trim()
const behavior = JSON.parse(fs.readFileSync(path.join(app, 'behavior.json'), 'utf8'))
fs.appendFileSync(path.join(home, 'starts'), build + '\\n')
if (fs.existsSync(path.join(state, 'daemon.pid'))) fs.writeFileSync(path.join(home, 'overlap'), 'yes')
fs.writeFileSync(path.join(state, 'daemon.pid'), String(process.pid))
const finish = (code) => { try { fs.unlinkSync(path.join(state, 'daemon.pid')) } catch {}; process.exit(code) }
process.on('SIGTERM', () => finish(0))
if (behavior.mode === 'crash') finish(1)
if (behavior.mode === 'planned' && build === 'bad-build') {
  fs.writeFileSync(path.join(app, '.build'), 'new-build')
  finish(0)
}
const begun = Date.now()
let goodAt = null
const write = () => {
  const checks = { signin: true, selfcheck: true, herdr: true }
  if (behavior.fail && (!behavior.recoverAfter || Date.now() - begun < behavior.recoverAfter)) checks[behavior.fail] = false
  const tmp = path.join(state, 'health.' + process.pid + '.tmp')
  fs.writeFileSync(tmp, JSON.stringify({ build, pid: process.pid, checks, aliveAt: Date.now() }))
  fs.renameSync(tmp, path.join(state, 'health'))
}
write()
setInterval(() => {
  if (behavior.hangAfterGood || behavior.exitAfterGood) {
    if (fs.readFileSync(path.join(state, 'good-build'), 'utf8').trim() === build) goodAt ??= Date.now()
    if (goodAt && Date.now() - goodAt > 100) {
      if (behavior.exitAfterGood) finish(1)
      return
    }
  }
  if (!behavior.hangAfter || Date.now() - begun < behavior.hangAfter) write()
}, 100)
if (behavior.exitAfter) setTimeout(() => finish(behavior.exitCode ?? 1), behavior.exitAfter)
`

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, ms = 45_000, detail = () => '') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await pause(25) }
  assert.fail(`timed out waiting for guard state: ${detail()}`)
}
const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' } }
const data = (file) => { try { return JSON.parse(read(file)) } catch { return null } }

function appAt(dir, build, behavior) {
  fs.mkdirSync(path.join(dir, 'src', 'daemon'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: build === 'old-build' ? '1.0.0' : '2.0.0' }))
  fs.writeFileSync(path.join(dir, '.build'), build)
  fs.writeFileSync(path.join(dir, 'behavior.json'), JSON.stringify(behavior))
  fs.writeFileSync(path.join(dir, 'src', 'daemon', 'main.mjs'), fakeMain)
  fs.copyFileSync(path.join(source, 'run-daemon.sh'), path.join(dir, 'src', 'daemon', 'run-daemon.sh'))
  fs.copyFileSync(path.join(source, 'guard.mjs'), path.join(dir, 'src', 'daemon', 'guard.mjs'))
  fs.copyFileSync(path.join(source, 'health.mjs'), path.join(dir, 'src', 'daemon', 'health.mjs'))
  fs.writeFileSync(path.join(dir, 'defaults.json'), JSON.stringify({ server: 'http://invalid.test' }))
}

function frame(text) {
  const bytes = Buffer.from(text)
  return Buffer.concat([Buffer.from([0x81, bytes.length]), bytes])
}
function stubServer(home) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/v1/whoami') {
      res.writeHead(req.headers.authorization === 'Bearer test-token' ? Number(read(path.join(home, 'whoami-status'))) || 200 : 401, { 'content-type': 'application/json' })
      res.end('{}')
    } else { res.writeHead(404); res.end() }
  })
  const sockets = new Set()
  srv.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  srv.destroySockets = () => { for (const socket of sockets) socket.destroy() }
  srv.on('upgrade', (req, socket) => {
    if (req.url !== '/api/v1/selfcheck' || req.headers.authorization !== 'Bearer test-token' || fs.existsSync(path.join(home, 'selfcheck-fail'))) { socket.destroy(); return }
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const nonce = 'test-nonce'
    setTimeout(() => { if (!socket.destroyed) socket.write(frame(JSON.stringify({ type: 'selfcheck', nonce }))) }, 10)
    socket.on('data', (bytes) => {
      if (bytes.length < 6 || (bytes[0] & 0x0f) !== 1) return
      const length = bytes[1] & 0x7f
      const mask = bytes.subarray(2, 6)
      const message = Buffer.from(bytes.subarray(6, 6 + length))
      for (let i = 0; i < message.length; i += 1) message[i] ^= mask[i % 4]
      if (dataMessage(message)?.nonce === nonce) socket.write(frame(JSON.stringify({ type: 'selfcheck_ok' })))
      else socket.destroy()
    })
  })
  return srv
}
const dataMessage = (bytes) => { try { return JSON.parse(bytes.toString()) } catch { return null } }

async function fixture(t, { badBehavior = {}, oldBehavior = {}, previous = true, protectedPrevious = true, good = 'old-build', environment = null, hangMs = 30_000, trialMs = 12_000 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-guard-'))
  const bin = path.join(home, 'bin')
  fs.mkdirSync(path.join(home, 'state'), { recursive: true })
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(home, 'token'), 'test-token')
  fs.writeFileSync(path.join(home, 'state', 'good-build'), good)
  if (environment === '503' || environment === '401') fs.writeFileSync(path.join(home, 'whoami-status'), environment)
  if (environment === 'selfcheck') fs.writeFileSync(path.join(home, 'selfcheck-fail'), '')
  if (environment === 'herdr') fs.writeFileSync(path.join(home, 'herdr-fail'), '')
  fs.writeFileSync(path.join(bin, 'herdr'), '#!/bin/sh\n[ -f "$SCORPIO_HOME/herdr-fail" ] && exit 1\necho \'{"result":{"panes":[]}}\'\n', { mode: 0o755 })
  appAt(path.join(home, 'app'), 'bad-build', badBehavior)
  if (previous) {
    appAt(path.join(home, 'app.prev'), 'old-build', oldBehavior)
    if (!protectedPrevious) fs.rmSync(path.join(home, 'app.prev', 'src', 'daemon', 'guard.mjs'))
  }
  const server = stubServer(home)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = testEnv(home, {
    SCORPIO_HOME: home, SCORPIO_SERVER: `http://127.0.0.1:${server.address().port}`,
    PATH: `${bin}:${process.env.PATH}`, HERDR_BIN_PATH: '', SCORPIO_GUARD_TICK_MS: '500', SCORPIO_GUARD_RESTART_MS: '50',
    SCORPIO_GUARD_CHECK_MS: '5000', SCORPIO_GUARD_CHECK_WINDOW_MS: '12000',
    SCORPIO_GUARD_TRIAL_MS: String(trialMs), SCORPIO_GUARD_HANG_MS: String(hangMs), SCORPIO_GUARD_CONFIRM_MS: '500',
    SCORPIO_GUARD_STOP_MS: '500', SCORPIO_GUARD_SLEEP_GAP_MS: '60000',
  })
  const guard = spawn('sh', [path.join(home, 'app', 'src', 'daemon', 'run-daemon.sh')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  guard.stderr.on('data', (chunk) => { errors = `${errors}${chunk}`.slice(-2_000) })
  t.after(async () => {
    if (guard.exitCode === null) { guard.kill('SIGTERM'); await Promise.race([new Promise((resolve) => guard.once('exit', resolve)), pause(1_000)]) }
    server.destroySockets()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { home, guard, env, errors: () => errors, file: (...parts) => path.join(home, ...parts), rollback: () => data(path.join(home, 'state', 'rollback.json')) }
}

test('three crashes roll back, record the failed build, and release the daemon lock before the previous build starts', async (t) => {
  const f = await fixture(t, { badBehavior: { mode: 'crash' } })
  await until(() => f.rollback(), 45_000, () => JSON.stringify({ errors: f.errors(), exit: f.guard.exitCode, starts: read(f.file('starts')), health: data(f.file('state', 'health')), app: read(f.file('app', '.build')) }))
  assert.equal(f.rollback().reason, 'crash')
  assert.deepEqual(f.rollback().bad, { version: '2.0.0', build: 'bad-build' })
  assert.equal(read(f.file('app', '.build')), 'old-build')
  await until(() => read(f.file('starts')).includes('old-build'))
  assert.equal(read(f.file('overlap')), '')
})

for (const failed of ['signin', 'selfcheck', 'herdr']) test(`${failed} failing only in the build rolls back`, async (t) => {
  const f = await fixture(t, { badBehavior: { fail: failed } })
  await until(() => data(f.file('state', 'health'))?.checks?.[failed] === false)
  await pause(1_000)
  assert.equal(f.rollback(), null, 'a failed startup check gets its full awake window')
  await until(() => f.rollback())
  assert.equal(f.rollback().reason, failed)
})

test('a startup check that recovers inside the awake window does not roll back', async (t) => {
  const f = await fixture(t, { badBehavior: { fail: 'signin', recoverAfter: 9_000 } })
  await until(() => read(f.file('state', 'good-build')) === 'bad-build')
  assert.equal(f.rollback(), null)
})

for (const environment of ['503', '401', 'selfcheck', 'herdr']) test(`${environment} failing for the guard too pauses probation without rollback`, async (t) => {
  const failed = environment === 'selfcheck' ? 'selfcheck' : environment === 'herdr' ? 'herdr' : 'signin'
  const f = await fixture(t, { badBehavior: { fail: failed }, environment })
  await pause(13_000)
  assert.equal(f.rollback(), null)
  assert.equal(read(f.file('app', '.build')), 'bad-build')
})

test('a hanging build during probation rolls back; after probation it only restarts', async (t) => {
  const f = await fixture(t, { badBehavior: { hangAfter: 1 }, hangMs: 10_000, trialMs: 30_000 })
  await until(() => f.rollback())
  assert.equal(f.rollback().reason, 'hang')
})

test('a hang after probation restarts without rolling back', async (t) => {
  const f = await fixture(t, { badBehavior: { hangAfterGood: true }, hangMs: 10_000 })
  await until(() => read(f.file('state', 'good-build')) === 'bad-build', 45_000, () => JSON.stringify({ errors: f.errors(), starts: read(f.file('starts')), health: data(f.file('state', 'health')), good: read(f.file('state', 'good-build')), rollback: f.rollback() }))
  await until(() => read(f.file('starts')).split('\n').filter((x) => x === 'bad-build').length >= 2)
  assert.equal(f.rollback(), null)
})

test('a crash after probation restarts without rolling back', async (t) => {
  const f = await fixture(t, { badBehavior: { exitAfterGood: true } })
  await until(() => read(f.file('state', 'good-build')) === 'bad-build')
  await until(() => read(f.file('starts')).split('\n').filter((x) => x === 'bad-build').length >= 2)
  assert.equal(f.rollback(), null)
})

test('a planned exit after a disk build change does not count as a crash', async (t) => {
  const f = await fixture(t, { badBehavior: { mode: 'planned' } })
  await until(() => read(f.file('state', 'good-build')) === 'new-build', 45_000, () => JSON.stringify({ errors: f.errors(), starts: read(f.file('starts')), good: read(f.file('state', 'good-build')), health: data(f.file('state', 'health')), current: read(f.file('app', '.build')) }))
  assert.equal(f.rollback(), null)
})

test('changing the disk build does not judge the old running process', async (t) => {
  const f = await fixture(t, { badBehavior: { fail: 'signin' } })
  await until(() => read(f.file('starts')).includes('bad-build'))
  fs.writeFileSync(f.file('app', '.build'), 'new-build')
  await pause(800)
  assert.equal(f.rollback(), null)
})

test('an unhealthy previous build is swapped back and the rollback record is removed', async (t) => {
  const f = await fixture(t, { badBehavior: { fail: 'signin' }, oldBehavior: { fail: 'signin' } })
  await until(() => f.rollback())
  await until(() => !f.rollback() && read(f.file('app', '.build')) === 'bad-build')
})

test('a healthy first install writes good-build and no previous copy keeps restarting', async (t) => {
  const first = await fixture(t, { good: '' })
  await until(() => read(first.file('state', 'good-build')) === 'bad-build')
  const noPrev = await fixture(t, { badBehavior: { mode: 'crash' }, previous: false })
  await until(() => read(noPrev.file('starts')).split('\n').filter(Boolean).length >= 3)
  assert.equal(noPrev.rollback(), null)
})

test('a pre-R2 previous app is not restored and the reason is logged', async (t) => {
  const f = await fixture(t, { badBehavior: { mode: 'crash' }, protectedPrevious: false })
  await until(() => read(f.file('state', 'daemon.log')).includes('app.prev lacks the R2 guard and health reporter'))
  await until(() => read(f.file('starts')).split('\n').filter((x) => x === 'bad-build').length >= 4)
  assert.equal(f.rollback(), null)
  assert.equal(read(f.file('app', '.build')), 'bad-build')
  assert.match(read(f.file('state', 'daemon.log')), /app\.prev lacks the R2 guard and health reporter/)
})

test('a sleep gap does not advance the trial clock', () => {
  assert.equal(awakeDelta(15_000, 60_000), 15_000)
  assert.equal(awakeDelta(61_000, 60_000), 0)
})

test('a wall-clock sleep gap and the next heartbeat cannot trigger a hang verdict', () => {
  const hangMs = 10 * 60_000
  let clock = { aliveAt: null, awake: 0 }
  for (let n = 0; n < 39; n += 1) clock = advanceHangClock(clock, 1_000, 15_000)
  clock = advanceHangClock(clock, 1_000, 30 * 60_000)
  assert.equal(clock.awake > hangMs, false, 'stale heartbeat after sleep does not restart or roll back')
  clock = advanceHangClock(clock, 1_900_000, 15_000)
  assert.equal(clock.awake, 0, 'fresh heartbeat clears awake hang time')
  for (let n = 0; n < 41; n += 1) clock = advanceHangClock(clock, 1_900_000, 15_000)
  assert.equal(clock.awake > hangMs, true, 'a real awake hang still reaches the verdict')

  let launching = { aliveAt: null, awake: 0 }
  launching = advanceHangClock(launching, null, 30 * 60_000)
  assert.equal(launching.awake >= hangMs, false, 'sleep before first health does not count as a hang')
  for (let n = 0; n < 40; n += 1) launching = advanceHangClock(launching, null, 15_000)
  assert.equal(launching.awake >= hangMs, true, 'missing health for awake hang time still counts')
})
