import fs from 'node:fs'
import {
  api, done, server, readToken, ensureToken, readBinding, sessionKey, rm, writePrivate,
  TOKEN_FILE, DEVICE_FILE, LOGGED_OUT_FILE,
} from '../client.mjs'

// ---------- actions ----------

async function login() {
  if (readToken()) {
    try {
      const me = await api('GET', '/whoami')
      rm(LOGGED_OUT_FILE)
      return done({ status: 'logged_in', server: server(), account: me.account ?? null, device: me.device ?? null })
    } catch (e) {
      if (e.error !== 'unauthorized') throw e
    }
  }
  await ensureToken()
  const me = await api('GET', '/whoami')
  rm(LOGGED_OUT_FILE)
  return done({ status: 'logged_in', server: server(), account: me.account ?? null, device: me.device ?? null })
}

async function whoami() {
  const rooms = {}
  for (const [id, v] of Object.entries(readBinding().rooms)) rooms[id] = typeof v === 'string' ? v : v?.role
  const base = { server: server(), account: null, displayName: null, email: null, device: null, tokenExpiresAt: null, plan: null, session: sessionKey(), rooms }
  if (!readToken()) return done({ ...base, next: 'No token on this computer yet. Run `scorpio login` (or `scorpio join …`, which logs in first).' })
  const me = await api('GET', '/whoami')
  return done({
    ...base,
    account: me.account ?? null,
    displayName: me.displayName ?? null,
    email: me.email ?? null,
    device: me.device ?? null,
    tokenExpiresAt: me.tokenExpiresAt ?? null,
    plan: me.plan ?? null,
  })
}

async function topics() {
  const res = await api('GET', '/rooms')
  return done({
    topics: res.rooms.map((r) => ({ id: r.roomId, name: r.name, status: r.status })),
    freeActiveLimitReached: res.freeActiveLimitReached === true,
  })
}

async function logout(args = {}) {
  if (args.yes !== 'true') return done({ status: 'confirm', next: 'Work in progress on this computer is not interrupted, but its messages will no longer reach any topic. To log out, run scorpio logout yes=true' })
  writePrivate(LOGGED_OUT_FILE, JSON.stringify({ at: Date.now() }) + '\n')
  fs.rmSync(TOKEN_FILE, { force: true })
  fs.rmSync(DEVICE_FILE, { force: true })
  return done({ status: 'logged_out', next: 'Work in progress on this computer is not interrupted, but its messages no longer reach any topic.' })
}

export { login, whoami, topics, logout }
