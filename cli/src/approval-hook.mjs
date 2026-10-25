// Native hooks only transport requests; a disconnected daemon leaves the native menu alone.
import net from 'node:net'
import path from 'node:path'
import { STATE_DIR } from './daemon/paths.mjs'

export async function approvalHook(cli, { input = process.stdin, output = process.stdout, pane = process.env.HERDR_PANE_ID,
  socket = path.join(STATE_DIR, 'approval.sock'), timeoutMs = cli === 'codex' ? 2000 : 3600_000 } = {}) {
  if (!pane || !['claude', 'codex'].includes(cli)) return
  await new Promise((resolve) => {
    const client = net.createConnection(socket)
    let buffer = '', finished = false
    const finish = (reply) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (cli === 'claude' && ['allow', 'deny'].includes(reply?.decision?.behavior)) {
        output.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: reply.decision } }) + '\n')
      }
      client.destroy(); resolve()
    }
    const timer = setTimeout(() => finish(), timeoutMs)
    client.on('connect', async () => {
      try {
        let raw = ''; for await (const chunk of input) raw += chunk
        const event = JSON.parse(raw)
        if (!finished) client.write(JSON.stringify({ v: 1, cli, pane, event }) + '\n')
      } catch { finish() }
    })
    client.on('data', (data) => {
      buffer += data
      if (buffer.includes('\n')) { try { finish(JSON.parse(buffer.split('\n')[0])) } catch { finish() } }
    })
    client.on('error', () => finish())
    client.on('close', () => finish())
  })
}
