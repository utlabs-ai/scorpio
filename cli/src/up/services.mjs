import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { HOME, TOKEN_FILE, server, readJson, writeJson } from '../daemon/paths.mjs'

const execFileP = promisify(execFile)
export const homeDir = HOME
export const userHome = os.homedir()
export const cliPath = path.join(HOME, 'bin', 'scorpio')

export function onPath(name, env = process.env) {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    try { fs.accessSync(file, fs.constants.X_OK); return file } catch {}
  }
  return null
}

export async function command(program, args, { timeout = 30_000, env = process.env, json = true } = {}) {
  let output
  try {
    output = await execFileP(program, args, { env, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    const raw = String(error.stdout || error.stderr || error.message || '').trim()
    let message = raw
    try { const parsed = JSON.parse(raw); message = parsed.next || parsed.error?.message || parsed.error || raw } catch {}
    throw new Error(String(message).slice(0, 600))
  }
  const text = String(output.stdout || '').trim()
  if (!json) return text
  try { return JSON.parse(text) } catch { throw new Error(program + ' returned invalid JSON.') }
}

export const cli = (action, args = [], options) => command(cliPath, [action, ...args], options)
export const herdr = (bin, args, options) => command(bin, args, options)

export async function api(method, endpoint, body, { role = null } = {}) {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  if (!token) throw new Error('Scorpio authorization is missing.')
  const response = await fetch(server() + '/api/v1' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(role ? { 'x-scorpio-role': role } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(String(data?.next || data?.error || 'Scorpio HTTP ' + response.status))
  return data
}

export function privateFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, contents, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

export function startDetached(program, args, logFile, env = process.env) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(logFile, 'a', 0o600)
  try {
    const child = spawn(program, args, { detached: true, stdio: ['ignore', fd, fd], env })
    child.unref()
    return child.pid
  } finally { fs.closeSync(fd) }
}

export { readJson, writeJson }
