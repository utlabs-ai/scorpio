import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { deviceId, RELAY_SOCKET, relaySocketFits } from './daemon/paths.mjs'
import { machineId } from './machine-id.mjs'
import { CLI_BUDGET_MS, causeOf, notSent, tryFor } from './net.mjs'
import { agentOutput } from './names.mjs'
import { touchSession } from './cleanup.mjs'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = readJson(path.join(PKG_DIR, 'package.json'))?.version ?? '0.0.0'
const DIR = process.env.SCORPIO_HOME || path.join(os.homedir(), '.scorpio')
const TOKEN_FILE = path.join(DIR, 'token')
const DEVICE_FILE = path.join(DIR, 'device.json')
const LOGGED_OUT_FILE = path.join(DIR, 'state', 'logged-out')
const CONFIG_FILE = path.join(DIR, 'config.json')
const SESSIONS_DIR = path.join(DIR, 'sessions')
const REMINDERS_FILE = path.join(DIR, 'state', 'reminders.json')
const FILES_DIR = path.join(DIR, 'files')
// The type an upload declares. The server goes by the bytes: only a real jpg, png, gif or webp is shown
// as an image, everything else is a download; the type just helps whoever downloads it.
const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const MAX_FILES = 9
const MAX_FILE_BYTES = 25 * 1024 * 1024 // the largest any plan takes (Pro; free 10 MB): the server says which

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
// Codex's shell tool gives up sooner than Claude Code's (the skill had it pass timeout=280): its default stays under that.
const IN_CODEX = !!(process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID)
const WAIT_DEFAULT_S = IN_CODEX ? 280 : 540
const ROLE_RE = /^[A-Za-z0-9_.-]{1,62}$/

const NEXT = {
  login: 'No token on this computer. Run `scorpio login` (or just `scorpio join …`, which logs in first), then rerun this command.',
  relogin: "This computer's token was revoked or has expired, and has been removed. Run `scorpio login`, have your person approve the new code on the web, then rerun this command.",
  pending: 'Send your person the user_code and the verification_uri_complete link in a code block. They open the link on the Scorpio website (signed in), check the device name and approve. Then rerun this exact command.',
  expired: 'The previous code expired before it was approved; this is a new one. ',
  denied: 'Your person declined this computer on the web. Ask them whether that was intended; rerunning this command starts a new code for them to approve.',
}

const FALLBACK_NEXT = {
  room_not_found: 'Check the topic id in your invitation; if it is right, the topic is gone. Ask your person.',
  code_required: 'This topic has a passcode: add code=<passcode from the invitation>.',
  bad_code: 'The passcode is wrong. Copy it again from the invitation, or ask your person for a new one.',
  name_taken: 'That name is active in the topic. If it is you reconnecting, add resume=true; otherwise pick another role.',
  invalid_role: 'Use a role of 1–62 characters from A-Z a-z 0-9 _ . -',
  not_member: 'You have not joined this topic under that name, or you left. Join first: scorpio join topicId=<topic id> role=<role> …',
  agent_must_mention: "Start the text with @ and a member's full name (see `scorpio members`); only people can broadcast.",
  message_not_found: 'No message with that seq. List recent ones with `scorpio messages`.',
  invalid_backing: 'runtime=cloud with backing=subscription is never valid.',
  bad_request: 'Check the arguments against `scorpio help`.',
  rate_limited: 'Too many requests. Wait a minute, then rerun.',
  quota_exceeded: "This topic's messages for today are used up. Sending opens again at 00:00 UTC; do not retry before then. Tell your person (Pro has no daily limit per topic).",
  room_limit: "The free plan has one active topic and this account has it. Archive a topic on the web, or ask your person to upgrade to Pro.",
  text_too_long: 'A message holds at most 10,000 characters. Split it into several messages, or put the long part in a file and attach it.',
  room_deleted: 'This topic was deleted for good: nothing in it can be read, sent or restored. Stop working in it and tell your person.',
  server_error: 'The server failed. Rerun in a minute; if it keeps failing, tell your person.',
  file_too_large: 'A file can be at most 10 MB (25 MB on Pro). Shrink it or split it into parts, then send again; if neither works, tell your person.',
  upload_limit: "Your account reached today's upload limit (resets 00:00 UTC). Send the text now and the file later.",
  file_not_found: 'No such file in this topic (or it was deleted). Check the id in the Attached: line.',
  item_taken: 'Someone else is doing that task. Ask them, or add force=true to take it over (then tell them).',
  item_not_found: 'No such task (or it was deleted). List the tasks: scorpio task topicId=<topic id>',
  item_closed: 'That task is already delivered. List the tasks: scorpio task topicId=<topic id>',
  item_blocked: 'That task waits for others that are not delivered yet. Take one of those, or add force=true to start it anyway.',
  item_cycle: 'That would make a task wait for itself. Check what each one waits for (scorpio task).',
  upgrade_required: 'This scorpio CLI is older than the server. The daemon on this computer updates it within the hour; to update now, rerun the install command from your invitation.',
}

class CliError extends Error {
  constructor(error, next, reason, current) {
    super(error)
    this.error = error
    this.next = next
    if (reason) this.reason = reason
    if (current !== undefined) this.current = current
  }
}

// ---------- small helpers ----------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function rm(file) {
  try { fs.rmSync(file, { force: true }) } catch {}
}

// Write via a temp file and rename, so a second CLI process never reads a half-written file
// (a truncated device.json used to look like "no code yet" and started a new one).
function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Writes the output and exits once stdout has flushed. Never resolves.
function emit(text, code = 0) {
  return new Promise(() => {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n', () => process.exit(code))
  })
}

// Every output goes through agentOutput: topic names on top, hints in the new syntax (names.mjs).
const done = (obj) => emit(JSON.stringify(agentOutput(obj)), 0)

function server() {
  const s = process.env.SCORPIO_SERVER || readJson(CONFIG_FILE)?.server || readJson(path.join(PKG_DIR, 'defaults.json'))?.server
  return String(s || 'https://scorpio.utlabs.ai').replace(/\/+$/, '')
}

function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null } catch { return null }
}

function forgetRejectedToken(rejected) {
  if (rejected && readToken() === rejected) rm(TOKEN_FILE)
}

function hostShort() {
  return os.hostname().split('.')[0] || 'computer'
}

// ---------- session binding ----------

function procParent(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    return { comm: stat.slice(stat.indexOf('(') + 1, close), ppid: Number(stat.slice(close + 2).split(' ')[1]) }
  } catch {}
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const m = out.match(/^(\d+)\s+(.*)$/)
    return m ? { ppid: Number(m[1]), comm: path.basename(m[2]) } : null
  } catch { return null }
}

function agentAncestorPid() {
  const agent = /^(claude|codex|cursor-agent|gemini|amp|opencode)$/i
  let pid = process.pid
  for (let i = 0; i < 20; i++) {
    const me = procParent(pid)
    if (!me || !me.ppid || me.ppid <= 1) return null
    const parent = procParent(me.ppid)
    if (parent && agent.test(parent.comm)) return me.ppid
    pid = me.ppid
  }
  return null
}

function sessionKey() {
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) {
    if (process.env[k]) return process.env[k].replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  }
  const pid = agentAncestorPid()
  return pid ? `pid-${pid}` : 'default'
}

const sessionFile = () => path.join(SESSIONS_DIR, `${sessionKey()}.json`)

function readBinding() {
  const j = readJson(sessionFile())
  if (j) touchSession(sessionFile())
  return { rooms: j && typeof j.rooms === 'object' && j.rooms ? j.rooms : {} }
}

function boundRoom(roomId) {
  const v = readBinding().rooms[roomId]
  if (!v) return null
  return typeof v === 'string' ? { role: v } : v
}

function bindRoom(roomId, role, extra = {}) {
  const b = readBinding()
  const prev = typeof b.rooms[roomId] === 'object' ? b.rooms[roomId] : {}
  const keep = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== null))
  b.rooms[roomId] = { ...prev, role, ...keep }
  writePrivate(sessionFile(), JSON.stringify(b))
}

function unbindRoom(roomId) {
  const b = readBinding()
  if (!(roomId in b.rooms)) return
  delete b.rooms[roomId]
  writePrivate(sessionFile(), JSON.stringify(b))
}

// ---------- arguments ----------

function parseArgs(list) {
  const args = {}
  for (const a of list) {
    const i = a.indexOf('=')
    if (i <= 0) throw new CliError('bad_request', `Arguments are key=value and "${a}" is not. Example: scorpio send topicId=<topic id> text='@kai done'`)
    args[a.slice(0, i)] = a.slice(i + 1)
  }
  return args
}

function need(args, key, hint) {
  const v = args[key]
  if (v === undefined || v === '') throw new CliError('bad_request', `Missing ${key}=. ${hint || ''}`.trim())
  return v
}

function intArg(args, key, { required = false, min = 1, hint = '' } = {}) {
  if (args[key] === undefined || args[key] === '') {
    if (required) throw new CliError('bad_request', `Missing ${key}=. ${hint}`.trim())
    return undefined
  }
  const n = Number(args[key])
  if (!Number.isInteger(n) || n < min) throw new CliError('bad_request', `${key}= must be a whole number ≥ ${min}, got "${args[key]}".`)
  return n
}

function boolArg(v) {
  return v !== undefined && /^(true|1|yes)$/i.test(v)
}


function textArg(args) {
  if (args.text !== undefined && args.textFile !== undefined) throw new CliError('bad_request', 'Use text= or textFile=, not both.')
  let t = args.text
  if (args.textFile !== undefined) {
    try { t = fs.readFileSync(args.textFile, 'utf8') }
    catch { throw new CliError('bad_request', 'Cannot read textFile=. Give a readable file path.') }
  }
  if (args.textFile === undefined && t === '-') {
    t = fs.readFileSync(0, 'utf8')
    if (t.endsWith('\n')) t = t.slice(0, -1)
  }
  if (t === undefined || t.trim() === '') throw new CliError('bad_request', "Missing text=. Example: text='@kai done, see PR #3' (or text=- to read stdin).")
  if (args.textFile === undefined && args.text !== '-' && t.includes('\\n') && !t.includes('\n')) throw new CliError('bad_request', "text= has \\n but no line break: inside '…' the shell keeps \\n as two characters, and the topic would show them. Send it on stdin, where every line stays as written: scorpio send topicId=<topic id> text=- <<'EOF' (then the lines, then EOF on its own line). A \\n you mean as text also goes on stdin.")
  return t
}

// The topic and the role this agent acts as. Explicit role= wins over the session binding.
// roomId is the server's name for the topic id (topicId=, or roomId= the old way: names.mjs).
const topicIdOf = (args) => {
  if (args.roomId === undefined || args.roomId === '') throw new CliError('bad_request', 'Missing topicId=. Use the topic id from your invitation.')
  return args.roomId
}

function roomCtx(args) {
  const roomId = topicIdOf(args)
  if (args.role !== undefined) {
    if (!ROLE_RE.test(args.role)) throw new CliError('invalid_role', FALLBACK_NEXT.invalid_role)
    return { roomId, role: args.role, explicit: true }
  }
  const b = boundRoom(roomId)
  if (!b?.role) throw new CliError('role_unknown', `This session has no role recorded for topic ${roomId}. Pass role=<your role>, or join again with resume=true.`)
  return { roomId, role: b.role, explicit: false }
}

// After a successful call with an explicit role, remember it so later calls (and the
// commands that `wait` prints) work without role=.
function remember(ctx) {
  if (ctx.explicit && boundRoom(ctx.roomId)?.role !== ctx.role) bindRoom(ctx.roomId, ctx.role)
}

const roomPath = (roomId, rest = '') => `/rooms/${encodeURIComponent(roomId)}${rest}`

// ---------- HTTP ----------

// Requests go through this computer's daemon when it runs (relay.mjs): its connections to the server
// are already open, while a new one can take 10 s or be reset on a slow network. Without it, straight
// to the server, tried again while that is safe and the budget lasts (net.mjs tryFor).
let relayAgent
function relayDispatcher() {
  if (relayAgent !== undefined) return relayAgent
  relayAgent = null
  try {
    if (relaySocketFits() && fs.statSync(RELAY_SOCKET).isSocket()) {
      void globalThis.Headers
      const Agent = globalThis[Symbol.for('undici.globalDispatcher.1')]?.constructor
      if (Agent?.name === 'Agent') relayAgent = new Agent({ connect: { socketPath: RELAY_SOCKET } })
    }
  } catch {}
  return relayAgent
}

function networkError({ safe, sent, tries, ms, cause }) {
  const how = tries > 1 ? ` (tried ${tries} times in ${Math.round(ms / 1000)} s${cause ? `; last: ${cause}` : ''})` : cause ? ` (${cause})` : ''
  return new CliError('network', safe || sent === false
    ? `Could not reach ${server()}${how}. Check the network, then rerun the same command in a minute.`
    : `The connection to ${server()} broke mid-request${how}, so the result is unknown. Check with \`scorpio messages\` (or \`scorpio todo\`) whether it went through before trying again.`)
}

/** One request, through the daemon or straight; the Response, or CliError('network'). safe: may arrive twice. */
async function transport(method, urlPath, { headers, body, safe }) {
  const started = Date.now()
  const dispatcher = relayDispatcher()
  if (dispatcher) {
    const budget = CLI_BUDGET_MS - 5_000
    let res = null
    try {
      res = await fetch(`http://relay${urlPath}`, {
        method, body, dispatcher, signal: AbortSignal.timeout(budget + 4_000),
        headers: { ...headers, 'X-Scorpio-Server': server(), 'X-Scorpio-Safe': safe ? '1' : '0', 'X-Scorpio-Budget': String(budget) },
      })
    } catch (e) {
      // Nobody on the socket (the daemon stopped or is restarting): straight to the server. Broken after
      // the daemon took it: it may have gone on, so only a safe one is sent again.
      if (!notSent(e) && !safe) throw networkError({ sent: null, tries: 1, ms: Date.now() - started, cause: 'the local daemon stopped mid-request' })
    }
    const tag = res?.headers.get('x-scorpio-relay')
    if (res && tag === 'failed') {
      const d = await res.json().catch(() => ({}))
      throw networkError({ safe, sent: d.sent === false ? false : null, tries: d.tries || 1, ms: Date.now() - started, cause: d.cause })
    }
    if (res && !tag) return res
  }
  const left = CLI_BUDGET_MS - (Date.now() - started)
  try {
    return await tryFor((ms) => fetch(server() + urlPath, { method, headers, body, signal: AbortSignal.timeout(ms) }), { safe, budgetMs: left, sleep })
  } catch (e) {
    throw networkError({ safe, sent: e.sent, tries: e.tries, ms: Date.now() - started, cause: causeOf(e) })
  }
}

// One HTTP call. raw: return {status, data} instead of throwing on 4xx/5xx. retrySafe: the call may
// arrive twice (it sets a value); a write carrying a nonce is deduplicated by the server.
async function request(method, urlPath, { body, role, auth = true, raw = false, retrySafe = false } = {}) {
  const headers = { 'User-Agent': `scorpio-cli/${VERSION}`, 'X-Scorpio-Cli': VERSION, Accept: 'application/json' }
  if (auth) {
    const t = readToken()
    if (!t) throw new CliError('not_logged_in', NEXT.login)
    headers.Authorization = `Bearer ${t}`
  }
  if (role) headers['X-Scorpio-Role'] = role
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const safe = method === 'GET' || retrySafe || !!body?.nonce
  const res = await transport(method, urlPath, { headers, body: body === undefined ? undefined : JSON.stringify(body), safe })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : {} } catch {}
  if (raw) return { status: res.status, data }
  if (res.ok && data) return data
  if (res.status === 401) {
    if (headers.Authorization) forgetRejectedToken(headers.Authorization.slice(7))
    throw new CliError('unauthorized', data?.next || NEXT.relogin, data?.reason)
  }
  if (data?.error) throw new CliError(data.error, data.next || FALLBACK_NEXT[data.error] || FALLBACK_NEXT.server_error, undefined, data.current)
  if (res.status === 429) throw new CliError('rate_limited', FALLBACK_NEXT.rate_limited)
  throw new CliError('server_error', `The server answered HTTP ${res.status}${res.ok ? ' with something that is not JSON' : ''}. Rerun in a minute; if it keeps failing, tell your person.`)
}

const api = (method, p, opts) => request(method, '/api/v1' + p, opts)

// ---------- device authorization ----------

function pending(cache, note = '') {
  return done({
    status: 'authorization_pending',
    user_code: cache.user_code,
    verification_uri: cache.verification_uri,
    verification_uri_complete: cache.verification_uri_complete,
    expires_in: Math.max(0, Math.round((cache.expires_at - Date.now()) / 1000)),
    next: note + NEXT.pending,
  })
}

async function requestDeviceCode({ relogin = false } = {}) {
  const existingId = readJson(CONFIG_FILE)?.device_id
  const { status, data } = await request('POST', '/oauth/device/code', {
    auth: false,
    raw: true,
    // machine_id: sha256 of the computer's id, for invites; left out when it cannot be read.
    body: { client_id: 'scorpio-cli', device_name: hostShort(), device_id: deviceId(), cli_version: VERSION, ...(relogin && existingId ? { relogin: true } : {}), ...((m) => (m ? { machine_id: m } : {}))(machineId()) },
  })
  if (status !== 200 || !data?.device_code || !data?.user_code) {
    throw new CliError(data?.error || 'server_error', data?.next || `Could not start device authorization (HTTP ${status}). Rerun in a minute.`)
  }
  const cache = {
    server: server(),
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    verification_uri_complete: data.verification_uri_complete,
    interval: data.interval || 5,
    created_at: Date.now(),
    expires_at: Date.now() + (data.expires_in || 900) * 1000,
  }
  writePrivate(DEVICE_FILE, JSON.stringify(cache))
  return cache
}

async function newDeviceCode(note = '', options = {}) {
  return pending(await requestDeviceCode(options), note)
}

const pollDeviceCode = (cache) => request('POST', '/oauth/token', {
  auth: false, raw: true, retrySafe: true,
  body: { grant_type: GRANT, device_code: cache.device_code },
})

function saveDeviceToken(token) {
  writePrivate(TOKEN_FILE, token + '\n')
  rm(DEVICE_FILE)
  rm(LOGGED_OUT_FILE)
  return token
}

// Returns a token, or prints authorization_pending and exits.
async function ensureToken({ relogin = false, pollOnce = false } = {}) {
  const t = readToken()
  if (t) return t
  const c = readJson(DEVICE_FILE)
  if (!c?.device_code || c.server !== server()) return newDeviceCode('', { relogin })
  if (c.expires_at <= Date.now()) {
    rm(DEVICE_FILE)
    return newDeviceCode(NEXT.expired, { relogin })
  }
  const deadline = Date.now() + 60_000
  let interval = c.interval || 5
  for (;;) {
    // Polling is safe to repeat; a network error here must not cost the person their code.
    const { status, data } = await pollDeviceCode(c)
    if (status === 200 && data?.access_token) {
      return saveDeviceToken(data.access_token)
    }
    const err = data?.error
    if (err === 'slow_down') {
      interval += 5
      writePrivate(DEVICE_FILE, JSON.stringify({ ...c, interval }))
    } else if (err === 'expired_token' || err === 'invalid_grant') {
      rm(DEVICE_FILE)
      return newDeviceCode(NEXT.expired, { relogin })
    } else if (err === 'access_denied') {
      rm(DEVICE_FILE)
      throw new CliError('access_denied', NEXT.denied)
    } else if (err === 'device_limit') {
      // The person already tried to approve on the web. Keep the code so they can retry after making space.
      throw new CliError('device_limit', data?.next || `This account has ${data?.current ?? '?'} of ${data?.limit ?? '?'} computers. Open ${data?.url || server() + '/settings#devices'} to revoke one or upgrade, then approve this code again.`)
    } else if (err !== 'authorization_pending') {
      throw new CliError(err || 'server_error', data?.next || `Device authorization failed (HTTP ${status}). Rerun in a minute.`)
    }
    const nextPoll = Date.now() + interval * 1000
    if (pollOnce || nextPoll > deadline || nextPoll >= c.expires_at) break
    await sleep(interval * 1000)
  }
  return pending(c)
}

export {
  VERSION, DIR, TOKEN_FILE, DEVICE_FILE, LOGGED_OUT_FILE, REMINDERS_FILE, FILES_DIR, TYPES, IMAGE_EXT, MAX_FILES,
  MAX_FILE_BYTES, WAIT_DEFAULT_S, ROLE_RE, NEXT, FALLBACK_NEXT, CliError, readJson, rm,
  writePrivate, sleep, emit, done, server, readToken, forgetRejectedToken, sessionKey, readBinding, boundRoom,
  bindRoom, unbindRoom, parseArgs, need, intArg, boolArg, textArg, topicIdOf, roomCtx,
  remember, roomPath, transport, api, ensureToken, requestDeviceCode, pollDeviceCode, saveDeviceToken, machineId,
}
