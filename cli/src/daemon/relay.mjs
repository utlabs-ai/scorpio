// The daemon's relay: the CLI on this computer sends its requests to a unix socket the daemon
// listens on, and the daemon forwards them to the server over the connections it already has open.
//
// Why: on some networks every new TLS connection takes about 10 s and many are reset, while an open
// one answers in a fraction of a second. Each CLI command is a new process, so on its own it pays a
// new handshake every time. The daemon keeps its connections (net.mjs: 2 per server, 2 idle minutes)
// and, while the CLI used it in the last half hour, asks the server for something small every 3 idle
// minutes so one stays open.
//
// It is not a proxy to anywhere: it only forwards to this computer's server, with the headers the CLI
// sent (its own token, role and user agent), and only this user can open the socket (~/.scorpio/state
// is 0700, the socket 0600). The CLI goes straight to the server when the socket isn't there or nobody
// answers on it, and when it asks for another server (X-Scorpio-Server).
//
// Headers from the CLI: X-Scorpio-Server (the server it means), X-Scorpio-Safe: 1 (may be sent twice),
// X-Scorpio-Budget (ms it can still wait). When every try failed the answer is 502 with
// X-Scorpio-Relay: failed and {"error":"network","sent":false|null,"tries","cause"}.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RELAY_SOCKET, relaySocketFits, server as serverUrl } from './paths.mjs'
import { CLI_BUDGET_MS, causeOf, tryFor } from '../net.mjs'

const MIN = 60_000
export const WARM_EVERY_MS = 3 * MIN // the server's side closed idle connections after about 6.5 minutes
export const WARM_FOR_MS = 30 * MIN // keep warm this long after the CLI last used the relay
const WARM_PATH = '/dl/latest.json' // small, served from static assets
// A forwarded request older than this holds no restart: nothing the CLI sends takes that long (its budget is
// 100 s), so one still counted is stuck, and an update must not wait on it forever.
export const BUSY_MAX_MS = 10 * MIN
// Not passed on: hop-by-hop, what fetch sets itself, and the relay's own.
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'expect', 'te', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'x-scorpio-server', 'x-scorpio-safe', 'x-scorpio-budget'])
// fetch has already undone the content encoding, and the length may differ from the server's.
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length'])

const strip = (url) => String(url || '').replace(/\/+$/, '')

export function createRelay({ socketPath = RELAY_SOCKET, server = serverUrl, log = () => {}, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, sleep, onUpgradeRequired = () => {} } = {}) {
  let usedAt = -Infinity, upstreamAt = -Infinity, warming = null
  const inflight = new Map() // request → when it came in

  async function handle(req, res) {
    const key = {}
    inflight.set(key, now())
    usedAt = now()
    try {
      const target = strip(server())
      const asked = strip(req.headers['x-scorpio-server'])
      if (asked && asked !== target) return answer(res, 421, { error: 'other_server', server: target }, 'other-server')
      // Only paths on this server: an absolute URL or //host in the request line would name another host.
      let url
      try { url = new URL(target + req.url) } catch {}
      if (!/^\/(?!\/)/.test(req.url) || !url || url.origin !== new URL(target).origin) return answer(res, 400, { error: 'bad_request' }, 'bad-path')
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
      const headers = {}
      for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQUEST.has(k)) headers[k] = v
      const left = Number(req.headers['x-scorpio-budget'])
      const budgetMs = Number.isFinite(left) ? Math.max(1_000, Math.min(CLI_BUDGET_MS, left)) : CLI_BUDGET_MS
      let up
      try {
        up = await tryFor((ms) => fetchImpl(url, { method: req.method, headers, body, signal: AbortSignal.timeout(ms) }),
          { safe: req.headers['x-scorpio-safe'] === '1', budgetMs, now, ...(sleep ? { sleep } : {}) })
      } catch (e) {
        log(`relay: ${req.method} ${url.pathname} failed after ${e.tries} ${e.tries === 1 ? 'try' : 'tries'} in ${Math.round(e.ms / 1000)} s: ${causeOf(e)}`)
        return answer(res, 502, { error: 'network', sent: e.sent, tries: e.tries, cause: causeOf(e) }, 'failed')
      }
      upstreamAt = now()
      if (up.status === 426) onUpgradeRequired() // the CLI here is too old for the server: the daemon updates the package
      const out = {}
      for (const [k, v] of up.headers) if (!DROP_RESPONSE.has(k)) out[k] = v
      res.writeHead(up.status, out)
      if (!up.body || req.method === 'HEAD') return res.end()
      // The body as it comes (an image may be megabytes); a break midway breaks the CLI's response too. A CLI
      // that hung up while the server was still answering (killed by its shell at 2 minutes, out of budget)
      // has closed res already: pipeline ends at once and cancels the body. Waiting for res's 'close' here
      // waited forever then, and the request kept the daemon from ever restarting after an update.
      await pipeline(Readable.fromWeb(up.body), res).catch(() => res.destroy())
    } catch (e) {
      log(`relay: ${String(e?.message || e).slice(0, 160)}`)
      if (!res.headersSent) answer(res, 502, { error: 'network', sent: null, tries: 0, cause: causeOf(e) }, 'failed')
      else res.destroy()
    } finally { inflight.delete(key) }
  }

  function answer(res, status, data, tag) {
    res.writeHead(status, { 'content-type': 'application/json', 'x-scorpio-relay': tag })
    res.end(JSON.stringify(data))
  }

  const httpServer = http.createServer((req, res) => { handle(req, res) })
  httpServer.keepAliveTimeout = 5_000

  return {
    /** Listen on the socket. The pid lock says no other daemon runs here, so a socket file left over is stale. */
    async start() {
      if (!relaySocketFits(socketPath)) throw Object.assign(new Error(`the path ${socketPath} is too long for a unix socket`), { code: 'path_too_long' })
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
      try { fs.unlinkSync(socketPath) } catch {}
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(socketPath, () => { httpServer.off('error', reject); resolve() })
      })
      try { fs.chmodSync(socketPath, 0o600) } catch {}
    },
    stop() {
      try { httpServer.close() } catch {}
      try { fs.unlinkSync(socketPath) } catch {}
    },
    /** A request is being forwarded: the daemon does not restart under it (one stuck past BUSY_MAX_MS does not count). */
    busy: () => [...inflight.values()].some((at) => now() - at < BUSY_MAX_MS),
    /** How many requests are being forwarded, the stuck ones too: said when a restart waits long. */
    inflight: () => inflight.size,
    /** Each round: while the CLI used the relay lately, keep a connection to the server open. */
    tick() {
      const t = now()
      if (warming || t - usedAt >= WARM_FOR_MS || t - upstreamAt < WARM_EVERY_MS) return
      warming = fetchImpl(strip(server()) + WARM_PATH, { signal: AbortSignal.timeout(60_000) })
        .then((r) => r.arrayBuffer())
        .then(() => { upstreamAt = now() })
        // Failed (a reset handshake): try again in half a minute, not every round.
        .catch(() => { upstreamAt = now() - WARM_EVERY_MS + 30_000 })
        .finally(() => { warming = null })
    },
    /** For tests: when the server was last reached. */
    get upstreamAt() { return upstreamAt },
  }
}
