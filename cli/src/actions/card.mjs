import path from 'node:path'
import { roomCtx, intArg, api, roomPath, remember, done, CliError, writePrivate } from '../client.mjs'
import { topicFilesDir, ensureDir } from '../workspace.mjs'

export async function card(args) {
  const ctx = roomCtx(args)
  const seq = intArg(args, 'seq', { required: true, hint: 'The seq of the message with a card.' })
  let dir
  try { dir = topicFilesDir(ctx.roomId) }
  catch { throw new CliError('bad_request', 'topicId= is the topic id from your invitation.') }
  const data = await api('GET', roomPath(ctx.roomId, `/messages/${seq}/card`), { role: ctx.role })
  if (typeof data.html !== 'string') throw new CliError('server_error', 'The server answered without the card HTML. Rerun in a minute; if it keeps failing, tell your person.')
  const out = path.join(ensureDir(dir), `card-${seq}.html`)
  writePrivate(out, data.html)
  remember(ctx)
  return done({ roomId: ctx.roomId, seq, summary: data.summary, size: data.size, path: out })
}
