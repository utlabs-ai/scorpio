import test from 'node:test'
import assert from 'node:assert/strict'
import { debugFrame } from '../src/daemon/frame-log.mjs'
test('debug logging excludes all workspace frames before serialization', () => {
  const lines = [], write = (...args) => lines.push(args)
  for (const type of ['workspace_begin', 'workspace_chunk', 'workspace_end', 'workspace_error', 'workspace_unknown']) {
    debugFrame('box', { type, get data() { throw new Error('A protected frame was serialized') } }, write)
  }
  assert.deepEqual(lines, [])
  debugFrame('box', { type: 'work', name: 'api@kai', work: 'idle' }, write)
  assert.equal(lines.length, 1)
})
