// The daemon's HTTP client for the agent API. Same token as the CLI: one per computer,
// shared by every agent on it and by the daemon. Room calls carry the role they act as.

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { TOKEN_FILE, server as serverUrl, version } from './paths.mjs'
import { causeOf, tryFor } from '../net.mjs'

export class ApiError extends Error {
  constructor(code, next, status = 0, reason = null) {
    super(`${code}: ${next || ''}`)
    this.code = code
    this.next = next
    this.status = status
    this.reason = reason
  }
}

export function readToken(file = TOKEN_FILE) {
  try { return fs.readFileSync(file, 'utf8').trim() || null } catch { return null }
}

export function createApi({ server = serverUrl, token = readToken, fetchImpl = (...a) => globalThis.fetch(...a), sleep = null, onUpgradeRequired = () => {}, onResult = () => {} } = {}) {
  const base = () => (typeof server === 'function' ? server() : server)
  const ua = `scorpio-daemon/${version()}`

  async function request(method, path, { body, role, budgetMs, decisive = false } = {}) {
    const t = token()
    if (!t) {
      onResult({ code: 'not_logged_in', token: null, decisive })
      throw new ApiError('not_logged_in', 'No token on this computer: run `scorpio login`.')
    }
    const headers = { Authorization: `Bearer ${t}`, 'User-Agent': ua, 'X-Scorpio-Cli': version(), Accept: 'application/json' }
    if (role) headers['X-Scorpio-Role'] = role
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    // Reads, writes that never left, and writes with a nonce (deduplicated by the server) are tried again.
    let res
    try {
      res = await tryFor((ms) => fetchImpl(`${base()}/api/v1${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms),
      }), { safe: method === 'GET' || Boolean(body?.nonce), ...(sleep ? { sleep } : {}), ...(budgetMs ? { budgetMs } : {}) })
    } catch (e) {
      if (budgetMs && e.ms >= budgetMs - 1_000) throw new ApiError('timeout', `No answer from ${base()} within ${Math.round(budgetMs / 1000)} s: ${causeOf(e)}`)
      throw new ApiError('network', `Could not reach ${base()}${e.tries > 1 ? ` (${e.tries} tries in ${Math.round(e.ms / 1000)} s)` : ''}: ${causeOf(e)}`)
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : {} } catch {}
    if (res.ok && data) { onResult({ code: 'ok', token: t, decisive }); return data }
    // The server no longer talks to this version: update now, not at the next hourly check.
    if (data?.error === 'upgrade_required' || res.status === 426) onUpgradeRequired()
    if (res.status === 401) onResult({ code: 'unauthorized', reason: data?.reason || null, token: t, decisive })
    if (data?.error) throw new ApiError(data.error, data.next, res.status, data.reason)
    throw new ApiError(res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not_found' : 'server_error', `HTTP ${res.status}`, res.status, data?.reason)
  }

  const room = (roomId, rest = '') => `/rooms/${encodeURIComponent(roomId)}${rest}`
  return {
    request,
    server: base,
    token,
    whoami: (options = {}) => request('GET', '/whoami', options),
    /** The rooms this account created. null when the server has no such endpoint yet. */
    async rooms() {
      try { return (await request('GET', '/rooms')).rooms || [] } catch (e) {
        if (e.status === 404 || e.code === 'not_found' || (e.code === 'bad_request' && e.status === 404)) return null
        throw e
      }
    },
    join: (roomId, body) => request('POST', room(roomId, '/join'), { body: { nonce: randomUUID(), ...body } }),
    listen: (roomId, role) => request('GET', room(roomId, '/listen'), { role }),
    messages: (roomId, role, { from, limit = 50 } = {}) => {
      const q = new URLSearchParams({ limit: String(limit), ...(from ? { from: String(from) } : {}) })
      return request('GET', room(roomId, `/messages?${q}`), { role })
    },
    members: (roomId, role) => request('GET', room(roomId, '/members'), { role }),
    send: (roomId, role, text, replyTo, screen) => request('POST', room(roomId, '/send'), { role, body: { text, nonce: randomUUID(), ...(replyTo ? { replyTo } : {}), ...(screen ? { screen } : {}) } }),
    mark: (roomId, role, upTo) => request('POST', room(roomId, '/mark'), { role, body: { upTo } }),
    leave: (roomId, role) => request('POST', room(roomId, '/leave'), { role, body: {} }),
    /** A seat's handoff in the cloud, read as this computer's seat for a takeover; budgetMs bounds the tries. */
    handoff: (roomId, role, name, { budgetMs } = {}) => request('GET', room(roomId, `/handoff?name=${encodeURIComponent(name)}`), { role, budgetMs }),
    /** The key table for /keys (keys.mjs); the server needs no login for it. */
    keys: () => request('GET', '/config/keys'),
    spawnOptions: () => request('GET', '/config/spawn'),
    spawnPerm: () => request('GET', '/account/spawn-perm'),
    wsUrl: (roomId) => `${base().replace(/^http/, 'ws')}/api/v1${room(roomId, '/ws')}`,
    wsSelfcheckUrl: () => `${base().replace(/^http/, 'ws')}/api/v1/selfcheck`,
    userAgent: ua,
  }
}
