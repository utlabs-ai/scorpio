// What a signed-out daemon does with the reason. HTTP requests report their result here;
// the login loop is separate from delivery so an agent's current work is not interrupted.

import fs from 'node:fs'
import { TOKEN_FILE, DEVICE_FILE, LOGGED_OUT_FILE, readJson, rm, requestDeviceCode, pollDeviceCode, saveDeviceToken, server } from '../client.mjs'
import { readToken } from './api.mjs'

export const OFFLINE_LINE = 'Scorpio: this computer is logged out. Keep working on your current task, but do not send to Scorpio until a line here says it is back: sends fail, and new messages do not reach you.'
export const ONLINE_LINE = 'Scorpio: this computer is back online. Sending and receiving work again; resend what failed while it was out.'
export const NEW_CODE_MS = 10 * 60_000

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tokenStamp = () => {
  try {
    const { mtimeMs, size } = fs.statSync(TOKEN_FILE)
    return `${mtimeMs}:${size}`
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function createLogoutMonitor({
  token = readToken,
  marked = () => fs.existsSync(LOGGED_OUT_FILE),
  cache = () => readJson(DEVICE_FILE),
  requestCode = () => requestDeviceCode({ relogin: true }),
  pollCode = pollDeviceCode,
  saveToken = saveDeviceToken,
  clearCode = (code) => { if (readJson(DEVICE_FILE)?.device_code === code.device_code) rm(DEVICE_FILE) },
  onExpected = () => {}, onOffline = () => {}, onReload = () => {}, onOnline = () => {}, onError = () => {},
  now = Date.now, sleep = wait,
} = {}) {
  let state = 'online', failures = 0, reason = null, refusedToken = null, job = null
  let lastStamp = tokenStamp(), lastGoodToken = null, checkingToken = false

  function reset() { failures = 0; reason = null; refusedToken = null }
  function resume(newToken) {
    if (state !== 'offline' || !newToken) return
    state = 'online'
    lastGoodToken = newToken
    reset()
    onOnline()
  }

  async function relogin() {
    let lastCodeAt = 0
    while (state === 'offline') {
      const current = token()
      if (current && current !== refusedToken) {
        const code = cache()
        if (code) clearCode(code)
        resume(current); return
      }
      let code = cache()
      if (code?.created_at) lastCodeAt = Math.max(lastCodeAt, code.created_at)
      if (!code?.device_code || code.server !== server() || code.expires_at <= now()) {
        if (lastCodeAt && now() - lastCodeAt < NEW_CODE_MS) {
          await sleep(Math.min(5_000, NEW_CODE_MS - (now() - lastCodeAt)))
          continue
        }
        try {
          code = await requestCode()
          lastCodeAt = now()
        } catch (e) {
          onError(e)
          await sleep(30_000)
          continue
        }
      }
      try {
        const { status, data } = await pollCode(code)
        if (status === 200 && data?.access_token) {
          try { saveToken(data.access_token); resume(data.access_token) }
          catch (e) { onError(e); await sleep(30_000); continue }
          return
        }
        if (['expired_token', 'invalid_grant', 'access_denied'].includes(data?.error)) {
          clearCode(code)
          await sleep(5_000)
          continue
        }
        if (data?.error === 'slow_down') code.interval = (code.interval || 5) + 5
        else if (data?.error !== 'authorization_pending') onError(new Error(data?.error || `HTTP ${status}`))
      } catch (e) { onError(e) }
      await sleep(Math.max(1, code.interval || 5) * 1000)
    }
  }

  function observe({ code, reason: answerReason = null, token: usedToken = null, decisive = false }) {
    if (state !== 'online') return
    if (code === 'ok') { lastGoodToken = usedToken; reset(); return }
    if (code !== 'unauthorized' && code !== 'not_logged_in') return
    failures += 1
    if (answerReason) reason = answerReason
    if (usedToken) refusedToken = usedToken
    if (!decisive && failures < 3) return
    const current = token()
    if (reason === 'replaced' && current && current !== refusedToken) {
      reset()
      onReload()
      return
    }
    if (reason === 'revoked' || reason === 'plan' || marked()) {
      state = 'expected'
      const code = cache()
      if (code) clearCode(code)
      onExpected(reason || 'local logout', refusedToken)
      return
    }
    state = 'offline'
    onOffline(reason || (current ? 'token refused' : 'token missing'))
    job = relogin().catch(onError)
  }

  function checkLocalLogout() {
    if (state !== 'online' || !marked() || token()) return false
    state = 'expected'
    const code = cache()
    if (code) clearCode(code)
    onExpected('local logout')
    return true
  }

  async function checkTokenFile(whoami) {
    if (state !== 'online' || checkingToken) return
    const stamp = tokenStamp()
    if (stamp === lastStamp) return
    lastStamp = stamp
    const current = stamp === null ? null : token()
    if (current && current === lastGoodToken) return
    await checkToken(whoami)
  }

  async function checkToken(whoami) {
    if (state !== 'online' || checkingToken) return
    checkingToken = true
    try { await whoami({ decisive: true }) }
    finally { checkingToken = false }
  }

  return { observe, checkLocalLogout, checkTokenFile, checkToken, offline: () => state === 'offline', state: () => state, settle: () => job }
}
