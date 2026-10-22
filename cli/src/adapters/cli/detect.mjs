// Which agent CLIs are installed on this computer, and their versions, nothing more.
// Never reads login state, credentials, the keychain or config files.
//
// "Installed" means the command resolves to an executable file the way the /spawn tab will find it: first
// `command -v` in the person's login shell, so a PATH set only in shell startup files counts; if that finds
// nothing, the daemon's own PATH. A shell alias is not a command and does not count.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CLIS, KINDS } from './index.mjs'

export const DETECT_TIMEOUT_MS = 5000
const OUTPUT_MAX = 64 * 1024

/**
 * Run a program, answering {code, stdout, stderr, timedOut}. Past the limit the whole process group is killed
 * (a CLI's launcher may have started children). Never rejects: a program that cannot start answers {error}.
 */
export function run(file, args, { env = process.env, timeoutMs = DETECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }) } catch (error) { return resolve({ error: error.code || String(error.message) }) }
    let stdout = '', stderr = '', timedOut = false, done = false
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout, stderr, timedOut, ...result }) }
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
      finish({ code: null })
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (d) => { if (stdout.length < OUTPUT_MAX) stdout += d })
    child.stderr.on('data', (d) => { if (stderr.length < OUTPUT_MAX) stderr += d })
    child.on('error', (error) => finish({ error: error.code || String(error.message), code: null }))
    child.on('close', (code) => finish({ code }))
  })
}

const isExecutable = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}

/** The command on the daemon's own PATH: an executable regular file, else null. */
export function findOnPath(command, pathEnv = process.env.PATH || '') {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, command)
    if (isExecutable(file)) return file
  }
  return null
}

/**
 * The command as the person's login shell finds it (`$SHELL -lc 'command -v …'`), else null. Startup files may
 * print things of their own, so only the last line that is an absolute path counts (an alias or function prints
 * its name or definition instead, and is not a command).
 */
export async function findInLoginShell(command, { shell = process.env.SHELL || os.userInfo().shell || '/bin/sh', env = process.env, runner = run } = {}) {
  const answer = await runner(shell, ['-lc', `command -v -- ${command}`], { env, timeoutMs: DETECT_TIMEOUT_MS })
  if (answer.error || answer.timedOut) return null
  const found = answer.stdout.split('\n').map((line) => line.trim()).filter((line) => path.isAbsolute(line)).at(-1)
  return found && isExecutable(found) ? found : null
}

const VERSION = /\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?/

/** The version number in a CLI's `--version` output (stdout first, then stderr); else its first non-empty line, cut to 40 characters; else null. */
export function parseVersion(stdout = '', stderr = '') {
  for (const text of [stdout, stderr]) { const m = VERSION.exec(text); if (m) return m[0] }
  for (const text of [stdout, stderr]) {
    const line = text.split('\n').map((l) => l.trim()).find(Boolean)
    if (line) return line.slice(0, 40)
  }
  return null
}

/** One kind: {kind, installed, version, at}. Failures are not retried; a CLI found but silent is installed with version null. */
export async function detectKind(kind, { command = kind, now = Date.now, shellFind = findInLoginShell, pathFind = findOnPath, runner = run, env = process.env } = {}) {
  const at = now()
  let file = null
  try { file = await shellFind(command) } catch {}
  if (!file) { try { file = pathFind(command) } catch {} }
  if (!file) return { kind, installed: false, version: null, at }
  const answer = await runner(file, ['--version'], { env, timeoutMs: DETECT_TIMEOUT_MS })
  const version = answer.error || answer.timedOut ? null : parseVersion(answer.stdout, answer.stderr)
  return { kind, installed: true, version, at }
}

/**
 * What the daemon knows of its computer's CLIs: the last result per kind, in memory. detect(kinds) looks again
 * (the kinds at once) and keeps what it finds; a second call for a kind already being looked at joins that look.
 */
export function createDetector({ kinds = KINDS, detectOne = detectKind, log = () => {} } = {}) {
  const last = new Map()
  const running = new Map()
  async function detect(which = kinds) {
    await Promise.all(which.map((kind) => {
      if (!running.has(kind)) {
        running.set(kind, Promise.resolve().then(() => detectOne(kind)).then((result) => { last.set(kind, result); return result }, (error) => {
          log(`detecting ${kind} failed: ${String(error?.message || error).slice(0, 80)}`)
        }).finally(() => running.delete(kind)))
      }
      return running.get(kind)
    }))
    return list()
  }
  /** The last results in kind order, only the kinds looked at so far. */
  const list = () => kinds.filter((kind) => last.has(kind)).map((kind) => last.get(kind))
  return { detect, list, get: (kind) => last.get(kind) || null, ready: () => last.size > 0 }
}

/** `Claude Code 2.1.301; Codex not installed.` (nothing installed: `no supported agent yet.`); '' before any detection. */
export function detectedText(results) {
  if (!results.length) return ''
  if (!results.some((r) => r.installed)) return 'Detected: no supported agent yet.'
  const part = (r) => `${CLIS[r.kind].label} ${r.installed ? (r.version ? r.version : '(version unknown)') : 'not installed'}`
  return `Detected: ${results.map(part).join('; ')}.`
}

/** Public role cards carry installed kinds; the version report is kept separately. */
export function agentClisText(results) {
  if (!results.some((r) => r.installed)) return 'Agent CLIs: none yet.'
  return `Agent CLIs: ${KINDS.map((kind) => `${CLIS[kind].label}${results.find((r) => r.kind === kind)?.installed ? '' : ' not installed'}`).join('; ')}.`
}

/** Do two detections differ in which CLIs are installed? (A version change alone is not.) */
export const installedChanged = (a, b) => KINDS.some((kind) => Boolean(a?.find((r) => r.kind === kind)?.installed) !== Boolean(b?.find((r) => r.kind === kind)?.installed))
export const versionsChanged = (a, b) => KINDS.some((kind) => (a?.find((r) => r.kind === kind)?.version ?? null) !== (b?.find((r) => r.kind === kind)?.version ?? null))
