// One daemon per computer: two would run every room command twice (/spawn would start two agents).
// The lock is a pid file created atomically; a stale one (dead process, or a pid reused by something
// else after a reboot) is cleared.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PID_FILE } from './paths.mjs'

/** A pid that really is a running daemon. */
export function isDaemonPid(pid) {
  if (!pid || pid === process.pid) return false
  try { process.kill(pid, 0) } catch { return false }
  try { return /src\/daemon\/main\.mjs/.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })) } catch { return false }
}

/** The running daemon's pid, or null. */
export function daemonPid(file = PID_FILE) {
  try { const pid = Number(fs.readFileSync(file, 'utf8')); return isDaemonPid(pid) ? pid : null } catch { return null }
}

/** Take the lock. null when taken; else the pid of the daemon holding it. */
export function takeLock(file = PID_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const holder = () => { try { return Number(fs.readFileSync(file, 'utf8')) } catch { return 0 } }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); break } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // The other one may have created the file without writing its pid yet: look again before calling it dead.
      let other = holder()
      if (!other) { pause(300); other = holder() }
      if (isDaemonPid(other)) return other
      if (attempt === 1) return other || -1
      try { fs.unlinkSync(file) } catch {}
    }
  }
  const release = () => { try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file) } catch {} }
  process.on('exit', release)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { release(); process.exit(0) })
  return null
}
