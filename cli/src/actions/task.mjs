import fs from 'node:fs'
import { CliError, roomCtx, boolArg, api, roomPath, remember, done, intArg } from '../client.mjs'

// ---------- tasks (the server calls them todo) ----------

function itemArg(v, key) {
  // T3, 3, and the old spelling P3.
  const m = /^[TtPp]?(\d+)$/.exec(String(v || '').trim())
  if (!m) throw new CliError('bad_request', `${key}= takes a task id like T3 (or 3). List the tasks: scorpio task topicId=<topic id>`)
  return `T${m[1]}`
}
const itemsArg = (v, key) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => itemArg(x, key))
const descArg = (v) => (v === '-' ? fs.readFileSync(0, 'utf8').replace(/\n$/, '') : v)
const TODO_OPS = ['add', 'take', 'done', 'edit', 'delete', 'show', 'mine', 'open']
const STATUSES = ['todo', 'doing', 'done']

async function todo(args) {
  const ctx = roomCtx(args)
  if (args.round !== undefined || args.name !== undefined) throw new CliError('bad_request', 'Rounds are gone. To find a delivered task: search in=task, or task show=T….')
  const ops = TODO_OPS.filter((k) => args[k] !== undefined)
  if (ops.length > 1) throw new CliError('bad_request', `One of ${TODO_OPS.map((k) => `${k}=`).join(', ')} at a time (got ${ops.join(', ')}).`)
  const op = ops[0]
  let res
  if (!op) {
    res = await api('GET', roomPath(ctx.roomId, '/todo'), { role: ctx.role })
  } else if (op === 'mine' || op === 'open') {
    // The short views: yours and what you wait for; the whole topic's open tasks, or one name's.
    if (!boolArg(args[op])) throw new CliError('bad_request', `${op}=true, or leave it out for the full list.`)
    if (op === 'mine' && args.to !== undefined) throw new CliError('bad_request', 'to= goes with open=true (the open tasks under one name).')
    const q = op === 'mine' ? 'mine=1' : `open=1${args.to ? `&to=${encodeURIComponent(args.to)}` : ''}`
    res = await api('GET', roomPath(ctx.roomId, `/todo?${q}`), { role: ctx.role })
  } else if (op === 'show') {
    res = await api('GET', roomPath(ctx.roomId, `/todo/${itemArg(args.show, 'show')}`), { role: ctx.role })
  } else {
    const body = { op }
    if (op === 'add') {
      body.title = String(args.add).trim()
      if (!body.title) throw new CliError('bad_request', "add= is the task's title, e.g. add='Refresh-token endpoint'.")
      body.from = intArg(args, 'from', { required: true, hint: "Use send … add= to create a task with its source message, or pass from=<message seq>." })
      if (args.to !== undefined) body.to = args.to
      if (args.after !== undefined) body.after = itemsArg(args.after, 'after')
      if (args.desc !== undefined) body.desc = descArg(args.desc)
    } else if (op === 'delete') {
      body.ids = itemsArg(args.delete, 'delete')
      if (!body.ids.length) throw new CliError('bad_request', 'delete= takes task ids, e.g. delete=T3,T4.')
      if (boolArg(args.force)) body.force = true
    } else {
      body.id = itemArg(args[op], op)
      if (boolArg(args.force)) body.force = true
      if (op === 'edit') {
        // An empty to= or after= clears it.
        if (args.title !== undefined) body.title = args.title
        if (args.desc !== undefined) body.desc = descArg(args.desc)
        if (args.to !== undefined) body.to = args.to
        if (args.after !== undefined) body.after = itemsArg(args.after, 'after')
        if (args.from !== undefined) body.from = intArg(args, 'from')
        if (args.status !== undefined) {
          if (!STATUSES.includes(args.status)) throw new CliError('bad_request', `status= is one of ${STATUSES.join(', ')}.`)
          body.status = args.status
        }
        if (Object.keys(body).length === 2 + (body.force ? 1 : 0)) throw new CliError('bad_request', 'edit= changes something: add title=, to=, after=, from= or status=.')
      }
    }
    res = await api('POST', roomPath(ctx.roomId, '/todo'), { role: ctx.role, body })
  }
  remember(ctx)
  return done(res)
}

export { itemArg, itemsArg, todo }
