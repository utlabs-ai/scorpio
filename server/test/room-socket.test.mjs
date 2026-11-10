import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

const source = new URL('../../web/public/static/room-socket.js', import.meta.url)

function setup(early = null) {
  const sockets = []
  const timeouts = new Map()
  const intervals = new Map()
  const listeners = new Map()
  const windowListeners = new Map()
  const seen = []
  let nextTimer = 0
  class WebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; sockets.push(this) }
    send(value) { this.sent.push(value) }
    close() { this.closed = true }
    open() { this.readyState = 1; this.onopen?.() }
    frame(value) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }) }
    end(code = 1006) { this.onclose?.({ code }) }
  }
  const sandbox = {
    window: { scorpioEarly: early, scorpioRoomStarted: false,
      addEventListener(name, fn) { windowListeners.set(name, fn) }, removeEventListener(name) { windowListeners.delete(name) } },
    location: { protocol: 'http:', host: 'local.test', pathname: '/r/topic' },
    document: { visibilityState: 'visible', addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name) { listeners.delete(name) } },
    WebSocket,
    setTimeout(fn, ms) { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id },
    clearTimeout(id) { timeouts.delete(id) },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id },
    clearInterval(id) { intervals.delete(id) },
  }
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), sandbox)
  const status = { status(channel, value) { seen.push(`status:${channel}:${value}`) }, clear(channel) { seen.push(`clear:${channel}`) } }
  const socket = sandbox.window.createRoomSocket({ roomId: 'topic', status, reconnecting: 'retrying',
    hello: () => seen.push('hello'), members: () => seen.push('members'),
    removed: () => seen.push('removed'), gone: () => seen.push('gone') })
  for (const type of ['message', 'files', 'cursor', 'todo', 'schedules', 'quota', 'room', 'approvals', 'removed', 'deleted']) {
    socket.on(type, () => seen.push(type))
  }
  return { socket, sockets, timeouts, intervals, listeners, windowListeners, seen, WebSocket, sandbox,
    runTimeout() { const [id, timer] = timeouts.entries().next().value; timeouts.delete(id); timer.fn(); return timer.ms } }
}

test('pre-hello frames replay only the three data types that hello cannot cover, in arrival order', () => {
  const h = setup(); h.socket.connect(); const ws = h.sockets[0]
  for (const type of ['members', 'message', 'todo', 'files', 'schedules', 'cursor', 'quota', 'room']) ws.frame({ type })
  assert.deepEqual(h.seen, [])
  ws.frame({ type: 'hello' })
  assert.deepEqual(h.seen, ['hello', 'message', 'files', 'cursor'])
  ws.frame({ type: 'members' }); ws.frame({ type: 'todo' })
  assert.deepEqual(h.seen.slice(-2), ['members', 'todo'])
})

test('terminal frames are immediate, and irrelevant frames are ignored', () => {
  const h = setup(); h.socket.connect(); const ws = h.sockets[0]
  ws.frame('pong'); ws.frame('{bad'); ws.frame({ type: 'unknown' })
  assert.deepEqual(h.seen, [])
  ws.frame({ type: 'removed' })
  assert.deepEqual(h.seen, ['removed'])
  const other = setup(); other.socket.connect(); other.sockets[0].frame({ type: 'deleted' })
  assert.deepEqual(other.seen, ['deleted'])
})

test('early socket replays open, frames, close; a mismatched path is replaced', () => {
  const earlyWs = { url: 'ws://local.test/r/topic/ws', readyState: 1, sent: [], send(value) { this.sent.push(value) }, close() {} }
  const early = { ws: earlyWs, open: true, frames: [JSON.stringify({ type: 'message' }), JSON.stringify({ type: 'hello' }), JSON.stringify({ type: 'files' })], closed: { code: 1006 } }
  const h = setup(early); h.socket.connect()
  assert.deepEqual(h.seen.slice(0, 4), ['clear:connection', 'hello', 'message', 'files'])
  assert.equal(earlyWs.sent[0], 'visible')
  assert.equal(h.timeouts.size, 1)
  const wrong = { ws: { url: 'ws://local.test/r/wrong/ws', closed: false, close() { this.closed = true } }, frames: [] }
  const j = setup(wrong); j.socket.connect()
  assert.equal(wrong.ws.closed, true)
  assert.equal(j.sockets.length, 1)
  assert.equal(j.sandbox.window.scorpioEarly, null)
  assert.equal(j.sandbox.window.scorpioRoomStarted, true)
})

test('reconnect delays grow to 15 seconds; each connection gets a new hello hold', () => {
  const h = setup(); h.socket.connect()
  const expected = [1000, 2000, 4000, 8000, 15000]
  for (let i = 0; i < expected.length; i++) {
    const ws = h.sockets.at(-1)
    ws.frame({ type: 'message' }); ws.end()
    assert.equal(h.runTimeout(), expected[i])
  }
  h.sockets.at(-1).frame({ type: 'hello' })
  assert.equal(h.seen.filter((v) => v === 'message').length, 0)
  h.sockets.at(-1).frame({ type: 'message' })
  assert.equal(h.seen.filter((v) => v === 'message').length, 1)
})

test('close codes 4004 and 4010 stop; stop cancels pending reconnect and ping', () => {
  for (const [code, callback] of [[4004, 'removed'], [4010, 'gone']]) {
    const h = setup(); h.socket.connect(); h.sockets[0].end(code)
    assert.equal(h.timeouts.size, 0)
    assert.ok(h.seen.includes(callback))
  }
  const h = setup(); h.socket.connect(); h.sockets[0].open()
  assert.equal(h.intervals.size, 1)
  assert.deepEqual(h.sockets[0].sent, ['visible'])
  h.sandbox.document.visibilityState = 'hidden'; h.listeners.get('visibilitychange')()
  h.intervals.values().next().value.fn()
  assert.deepEqual(h.sockets[0].sent, ['visible', 'hidden', 'ping'])
  h.sockets[0].end(); assert.equal(h.intervals.size, 0)
  h.socket.stop(); assert.equal(h.timeouts.size, 0)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.windowListeners.size, 0)
  assert.equal(h.sockets.length, 1)
})

test('back on the page while a reconnect waits: it connects at once, and the backoff starts over', () => {
  const h = setup(); h.socket.connect()
  for (let i = 0; i < 4; i++) { h.sockets.at(-1).end(); h.runTimeout() }
  h.sockets.at(-1).end()
  assert.equal(h.timeouts.size, 1)
  h.listeners.get('visibilitychange')()
  assert.equal(h.timeouts.size, 0)
  assert.equal(h.sockets.length, 6)
  h.sockets.at(-1).end()
  assert.equal(h.runTimeout(), 1000)
})

test('back on the page with a socket that reads open: a ping, and without a pong in 5 s a new socket', () => {
  const h = setup(); h.socket.connect(); const ws = h.sockets[0]; ws.open()
  h.listeners.get('visibilitychange')()
  assert.deepEqual(ws.sent, ['visible', 'visible', 'ping'])
  const [[id, probe]] = h.timeouts.entries()
  assert.equal(probe.ms, 5000)
  ws.frame('pong')
  assert.equal(h.timeouts.has(id), false)
  assert.equal(h.sockets.length, 1)

  h.windowListeners.get('online')()
  assert.equal(ws.sent.at(-1), 'ping')
  h.runTimeout()
  assert.equal(ws.closed, true)
  assert.equal(h.sockets.length, 2)
  assert.equal(h.seen.at(-1), 'status:connection:retrying')
  ws.end()
  assert.equal(h.timeouts.size, 0, 'the dropped socket closing later schedules nothing')
  h.sockets[1].open()
  assert.equal(h.seen.at(-1), 'clear:connection')
})

test('hidden does not probe; a socket still connecting is left to finish', () => {
  const h = setup(); h.socket.connect(); const ws = h.sockets[0]
  h.listeners.get('visibilitychange')()
  assert.equal(h.timeouts.size, 0)
  ws.open()
  h.sandbox.document.visibilityState = 'hidden'; h.listeners.get('visibilitychange')()
  assert.deepEqual(ws.sent, ['visible', 'hidden'])
  assert.equal(h.timeouts.size, 0)
})

// Approval snapshots are separate from hello and must survive an early socket connection.
test('approval snapshots received before hello replay on connect and reconnect', () => {
  const h = setup(); h.socket.connect(); const ws = h.sockets[0]
  ws.frame({ type: 'approvals', items: [{ id: 'first' }] }); ws.frame({ type: 'hello' })
  assert.deepEqual(h.seen, ['hello', 'approvals'])
  ws.end(); h.runTimeout(); const next = h.sockets[1]
  next.frame({ type: 'approvals', items: [] }); next.frame({ type: 'hello' })
  assert.deepEqual(h.seen.slice(-2), ['hello', 'approvals'])
})
