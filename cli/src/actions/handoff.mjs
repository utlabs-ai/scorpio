import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError, api, done, emit, roomCtx, roomPath, remember, writePrivate } from '../client.mjs'
import { agentOutput } from '../names.mjs'
import { ensureDir, topicFilesDir } from '../workspace.mjs'
import { HANDOFF_MAX_BYTES, handoffCopyPath, handoffPath } from '../daemon/paths.mjs'
import { SPACE_FULL_LINE, machineName } from '../daemon/commands.mjs'
import { binary } from './file.mjs'

// ---------- handoffs ----------
// file=: store this seat's handoff in the cloud. name=: read a seat's handoff from it.

const SEAT = /^[A-Za-z0-9_.-]{1,62}@[A-Za-z0-9_.-]{1,64}$/
const kb = (bytes) => `${Math.max(1, Math.ceil(bytes / 1024))} KB`

const tooLarge = (size, file) => `The handoff is ${kb(size)}; the limit is ${kb(HANDOFF_MAX_BYTES)}. Shorten it (keep facts and decisions, drop logs and pasted output), save it to ${file}, and run this command again. Until it is uploaded it exists only on this computer.`

/** What the agent does after a failed upload: one sentence per code; the file stays where it is. */
function failedNext(code, file, size) {
  if (code === 'handoff_too_large') return tooLarge(size, file)
  if (code === 'handoff_not_text') return `${file} is not plain text (not UTF-8, or it has control characters). Write the handoff as plain Markdown text and run this command again.`
  if (code === 'handoff_space_full') return `Your account's handoffs in this topic already add up to 2.5 MB, the limit, so this one was not uploaded; it stays on this computer at ${file}. Post your takeover command as usual, and add this line for your owner: "${SPACE_FULL_LINE}"`
  if (code === 'room_archived') return `This topic is archived, so nothing can be stored or posted in it. The handoff stays on this computer at ${file}.`
  // Only a network failure is "could not reach"; any other code was an answer from the server.
  const why = code === 'network' ? `Could not reach Scorpio (${code}), so the handoff stays on this computer at ${file}.` : `The handoff was not uploaded (${code}), so it stays on this computer at ${file}.`
  return `${why} Try this command once more; if it fails again, post your takeover command as usual and say nothing about it: the next takeover on this computer uses this copy, and the daemon says so then.`
}

// An error that also names the file kept: {"error","next","path"}, exit 1.
const failed = (error, next, file) => emit(JSON.stringify(agentOutput({ error, next, path: file })), 1)

async function store(args) {
  const ctx = roomCtx(args)
  const { roomId, role } = ctx
  try { topicFilesDir(roomId) } catch { throw new CliError('bad_request', 'topicId= is the topic id from your invitation.') }
  const file = path.resolve(String(args.file).replace(/^~(?=\/|$)/, os.homedir()))
  let st = null
  try { st = fs.statSync(file) } catch {}
  if (!st) throw new CliError('bad_request', `No file ${args.file}. file= is the handoff you wrote, e.g. file=${handoffPath(roomId, role)}`)
  if (!st.isFile()) throw new CliError('bad_request', `${args.file} is not a file. file= is the handoff you wrote, e.g. file=${handoffPath(roomId, role)}`)
  const body = fs.readFileSync(file)
  if (!body.toString('utf8').trim()) throw new CliError('bad_request', `${args.file} is empty. Write the handoff into it, then run this command again.`)
  let res
  try {
    res = await binary('PUT', roomPath(roomId, '/handoff'), {
      role,
      body,
      // The same body twice only replaces it with itself, so it may be tried again.
      safe: true,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'X-Scorpio-Computer': machineName(),
      },
    })
  } catch (e) {
    if (!(e instanceof CliError)) throw e
    // The person chose to keep handoffs on agents' computers: nothing failed (exit 0).
    if (e.error === 'handoff_local_only') {
      remember(ctx)
      return done({ roomId, role, stored: 'local', path: file, next: `Cloud handoffs are off for this account (Settings → Keep handoffs on agents' computers), so the handoff stays here at ${file}. Post your takeover command as usual; nothing to say about this.` })
    }
    return failed(e.error, failedNext(e.error, file, body.length), file)
  }
  const data = await res.json().catch(() => null)
  // Only an answer that says it was stored counts; anything else keeps the file (the next /spawn compares).
  if (!data?.name || !Number.isFinite(data.updatedAt)) return failed('server_error', failedNext('server_error', file, body.length), file)
  remember(ctx)
  const fallback = file === handoffPath(roomId, role)
  if (fallback) fs.rmSync(file, { force: true })
  return done({
    roomId, name: data.name, stored: 'cloud', size: data.size, updatedAt: data.updatedAt, link: data.link,
    next: `Uploaded (${kb(data.size ?? body.length)}). Put this link in your takeover message: ${data.link}. ${fallback ? 'The copy on this computer was removed; the cloud copy' : 'The cloud copy'} is the one your successor reads.`,
  })
}

async function read(args) {
  const ctx = roomCtx(args)
  try { topicFilesDir(ctx.roomId) } catch { throw new CliError('bad_request', 'topicId= is the topic id from your invitation.') }
  const name = String(args.name).replace(/^@/, '')
  if (!SEAT.test(name)) throw new CliError('bad_request', `name= is a seat's full name, role@account (e.g. name=api@kai); see \`scorpio members\`.`)
  let data
  try {
    data = await api('GET', roomPath(ctx.roomId, `/handoff?name=${encodeURIComponent(name)}`), { role: ctx.role })
  } catch (e) {
    if (e instanceof CliError && e.error === 'handoff_not_found') throw new CliError(e.error, `${name} has no handoff in the cloud in this topic. If it was handed off on another computer, that copy was not uploaded.`)
    if (e instanceof CliError && e.error === 'seat_not_found') throw new CliError(e.error, `${name} is not a member of this topic.`)
    throw e
  }
  if (typeof data?.body !== 'string') throw new CliError('server_error', 'The server answered without the handoff. Rerun in a minute; if it keeps failing, tell your person.')
  remember(ctx)
  ensureDir(topicFilesDir(ctx.roomId))
  const out = handoffCopyPath(ctx.roomId, name)
  writePrivate(out, data.body)
  return done({ roomId: ctx.roomId, name: data.name || name, size: data.size, updatedAt: data.updatedAt, computer: data.computer ?? null, path: out })
}

async function handoff(args) {
  const hasFile = args.file !== undefined, hasName = args.name !== undefined
  if (hasFile === hasName) throw new CliError('bad_request', 'Give file= (store your handoff: scorpio handoff topicId=<topic id> role=<role> file=<path>) or name= (read a seat\'s: scorpio handoff topicId=<topic id> name=<role@account>), not both.')
  if (hasFile && !args.file) throw new CliError('bad_request', 'file= is the path of the handoff you wrote.')
  return hasFile ? store(args) : read(args)
}

export { handoff }
