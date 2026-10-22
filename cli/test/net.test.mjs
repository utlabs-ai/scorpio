// Run with node --test from cli/ (no dependencies; local sockets only)
import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'
import http from 'node:http'

const { setupNetwork, notSent, waitedOut } = await import('../src/net.mjs')

// A TCP server that does something to each connection; resolves to its port.
async function tcp(onSocket) {
  const server = net.createServer(onSocket)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => { server.close(); for (const s of open) s.destroy() } }
}
const open = new Set()
const track = (s) => { open.add(s); s.on('close', () => open.delete(s)) }

const failure = (p) => p.then(() => assert.fail('should have failed'), (e) => e)

test('the connect timeout fetch and WebSocket use is the one set here', async (t) => {
  assert.equal(setupNetwork({ timeout: 300 }), true)
  const silent = await tcp((s) => track(s)) // accepts, never answers the TLS hello
  t.after(silent.close)

  const started = Date.now()
  const e = await failure(fetch(`https://127.0.0.1:${silent.port}/`, { method: 'POST', body: '{}' }))
  assert.equal(e.cause?.code, 'UND_ERR_CONNECT_TIMEOUT')
  assert.ok(Date.now() - started < 5000, 'gave up after our 300 ms, not the default 10 s')
  assert.equal(notSent(e), true)
  assert.equal(waitedOut(e), true, 'a connect that waited the full time is not retried')

  if (typeof WebSocket === 'function') {
    const wsStarted = Date.now()
    await new Promise((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${silent.port}/`)
      ws.addEventListener('error', resolve)
    })
    assert.ok(Date.now() - wsStarted < 5000, 'the WebSocket handshake has the same connect timeout')
  }
})

test('a reset during the handshake was not sent; a reset after the request went out may have been', async (t) => {
  const reset = await tcp((s) => s.resetAndDestroy())
  t.after(reset.close)
  const e = await failure(fetch(`https://127.0.0.1:${reset.port}/`, { method: 'POST', body: '{}' }))
  assert.equal(e.cause?.code, 'ECONNRESET')
  assert.equal(notSent(e), true)
  assert.equal(waitedOut(e), false)

  // Plain HTTP: the connection is up and the request is read before the reset.
  const server = http.createServer((req) => req.on('data', () => {}).on('end', () => req.socket.resetAndDestroy()))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const late = await failure(fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: '{}' }))
  assert.equal(notSent(late), false)
})

test('parallel requests share at most 2 connections, still open after 4 idle seconds', async (t) => {
  let connections = 0
  const server = http.createServer((req, res) => setTimeout(() => res.end('ok'), 50))
  server.keepAliveTimeout = 0 // no Keep-Alive hint (Cloudflare sends none): undici's own setting decides
  server.on('connection', () => { connections += 1 })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/`
  const round = () => Promise.all(Array.from({ length: 6 }, () => fetch(url).then((r) => r.text())))
  assert.deepEqual(await round(), Array(6).fill('ok'))
  assert.equal(connections, 2)
  await new Promise((r) => setTimeout(r, 4500)) // undici's default would have closed them by now
  await round()
  assert.equal(connections, 2)
})
