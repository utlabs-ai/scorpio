import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readToken, forgetRejectedToken, CliError, NEXT, VERSION, transport, FALLBACK_NEXT,
  MAX_FILES, MAX_FILE_BYTES, TYPES, roomPath, IMAGE_EXT, roomCtx, need, remember,
  FILES_DIR, writePrivate, done,
} from '../client.mjs'
import { topicFilesDir, ensureDir } from '../workspace.mjs'

// ---------- attachments ----------

// Binary request: a file up, or a file down. Errors come back as JSON like every other call.
// safe: it may arrive twice (a GET, or a PUT that replaces with the same body).
async function binary(method, urlPath, { role, body, headers: extra = {}, safe = method === 'GET' } = {}) {
  const t = readToken()
  if (!t) throw new CliError('not_logged_in', NEXT.login)
  const headers = { 'User-Agent': `scorpio-cli/${VERSION}`, 'X-Scorpio-Cli': VERSION, Authorization: `Bearer ${t}`, 'X-Scorpio-Role': role, ...extra }
  // An upload that may have arrived is not resent: the server lets an upload be sent once.
  const res = await transport(method, '/api/v1' + urlPath, { headers, body, safe })
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

function fileArgs(args) {
  if (args.files === undefined) return []
  const list = args.files.split(',').map((f) => f.trim()).filter(Boolean)
  if (list.length > MAX_FILES) throw new CliError('bad_request', `At most ${MAX_FILES} files per message; split them over several messages.`)
  return list.map((f) => {
    const p = path.resolve(f.replace(/^~(?=\/|$)/, os.homedir()))
    let st = null
    try { st = fs.statSync(p) } catch {}
    if (!st?.isFile()) throw new CliError('bad_request', `No file ${f}. files= takes file paths separated by commas, e.g. files=shot.png,report.pdf`)
    // Checked before anything is uploaded or sent: no plan takes it, so the message would go without it.
    if (st.size > MAX_FILE_BYTES) throw new CliError('file_too_large', `${f} is ${mb(st.size)}; a file can be at most 10 MB (25 MB on Pro). Shrink it or split it into parts; if neither works, tell your person.`)
    return p
  })
}

async function upload(ctx, file) {
  const res = await binary('POST', roomPath(ctx.roomId, '/files'), {
    role: ctx.role,
    body: fs.readFileSync(file),
    headers: {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(path.basename(file)),
    },
  })
  return (await res.json()).id
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** The extension a download is saved under: an image's from its type (what the bytes are), any other file's from its name. */
function extOf(type, name) {
  if (IMAGE_EXT[type]) return IMAGE_EXT[type]
  const ext = path.extname(String(name || '')).slice(1).toLowerCase()
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin'
}

async function file(args) {
  const ctx = roomCtx(args)
  const id = need(args, 'id', 'The id from the "Attached: scorpio file …" line.')
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new CliError('bad_request', 'id= is the id from the "Attached: scorpio file …" line.')
  const res = await binary('GET', roomPath(ctx.roomId, `/files/${encodeURIComponent(id)}`), { role: ctx.role })
  remember(ctx)
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim()
  const disposition = res.headers.get('content-disposition') || ''
  let name = id
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  const plain = /filename="([^"]*)"/i.exec(disposition)
  try { name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : id } catch {}
  const bytes = Buffer.from(await res.arrayBuffer())
  let dir, warn
  try { dir = ensureDir(topicFilesDir(ctx.roomId)) } catch (error) {
    dir = FILES_DIR
    warn = `Could not prepare the topic files directory (${error?.message || error}); saved to the legacy files directory instead.`
  }
  const out = path.join(dir, `${id}.${extOf(type, name)}`)
  writePrivate(out, bytes)
  return done({ roomId: ctx.roomId, id, name, type, size: bytes.length, path: out, ...(warn ? { warn } : {}) })
}

export { binary, fileArgs, upload, file }
