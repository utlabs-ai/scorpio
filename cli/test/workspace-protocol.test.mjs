import test from 'node:test'
import assert from 'node:assert/strict'
import * as p from '../src/workspace-protocol.mjs'
const id = '00000000-0000-4000-8000-000000000000'
const start = { connectionId: id, connectionToken: 'a'.repeat(43), epoch: id, requestId: id, op: 'read', path: 'src/日本語.txt' }
const fails = (fn, code = 'workspace_protocol_error') => assert.throws(fn, (e) => e.code === code)
test('request whitelist accepts only canonical relative paths and bounded metadata', () => {
  assert.deepEqual(p.workspaceRequest(start), start)
  for (const path of ['/etc/passwd', '../a', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'C:a', '.git/config', 'a/.git', 'a\0b']) fails(() => p.workspaceRequest({ ...start, path }), 'workspace_path_denied')
  for (const extra of [{ owner: 'zoe' }, { topicId: id }, { cwd: '/tmp' }, { root: '' }, { cursor: 'x' }, { repo: '' }]) fails(() => p.workspaceRequest({ ...start, ...extra }))
  fails(() => p.workspaceRequest({ ...start, connectionToken: '' }))
  fails(() => p.workspaceRequest({ ...start, path: '文'.repeat(1366) }), 'workspace_path_denied')
  assert.equal(p.wireBytes('文'), 3)
})
const stream = (name, bytes, exists = true) => ({ name, bytes, exists, encoding: 'utf-8' })
const chunk = (seq, data, offset = seq * 32768, stream = 'file') => ({ seq, stream, offset, data: Buffer.from(data).toString('base64') })
test('full 1 MiB uses four-chunk windows and a final ACK before end', () => {
  const s = p.beginWorkspace('read', [stream('file', 1048576)])
  for (let i = 0; i < 32; i++) { assert.equal(p.chunkWorkspace(s, chunk(i, Buffer.alloc(32768, 250))), 32768); if (i % 4 === 3) p.ackWorkspace(s, i) }
  p.endWorkspace(s, [{ name: 'file', bytes: 1048576, chunks: 32 }])
})
test('duplicate, out of order, offset, totals, wrong stream and premature end fail', () => {
  const make = () => p.beginWorkspace('read', [stream('file', 6)])
  for (const frame of [chunk(1, 'abc', 0), chunk(0, 'abc', 1), chunk(0, 'abc', 0, 'json'), chunk(0, 'abcdefg', 0)]) fails(() => p.chunkWorkspace(make(), frame))
  const s = make(); p.chunkWorkspace(s, chunk(0, 'abcdef', 0))
  fails(() => p.chunkWorkspace(s, chunk(0, 'abcdef', 0)))
  fails(() => p.endWorkspace(s, [{ name: 'file', bytes: 6, chunks: 1 }]))
  p.ackWorkspace(s, 0); p.endWorkspace(s, [{ name: 'file', bytes: 6, chunks: 1 }])
  fails(() => p.ackWorkspace(s, 1))
})
test('base64, window and per-stream budgets are exact', () => {
  for (const x of ['', 'YWJj=', 'Zg=', 'Zh==', '%%%%', Buffer.alloc(32769).toString('base64')]) fails(() => p.base64Bytes(x))
  const s = p.beginWorkspace('read', [stream('file', 6)])
  for (let i = 0; i < 4; i++) p.chunkWorkspace(s, chunk(i, 'a', i))
  fails(() => p.chunkWorkspace(s, chunk(4, 'a', 4)))
  assert.equal(p.ackWorkspace(s, 3), true); assert.equal(p.ackWorkspace(s, 3), false)
  fails(() => p.beginWorkspace('read', [stream('file', 1048577)]), 'workspace_too_large')
  fails(() => p.beginWorkspace('list', [stream('json', 262145)]), 'workspace_too_large')
})
test('absent diff sides differ from existing empty files', () => {
  const s = p.beginWorkspace('diff', [stream('before', 0, false), stream('after', 0, true)])
  assert.equal(s.streams[0].exists, false); assert.equal(s.streams[1].exists, true)
  p.endWorkspace(s, [{ name: 'before', bytes: 0, chunks: 0 }, { name: 'after', bytes: 0, chunks: 0 }])
  fails(() => p.beginWorkspace('diff', [stream('before', 1, false), stream('after', 0)]))
})
test('viewer, account-topic and topic concurrency limits are independent', () => {
  assert.equal(p.workspaceCapacity([{ account: 'kai', viewer: 'a' }, { account: 'kai', viewer: 'a' }], 'kai', 'a'), false)
  const pending = Array.from({ length: 8 }, (_, i) => ({ account: 'kai', viewer: String(i) }))
  assert.equal(p.workspaceCapacity(pending, 'kai', 'next'), false)
  assert.equal(p.workspaceCapacity(pending, 'mei', 'next'), true)
  assert.equal(p.workspaceCapacity(Array.from({ length: 32 }, (_, i) => ({ account: String(i), viewer: String(i) })), 'mei', 'next'), false)
  assert.deepEqual(p.safeWorkspaceDetails({ bytes: 123, path: '/private', data: 'secret', limit: -1 }), { bytes: 123 })
})
test('operation JSON schemas reject malformed or mismatched results before UI rendering', () => {
  const list = { path: '', entries: [{ name: 'file', kind: 'file', bytes: 0 }], nextCursor: null, truncated: false, order: 'filesystem' }
  assert.equal(p.workspaceJsonResult('list', list).entries.length, 1)
  for (const value of [{ ...list, path: 'other' }, { ...list, entries: [{ name: '.git', kind: 'directory' }] }, { ...list, entries: [list.entries[0], list.entries[0]] }, { ...list, nextCursor: 'x'.repeat(513) }, { ...list, entries: [{ name: 'file', kind: 'file', bytes: -1 }] }]) fails(() => p.workspaceJsonResult('list', value))
  const changes = { repositories: [{ repo: '', headOid: null, changes: [{ path: 'new', status: '??', kind: 'added', beforeExists: false, afterExists: true }] }], discoveryTruncated: false, changesTruncated: false, unavailable: [] }
  assert.equal(p.workspaceJsonResult('changes', changes).repositories.length, 1)
  fails(() => p.workspaceJsonResult('changes', { ...changes, repositories: [{ ...changes.repositories[0], headOid: '/outside' }] }))
  fails(() => p.workspaceJsonResult('changes', { ...changes, unavailable: [{ repo: '../outside', reason: 'workspace_git_unavailable' }] }))
})
test('list result order preserves both published modes and rejects unknown modes', () => {
  const list = { path: '', entries: [], nextCursor: null, truncated: false }
  for (const order of ['filesystem', 'directories-first-name']) assert.equal(p.workspaceJsonResult('list', { ...list, order }).order, order)
  fails(() => p.workspaceJsonResult('list', { ...list, order: 'unknown' }))
})
