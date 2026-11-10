import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

test('schedule routes persist calendar anchors, preserve edits and reject invalid rules', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    await w.join(p, room, 'worker')
    const endpoint = `/rooms/${room}/schedules`
    const send = async (body) => w.json(await p.apiPost(endpoint, body, 'worker'))
    const base = { kind: 'daily', time: '09:00', tz: 'UTC' }
    const made = await send({ op: 'add', text: '@worker@ops Calendar reminder', rule: { ...base, step: 3, from: '2030-10-21' } })
    assert.equal(made.status, 200, JSON.stringify(made))
    assert.deepEqual(made.item.rule, { ...base, step: 3, from: '2030-10-21' })
    assert.equal(made.item.nextAt, Date.parse('2030-10-21T09:00Z'))
    const id = made.item.id
    const edited = await send({ op: 'edit', id, rule: { ...base, time: '10:00' } })
    assert.deepEqual(edited.item.rule, { ...base, time: '10:00', step: 3, from: '2030-10-21' })
    assert.equal(edited.item.nextAt, Date.parse('2030-10-21T10:00Z'))
    await send({ op: 'off', id })
    const resumed = await send({ op: 'on', id })
    assert.equal(resumed.item.nextAt, edited.item.nextAt)
    const reset = await send({ op: 'edit', id, rule: { ...base, step: 1 } })
    assert.deepEqual(reset.item.rule, base)
    const read = await w.json(await p.api(`${endpoint}/${id}`, {}, 'worker'))
    assert.deepEqual(read.item.rule, base)
    const legacy = await send({ op: 'add', text: '@worker@ops Daily reminder', rule: base })
    assert.deepEqual(legacy.item.rule, base)
    const switched = await send({ op: 'edit', id, rule: { kind: 'weekly', days: ['mon'], time: '10:00', tz: 'UTC', step: 2, from: '2030-10-21' } })
    assert.equal(switched.item.rule.step, 2)
    const weeklyEdit = await send({ op: 'edit', id, rule: { kind: 'weekly', days: ['thu'], time: '11:00', tz: 'UTC' } })
    assert.equal(weeklyEdit.item.rule.step, 2)
    assert.equal(weeklyEdit.item.rule.from, '2030-10-21')
    const defaulted = await send({ op: 'add', text: '@worker@ops Anchored reminder', rule: { ...base, step: 3 } })
    const firstDate = new Date(defaulted.item.nextAt).toISOString().slice(0, 10)
    assert.equal(defaulted.item.rule.from, firstDate)
    for (const rule of [
      { ...base, step: 366 }, { ...base, step: 1.5 }, { ...base, step: 2, from: '2026-02-30' },
      { ...base, from: '2026-10-21' }, { kind: 'every', minutes: 30, step: 2 },
      { kind: 'once', at: Date.now() + 60_000, from: '2026-10-21' },
      { kind: 'weekly', days: ['mon'], time: '10:00', tz: 'UTC', step: 53 },
    ]) {
      const rejected = await send({ op: 'add', text: '@worker@ops Invalid reminder', rule })
      assert.equal(rejected.status, 400, JSON.stringify(rejected))
      assert.equal(rejected.error, 'bad_request')
    }
    const listed = await w.json(await p.api(endpoint, {}, 'worker'))
    assert.equal(listed.items.length, 3)
    assert.deepEqual(listed.items.find((item) => item.id === legacy.item.id).rule, base)
  } finally { await w.dispose() }
})
