import { randomUUID } from 'node:crypto'
import { api, CliError, done, intArg, remember, roomCtx, roomPath, textArg } from '../client.mjs'

const FORMS = ['add', 'retire', 'show', 'retired', 'restore', 'long', 'versions']
const formsHint = "Use one form: add='…' from=#seq|T3 [replaces=M3], retire=M3, show=M3, retired=true [limit= before=M3], restore=M3, long=L1 text='…' version=0 [merged=M3], versions=L1 [limit= before=], or restore=L1 version=1."
export function memoId(value, key = 'id') {
  if (!/^M[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(String(value).slice(1)))) throw new CliError('bad_request', `${key}= takes a memo number such as M3.`)
  return String(value)
}
export function memoIds(value, key) {
  const list = String(value).split(',').map(s => s.trim())
  if (list.length > 8 || list.some(s => !s)) throw new CliError('bad_request', `${key}= takes 1 to 8 comma-separated M numbers.`)
  return [...new Set(list.map(s => memoId(s, key)))]
}
function slot(value) {
  if (value !== 'L1' && value !== 'L2') throw new CliError('bad_request', 'A long memo is L1 or L2.')
  return value
}
export async function memo(args) {
  const forms = FORMS.filter(k => args[k] !== undefined)
  if (forms.length > 1) throw new CliError('bad_request', formsHint)
  const op = forms[0]
  const longRestore = op === 'restore' && /^L/.test(args.restore)
  const fields = op === 'add' ? ['from', 'replaces'] : op === 'long' ? ['text', 'textFile', 'version', 'merged']
    : op === 'retired' || op === 'versions' ? ['limit', 'before'] : longRestore ? ['version'] : []
  if (Object.keys(args).some(k => !['roomId', 'role', op, ...fields].includes(k))) throw new CliError('bad_request', formsHint)
  const ctx = roomCtx(args), q = new URLSearchParams()
  let body
  if (op === 'show') q.set('show', memoId(args.show, 'show'))
  else if (op === 'retired' || op === 'versions') {
    if (op === 'retired' && !/^(?:1|true|yes)$/i.test(args.retired)) throw new CliError('bad_request', 'retired=true lists the retired memos.')
    q.set(op, op === 'retired' ? '1' : slot(args.versions))
    if (args.limit !== undefined) {
      const limit = intArg(args, 'limit', { required: true }), max = op === 'retired' ? 50 : 20
      if (limit > max) throw new CliError('bad_request', `limit= is 1 to ${max}.`)
      q.set('limit', limit)
    }
    if (args.before !== undefined) q.set('before', op === 'retired' ? memoId(args.before, 'before') : intArg(args, 'before', { required: true }))
  } else if (op) {
    body = { op: op === 'long' ? 'long' : op }
    if (op === 'add') {
      const sourceHint = "from= is the memo's source: a message (#123) or a task (T45)."
      if (args.from === undefined || args.from === '') throw new CliError('source_required', sourceHint)
      if (!/^(?:#[1-9]\d*|T[1-9]\d*)$/.test(args.from)) throw new CliError('bad_request', sourceHint)
      body.text = textArg({ text: args.add })
      body.from = args.from
      if (args.replaces !== undefined) body.replaces = memoId(args.replaces, 'replaces')
    } else if (op === 'long' || longRestore) {
      body.slot = slot(args[op])
      body.version = intArg(args, 'version', { required: true, min: longRestore ? 1 : 0 })
      if (op === 'long') {
        body.text = textArg(args)
        if (args.merged !== undefined) body.merged = memoIds(args.merged, 'merged')
      }
    } else body.id = memoId(args[op], op)
    body.nonce = randomUUID()
  }
  const res = await api(body ? 'POST' : 'GET', roomPath(ctx.roomId, `/memo${q.toString() ? '?' + q : ''}`), { role: ctx.role, ...(body ? { body } : {}) })
  remember(ctx)
  return done(res)
}
