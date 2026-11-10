// Real Worker, RoomDO and authenticated routes with an isolated Node workspace host.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { worker, ORIGIN } from './helpers/worker.mjs'
import { createWorkspaceFiles } from '../../cli/src/daemon/workspace-files.mjs'
import { createWorkspaceHost } from '../../cli/src/daemon/workspace-view.mjs'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function socket(response) {
  assert.equal(response.status, 101)
  const ws = response.webSocket, frames = [], waiters = []
  ws.addEventListener('message', event => {
    if (event.data === 'pong') return
    const frame = JSON.parse(event.data); frames.push(frame)
    for (const waiter of [...waiters]) if (waiter.type === frame.type && waiter.predicate(frame)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(frame) }
  })
  ws.accept()
  return { ws, frames, next(type, predicate = () => true) {
    const old = frames.find(f => f.type === type && predicate(f))
    if (old) return Promise.resolve(old)
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, timer: setTimeout(() => reject(new Error(`No ${type}`)), 8000) }; waiters.push(waiter)
    })
  } }
}
test('owner reads actual workspace bytes through HTTP acceptance and directed Worker sockets', { timeout: 60000 }, async t => {
  const w = await worker({}, { name: 'workspace-test', inspect: true, className: 'WorkspaceTestRoom', append: `
export class WorkspaceTestRoom extends RoomDO {
  label = crypto.randomUUID();
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/workspace-test-meta') return Response.json({ label: this.label, attachments: this.ctx.getWebSockets().map(ws => ws.deserializeAttachment()) });
    if (pathname === '/workspace-test-kv') return Response.json({ entries: [...this.ctx.storage.kv.list()] });
    if (pathname === '/workspace-test-lose-timers') {
      let count = 0;
      for (const pending of this._workspace?.pending.values() || []) { clearTimeout(pending.timer); count++; }
      return Response.json({ count });
    }
    return super.fetch(request);
  }
}` }), home = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-worker-'))
  const links = []
  t.after(async () => { for (const link of links) { link.link.isOpen = false; link.host.handle(link.link, { type: 'closed' }) }; await w.dispose(); await fs.rm(home, { recursive: true, force: true }) })
  const kai = await w.person('kai'), mei = await w.person('mei'), topic = await w.topic(kai, 'ABC-DEF-GHJ')
  await mei.post(`/r/${topic}/enter`, { code: 'ABC-DEF-GHJ' })
  const computerId = 'device-box'
  const joined = await w.json(await kai.apiPost(`/rooms/${topic}/join`, { host: true, device_id: computerId, machine: 'box' }))
  assert.equal(joined.status, 200, JSON.stringify(joined))
  const hostSocket = socket(await kai.api(`/rooms/${topic}/ws`, { headers: { upgrade: 'websocket' } }, joined.name.split('@')[0]))
  const root = path.join(home, 'topics', topic, 'workspace'); await fs.mkdir(root, { recursive: true })
  const content = Buffer.from('\ufeffWORKSPACE-STREAM-UNIQUE-正文\r\n🙂\n')
  const beforeContent = Buffer.from('WORKSPACE-DIFF-UNIQUE-BEFORE\n')
  const large = character => {
    const line = Buffer.from(character + '🙂'.repeat(23) + '\n'), buffer = Buffer.alloc(1048576, 97)
    for (let offset = 0; offset + line.length <= buffer.length; offset += line.length) line.copy(buffer, offset)
    return buffer
  }
  const beforeLarge = large('a'), afterLarge = large('b')
  await fs.writeFile(path.join(root, 'file.txt'), beforeContent); await fs.writeFile(path.join(root, 'large.txt'), beforeLarge)
  const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Kai', GIT_AUTHOR_EMAIL: 'kai@example.com', GIT_COMMITTER_NAME: 'Kai', GIT_COMMITTER_EMAIL: 'kai@example.com' }, stdio: 'pipe' })
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'Initial workspace files')
  await fs.writeFile(path.join(root, 'file.txt'), content)
  await fs.writeFile(path.join(root, 'large.txt'), afterLarge)
  const files = createWorkspaceFiles({ home, rootFor: () => root })
  const host = createWorkspaceHost({ account: () => 'kai', computerId: () => computerId, files })
  const link = { host: true, isOpen: true, ws: hostSocket.ws, roomId: topic }; links.push({ host, link })
  hostSocket.ws.addEventListener('message', event => { if (event.data !== 'pong') host.handle(link, JSON.parse(event.data)) })
  for (const frame of hostSocket.frames) host.handle(link, frame)
  await hostSocket.next('workspace_host_ready')
  const viewer = socket(await kai.web(`/r/${topic}/workspace/ws?computer=${computerId}`, { headers: { upgrade: 'websocket', origin: ORIGIN } }))
  const ready = await viewer.next('workspace_ready')
  const ns = await w.mf.getDurableObjectNamespace('ROOMS'), stub = ns.get(ns.idFromName(topic))
  const read = { connectionId: ready.connectionId, connectionToken: ready.connectionToken, epoch: ready.epoch, requestId: randomUUID(), op: 'read', path: 'file.txt' }
  let acknowledge = true
  viewer.ws.addEventListener('message', event => {
    const frame = JSON.parse(event.data)
    if (acknowledge && frame.type === 'workspace_chunk') viewer.ws.send(JSON.stringify({ type: 'workspace_ack', v: 1, epoch: frame.epoch, transferId: frame.transferId, requestId: frame.requestId, ackSeq: frame.seq }))
  })
  const accepted = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, read))
  assert.equal(accepted.status, 200, JSON.stringify(accepted))
  await viewer.next('workspace_end')
  assert.deepEqual(Buffer.concat(viewer.frames.filter(f => f.type === 'workspace_chunk').map(f => Buffer.from(f.data, 'base64'))), content)
  const types = viewer.frames.map(f => f.type)
  assert.ok(types.indexOf('workspace_accepted') < types.indexOf('workspace_begin'))
  assert.equal(viewer.frames.some(f => ['hello', 'room', 'message', 'approvals'].includes(f.type)), false)
  await t.test('list, changes, 1 MiB Unicode read and 2 MiB diff use actual filesystem and Git bytes', async () => {
    const operation = async fields => {
      const requestId = randomUUID(), result = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, path: undefined, requestId, ...fields }))
      assert.equal(result.status, 200, JSON.stringify(result)); await viewer.next('workspace_end', frame => frame.requestId === requestId)
      return viewer.frames.filter(frame => frame.type === 'workspace_chunk' && frame.requestId === requestId)
    }
    const listing = JSON.parse(Buffer.concat((await operation({ op: 'list', path: '' })).map(frame => Buffer.from(frame.data, 'base64'))))
    assert.deepEqual(new Set(listing.entries.map(entry => entry.name)), new Set(['file.txt', 'large.txt']))
    const changed = JSON.parse(Buffer.concat((await operation({ op: 'changes' })).map(frame => Buffer.from(frame.data, 'base64'))))
    assert.equal(changed.repositories.length, 1); assert.equal(changed.repositories[0].changes.length, 2)
    assert.deepEqual(Buffer.concat((await operation({ op: 'read', path: 'large.txt' })).map(frame => Buffer.from(frame.data, 'base64'))), afterLarge)
    const diff = await operation({ op: 'diff', repo: '', path: 'large.txt' })
    assert.deepEqual(Buffer.concat(diff.filter(frame => frame.stream === 'before').map(frame => Buffer.from(frame.data, 'base64'))), beforeLarge)
    assert.deepEqual(Buffer.concat(diff.filter(frame => frame.stream === 'after').map(frame => Buffer.from(frame.data, 'base64'))), afterLarge)
    assert.equal(diff.length, 64)
    const smallDiff = await operation({ op: 'diff', repo: '', path: 'file.txt' })
    assert.deepEqual(Buffer.concat(smallDiff.filter(frame => frame.stream === 'before').map(frame => Buffer.from(frame.data, 'base64'))), beforeContent)
  })
  let externalScope;
  await t.test('directory extension relays real external roots, shortcut labels, two viewers and exact Git sides', async () => {
    assert.equal(ready.computer.directoryNavigation, 1);
    const external = path.join(home, 'external-unique-root'), second = path.join(home, 'other-root');
    await fs.mkdir(external); await fs.mkdir(second);
    await fs.writeFile(path.join(external, 'file.txt'), beforeContent);
    execFileSync('git', ['init', '-q'], { cwd: external });
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Kai', GIT_AUTHOR_EMAIL: 'kai@example.com', GIT_COMMITTER_NAME: 'Kai', GIT_COMMITTER_EMAIL: 'kai@example.com' };
    execFileSync('git', ['add', '.'], { cwd: external, env }); execFileSync('git', ['commit', '-qm', 'Initial external file'], { cwd: external, env });
    await fs.writeFile(path.join(external, 'file.txt'), content); await fs.writeFile(path.join(second, 'file.txt'), 'SECOND-ROOT-UNIQUE');
    const records = path.join(home, 'spawns', topic); await fs.mkdir(records, { recursive: true });
    await fs.writeFile(path.join(records, 'api.json'), JSON.stringify({ dir: external, name: 'wrong@mei' }));
    async function operation(fields, v = viewer, credentials = ready) {
      const requestId = randomUUID();
      const accepted = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { connectionId: credentials.connectionId, connectionToken: credentials.connectionToken, epoch: credentials.epoch, requestId, ...fields }));
      assert.equal(accepted.status, 200, JSON.stringify(accepted));
      await Promise.race([v.next('workspace_end', f => f.requestId === requestId), v.next('workspace_error', f => f.requestId === requestId)]);
      const error = v.frames.find(f => f.requestId === requestId && f.type === 'workspace_error');
      if (error) return { error: error.code };
      const chunks = v.frames.filter(f => f.requestId === requestId && f.type === 'workspace_chunk');
      const bytes = stream => Buffer.concat(chunks.filter(f => f.stream === stream).map(f => Buffer.from(f.data, 'base64')));
      return { meta: v.frames.find(f => f.requestId === requestId && f.type === 'workspace_begin').meta, bytes, json: () => JSON.parse(bytes('json')) };
    }
    const locations = (await operation({ op: 'locations' })).json();
    assert.deepEqual(locations.entries.find(e => e.path === external).agents, ['api@kai']);
    assert.equal(locations.defaultPath, root); assert.equal(locations.homePath, os.homedir());
    const listed = await operation({ op: 'list', path: '', directory: { path: external } });
    assert.equal(listed.error, undefined, JSON.stringify(listed)); externalScope = listed.meta.directory; assert.equal(listed.meta.defaultWorkspace, false); assert.match(externalScope.id, /^\d+:\d+$/);
    assert.equal(listed.json().entries.some(e => e.name === '.git'), false);
    const v2 = socket(await kai.web(`/r/${topic}/workspace/ws?computer=${computerId}`, { headers: { upgrade: 'websocket', origin: ORIGIN } }));
    const r2 = await v2.next('workspace_ready');
    v2.ws.addEventListener('message', event => { const f = JSON.parse(event.data); if (f.type === 'workspace_chunk') v2.ws.send(JSON.stringify({ type: 'workspace_ack', v: 1, epoch: f.epoch, requestId: f.requestId, transferId: f.transferId, ackSeq: f.seq })); });
    const listed2 = await operation({ op: 'list', path: '', directory: { path: second } }, v2, r2);
    const [first, other] = await Promise.all([operation({ op: 'read', path: 'file.txt', directory: externalScope }), operation({ op: 'read', path: 'file.txt', directory: listed2.meta.directory }, v2, r2)]);
    assert.deepEqual(first.bytes('file'), content); assert.equal(other.bytes('file').toString(), 'SECOND-ROOT-UNIQUE');
    const changes = (await operation({ op: 'changes', directory: externalScope })).json(); assert.equal(changes.repositories[0].changes[0].path, 'file.txt');
    const diff = await operation({ op: 'diff', repo: '', path: 'file.txt', directory: externalScope });
    assert.deepEqual(diff.bytes('before'), beforeContent); assert.deepEqual(diff.bytes('after'), content);
    assert.equal((await operation({ op: 'list', path: '', directory: { path: path.join(second, 'missing') } })).error, 'workspace_directory_missing');
    assert.equal((await operation({ op: 'list', path: '', directory: { path: path.join(second, 'file.txt') } })).error, 'workspace_not_directory');
    await fs.rename(second, second + '-old'); await fs.mkdir(second);
    assert.equal((await operation({ op: 'list', path: '', directory: listed2.meta.directory }, v2, r2)).error, 'workspace_directory_changed');
    v2.ws.close();
    // Continue the reconstruction and retention cases with a real external bound scope.
    read.directory = externalScope;
    const page = await (await kai.web(`/r/${topic}/workspace?computer=${computerId}`)).text();
    assert.match(page, /viewerAccount/); assert.match(page, /kai/);
  });
  await t.test('old host capability rejects extension without dropping directory and still accepts legacy reads', async () => {
    hostSocket.ws.send(JSON.stringify({ type: 'workspace_capabilities', v: 1, ops: ['list', 'read', 'changes', 'diff'] }));
    await pause(30);
    for (const fields of [{ op: 'locations', path: undefined }, { op: 'read', path: 'file.txt', directory: externalScope }]) {
      const response = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, directory: undefined, requestId: randomUUID(), ...fields }));
      assert.equal(response.status, 409); assert.equal(response.error, 'workspace_unsupported');
    }
    const requestId = randomUUID(), response = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, directory: undefined, requestId }));
    assert.equal(response.status, 200); await viewer.next('workspace_end', f => f.requestId === requestId);
    hostSocket.ws.send(JSON.stringify({ type: 'workspace_capabilities', v: 1, ops: ['list', 'read', 'changes', 'diff'], directoryNavigation: 1 }));
    await pause(30);
  });
  await t.test('other members, agent tokens, foreign tabs, origins and repeated IDs cannot start reads', async () => {
    const otherHosts = await w.json(await mei.web(`/r/${topic}/workspace/hosts`))
    assert.deepEqual(otherHosts.computers, [])
    const other = await w.json(await mei.web(`/r/${topic}/workspace?computer=${computerId}`))
    assert.equal(other.status, 404); assert.equal(other.error, 'workspace_not_found')
    const token = await w.json(await w.fetch(`/r/${topic}/workspace/hosts`, { headers: { authorization: 'Bearer tok-kai-0123456789abcdef' } }))
    assert.equal(token.status, 401); assert.equal(token.error, 'not_logged_in')
    const wrongToken = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, connectionToken: 'z'.repeat(43), requestId: randomUUID() }))
    assert.equal(wrongToken.status, 404)
    const cross = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, requestId: randomUUID() }, { origin: 'https://other.test' }))
    assert.equal(cross.status, 403)
  })
  await t.test('HTTP metadata accepts more than 8 KiB for validation and rejects more than 16 KiB before dispatch', async () => {
    for (const [length, expected] of [[9000, 400], [17000, 413]]) {
      const response = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, requestId: randomUUID(), padding: 'x'.repeat(length) }));
      assert.equal(response.status, expected); assert.equal(response.error, 'workspace_protocol_error');
    }
  });
  await t.test('viewer document alone receives the scoped CSP and framing policy', async () => {
    const standalone = await kai.web(`/r/${topic}/workspace?computer=${computerId}`), embedded = await kai.web(`/r/${topic}/workspace?computer=${computerId}&embed=1`), parent = await kai.web(`/r/${topic}`)
    assert.equal(standalone.status, 200); assert.equal(embedded.status, 200)
    assert.equal(standalone.headers.get('x-frame-options'), 'DENY'); assert.equal(embedded.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.match(embedded.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/)
    assert.match(embedded.headers.get('content-security-policy'), /img-src 'self' data:;/)
    assert.match(parent.headers.get('content-security-policy'), /style-src 'self';/)
    assert.doesNotMatch(parent.headers.get('content-security-policy'), /unsafe-inline/)
  })
  await t.test('same physical viewer reads once after 1.2 s and after 12 s with forced hibernation', async () => {
    let label = (await (await stub.fetch('https://room/workspace-test-meta')).json()).label
    const initialFrames = viewer.frames.filter(f => ['workspace_ready', 'workspace_reset'].includes(f.type)).length
    for (const delay of [1200, 12000]) {
      await pause(delay)
      if (delay === 12000) {
        // An idle local object may already have hibernated; wake it before the forced-loss probe.
        label = (await (await stub.fetch('https://room/workspace-test-meta')).json()).label
        await w.mf.unsafeEvictDurableObject('workspace-test', 'WorkspaceTestRoom', { name: topic, webSockets: 'hibernate' })
      }
      const requestId = randomUUID(), result = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, requestId }))
      assert.equal(result.status, 200, JSON.stringify(result))
      const until = Date.now() + 8000
      while (!viewer.frames.some(f => f.type === 'workspace_end' && f.requestId === requestId) && Date.now() < until) await pause(10)
      assert.equal(viewer.frames.some(f => f.type === 'workspace_end' && f.requestId === requestId), true)
      assert.equal(viewer.frames.filter(f => ['workspace_ready', 'workspace_reset'].includes(f.type)).length, initialFrames)
      const next = (await (await stub.fetch('https://room/workspace-test-meta')).json()).label
      if (delay === 12000) assert.notEqual(next, label, 'the local runtime reconstructed the object after forced hibernation')
      label = next
    }
    const attachments = (await (await stub.fetch('https://room/workspace-test-meta')).json()).attachments
    assert.equal(JSON.stringify(attachments).includes(ready.connectionToken), false)
    assert.equal(JSON.stringify(attachments).includes('file.txt'), false)
    assert.equal(JSON.stringify(attachments).includes('external-unique-root'), false)
    assert.equal(attachments.find(a => a.kind === 'host' && a.workspaceProtocol === 1)?.directoryNavigation, 1)
    assert.equal(JSON.stringify(attachments).includes('WORKSPACE-STREAM-UNIQUE'), false)
    const own = attachments.find(a => a.kind === 'workspace' && a.connectionId === ready.connectionId)
    assert.match(own.connectionTokenVerifier, /^[a-f0-9]{64}$/)
    assert.deepEqual(own.inFlight, [])
  })
  await t.test('unfinished transfer fails after forced reconstruction while one new explicit read succeeds', async () => {
    acknowledge = false
    const requestId = randomUUID(), accepted = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, requestId }))
    assert.equal(accepted.status, 200)
    await viewer.next('workspace_chunk', frame => frame.requestId === requestId)
    const before = viewer.frames.filter(frame => frame.type === 'workspace_chunk' && frame.requestId === requestId).length
    const meta = await (await stub.fetch('https://room/workspace-test-meta')).json(), own = meta.attachments.find(a => a.kind === 'workspace' && a.connectionId === ready.connectionId)
    assert.deepEqual(Object.keys(own.inFlight[0]).sort(), ['deadlineAt', 'requestId', 'transferId'])
    // Runtime safe-eviction waits for active timers. Lose only those references to inject abrupt process loss,
    // then force a real object reconstruction while the original sockets and inFlight markers survive.
    assert.equal((await (await stub.fetch('https://room/workspace-test-lose-timers')).json()).count, 1)
    const connectionsBefore = viewer.frames.filter(frame => ['workspace_ready', 'workspace_reset'].includes(frame.type)).length
    await w.mf.unsafeEvictDurableObject('workspace-test', 'WorkspaceTestRoom', { name: topic, webSockets: 'hibernate' })
    acknowledge = true
    const nextId = randomUUID(), next = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, requestId: nextId }))
    assert.equal(next.status, 200, JSON.stringify(next))
    const reset = await viewer.next('workspace_error', frame => frame.requestId === requestId)
    assert.equal(reset.code, 'workspace_reset')
    await viewer.next('workspace_end', frame => frame.requestId === nextId)
    const rebuilt = await (await stub.fetch('https://room/workspace-test-meta')).json(), rebound = rebuilt.attachments.find(a => a.kind === 'workspace' && a.connectionId === ready.connectionId)
    assert.notEqual(rebuilt.label, meta.label)
    assert.equal(rebound.epoch, ready.epoch); assert.equal(rebound.connectionId, ready.connectionId)
    assert.equal(viewer.frames.filter(frame => ['workspace_ready', 'workspace_reset'].includes(frame.type)).length, connectionsBefore)
    assert.equal(viewer.frames.filter(frame => frame.type === 'workspace_error' && frame.requestId === requestId && frame.code === 'workspace_reset').length, 1)
    assert.equal(viewer.frames.filter(frame => frame.type === 'workspace_accepted' && frame.requestId === nextId).length, 1)
    assert.equal(viewer.frames.filter(frame => frame.type === 'workspace_chunk' && frame.requestId === requestId).length, before)
    assert.equal(viewer.frames.some(frame => frame.type === 'workspace_end' && frame.requestId === requestId), false)
  })
  await t.test('original production timers expire an unacknowledged transfer without a reset', async () => {
    acknowledge = false
    const requestId = randomUUID(), accepted = await w.json(await kai.post(`/r/${topic}/workspace/request?computer=${computerId}`, { ...read, requestId }))
    assert.equal(accepted.status, 200)
    const error = await viewer.next('workspace_error', frame => frame.requestId === requestId)
    assert.equal(error.code, 'workspace_expired')
    acknowledge = true
  })
  await t.test('workspace bytes and paths never enter DO SQL, D1, KV, R2 or topic messages', async () => {
    const ns = await w.mf.getDurableObjectNamespace('ROOMS'), stub = ns.get(ns.idFromName(topic))
    const storage = await w.mf.unsafeGetDurableObjectStorage('workspace-test', 'WorkspaceTestRoom', { name: topic })
    const doTables = await storage.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    const stored = []
    for (const table of doTables) stored.push({ name: table.name, rows: await storage.exec('SELECT * FROM "' + table.name.replaceAll('"', '""') + '"') })
    assert.equal(JSON.stringify(stored).includes('WORKSPACE-STREAM-UNIQUE'), false)
    assert.equal(JSON.stringify(stored).includes('file.txt'), false)
    assert.equal(JSON.stringify(stored).includes('external-unique-root'), false)
    const doKV = await (await stub.fetch('https://room/workspace-test-kv')).text()
    assert.equal(doKV.includes('WORKSPACE-STREAM-UNIQUE'), false); assert.equal(doKV.includes('file.txt'), false)
    const tables = (await w.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results
    for (const table of tables) {
      const data = await w.db.prepare('SELECT * FROM "' + table.name.replaceAll('"', '""') + '"').all()
      assert.equal(JSON.stringify(data).includes('WORKSPACE-STREAM-UNIQUE'), false)
      assert.equal(JSON.stringify(data).includes('file.txt'), false)
      assert.equal(JSON.stringify(data).includes('external-unique-root'), false)
    }
    const keys = await w.kv.list()
    for (const key of keys.keys) {
      const value = await w.kv.get(key.name)
      assert.equal(value.includes('WORKSPACE-STREAM-UNIQUE'), false); assert.equal(value.includes('file.txt'), false); assert.equal(value.includes('external-unique-root'), false)
    }
    const r2 = await w.mf.getR2Bucket('FILES'); assert.equal((await r2.list()).objects.length, 0)
    const messages = await w.json(await kai.api(`/rooms/${topic}/messages`, {}, joined.name.split('@')[0]))
    assert.equal(JSON.stringify(messages).includes('WORKSPACE-STREAM-UNIQUE'), false)
  })
  await t.test('computer removal revokes the existing viewer before any later content', async () => {
    const removed = await w.json(await kai.post(`/r/${topic}/removeComputer`, { name: joined.name }))
    assert.equal(removed.status, 200, JSON.stringify(removed))
    await viewer.next('workspace_revoked')
    const chunks = viewer.frames.filter(f => f.type === 'workspace_chunk').length
    await pause(50); assert.equal(viewer.frames.filter(f => f.type === 'workspace_chunk').length, chunks)
  })
})
