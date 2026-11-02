import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CliError, done, remember, roomCtx, roomPath } from '../client.mjs'
import { ensureDir, topicFilesDir } from '../workspace.mjs'
import { binary } from './file.mjs'

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

async function exportTopic(args) {
  const ctx = roomCtx(args)
  const include = partsOf(args)
  const query = new URLSearchParams({ tz: zoneOf(args) })
  if (include.length !== PARTS.length) query.set('include', include.join(','))
  const res = await binary('GET', roomPath(ctx.roomId, `/export?${query}`), { role: ctx.role })
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
