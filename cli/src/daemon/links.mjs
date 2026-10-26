// The daemon's live connections to rooms. Two shapes, chosen per room by what the server said when
// the seat joined:
//
// - host: one WebSocket per room as the host seat. The daemon sends {"type":"carry","names":[…]} with
//   the agents of this computer in that room (the whole list, every time it changes); pushes for them
//   arrive with "to". The server also sends room state (members, topic, last_human_ts).
// - agent (until the server knows hosts): one WebSocket per agent, opened with that agent's role, so
//   it shows online and its pushes arrive; plus one for the seat itself.
//
// A connection here is a doorbell and a presence: frames go to onFrame, and the daemon reads the
// authoritative state over HTTP (listen) before it types anything.

const PING_MS = 30_000
// No pong (or any frame) for this long: the connection is dead even if no close ever came (a network
// that dropped it silently). Drop it and connect again.
const DEAD_MS = 2.5 * PING_MS
// Not open this long after connecting: give up on it and connect again. A network that swallows the
// handshake (no answer, no reset) leaves a socket connecting for good, with no close to retry on: the
// seat sat offline for 90 minutes that way while deliveries limped on the once-a-minute sweep.
export const OPEN_MS = 45_000

export function createLinks({ api, log = () => {}, onFrame, onTokenRejected = () => {}, WebSocketImpl = globalThis.WebSocket, now = () => Date.now() }) {
  const links = new Map()

  function open(spec) {
    const link = { ...spec, carry: spec.carry || [], ws: null, isOpen: false, openedAt: 0, latencyMs: null, latencyAt: null, pingSentAt: null, failures: 0, closed: false, timer: null, ping: null, opening: null }
    const connect = () => {
      if (link.closed) return
      let ws
      try {
        ws = new WebSocketImpl(api.wsUrl(link.roomId), {
          headers: { Authorization: `Bearer ${api.token()}`, 'X-Scorpio-Role': link.role, 'User-Agent': api.userAgent },
        })
      } catch (e) {
        // Not even started (no WebSocket in this Node, a header it refuses): say why, once per reason, and keep trying.
        const why = `could not start: ${e?.message || e}`
        if (why !== link.startError) { link.startError = why; onFrame(link, { type: 'closed', reason: why }) }
        return retry()
      }
      link.ws = ws
      clearTimeout(link.opening)
      link.opening = setTimeout(() => dead(ws, `not connected within ${OPEN_MS / 1000} s`), OPEN_MS)
      ws.addEventListener('open', () => {
        if (link.ws !== ws) return
        clearTimeout(link.opening)
        link.isOpen = true; link.openedAt = now(); link.failures = 0; link.heard = now(); link.startError = null
        link.latencyMs = null; link.latencyAt = null; link.pingSentAt = null
        clearInterval(link.ping)
        link.ping = setInterval(() => {
          if (now() - link.heard > DEAD_MS) return dead(ws, `nothing heard for ${Math.round(DEAD_MS / 1000)} s`)
          try { link.pingSentAt = now(); ws.send('ping') } catch {}
        }, PING_MS)
        if (link.host) sendCarry(link)
        if (link.host) { try { link.pingSentAt = now(); ws.send('ping') } catch {} }
        onFrame(link, { type: 'open' })
      })
      ws.addEventListener('message', (ev) => {
        if (link.ws !== ws) return
        link.heard = now()
        if (ev.data === 'pong') {
          if (link.pingSentAt != null) { link.latencyMs = now() - link.pingSentAt; link.latencyAt = now(); link.pingSentAt = null; onFrame(link, { type: 'latency', ms: link.latencyMs }) }
          return
        }
        if (typeof ev.data !== 'string') return
        let frame
        try { frame = JSON.parse(ev.data) } catch { return }
        onFrame(link, frame)
      })
      // An error is always followed by close. A socket already given up on (dead) may close much later,
      // when its successor is open: it must not touch the link.
      ws.addEventListener('close', (ev) => {
        if (link.ws !== ws) return
        clearInterval(link.ping); clearTimeout(link.opening)
        const was = link.isOpen
        link.isOpen = false
        link.ws = null
        if (link.closed) return
        if (ev?.code === 4011) onTokenRejected()
        onFrame(link, { type: 'closed', code: ev?.code, reason: ev?.reason, wasOpen: was })
        retry()
      })
    }
    // Give up on a silent connection, or one that never opened, without waiting for a close that may never come.
    const dead = (ws, reason) => {
      if (link.ws !== ws) return
      clearInterval(link.ping); clearTimeout(link.opening)
      link.ws = null; link.isOpen = false
      try { ws.close() } catch {}
      onFrame(link, { type: 'closed', reason })
      retry()
    }
    const retry = () => {
      if (link.closed) return
      link.failures += 1
      // The handshake carries no error body; after a few failures the daemon asks over HTTP why.
      if (link.failures === 3) onFrame(link, { type: 'failing' })
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(link.failures - 1, 5))
      clearTimeout(link.timer)
      link.timer = setTimeout(connect, delay)
    }
    link.close = () => {
      link.closed = true
      clearTimeout(link.timer); clearInterval(link.ping); clearTimeout(link.opening)
      try { link.ws?.close(1000, 'daemon') } catch {}
      link.ws = null; link.isOpen = false
    }
    connect()
    return link
  }

  function sendCarry(link) {
    try { link.ws?.send(JSON.stringify({ type: 'carry', names: link.carry, perm: link.perm || {} })) } catch {}
  }

  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

  /**
   * Make the open connections match the wanted ones: [{key, roomId, role, host, name, carry, perm}].
   * Unwanted ones are closed; changed carry names or permissions are sent on the host connection.
   */
  function sync(wanted) {
    const keys = new Set(wanted.map((w) => w.key))
    for (const [key, link] of links) {
      if (!keys.has(key)) { link.close(); links.delete(key); log(`connection closed: ${key}`) }
    }
    for (const w of wanted) {
      const carry = [...(w.carry || [])].sort()
      const link = links.get(w.key)
      if (link && link.role !== w.role) { link.close(); links.delete(w.key) } // the seat was renamed: reconnect under the new role
      if (!links.get(w.key)) { links.set(w.key, open({ ...w, carry })); log(`connecting: ${w.key}`); continue }
      if (w.host && (!same(link.carry, carry) || JSON.stringify(link.perm || {}) !== JSON.stringify(w.perm || {}))) {
        link.carry = carry; link.perm = w.perm || {}; if (link.isOpen) sendCarry(link)
      }
    }
  }

  /** Send a frame on an open connection; false when it is not open. */
  function send(key, frame) {
    const link = links.get(key)
    if (!link?.isOpen) return false
    try { link.ws.send(JSON.stringify(frame)); return true } catch { return false }
  }

  // A one-shot connection through the same WebSocket implementation and auth headers as a topic link.
  function selfcheck(timeoutMs = 60_000) {
    return new Promise((resolve) => {
      let ws, timer, nonce = null, doneAlready = false
      const done = (ok) => {
        if (doneAlready) return
        doneAlready = true
        clearTimeout(timer)
        try { ws?.close() } catch {}
        resolve(ok)
      }
      timer = setTimeout(() => done(false), timeoutMs)
      try {
        ws = new WebSocketImpl(api.wsSelfcheckUrl(), {
          headers: { Authorization: `Bearer ${api.token()}`, 'User-Agent': api.userAgent },
        })
        ws.addEventListener('message', (event) => {
          let frame
          try { frame = JSON.parse(String(event.data)) } catch { return done(false) }
          if (!nonce && frame.type === 'selfcheck' && typeof frame.nonce === 'string' && frame.nonce) {
            nonce = frame.nonce
            try { ws.send(JSON.stringify({ type: 'selfcheck', nonce })) } catch { done(false) }
          } else if (nonce && frame.type === 'selfcheck_ok') done(true)
          else done(false)
        })
        ws.addEventListener('error', () => done(false))
        ws.addEventListener('close', (event) => { if (event?.code === 4011) onTokenRejected(); done(false) })
      } catch { done(false) }
    })
  }

  return {
    sync,
    send,
    selfcheck,
    get: (key) => links.get(key) || null,
    all: () => [...links.values()],
    closeAll() { for (const link of links.values()) link.close(); links.clear() },
  }
}
