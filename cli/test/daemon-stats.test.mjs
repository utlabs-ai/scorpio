import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDeliveryStats } from '../src/daemon/stats.mjs'

test('delivery counts use message counts and survive restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-stats-'))
  const file = path.join(dir, 'stats.json')
  const date = new Date('2026-10-17T14:00:00Z')
  const stats = createDeliveryStats({ file, now: () => date })
  stats.add('topic', 'a', 3)
  stats.add('topic', 'b', 1)
  stats.save()
  assert.deepEqual(createDeliveryStats({ file, now: () => date }).snapshot(), { v: 1, day: '2026-10-17', total: 4, totalSince: date.getTime(), today: { total: 4, rooms: { topic: { total: 4, agents: { a: 3, b: 1 } } } } })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('delivery counters reset at local midnight, retaining the total', () => {
  let date = new Date(2026, 9, 17, 23, 59)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-stats-'))
  const stats = createDeliveryStats({ file: path.join(dir, 'stats.json'), now: () => date })
  stats.add('topic', 'a', 2)
  date = new Date(2026, 9, 18, 0, 0)
  assert.deepEqual(stats.snapshot(), { v: 1, day: '2026-10-18', total: 2, totalSince: new Date(2026, 9, 17, 23, 59).getTime(), today: { total: 0, rooms: {} } })
  fs.rmSync(dir, { recursive: true, force: true })
})
