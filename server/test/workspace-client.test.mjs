// Unit boundary tests for browser transfer ownership; real Worker integration is covered separately.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
const wire = new URL('../../cli/src/workspace-protocol.mjs', import.meta.url).pathname
const built = await build({ entryPoints: [new URL('../../web/public/static/workspace-client.js', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false,
  plugins: [{ name: 'canonical-wire', setup(b) { b.onResolve({ filter: /workspace-assets\/wire\.js$/ }, () => ({ path: wire })) } }] })
const { createWorkspaceClient } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const tick = () => new Promise(resolve => setImmediate(resolve))
function setup(t) {
  const previous = { window: globalThis.window, fetch: globalThis.fetch }, handlers = {}, requests = [], sent = []
  let ctx
  const socket = { on(type, fn) { handlers[type] = fn }, connect() {}, send(data) { sent.push(JSON.parse(data)) }, stop() {} }
  globalThis.window = { createRoomSocket(value) { ctx = value; return socket } }
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    requests.push(JSON.parse(options.body)); options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
  const client = createWorkspaceClient({ topicId: 'aaaaaaaaaaaaaaaaaaaaaa', computerId: 'box', onState() {}, onReady() {}, onStatus() {}, onRevoked() {} })
  const ready = { type: 'workspace_ready', v: 1, connectionId: randomUUID(), connectionToken: 'a'.repeat(43), epoch: randomUUID(), computer: { computerId: 'box', online: true, workspaceProtocol: 1 } }
  const frame = value => handlers[value.type](value)
  frame(ready)
  t.after(() => { client.stop(); Object.assign(globalThis, previous) })
  return { client, requests, sent, ready, frame, disconnect: () => ctx.onDisconnect() }
}
test('pre-accepted transfer reset rejects only its own pending request', async t => {
  const s = setup(t), first = s.client.request({ op: 'read', path: 'first' }), second = s.client.request({ op: 'read', path: 'second' })
  const secondOutcome = second.catch(e => e.code)
  const failure = assert.rejects(first, e => e.code === 'workspace_reset')
  s.frame({ type: 'workspace_error', v: 1, epoch: s.ready.epoch, requestId: s.requests[0].requestId, transferId: randomUUID(), code: 'workspace_reset' })
  await failure; await tick()
  assert.equal(s.client.ready, true)
  const requestId = s.requests[1].requestId, transferId = randomUUID(), base = { v: 1, epoch: s.ready.epoch, requestId, transferId }
  s.frame({ ...base, type: 'workspace_accepted' })
  s.frame({ ...base, type: 'workspace_begin', streams: [{ name: 'file', exists: true, bytes: 3, encoding: 'utf-8' }] })
  s.frame({ ...base, type: 'workspace_chunk', seq: 0, stream: 'file', offset: 0, data: 'YWJj' })
  s.frame({ ...base, type: 'workspace_end', streams: [{ name: 'file', bytes: 3, chunks: 1 }], readAt: Date.now() })
  assert.equal((await secondOutcome).file.text, 'abc')
  assert.equal(s.requests.length, 2)
})
test('same identity ready is idempotent and a reconnect never creates an automatic read', async t => {
  const s = setup(t), pending = s.client.request({ op: 'list', path: '' }), outcome = pending.catch(e => e.code)
  s.frame(s.ready); await tick()
  assert.equal(s.requests.length, 1); assert.equal(s.client.ready, true)
  s.disconnect(); assert.equal(await outcome, 'workspace_offline')
  s.frame({ ...s.ready, connectionId: randomUUID() }); await tick()
  assert.equal(s.requests.length, 1)
})
test('begin and chunk cannot bind a job before acceptance and malformed totals never publish', async t => {
  const s = setup(t), pending = s.client.request({ op: 'read', path: 'file' }), outcome = pending.catch(e => e.code)
  const base = { v: 1, epoch: s.ready.epoch, requestId: s.requests[0].requestId, transferId: randomUUID() }
  s.frame({ ...base, type: 'workspace_begin', streams: [{ name: 'file', exists: true, bytes: 3, encoding: 'utf-8' }] })
  assert.equal(s.sent.length, 0)
  s.frame({ ...base, type: 'workspace_accepted' })
  s.frame({ ...base, type: 'workspace_begin', streams: [{ name: 'file', exists: true, bytes: 3, encoding: 'utf-8' }] })
  s.frame({ ...base, type: 'workspace_chunk', seq: 0, stream: 'file', offset: 1, data: 'YWJj' })
  assert.equal(await outcome, 'workspace_protocol_error')
  assert.equal(s.sent.at(-1).type, 'workspace_cancel')
})
