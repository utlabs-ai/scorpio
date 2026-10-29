import { randomUUID } from 'node:crypto'
import { roomCtx, textArg, intArg, CliError, boolArg, api, roomPath, remember, done } from '../client.mjs'
import { fileArgs, upload } from './file.mjs'
import { itemArg, itemsArg } from './task.mjs'
import { memoIds } from './memo.mjs'
import { richMessageArgs } from '../rich-message.mjs'

async function send(args) {
  const ctx = roomCtx(args)
  const body = { text: textArg(args), ...richMessageArgs(args) }
  for (const key of ['cite', 'misled']) if (args[key] !== undefined) body[key] = memoIds(args[key], key)
  if (body.cite?.some(id => body.misled?.includes(id))) throw new CliError('bad_request', 'A memo cannot be both cited and misled in one message.')
  const replyTo = intArg(args, 'replyTo')
  if (replyTo !== undefined) body.replyTo = replyTo
  if (args.done !== undefined) body.done = itemArg(args.done, 'done')
  // update=: the message becomes the task's source, and to= hands it on.
  if (args.update !== undefined) {
    if (args.done !== undefined || args.add !== undefined) throw new CliError('bad_request', "update= goes alone: its to= is the task's new assignee. Send done= or add= in a message of their own.")
    body.update = itemArg(args.update, 'update')
    if (args.to !== undefined) body.to = args.to
    // title=: the message renames the task it updates; the server checks it.
    if (args.title !== undefined) body.title = args.title
    if (boolArg(args.force)) body.force = true
    const stray = ['desc', 'after'].filter((k) => args[k] !== undefined)
    if (stray.length) throw new CliError('bad_request', `${stray.map((k) => `${k}=`).join(', ')} only go with add='<title>'; to change the task itself: scorpio task topicId=${ctx.roomId} edit=${body.update} ${stray.map((k) => `${k}=…`).join(' ')}.`)
  } else if (args.add !== undefined) {
    body.add = String(args.add).trim()
    if (!body.add) throw new CliError('bad_request', "add= is the new task's title, e.g. add='Decide the free quota' to=kai.")
    if (args.to !== undefined) body.to = args.to
    if (args.desc !== undefined) body.desc = args.desc
    if (args.after !== undefined) body.after = itemsArg(args.after, 'after')
  } else {
    const stray = ['to', 'desc', 'after', 'title'].filter((k) => args[k] !== undefined)
    if (stray.length) throw new CliError('bad_request', `${stray.map((k) => `${k}=`).join(', ')} only go with add='<title>' (send … add='…' to=<name>), or to= and title= with update=T3.`)
  }
  const files = fileArgs(args)
  if (files.length) {
    body.files = []
    for (const f of files) body.files.push(await upload(ctx, f))
  }
  body.nonce = args.nonce || randomUUID()
  const res = await api('POST', roomPath(ctx.roomId, '/send'), { role: ctx.role, body })
  remember(ctx)
  return done(res)
}

export { send }
