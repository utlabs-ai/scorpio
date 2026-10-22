// The installer's server step: `--server` names another server than config.json. One token is
// shared by this computer's daemon and every agent on it. When the new server is the one this package
// was built for, it is asked whether it still takes the token (the same server under another name, its
// workers.dev address say, does), and the token goes only if it refuses. Any other address never sees
// the token: an invitation or a message could name a server of someone else's, so there it goes as before.

import fs from 'node:fs'
import path from 'node:path'

const TRIES = 3
const TIMEOUT_MS = 15_000

/**
 * GET <server>/api/v1/whoami with the token: {verdict: 'ok'} on 200, {verdict: 'refused'} on 401, else
 * {verdict: 'unknown', reason}. A read, so a network failure is tried again (after 1 s, then 2 s).
 */
export async function checkToken({ server, token, version = '', fetchImpl = (...a) => globalThis.fetch(...a),
  tries = TRIES, timeoutMs = TIMEOUT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const headers = { Authorization: `Bearer ${token}`, 'X-Scorpio-Cli': version, 'User-Agent': `scorpio-install/${version}`, Accept: 'application/json' }
  let reason = 'no answer'
  for (let i = 0; i < tries; i += 1) {
    if (i) await sleep(1000 * 2 ** (i - 1))
    try {
      const res = await fetchImpl(`${server}/api/v1/whoami`, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 200) return { verdict: 'ok' }
      if (res.status === 401) return { verdict: 'refused' }
      return { verdict: 'unknown', reason: `HTTP ${res.status}` }
    } catch (e) {
      reason = e?.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : String(e?.cause?.code || e?.code || e?.message || e)
    }
  }
  return { verdict: 'unknown', reason }
}

/**
 * Keep or remove ~/.scorpio/token for the new server `to`; only `trusted` (the package's own server) is
 * asked. The pending device code (device.json) belonged to the old server and goes either way. Returns
 * the line the installer prints.
 */
export async function onServerChange({ dir, from, to, trusted, version, check = checkToken }) {
  const tokenFile = path.join(dir, 'token')
  fs.rmSync(path.join(dir, 'device.json'), { force: true })
  let token = null
  try { token = fs.readFileSync(tokenFile, 'utf8').trim() || null } catch { /* none yet */ }
  const head = `Server changed from ${from} to ${to}`
  if (!token) return `${head}.`
  if (to !== trusted) {
    fs.rmSync(tokenFile, { force: true })
    return `${head}: removed this computer's token without sending it there (only ${trusted}, the server this package is built for, is asked whether it still takes it), so the next join asks your person to approve this computer again.`
  }
  const { verdict, reason } = await check({ server: to, token, version })
  if (verdict === 'ok') return `${head}: it accepts this computer's token, so the token is kept.`
  if (verdict === 'refused') {
    fs.rmSync(tokenFile, { force: true })
    return `${head}: it refused this computer's token (401), so the token was removed and the next join asks your person to approve this computer again.`
  }
  return `${head}: could not check this computer's token there (${reason}), so it is kept. If that server refuses it, the next scorpio command removes it and asks your person to approve this computer again.`
}
