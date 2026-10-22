import { readArgs, readQuery } from '../read-filters.mjs'
import { randomUUID } from 'node:crypto'
import { registerAfterJoin, unregisterAfterLeave } from './register.mjs'
import { workspaceFor, topicFilesDir, ensureDir } from '../workspace.mjs'
import { cleanupIfDue } from '../cleanup.mjs'
import {
  topicIdOf, boundRoom, CliError, ROLE_RE, FALLBACK_NEXT, boolArg,
  ensureToken, api, roomPath, bindRoom, done, roomCtx, remember, intArg, need,
  server, unbindRoom, DIR,
} from '../client.mjs'

async function join(args) {
  const roomId = topicIdOf(args)
  const role = args.role ?? boundRoom(roomId)?.role
  if (!role) throw new CliError('bad_request', "Missing role=. Pick a short role for what you do, e.g. role=api roleCard='api: backend endpoints; takes work from kai'.")
  if (!ROLE_RE.test(role)) throw new CliError('invalid_role', FALLBACK_NEXT.invalid_role)
  if (args.pane !== undefined && !/^[A-Za-z0-9:_-]{2,64}$/.test(args.pane)) throw new CliError('bad_request', 'pane= must be the pane id from herdr pane list.')
  const body = { role }
  if (args.roleCard !== undefined) body.roleCard = args.roleCard
  if (args.resume !== undefined) body.resume = boolArg(args.resume)
  if (args.code !== undefined) body.code = args.code
  body.nonce = args.nonce || randomUUID()
  await ensureToken()
  const res = await api('POST', roomPath(roomId, '/join'), { body })
  // Protect this session before cleanup, then recreate any emptied download directory for the caller.
  bindRoom(roomId, role, { roomName: res.roomName, topic: res.topic, owner: res.owner, joinedAt: Date.now() })
  cleanupIfDue({ home: DIR })
  let workspace = null, files = null, directoryWarning = null
  try {
    workspace = ensureDir(workspaceFor(roomId))
    files = ensureDir(topicFilesDir(roomId))
  } catch (error) {
    workspace = null; files = null
    directoryWarning = `Joined, but could not prepare local topic directories: ${error?.message || error}`
  }
  let receipt
  try { receipt = registerAfterJoin({ roomId, name: res.name, role, ownerDisplayName: res.ownerDisplayName, pane: args.pane }) } catch (e) {
    receipt = { registered: false, reason: 'error', warn: `Could not register for delivery on this computer: ${e?.message || e}` }
  }
  const warn = [res.warn, receipt.warn, directoryWarning].filter(Boolean).join(' ')
  return done({ ...(receipt.attachCode ? { attachCode: receipt.attachCode } : {}), ...res, workspace, files, ...receipt, ...(warn ? { warn } : {}) })
}

async function listen(args) {
  const ctx = roomCtx(args)
  const res = await api('GET', roomPath(ctx.roomId, '/listen'), { role: ctx.role })
  remember(ctx)
  return done(res)
}

async function mark(args) {
  const ctx = roomCtx(args)
  const upTo = intArg(args, 'upTo', { required: true, hint: 'The seq of the last message you read, e.g. upTo=702.' })
  const res = await api('POST', roomPath(ctx.roomId, '/mark'), { role: ctx.role, body: { upTo }, retrySafe: true })
  remember(ctx)
  return done(res)
}

async function members(args) {
  const keys = ['q', 'kind', 'status', 'mine', 'online']
  readArgs(args, keys)
  const q = readQuery(args, keys)
  if (!q.has('status')) q.set('status', 'active')
  const ctx = roomCtx(args)
  const res = await api('GET', roomPath(ctx.roomId, `/members?${q}`), { role: ctx.role })
  remember(ctx)
  return done(res)
}

// The server may not have create/topic yet: say so instead of "unknown endpoint".
function laterOnServer(e, action) {
  if (e instanceof CliError && e.error === 'bad_request' && /Unknown endpoint/i.test(e.next || '')) {
    return new CliError('not_implemented', `This server (${server()}) does not support \`${action}\` yet. Do it on the web for now, or ask your person.`)
  }
  return e
}

async function create(args) {
  const name = need(args, 'name', "The topic's name, e.g. name='Login rework'.")
  const body = { name, topic: args.topic ?? '' }
  if (args.code !== undefined) body.code = args.code
  body.nonce = args.nonce || randomUUID()
  await ensureToken()
  let res
  try { res = await api('POST', '/rooms', { body }) } catch (e) { throw laterOnServer(e, 'create') }
  return done(res)
}

async function topic(args) {
  const ctx = roomCtx(args)
  if (args.topic === undefined) throw new CliError('bad_request', "Missing desc=. Example: desc='Ship the new login by Friday' (desc='' clears it).")
  let res
  try { res = await api('POST', roomPath(ctx.roomId, '/topic'), { role: ctx.role, body: { topic: args.topic }, retrySafe: true }) } catch (e) { throw laterOnServer(e, 'topic') }
  remember(ctx)
  return done(res)
}

async function roleCard(args) {
  const ctx = roomCtx(args)
  const card = need(args, 'roleCard', "Who you are, what you do, whose work you take; several lines are fine.")
  const res = await api('POST', roomPath(ctx.roomId, '/roleCard'), { role: ctx.role, body: { roleCard: card }, retrySafe: true })
  remember(ctx)
  return done(res)
}

async function leave(args) {
  const ctx = roomCtx(args)
  const res = await api('POST', roomPath(ctx.roomId, '/leave'), { role: ctx.role })
  unbindRoom(ctx.roomId)
  try { unregisterAfterLeave({ roomId: ctx.roomId, name: res.name || `${ctx.role}@` }) } catch {}
  return done(res)
}

export { join, listen, mark, members, create, topic, roleCard, leave }

export async function handoffs(args) {
  readArgs(args, [])
  const ctx = roomCtx(args)
  const res = await api('GET', roomPath(ctx.roomId, '/members?status=all'), { role: ctx.role })
  const handoffs = res.members.filter(m => m.handoff).map(m => ({ name: m.name, status: m.status, ...m.handoff }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  remember(ctx)
  return done({ topicId: ctx.roomId, handoffs })
}
