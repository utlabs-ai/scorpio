import assert from 'node:assert/strict'
import test from 'node:test'
import { chartY, integerTicks } from '../src/chart-scale.ts'

test('daily chart ticks are exact integer values with at most five levels', () => {
  assert.deepEqual(integerTicks(3), [0, 1, 2, 3])
  assert.deepEqual(integerTicks(4), [0, 1, 2, 3, 4])
  assert.deepEqual(integerTicks(13), [0, 4, 8, 12, 13])
  for (const max of [1, 3, 4, 13, 100]) {
    const ticks = integerTicks(max)
    assert.ok(ticks.length <= 5)
    assert.equal(ticks[0], 0)
    assert.equal(ticks.at(-1), max)
    for (const value of ticks) assert.equal(chartY(value, max, 232, 210), 232 - value / max * 210)
  }
  assert.equal(chartY(1, 3, 232, 210), 162)
  assert.equal(chartY(3, 3, 232, 210), 22)
})
