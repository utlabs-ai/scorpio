// The key table for /keys: which keys a person or agent may press in a pane the daemon
// started, what the web shows on each, and how each terminal adapter sends it. It lives on the server
// (GET /api/v1/config/keys), so a key is added there without a release; the web reads the same
// table. The default below is the only place a key name is written in the daemon: when the server cannot be
// asked, or answers with something that is not a table, this is used.

const MINUTE = 60_000

export const DEFAULT_KEYS = Object.freeze({
  keys: [
    { name: 'up', label: '↑', herdr: 'up' },
    { name: 'down', label: '↓', herdr: 'down' },
    { name: 'enter', label: 'Enter', herdr: 'enter' },
    { name: 'esc', label: 'Esc', herdr: 'esc' },
  ],
  settleMs: 3000,
})

/** The table as the server sent it, or null when it is not one (keys with name and label, settleMs a positive number). */
export function keyTable(body) {
  const keys = body?.keys
  if (!Array.isArray(keys) || !keys.length) return null
  if (!keys.every((k) => k && typeof k.name === 'string' && k.name && typeof k.label === 'string')) return null
  const settleMs = Number(body.settleMs)
  if (!Number.isFinite(settleMs) || settleMs <= 0) return null
  return { keys, settleMs }
}

/** The keys one terminal adapter can send: those with a column for it. */
export const keysFor = (table, adapter) => table.keys.filter((k) => typeof k[adapter] === 'string' && k[adapter])

/** A key the command named: by name, or by what the web shows on it, either case. */
export function findKey(keys, word) {
  const w = String(word).toLowerCase()
  return keys.find((k) => k.name.toLowerCase() === w) || keys.find((k) => k.label.toLowerCase() === w) || null
}

/** "up (↑), down (↓), …": the keys for a reply. */
export const keyList = (keys) => keys.map((k) => (k.label && k.label !== k.name ? `${k.name} (${k.label})` : k.name)).join(', ')

/**
 * The table, asked of the server at most once a minute. fetch() resolves to the server's answer; a failure or
 * a bad answer gives the default until the next minute.
 */
export function createKeys({ fetch, now = () => Date.now(), ttlMs = MINUTE, log = () => {} }) {
  let table = DEFAULT_KEYS, at = -Infinity, pending = null
  return async function get() {
    if (now() - at < ttlMs) return table
    if (!pending) {
      pending = (async () => {
        let got = null
        try { got = keyTable(await fetch()) } catch (e) { log(`could not read the key table: ${e.code || e.message}`) }
        table = got || DEFAULT_KEYS
        at = now()
        return table
      })().finally(() => { pending = null })
    }
    return pending
  }
}
