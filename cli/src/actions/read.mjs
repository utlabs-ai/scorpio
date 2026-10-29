import { readArgs, readQuery, messageFilterKeys } from '../read-filters.mjs'
import { roomCtx, intArg, api, roomPath, remember, done, CliError } from '../client.mjs'

async function messages(args) {
  readArgs(args, messageFilterKeys)
  const ctx = roomCtx(args)
  const q = readQuery(args, messageFilterKeys)
  if (!q.has('limit')) q.set('limit', '50')
  const res = await api('GET', roomPath(ctx.roomId, `/messages?${q}`), { role: ctx.role })
  remember(ctx)
  return done(res)
}

async function search(args) {
  if (args.in !== undefined && !['messages', 'todo', 'files', 'memo'].includes(args.in)) throw new CliError('bad_request', 'in= is messages, task, files or memo.')
  const keys = ['q', 'in', 'limit', 'before', ...messageFilterKeys.filter(k => !['q', 'limit', 'before'].includes(k)), 'status', 'to']
  readArgs(args, keys)
  if (!args.q?.trim() && !keys.some(k => !['q', 'limit'].includes(k) && args[k] !== undefined)) throw new CliError('bad_request', 'Give q= search text, or give a filter or in=.')
  const ctx = roomCtx(args)
  const q = readQuery(args, keys)
  const res = await api('GET', roomPath(ctx.roomId, `/search?${q}`), { role: ctx.role })
  remember(ctx)
  return done(res)
}

async function files(args) {
  const keys = ['kind', 'q', 'by', 'from', 'since', 'until', 'before', 'beforeId', 'limit']
  readArgs(args, keys)
  const ctx = roomCtx(args)
  if (args.kind !== undefined && !['files', 'pics'].includes(args.kind)) throw new CliError('bad_request', 'kind= is files or pics.')
  if (args.by !== undefined && args.from !== undefined) throw new CliError('bad_request', 'Use by= or its synonym from=, not both.')
  const q = readQuery(args, keys)
  if (!q.has('limit')) q.set('limit', '20')
  const res = await api('GET', roomPath(ctx.roomId, `/files?${q}`), { role: ctx.role })
  remember(ctx)
  return done({
    topicId: ctx.roomId,
    kind: res.kind,
    files: res.files.map(({ id, name, type, size, from, displayName, seq, ts, link }) => ({ id, name, type, size, from, displayName, seq, ts, link })),
    hasMore: res.hasMore,
    counts: res.counts,
  })
}

async function message(args) {
  const ctx = roomCtx(args)
  const seq = intArg(args, 'seq', { required: true, hint: 'The seq of the message to fetch.' })
  const res = await api('GET', roomPath(ctx.roomId, `/messages/${seq}`), { role: ctx.role })
  remember(ctx)
  return done(res)
}

export { messages, search, files, message }
