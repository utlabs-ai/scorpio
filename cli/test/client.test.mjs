import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs, intArg, boolArg, topicIdOf, roomPath } from '../src/client.mjs'

test('parseArgs keeps values after the first equals sign and rejects bare arguments', () => {
  assert.deepEqual(parseArgs(['text=a=b', 'role=api']), { text: 'a=b', role: 'api' })
  assert.throws(() => parseArgs(['role']), { error: 'bad_request', next: /Arguments are key=value/ })
})

test('intArg enforces required, whole-number and minimum boundaries', () => {
  assert.equal(intArg({}, 'limit'), undefined)
  assert.throws(() => intArg({}, 'limit', { required: true, hint: 'Set a limit.' }), { error: 'bad_request', next: 'Missing limit=. Set a limit.' })
  assert.equal(intArg({ limit: '0' }, 'limit', { min: 0 }), 0)
  assert.equal(intArg({ limit: '3' }, 'limit'), 3)
  assert.throws(() => intArg({ limit: '0' }, 'limit'), { error: 'bad_request', next: /whole number ≥ 1/ })
  assert.throws(() => intArg({ limit: '1.5' }, 'limit'), { error: 'bad_request', next: /whole number ≥ 1/ })
})

test('boolArg recognizes the existing true spellings', () => {
  for (const value of ['true', 'TRUE', '1', 'yes']) assert.equal(boolArg(value), true)
  for (const value of [undefined, '', 'false', '0', 'no']) assert.equal(boolArg(value), false)
})

test('topicIdOf requires the normalized roomId and roomPath escapes it', () => {
  assert.equal(topicIdOf({ roomId: 'a/b c' }), 'a/b c')
  assert.throws(() => topicIdOf({}), { error: 'bad_request', next: 'Missing topicId=. Use the topic id from your invitation.' })
  assert.equal(roomPath('a/b c'), '/rooms/a%2Fb%20c')
  assert.equal(roomPath('a/b c', '/messages'), '/rooms/a%2Fb%20c/messages')
})
