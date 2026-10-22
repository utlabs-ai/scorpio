// Network settings shared by the CLI and the daemon.
//
// Some networks take 8–20 s for the TLS handshake with the server, and reset most handshakes when
// several run at once (seen on a machine reaching Cloudflare). Node's fetch and WebSocket (undici)
// give up connecting after 10 s, open one connection per parallel request and drop it after 4 idle
// seconds, so each round of the daemon's parallel reads paid fresh handshakes and lost some.
// setupNetwork() waits 60 s to connect, keeps at most 2 connections per server and keeps them for 2
// idle minutes (a WebSocket gets a connection of its own, outside these). Node does not export
// undici, so the Agent class is taken from the default dispatcher Node itself installs; a dispatcher
// someone else set (a proxy agent, say) is left alone, and so is anything this Node version does
// differently.
//
// A request whose connection never came up was not sent, so notSent() lets even a write be retried
// then. A connect that waited the whole minute is not retried (waitedOut): the agent's shell tool
// would kill the CLI first.
//
// On some networks every new TLS connection, to any host, took
// about 10 s and most were reset at about 11 s, while a connection already open answered in 0.3 s and
// stayed open for minutes. So retries run on a time budget (tryFor) rather than a count, and the CLI
// sends through the daemon (relay.mjs), whose connections are already open.

import dc from 'node:diagnostics_channel'

export const CONNECT_TIMEOUT_MS = 60_000
/** For a whole request: connecting, plus the server's answer. */
export const REQUEST_TIMEOUT_MS = CONNECT_TIMEOUT_MS + 30_000
/** The CLI's time for one request, tries included: an agent's shell tool kills a command after 2 minutes. */
export const CLI_BUDGET_MS = 100_000
/** No new try with less than this left: on a slow network the handshake alone takes 10 s. */
export const MIN_TRY_MS = 15_000
const CONNECTIONS = 2
const KEEP_IDLE_MS = 120_000
const DISPATCHER = Symbol.for('undici.globalDispatcher.1')
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
const neverConnected = new WeakSet()
let patient = false
dc.subscribe('undici:client:connectError', ({ error }) => { if (error && typeof error === 'object') neverConnected.add(error) })

/** Call once, before the first request. True when the settings are in place. */
export function setupNetwork({ timeout = CONNECT_TIMEOUT_MS, connections = CONNECTIONS, keepIdle = KEEP_IDLE_MS } = {}) {
  try {
    void globalThis.Headers // loads Node's undici, which installs its default dispatcher
    const current = globalThis[DISPATCHER]
    if (current?.constructor?.name !== 'Agent') return false
    globalThis[DISPATCHER] = new current.constructor({ connect: { timeout }, connections, keepAliveTimeout: keepIdle, keepAliveMaxTimeout: keepIdle })
    patient = true
    return true
  } catch { return false }
}

/** The request failed before anything reached the server, so resending it is safe. */
export function notSent(e) {
  return NOT_SENT.has(e?.cause?.code || e?.code) || neverConnected.has(e?.cause) || neverConnected.has(e)
}

/** Connecting timed out after the long wait: trying again would only keep the caller waiting. */
export function waitedOut(e) {
  return patient && (e?.cause?.code || e?.code) === 'UND_ERR_CONNECT_TIMEOUT'
}

/**
 * attempt(timeoutMs) until it answers. A failed try is tried again while that is safe (safe: a read or
 * a write the server deduplicates; else only when it was never sent) and the budget leaves room for
 * one more after the pause (1, 2, 4, 8, 8… s). The error thrown is the last one, with tries, sent
 * (false: it never left; null: unknown) and ms.
 */
export async function tryFor(attempt, { safe = false, budgetMs = CLI_BUDGET_MS, timeoutMs = REQUEST_TIMEOUT_MS, minTryMs = MIN_TRY_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const started = now()
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt(Math.max(1, Math.min(timeoutMs, budgetMs - (now() - started))))
    } catch (e) {
      const unsent = notSent(e)
      const pause = Math.min(8_000, 1_000 * 2 ** (tries - 1))
      if ((safe || unsent) && !waitedOut(e) && budgetMs - (now() - started) - pause >= minTryMs) { await sleep(pause); continue }
      const error = e instanceof Error ? e : new Error(String(e))
      Object.assign(error, { tries, sent: unsent ? false : null, ms: now() - started })
      throw error
    }
  }
}

/** Why a request failed, in a few words: the error code under fetch's "fetch failed". */
export const causeOf = (e) => e?.cause?.code || e?.code || (e?.name === 'TimeoutError' ? 'timeout' : e?.cause?.message || e?.message || String(e))
