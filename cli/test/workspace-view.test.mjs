import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createWorkspaceHost } from '../src/daemon/workspace-view.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
function setup(bytes = Buffer.from('hello')) {
  const frames = [], topicId = 'aaaaaaaaaaaaaaaaaaaaaa', epoch = randomUUID(), transferId = randomUUID()
  const socket = { send: text => frames.push(JSON.parse(text)) }
  const link = { host: true, isOpen: true, ws: socket, roomId: topicId }
  let reads = 0
  const host = createWorkspaceHost({ account: () => 'kai', computerId: () => 'box', files: {
    read: async () => { reads++; return { bytes, meta: { path: 'file' } } },
  } })
  host.handle(link, { type: 'ready' })
  host.handle(link, { type: 'workspace_host_ready', v: 1, epoch, computerId: 'box' })
  const request = { type: 'workspace_request', v: 1, topicId, computerId: 'box', owner: 'kai', viewerId: randomUUID(), requestId: randomUUID(), transferId, epoch, timeoutMs: 30000, op: 'read', path: 'file' }
  const ack = ackSeq => host.handle(link, { type: 'workspace_ack', v: 1, topicId, epoch, transferId, ackSeq })
  const close = () => { host.handle(link, { type: 'closed' }) }
  return { host, link, frames, request, ack, close, reads: () => reads }
}
test('1 MiB waits at four chunks and sends end only after the final cumulative ACK', async t => {
  const bytes = Buffer.alloc(1048576, 97), s = setup(bytes); t.after(s.close)
  s.host.handle(s.link, s.request); await tick()
  assert.equal(s.frames.filter(f => f.type === 'workspace_chunk').length, 4)
  assert.equal(s.frames.some(f => f.type === 'workspace_end'), false)
  for (let last = 3; last < 32; last += 4) { s.ack(last); await tick() }
  const chunks = s.frames.filter(f => f.type === 'workspace_chunk')
  assert.deepEqual(Buffer.concat(chunks.map(f => Buffer.from(f.data, 'base64'))), bytes)
  assert.equal(s.frames.at(-1).type, 'workspace_end')
})
test('forged account, topic, computer, path and epoch never start a read', async t => {
  const s = setup(); t.after(s.close)
  for (const change of [{ owner: 'mei' }, { topicId: 'bbbbbbbbbbbbbbbbbbbbbb' }, { computerId: 'other' }, { path: '../file' }, { epoch: randomUUID() }, { root: '/tmp' }]) s.host.handle(s.link, { ...s.request, ...change })
  await tick(); assert.equal(s.reads(), 0)
})
test('cancel, socket replacement and reset discard all subsequent bytes', async t => {
  for (const action of ['cancel', 'replace', 'reset']) {
    const s = setup(Buffer.alloc(200000, 97)); t.after(s.close)
    s.host.handle(s.link, s.request); await tick()
    const before = s.frames.filter(f => f.type === 'workspace_chunk').length
    if (action === 'cancel') s.host.handle(s.link, { ...s.request, type: 'workspace_cancel' })
    if (action === 'replace') s.link.ws = { send() {} }
    if (action === 'reset') s.host.handle(s.link, { type: 'workspace_reset', v: 1, epoch: randomUUID() })
    s.ack(3); await tick()
    assert.equal(s.frames.filter(f => f.type === 'workspace_chunk').length, before)
    assert.equal(s.frames.some(f => f.type === 'workspace_end'), false)
  }
})
