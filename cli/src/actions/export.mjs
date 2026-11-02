import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CliError, FALLBACK_NEXT, NEXT, VERSION, done, forgetRejectedToken, readToken, remember, roomCtx, roomPath, server } from '../client.mjs'
import { REQUEST_TIMEOUT_MS } from '../net.mjs'
import { ensureDir, topicFilesDir } from '../workspace.mjs'

// ---------- export ----------
// A topic's records as one zip, written into the topic's files folder: the record as Markdown and JSON, the
// attachments, the seats' handoffs, the scheduled messages and the memos. The server streams the zip as it builds
// it, so a download that breaks off has no end record; only a complete one is kept.

const PARTS = ['messages', 'tasks', 'files', 'handoffs', 'memo']
const END_RECORD = Buffer.from([0x50, 0x4b, 0x05, 0x06]) // PK\x05\x06: the zip's end record, its last 22 bytes

/** The parts asked for: include= as given (the server refuses an unknown one), else all five. */
function partsOf(args) {
  if (args.include === undefined || args.include === '') return PARTS
  const list = String(args.include).split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = list.find((p) => !PARTS.includes(p))
  if (unknown) throw new CliError('bad_request', `include=${unknown}: the parts are ${PARTS.join(', ')}, separated by commas; leave include= out for all of them.`)
  return PARTS.filter((p) => list.includes(p))
}

/** This computer's time zone, as the browser sends its own; tz= names another. */
function zoneOf(args) {
  if (args.tz !== undefined && args.tz !== '') return String(args.tz)
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** The file name the server chose (Content-Disposition's filename*, else filename), kept to a plain file name. */
export function nameOf(disposition, fallback) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '')
  const plain = /filename="([^"]*)"/i.exec(disposition || '')
  let name = fallback
  try { name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : fallback } catch {}
  name = path.basename(name.replace(/[\\/]/g, '-')).trim()
  return name && name !== '.' && name !== '..' ? name : fallback
}

/** A complete zip ends with its end record; a download cut short does not. */
export function endsWithEndRecord(file) {
  const size = fs.statSync(file).size
  if (size < 22) return false
  const tail = Buffer.alloc(22)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, tail, 0, 22, size - 22) } finally { fs.closeSync(fd) }
  return tail.subarray(0, 4).equals(END_RECORD)
}

/**
 * The download request, straight to the server and not through the daemon's relay: the usual request path limits a
 * whole request to about 90 seconds, body included, and a zip with attachments can take minutes to stream. Here only
 * the wait for the response headers is limited; reading the body is not. Answers the Response, or throws a CliError
 * as every other call does (a refusal comes as JSON before any byte of the zip).
 */
export async function download(urlPath, role, { headerTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const t = readToken()
  if (!t) throw new CliError('not_logged_in', NEXT.login)
  const headers = { 'User-Agent': `scorpio-cli/${VERSION}`, 'X-Scorpio-Cli': VERSION, Authorization: `Bearer ${t}`, 'X-Scorpio-Role': role, Accept: 'application/zip, application/json' }
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), headerTimeoutMs)
  let res
  try {
    res = await fetch(server() + urlPath, { headers, signal: control.signal })
  } catch (e) {
    throw new CliError('network', control.signal.aborted ? `The server did not start answering within ${Math.round(headerTimeoutMs / 1000)} s. Check the network, then run the same command again.` : `Could not reach ${server()} (${e?.cause?.code || e?.message || e}). Check the network, then run the same command again.`)
  } finally {
    clearTimeout(timer)
  }
  if (res.ok) return res
  let data = null
  try { data = await res.json() } catch {}
  if (res.status === 401) {
    forgetRejectedToken(t)
    throw new CliError('unauthorized', data?.next || NEXT.relogin, data?.reason)
  }
  if (data?.error) throw new CliError(data.error, data.next || FALLBACK_NEXT[data.error] || FALLBACK_NEXT.server_error)
  throw new CliError(res.status === 429 ? 'rate_limited' : 'server_error', res.status === 429 ? FALLBACK_NEXT.rate_limited : `The server answered HTTP ${res.status}. Rerun in a minute.`)
}

async function exportTopic(args) {
  const ctx = roomCtx(args)
  const include = partsOf(args)
  const query = new URLSearchParams({ tz: zoneOf(args) })
  if (include.length !== PARTS.length) query.set('include', include.join(','))
  const res = await download('/api/v1' + roomPath(ctx.roomId, `/export?${query}`), ctx.role)
  remember(ctx)
  const dir = ensureDir(topicFilesDir(ctx.roomId))
  const name = nameOf(res.headers.get('content-disposition'), `${ctx.roomId}.zip`)
  const out = path.join(dir, name)
  const tmp = path.join(dir, `.${name}.${process.pid}.part`)
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp, { mode: 0o600 }))
    if (!endsWithEndRecord(tmp)) throw new CliError('network', 'The download broke off before the end of the zip, so nothing was kept. Run the same command again.')
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    if (e instanceof CliError) throw e
    throw new CliError('network', `The download failed (${e?.message || e}), so nothing was kept. Run the same command again.`)
  }
  fs.renameSync(tmp, out) // the same topic exported again today replaces the earlier zip
  return done({ roomId: ctx.roomId, path: out, size: fs.statSync(out).size, include })
}

export { exportTopic }
