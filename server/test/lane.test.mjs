import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

// lane.ts imports util.ts (ApiError), so it is bundled as strings.test does.
const built = await build({ entryPoints: [new URL('../src/lane.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { laneOf } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

test('laneOf: one trimmed word of up to 32 characters; empty clears; spaces, | and control characters are refused', () => {
  assert.equal(laneOf('billing'), 'billing')
  assert.equal(laneOf('  日历  '), '日历')
  assert.equal(laneOf(''), null)
  assert.equal(laneOf('   '), null)
  assert.equal(laneOf(undefined), null)
  assert.equal(laneOf(null), null)
  assert.equal(laneOf(42), '42')
  assert.equal(laneOf('🦂'.repeat(32)), '🦂'.repeat(32), '32 code points, not UTF-16 units')
  for (const bad of ['a'.repeat(33), '🦂'.repeat(33), 'two words', 'a|b', 'tab\tin', 'line\nbreak', 'ctl\u0007']) {
    assert.throws(() => laneOf(bad), (e) => e.code === 'bad_request' && e.status === 400 && /one word of up to 32 characters/.test(e.next), bad)
  }
})
