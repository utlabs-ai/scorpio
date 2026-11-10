import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

function next(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000)
    ws.addEventListener(type, (event) => { clearTimeout(timer); resolve(event) }, { once: true })
  })
}

test('selfcheck is a device-token WebSocket round trip with no D1 write', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops')
    const response = await p.api('/selfcheck', { headers: { upgrade: 'websocket' } })
    assert.equal(response.status, 101)
    const ws = response.webSocket
    const challenge = next(ws, 'message')
    ws.accept()
    const frame = JSON.parse((await challenge).data)
    assert.equal(frame.type, 'selfcheck')
    assert.match(frame.nonce, /^[A-Za-z0-9_-]{24}$/)
    const answer = next(ws, 'message')
    const closed = next(ws, 'close')
    ws.send(JSON.stringify({ type: 'selfcheck', nonce: frame.nonce }))
    assert.deepEqual(JSON.parse((await answer).data), { type: 'selfcheck_ok' })
    await closed
    const row = await w.db.prepare('SELECT last_used_at FROM agent_tokens WHERE id = ?').bind('t-ops').first()
    assert.equal(row.last_used_at, null)
  } finally { await w.dispose() }
})

test('selfcheck closes on the wrong nonce without confirming success', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops')
    const response = await p.api('/selfcheck', { headers: { upgrade: 'websocket' } })
    assert.equal(response.status, 101)
    const ws = response.webSocket
    const challenge = next(ws, 'message')
    ws.accept()
    await challenge
    const frames = []
    ws.addEventListener('message', (event) => frames.push(JSON.parse(event.data)))
    const closed = next(ws, 'close')
    ws.send(JSON.stringify({ type: 'selfcheck', nonce: 'wrong' }))
    await closed
    assert.deepEqual(frames, [])
  } finally { await w.dispose() }
})

test('selfcheck refuses a bad token before upgrading', async () => {
  const w = await worker()
  try {
    const response = await w.fetch('/api/v1/selfcheck', { headers: { upgrade: 'websocket', authorization: 'Bearer wrong' } })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error, 'unauthorized')
    assert.equal(response.webSocket, null)
  } finally { await w.dispose() }
})
