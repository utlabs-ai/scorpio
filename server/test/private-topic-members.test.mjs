import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

// Real Worker routes, DO membership and D1 indexes, isolated in local Miniflare.
test('private-topic lists and join retries follow current membership', async (t) => {
  const w = await worker()
  const { json } = w
  try {
    const owner = await w.person('owner')
    const viewer = await w.person('viewer')
    const agent = await w.person('agent')
    const removed = await w.person('removed')
    const code = 'ABC-DEF-GHJ'
    const room = await w.topic(owner, code)
    const post = async (person, path, body) => {
      const out = await json(await person.post(`/r/${room}/${path}`, body))
      assert.equal(out.status, 200, JSON.stringify(out))
      return out
    }
    const absent = async (person) => {
      const list = await json(await person.web('/app/topics.json'))
      assert.equal(list.status, 200)
      assert.equal(list.topics.some((x) => x.id === room), false, 'private topic must be absent')
      const home = await json(await person.web('/home'))
      assert.equal(home.rooms.some((x) => x.roomId === room), false)
      const page = await person.web('/app')
      assert.equal((await page.text()).includes('Route test topic'), false)
      const pin = await json(await person.post('/app/pin', { topicId: room, pinned: true }))
      assert.equal(pin.error, 'room_not_found')
    }
    await t.test('a public viewer loses the list row and pin access when the topic becomes private', async () => {
      await post(owner, 'visibility', { public: true })
      assert.equal((await viewer.web(`/r/${room}`)).status, 200)
      const visible = await json(await viewer.web('/app/topics.json'))
      assert.equal(visible.topics.some((x) => x.id === room), true)
      await post(owner, 'visibility', { public: false })
      await absent(viewer)
    })
    await t.test('the last agent leaving removes its private topic from all web lists', async () => {
      const joined = await json(await agent.apiPost(`/rooms/${room}/join`, { role: 'helper', code }))
      assert.equal(joined.status, 200)
      const before = await json(await agent.web('/app/topics.json'))
      assert.equal(before.topics.some((x) => x.id === room), true, 'an agent-only account is a current member')
      assert.equal((await agent.apiPost(`/rooms/${room}/leave`, {}, 'helper')).status, 200)
      await absent(agent)
    })
    await t.test('a removed agent cannot replay a join nonce or reactivate the D1 index', async () => {
      const join = { role: 'helper', nonce: 'membership-retry', code }
      const first = await json(await removed.apiPost(`/rooms/${room}/join`, join))
      assert.equal(first.status, 200)
      assert.deepEqual(await json(await removed.apiPost(`/rooms/${room}/join`, join)), first, 'active seat retries remain idempotent')
      await post(owner, 'remove', { account: removed.handle })
      const replay = await json(await removed.apiPost(`/rooms/${room}/join`, { ...join, code: undefined }))
      assert.equal(replay.error, 'code_required')
      assert.equal(replay.roomName, undefined)
      assert.equal(await w.db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').bind(room, removed.id).first(), null)
      await absent(removed)
      const rejoined = await json(await removed.apiPost(`/rooms/${room}/join`, join))
      assert.equal(rejoined.status, 200, 'the correct unchanged passcode permits a real new join')
      assert.equal((await json(await removed.api(`/rooms/${room}/messages`, {}, 'helper'))).status, 200, 'successful join corresponds to an active seat')
    })
    await t.test('DO refusal drops the entire row even when D1 still says public and active', async () => {
      await w.db.prepare("UPDATE rooms SET visibility = 'link', topic = 'CURRENT-PRIVATE-DESCRIPTION' WHERE id = ?").bind(room).run()
      await w.db.prepare('UPDATE room_members SET active = 1 WHERE room_id = ? AND user_id = ?').bind(room, viewer.id).run()
      const list = await json(await viewer.web('/app/topics.json'))
      assert.equal(list.topics.some((x) => x.id === room), false)
      assert.equal(JSON.stringify(list).includes('CURRENT-PRIVATE-DESCRIPTION'), false)
      const home = await json(await viewer.web('/home'))
      assert.equal(home.rooms.some((x) => x.roomId === room), false)
    })
  } finally {
    await w.dispose()
  }
})
