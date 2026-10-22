// Reading quota for /usage: never calling a model, never opening a tab.
// - Claude Code: the quota API behind its /usage panel, with this computer's Claude Code login, read only.
// - Codex: its app-server (what its IDE plugin uses): initialize, then account/rateLimits/read.

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { execFile, spawn } from 'node:child_process'

// ------------------------------------------------------------------ Codex

/** Ask once. {result} | {error}; error 'missing' when codex is not installed. */
export function readCodexRateLimits({ bin = 'codex', cwd, timeoutMs = 20_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let settled = false, buffer = '', child
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* gone already */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish({ error: `app-server did not answer in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)
    const send = (message) => { try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch { /* close finishes */ } }
    try {
      child = spawnImpl(bin, ['-c', 'check_for_update_on_startup=false', 'app-server'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (error) { finish({ error: error?.code === 'ENOENT' ? 'missing' : String(error?.message || error) }); return }
    child.on('error', (error) => finish({ error: error?.code === 'ENOENT' ? 'missing' : String(error?.message || error) }))
    child.stdin.on('error', () => {})
    child.on('close', () => finish({ error: 'app-server exited without answering' }))
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 0) {
          if (message.error) { finish({ error: message.error.message || 'initialize refused' }); return }
          send({ method: 'initialized' })
          send({ id: 1, method: 'account/rateLimits/read' })
        } else if (message.id === 1) {
          finish(message.error ? { error: message.error.message || 'rate limits refused' } : { result: message.result })
          return
        }
      }
    })
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'scorpio-daemon', version: '1' } } })
  })
}

function windowLabel(minutes) {
  if (minutes === 300) return '5h'
  if (minutes === 10080) return 'week'
  if (!Number.isFinite(minutes) || minutes <= 0) return 'window'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/** app-server's answer → windows for usageLine. */
export function codexWindows(result) {
  const snapshot = result?.rateLimits || {}
  return ['primary', 'secondary'].map((key) => snapshot[key]).filter(Boolean).map((w) => ({
    label: windowLabel(w.windowDurationMins),
    pct: w.usedPercent,
    resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null,
  }))
}

// ------------------------------------------------------------------ Claude Code

// The quota API behind Claude Code's /usage panel, asked with this computer's Claude Code login (as
// ccstatusline does). The login is only read: never refreshed or written back (the Claude sessions
// running here keep it fresh), and it never reaches the log or the room: reasons carry only a status.
const CLAUDE_HOST = 'api.anthropic.com'
const CLAUDE_PATH = '/api/oauth/usage'
// Claude Code itself waits 5 s; on some computers the TLS handshake with Anthropic alone takes 2–7 s.
export const CLAUDE_TIMEOUT_MS = 20_000
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const KEYCHAIN_MS = 10_000
const RENEW = 'a Claude session started on this computer renews it'

const security = (args) => new Promise((resolve) => {
  execFile('security', args, { encoding: 'utf8', timeout: KEYCHAIN_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    resolve(error ? { error: error.killed ? 'timeout' : 'missing' } : { stdout: String(stdout).trim() })
  })
})

/**
 * The Mac keychain: Claude Code-credentials, else the entries whose name starts with it (Claude Code
 * with CLAUDE_CONFIG_DIR adds a suffix); dump-keychain lists entries without secrets. Reading a secret
 * may show a prompt waiting for someone to click Allow: not answered in time is a timeout.
 */
export const macKeychain = {
  read: (service) => security(['find-generic-password', '-s', service, '-w']),
  async services() {
    const dump = await security(['dump-keychain'])
    if (!dump.stdout) return []
    const names = [...dump.stdout.matchAll(/"svce"<blob>="([^"]+)"/g)].map((m) => m[1])
    return [...new Set(names.filter((n) => n.startsWith(KEYCHAIN_SERVICE) && n !== KEYCHAIN_SERVICE))]
  },
}

/** The claudeAiOauth part of Claude Code's login: {oauth} | {none} | {reason}. */
export async function readClaudeCredentials({ platform = process.platform, env = process.env, home = os.homedir(),
  readText = (p) => fs.readFileSync(p, 'utf8'), keychain = macKeychain } = {}) {
  const parse = (text) => {
    try { return { oauth: JSON.parse(text)?.claudeAiOauth || null } } catch { return { bad: true } }
  }
  if (platform === 'darwin') {
    let waited = false
    for (const service of [KEYCHAIN_SERVICE, ...await keychain.services()]) {
      const got = await keychain.read(service)
      if (got.error === 'timeout') waited = true
      if (!got.stdout) continue
      const { oauth } = parse(got.stdout)
      if (oauth?.accessToken) return { oauth }
    }
    if (waited) return { reason: `the keychain did not give out Claude's login within ${KEYCHAIN_MS / 1000} seconds; it may be waiting for someone to click Allow` }
  }
  let text
  try { text = readText(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json')) } catch { return { none: true } }
  const { oauth, bad } = parse(text)
  if (bad) return { reason: "Claude's credentials file cannot be read as JSON" }
  return oauth?.accessToken ? { oauth } : { none: true }
}

/**
 * One GET. Through HTTPS_PROXY (or https_proxy) when set, as a CONNECT tunnel: Claude Code honours it too,
 * and computers that need it reach Anthropic no other way. {status, headers, body}; throws {code}.
 */
export function getClaudeUsage({ token, timeoutMs = CLAUDE_TIMEOUT_MS, env = process.env }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const sockets = []
    const done = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const s of sockets) s.destroy()
      fn(value)
    }
    const timer = setTimeout(() => done(reject, { code: 'timeout' }), timeoutMs)
    const fail = (error) => done(reject, { code: error?.code || 'network' })
    const send = (createConnection) => {
      const req = https.request({
        host: CLAUDE_HOST, path: CLAUDE_PATH, method: 'GET', agent: false, ...(createConnection ? { createConnection } : {}),
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body }))
        res.on('error', fail)
      })
      req.on('socket', (s) => sockets.push(s))
      req.on('error', fail)
      req.end()
    }
    const proxy = (env.HTTPS_PROXY || env.https_proxy || '').trim()
    if (!proxy) { send(null); return }
    let url
    try { url = new URL(proxy) } catch { done(reject, { code: 'bad_proxy' }); return }
    const auth = url.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` } : {}
    const tunnel = http.request({ host: url.hostname, port: url.port || 80, method: 'CONNECT', path: `${CLAUDE_HOST}:443`, headers: { Host: `${CLAUDE_HOST}:443`, ...auth } })
    tunnel.on('socket', (s) => sockets.push(s))
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { done(reject, { code: `proxy_${res.statusCode}` }); return }
      send(() => tls.connect({ socket, servername: CLAUDE_HOST }))
    })
    tunnel.on('error', fail)
    tunnel.end()
  })
}

/**
 * Ask once. {result} (the API's JSON) | {reason} (one line for the room, no parentheses: usageLine adds them).
 * An expired login is not sent: the API would only answer 401.
 */
export async function readClaudeRateLimits({ now = Date.now, credentials = readClaudeCredentials, get = getClaudeUsage, timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  const creds = await credentials()
  if (creds.reason) return { reason: creds.reason }
  if (creds.none) return { reason: 'no Claude subscription login on this computer; billed by API, it has no quota windows' }
  const { accessToken, expiresAt } = creds.oauth
  if (Number.isFinite(expiresAt) && expiresAt <= now()) return { reason: `Claude's login has expired; ${RENEW}` }
  let res
  try { res = await get({ token: accessToken, timeoutMs }) } catch (error) {
    const code = error?.code || 'network'
    if (code === 'timeout') return { reason: `the quota API did not answer within ${Math.round(timeoutMs / 1000)} seconds` }
    return { reason: `could not reach the quota API: ${code}` }
  }
  if (res.status === 401) return { reason: `the quota API refused Claude's login with 401; ${RENEW}` }
  if (res.status === 429) {
    const after = Number.parseInt(res.headers?.['retry-after'], 10)
    return { reason: `the quota API is rate limiting${after > 0 ? `, try again in ${after} seconds` : ''}` }
  }
  if (res.status !== 200) return { reason: `the quota API answered HTTP ${res.status}` }
  try { return { result: JSON.parse(res.body) } } catch { return { reason: 'the quota API did not answer JSON' } }
}

const percent = (v) => (Number.isFinite(v) ? v : null)
const epoch = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null }

/**
 * The API's answer → windows for usageLine: 5h, week, week <model> (Fable, say). limits is the table the
 * panel draws; older answers only have the five_hour and seven_day buckets.
 */
export function claudeWindows(result) {
  const limits = Array.isArray(result?.limits) ? result.limits : null
  if (limits) {
    const label = (l) => {
      if (l.kind === 'session') return '5h'
      if (l.kind === 'weekly_all') return 'week'
      const scope = l.scope?.model?.display_name || l.scope?.surface?.display_name
      return l.kind === 'weekly_scoped' && scope ? `week ${scope}` : null
    }
    return limits.map((l) => ({ label: label(l), pct: percent(l.percent), resetsAt: epoch(l.resets_at) }))
      .filter((w) => w.label && w.pct !== null)
  }
  return [['five_hour', '5h'], ['seven_day', 'week']].map(([key, label]) => ({
    label, pct: percent(result?.[key]?.utilization), resetsAt: epoch(result?.[key]?.resets_at),
  })).filter((w) => w.pct !== null)
}

// ------------------------------------------------------------------ the line in the room

export function formatIn(ms) {
  if (!Number.isFinite(ms)) return null
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

/**
 * One CLI's line: "Claude Code: 5h 0% used (resets in 4h 10m) · week 18% used (resets in 2d 3h) · week Fable 13% used".
 * Every percentage is the share used (Claude's utilization, Codex's usedPercent), never what is left.
 */
export function usageLine(label, result, now) {
  if (result.missing) return `${label}: not installed`
  if (!result.windows?.length) return `${label}: could not read the quota${result.reason ? ` (${result.reason})` : ''}`
  let lastReset = null
  const parts = result.windows.map((w) => {
    const inText = w.resetsAt ? formatIn(w.resetsAt - now) : null
    const reset = inText ? `resets in ${inText}` : null
    const show = reset && reset !== lastReset
    lastReset = reset
    return `${w.label} ${w.pct}% used${show ? ` (${reset})` : ''}`
  })
  return `${label}: ${parts.join(' · ')}`
}
