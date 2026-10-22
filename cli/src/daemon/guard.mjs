#!/usr/bin/env node
// Loaded before app/ is replaced. Keep this file independent of every module in the installed app.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)
const home = process.env.SCORPIO_HOME || path.join(os.homedir(), '.scorpio')
const app = path.join(home, 'app')
const prev = path.join(home, 'app.prev')
const bad = path.join(home, 'app.bad')
const state = path.join(home, 'state')
const healthFile = path.join(state, 'health')
const goodFile = path.join(state, 'good-build')
const rollbackFile = path.join(state, 'rollback.json')
const pidFile = path.join(state, 'daemon.pid')
const sourceDir = path.dirname(fileURLToPath(import.meta.url))
const installed = (() => {
  try { return fs.realpathSync(path.resolve(sourceDir, '..', '..')) === fs.realpathSync(app) }
  catch { return false }
})()
const setting = (name, fallback) => {
  const value = Number(process.env[`SCORPIO_GUARD_${name}`])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const TICK_MS = setting('TICK_MS', 15_000)
const RESTART_MS = setting('RESTART_MS', 5_000)
const CHECK_MS = setting('CHECK_MS', 60_000)
const CHECK_WINDOW_MS = setting('CHECK_WINDOW_MS', 10 * 60_000)
const TRIAL_MS = setting('TRIAL_MS', 60 * 60_000)
const HANG_MS = setting('HANG_MS', 10 * 60_000)
const CONFIRM_MS = setting('CONFIRM_MS', 2 * 60_000)
const STOP_MS = setting('STOP_MS', 10_000)
const SLEEP_GAP_MS = setting('SLEEP_GAP_MS', 60_000)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const awakeDelta = (delta, sleepGapMs = SLEEP_GAP_MS) => delta <= sleepGapMs ? Math.max(0, delta) : 0
export const advanceHangClock = (clock, aliveAt, delta) =>
  aliveAt != null && aliveAt !== clock.aliveAt
    ? { aliveAt, awake: 0 }
    : { aliveAt: clock.aliveAt, awake: clock.awake + awakeDelta(delta) }
const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' } }
const json = (file) => { try { return JSON.parse(read(file)) } catch { return null } }
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(tmp, file)
}
const unlink = (file) => { try { fs.unlinkSync(file) } catch (e) { if (e.code !== 'ENOENT') throw e } }
const identity = (dir) => {
  const pkg = json(path.join(dir, 'package.json'))
  if (!pkg?.version || !fs.existsSync(path.join(dir, 'src', 'daemon', 'main.mjs'))) return null
  return { version: pkg.version, build: read(path.join(dir, '.build')) || pkg.version }
}
const same = (a, b) => Boolean(a && b && a.build === b.build)
const server = () => String(process.env.SCORPIO_SERVER || json(path.join(home, 'config.json'))?.server || json(path.join(app, 'defaults.json'))?.server || 'https://scorpio.utlabs.ai').replace(/\/+$/, '')
const token = () => read(path.join(home, 'token'))
const log = (line) => process.stderr.write(`[scorpio guard] ${line}\n`)
const unprotectedLogged = new Set()
function protectedPrevious(failed) {
  const ready = identity(prev) && fs.existsSync(path.join(prev, 'src', 'daemon', 'guard.mjs')) &&
    fs.existsSync(path.join(prev, 'src', 'daemon', 'health.mjs')) &&
    /createHealth\s*\(/.test(read(path.join(prev, 'src', 'daemon', 'main.mjs')))
  if (!ready && !unprotectedLogged.has(failed.build)) {
    unprotectedLogged.add(failed.build)
    const cause = fs.existsSync(prev) ? 'app.prev lacks the R2 guard and health reporter' : 'app.prev is absent'
    const line = `cannot roll back ${failed.version}: ${cause}; restarting this build`
    log(line)
    try {
      fs.mkdirSync(state, { recursive: true, mode: 0o700 })
      fs.appendFileSync(path.join(state, 'daemon.log'), `${new Date().toISOString().replace('Z', '+00:00')}\twarn\t${line}\n`, { mode: 0o600 })
    } catch {}
  }
  return Boolean(ready)
}

async function signin() {
  const t = token()
  if (!t) return false
  try {
    const response = await fetch(`${server()}/api/v1/whoami`, {
      headers: { Authorization: `Bearer ${t}`, 'X-Scorpio-Cli': identity(app)?.version || '0.0.0' },
      signal: AbortSignal.timeout(CHECK_MS),
    })
    return response.ok
  } catch { return false }
}

async function selfcheck() {
  const t = token()
  if (!t || typeof WebSocket !== 'function') return false
  return new Promise((resolve) => {
    let socket, timer
    const done = (ok) => { clearTimeout(timer); try { socket?.close() } catch {}; resolve(ok) }
    timer = setTimeout(() => done(false), CHECK_MS)
    try {
      socket = new WebSocket(`${server().replace(/^http/, 'ws')}/api/v1/selfcheck`, {
        headers: { Authorization: `Bearer ${t}`, 'X-Scorpio-Cli': identity(app)?.version || '0.0.0' },
      })
      let nonce = null
      socket.addEventListener('message', (event) => {
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return done(false) }
        if (!nonce && frame.type === 'selfcheck' && typeof frame.nonce === 'string' && frame.nonce) {
          nonce = frame.nonce
          try { socket.send(JSON.stringify({ type: 'selfcheck', nonce })) } catch { done(false) }
        } else if (nonce && frame.type === 'selfcheck_ok') done(true)
        else done(false)
      })
      socket.addEventListener('error', () => done(false))
      socket.addEventListener('close', () => done(false))
    } catch { done(false) }
  })
}

async function herdr() {
  try {
    const { stdout } = await execFileP(process.env.HERDR_BIN_PATH || 'herdr', ['pane', 'list'], { timeout: CHECK_MS })
    return Array.isArray(JSON.parse(stdout)?.result?.panes)
  } catch { return false }
}

const probes = { signin, selfcheck, herdr }
const allProbes = async () => (await Promise.all(Object.values(probes).map((probe) => probe()))).every(Boolean)
const healthy = (record, child) => record?.pid === child.pid && record.build === child.build &&
  Object.values(record.checks || {}).length === 3 && Object.values(record.checks).every((v) => v === true)

async function stop(child) {
  if (!child || child.exited) return
  child.proc.kill('SIGTERM')
  await Promise.race([child.exitedPromise, wait(STOP_MS)])
  if (!child.exited) { child.proc.kill('SIGKILL'); await child.exitedPromise }
  // The daemon releases its PID lock on exit. Do not launch another copy until it is gone.
  for (let n = 0; n < 100 && read(pidFile) === String(child.pid); n += 1) await wait(100)
}

function swapToPrevious(failed, reason) {
  if (!protectedPrevious(failed)) return null
  const restored = identity(prev)
  if (!restored || same(failed, restored)) return null
  fs.rmSync(bad, { recursive: true, force: true })
  fs.renameSync(app, bad)
  fs.renameSync(prev, app)
  const record = { bad: failed, good: restored, at: Date.now(), reason }
  save(rollbackFile, record)
  log(`restored ${restored.version} after ${reason} in ${failed.version}`)
  return record
}

function swapBack() {
  fs.rmSync(prev, { recursive: true, force: true })
  fs.renameSync(app, prev)
  fs.renameSync(bad, app)
  unlink(rollbackFile)
  log('previous build also failed its checks; returned to the newer build')
}

async function run() {
  let stopping = false, child = null, trial = null, restored = null, abandoned = null
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    stopping = true
    child?.proc.kill('SIGTERM')
  })
  for (;;) {
    if (stopping) return
    // R1 may be between the two renames. Its shell re-check also covers startup.
    let build = installed ? identity(app) : (fs.existsSync(path.join(sourceDir, 'main.mjs')) ? { version: 'checkout', build: 'checkout' } : null)
    for (let n = 0; !build && n < 100; n += 1) { await wait(100); build = identity(app) }
    if (!build) { log('main.mjs is missing'); return }
    if (!trial || !same(trial.build, build)) trial = { build, awake: 0, last: Date.now(), crashes: 0, confirmations: {} }
    const proc = spawn(process.execPath, [installed ? path.join(app, 'src', 'daemon', 'main.mjs') : path.join(sourceDir, 'main.mjs')], {
      stdio: 'inherit', env: { ...process.env, SCORPIO_GUARD: '1' },
    })
    child = { proc, pid: proc.pid, build: build.build, hang: { aliveAt: null, awake: 0 }, checkAwake: 0, exited: false }
    child.exitedPromise = new Promise((resolve) => proc.once('exit', (code, signal) => { child.exited = true; child.code = code; child.signal = signal; resolve() }))
    if (!installed) { // A checkout has no stable app.prev or installer-managed build.
      await child.exitedPromise
      if (child.code === 3 || child.code === 4 || stopping) return
      await wait(RESTART_MS)
      continue
    }
    let action = null
    while (!child.exited && !stopping) {
      await Promise.race([child.exitedPromise, wait(TICK_MS)])
      if (child.exited || stopping) break
      const now = Date.now()
      const delta = now - trial.last
      trial.last = now
      // A newly installed disk build never judges the process still running the older build.
      if (!same(identity(app), build)) continue
      const health = json(healthFile)
      const ownHealth = health?.pid === child.pid && health.build === build.build
      child.hang = advanceHangClock(child.hang, ownHealth ? health.aliveAt : null, delta)
      const good = read(goodFile)
      const inTrial = good !== build.build && abandoned !== build.build
      if (restored && same(restored.good, build)) {
        if (healthy(health, child)) { restored = null; trial.awake = 0; trial.confirmations = {} }
        else {
          trial.awake += awakeDelta(delta)
          if (trial.awake >= CHECK_WINDOW_MS) { action = 'swap-back'; break }
          continue
        }
      }
      if (!inTrial) {
        if (ownHealth && child.hang.awake > HANG_MS) { action = 'restart'; break }
        continue
      }
      let failure = null
      if (ownHealth) {
        for (const name of Object.keys(probes)) if (health.checks?.[name] !== true) { failure = name; break }
        if (!failure && child.hang.awake > HANG_MS) failure = 'hang'
      } else if (child.hang.awake >= HANG_MS) failure = 'hang'
      if (failure) {
        const environmentOK = failure === 'hang' ? await allProbes() : await probes[failure]()
        if (child.exited) break
        if (!environmentOK) { trial.confirmations = {}; continue } // environment: pause the awake clock
        if (failure === 'hang') { action = 'hang'; break }
        if (child.checkAwake >= CHECK_WINDOW_MS) {
          const first = trial.confirmations[failure]
          if (first != null && now - first >= CONFIRM_MS) { action = failure; break }
          trial.confirmations[failure] ??= now
        }
      } else trial.confirmations = {}
      const awake = awakeDelta(delta)
      trial.awake += awake
      child.checkAwake += awake
      if (healthy(health, child) && (!good || trial.awake >= TRIAL_MS)) {
        save(goodFile, build.build)
        if (json(rollbackFile)?.bad?.build !== build.build && json(rollbackFile)?.good?.build !== build.build) unlink(rollbackFile)
        trial.confirmations = {}
      }
    }
    if (stopping) { await stop(child); return }
    if (action === 'restart') { await stop(child); trial.crashes = 0 }
    if (action === 'swap-back') {
      await stop(child)
      swapBack()
      abandoned = restored?.bad.build || build.build
      restored = null
      trial = null
      continue
    }
    if (action && action !== 'restart') {
      await stop(child)
      const record = swapToPrevious(build, action)
      if (record) { restored = record; trial = null; continue }
    }
    if (child.code === 3 || child.code === 4) return
    const changed = !same(identity(app), build)
    if (!action && !(child.code === 0 && changed)) trial.crashes += 1
    if (!action && trial.crashes >= 3 && read(goodFile) !== build.build &&
        abandoned !== build.build && same(identity(app), build) && await allProbes()) {
      const record = swapToPrevious(build, 'crash')
      if (record) { restored = record; trial = null; continue }
    }
    if (child.code === 0 && changed) trial.crashes = 0
    await wait(RESTART_MS)
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await run()
