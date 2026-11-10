import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

test('join and leave lines use the topic minute budget without blocking membership changes', async () => {
  const w = await worker()
  try {
    const person = await w.person('system-rate')
    const room = await w.topic(person)
    for (let n = 0; n < 35; n++) {
      const result = await w.join(person, room, `worker-${n}`)
      assert.equal(result.status, 200, JSON.stringify(result))
    }
    const history = await w.json(await person.api(`/rooms/${room}/messages`, {}, 'worker-0'))
    assert.equal(history.status, 200)
    assert.equal(history.messages.filter((message) => message.fromKind === 'system').length, 30)
    const send = await w.json(await person.post(`/r/${room}/send`, { text: 'after joins' }))
    assert.equal(send.status, 429)
    assert.equal(send.error, 'rate_limited')
    const leftResponse = await person.apiPost(`/rooms/${room}/leave`, {}, 'worker-0')
    assert.equal(leftResponse.status, 200)
    const left = await leftResponse.json()
    assert.equal(left.status, 'left')
    const after = await w.json(await person.api(`/rooms/${room}/messages`, {}, 'worker-1'))
    assert.equal(after.messages.filter((message) => message.fromKind === 'system').length, 30)
  } finally { await w.dispose() }
})
