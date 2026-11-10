// Actual Worker sockets hold real file reads without ACK to exercise all three shared capacity scopes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { worker, ORIGIN } from './helpers/worker.mjs'
import { createWorkspaceFiles } from '../../cli/src/daemon/workspace-files.mjs'
import { createWorkspaceHost } from '../../cli/src/daemon/workspace-view.mjs'
import { WORKSPACE } from '../../cli/src/workspace-protocol.mjs'
function channel(response) {
  assert.equal(response.status, 101)
  const ws = response.webSocket, frames = [], waiters = []
  ws.addEventListener('message', event => {
    if (event.data === 'pong') return
    const frame = JSON.parse(event.data); frames.push(frame)
    for (const waiter of [...waiters]) if (frame.type === waiter.type && waiter.predicate(frame)) { clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame) }
  })
  ws.accept()
  return { ws, frames, next(type, predicate = () => true) {
    const old = frames.find(frame => frame.type === type && predicate(frame)); if (old) return Promise.resolve(old)
    return new Promise((resolve, reject) => { const waiter = { type, predicate, resolve, timer: setTimeout(() => reject(new Error(`No ${type}`)), 5000) }; waiters.push(waiter) })
  } }
}
test('actual pending reads enforce 2/viewer, 8/account and 32/topic while carry/work remains usable', { timeout: 60000 }, async t => {
  const w = await worker(), home = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-capacity-')), hosts = [], viewers = []
  t.after(async () => { for (const { host, link } of hosts) host.handle(link, { type: 'closed' }); for (const viewer of viewers) viewer.ws.close(); await w.dispose(); await fs.rm(home, { recursive: true, force: true }) })
  const owner = await w.person('kai'), code = 'ABC-DEF-GHJ', topic = await w.topic(owner, code)
  const people = [owner, ...await Promise.all(['mei', 'zoe', 'user-a', 'user-b'].map(name => w.person(name)))]
  const casts = []
  for (const person of people) {
    if (person !== owner) assert.equal((await person.post(`/r/${topic}/enter`, { code })).status, 200)
    const computerId = `device-${person.handle}`, joined = await w.json(await person.apiPost(`/rooms/${topic}/join`, { host: true, device_id: computerId, machine: 'box' }))
    assert.equal(joined.status, 200)
    const socket = channel(await person.api(`/rooms/${topic}/ws`, { headers: { upgrade: 'websocket' } }, joined.name.split('@')[0]))
    const accountHome = path.join(home, person.handle), root = path.join(accountHome, 'topics', topic, 'workspace'); await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'file'), 'x')
    const host = createWorkspaceHost({ account: () => person.handle, computerId: () => computerId, files: createWorkspaceFiles({ home: accountHome, rootFor: () => root }) })
    const link = { host: true, isOpen: true, ws: socket.ws, roomId: topic }; hosts.push({ host, link })
    socket.ws.addEventListener('message', event => { if (event.data !== 'pong') host.handle(link, JSON.parse(event.data)) })
    for (const frame of socket.frames) host.handle(link, frame)
    await socket.next('workspace_host_ready')
    casts.push({ person, computerId, socket })
  }
  const viewer = async cast => {
    const result = channel(await cast.person.web(`/r/${topic}/workspace/ws?computer=${cast.computerId}`, { headers: { upgrade: 'websocket', origin: ORIGIN } })); viewers.push(result)
    result.ready = await result.next('workspace_ready'); result.cast = cast
    return result
  }
  const groups = []
  for (const cast of casts.slice(0, 4)) groups.push(await Promise.all(Array.from({ length: 4 }, () => viewer(cast))))
  const extraAccount = await viewer(casts[0]), extraTopic = await viewer(casts[4])
  await w.join(owner, topic, 'api')
  casts[0].socket.ws.send(JSON.stringify({ type: 'carry', names: ['api@kai'] }))
  assert.ok((await casts[0].socket.next('carried')).names.includes('api@kai'))
  const request = async target => {
    const ready = target.ready, requestId = randomUUID(), body = { connectionId: ready.connectionId, connectionToken: ready.connectionToken, epoch: ready.epoch, requestId, op: 'read', path: 'file' }
    const result = await w.json(await target.cast.person.post(`/r/${topic}/workspace/request?computer=${target.cast.computerId}`, body))
    return { target, body, result }
  }
  const held = await Promise.all(groups[0].flatMap(target => [request(target), request(target)]))
  for (const item of held) assert.equal(item.result.status, 200, JSON.stringify(item.result))
  const duplicate = held[0]
  assert.equal((await w.json(await owner.post(`/r/${topic}/workspace/request?computer=${casts[0].computerId}`, duplicate.body))).error, 'workspace_duplicate_request')
  assert.equal((await request(groups[0][0])).result.error, 'workspace_busy')
  assert.equal((await request(extraAccount)).result.error, 'workspace_busy')
  for (const group of groups.slice(1)) {
    const next = await Promise.all(group.flatMap(target => [request(target), request(target)]))
    for (const item of next) assert.equal(item.result.status, 200, JSON.stringify(item.result))
    held.push(...next)
  }
  assert.equal(held.length, 32)
  assert.equal((await request(extraTopic)).result.error, 'workspace_busy')
  casts[0].socket.ws.send(JSON.stringify({ type: 'work', name: 'api@kai', work: 'working' }))
  let working = false
  for (let attempt = 0; attempt < 20 && !working; attempt++) {
    const members = await w.json(await owner.api(`/rooms/${topic}/members`, {}, casts[0].socket.frames.find(frame => frame.type === 'ready').me.name.split('@')[0]))
    working = members.members.some(member => member.name === 'api@kai' && member.work === 'working')
    if (!working) await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(working, true)
  for (const item of held) item.target.ws.send(JSON.stringify({ type: 'workspace_cancel', v: 1, epoch: item.target.ready.epoch, requestId: item.body.requestId, transferId: item.result.transferId }))
  await Promise.all(held.map(item => item.target.next('workspace_error', frame => frame.requestId === item.body.requestId && frame.code === 'workspace_cancelled')))
  const released = await request(extraTopic)
  assert.equal(released.result.status, 200)
  await extraTopic.next('workspace_chunk', frame => frame.requestId === released.body.requestId)
  const unknown = randomUUID(), beforeCancel = casts[4].socket.frames.filter(frame => frame.type === 'workspace_cancel' && frame.transferId === unknown).length
  if (Date.now() % 60000 > 59000) await new Promise(resolve => setTimeout(resolve, 1100))
  for (let i = 0; i < 241; i++) casts[4].socket.ws.send(JSON.stringify({ type: 'workspace_chunk', v: 1, topicId: topic, epoch: extraTopic.ready.epoch, transferId: unknown }))
  await new Promise(resolve => setTimeout(resolve, 200))
  const cancelled = casts[4].socket.frames.filter(frame => frame.type === 'workspace_cancel' && frame.transferId === unknown).length - beforeCancel
  assert.ok(cancelled < 241, 'unknown chunks must consume and obey the separate host control budget')
  await w.join(casts[4].person, topic, 'api')
  casts[4].socket.ws.send(JSON.stringify({ type: 'carry', names: ['api@user-b'] }))
  assert.ok((await casts[4].socket.next('carried')).names.includes('api@user-b'))
  const oversize = JSON.stringify({ type: 'workspace_unknown', v: 1, data: '文'.repeat(Math.ceil(WORKSPACE.frameBytes / 3)) })
  assert.ok(oversize.length < WORKSPACE.frameBytes); assert.ok(Buffer.byteLength(oversize) > WORKSPACE.frameBytes)
  casts[4].socket.ws.send(oversize)
  assert.equal((await extraTopic.next('workspace_error', frame => frame.requestId === released.body.requestId)).code, 'workspace_offline')
})
