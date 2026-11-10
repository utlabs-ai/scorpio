import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

const keys = { p256dh: 'key', auth: 'secret' }
const subscribe = (person, endpoint) => person.post('/push/subscribe', { endpoint, keys })

test('push subscriptions accept only known push-service HTTPS hosts', async () => {
  const w = await worker()
  try {
    const person = await w.person('push-hosts')
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/one',
      'https://updates.push.services.mozilla.com/wpush/v2/two',
      'https://web.push.apple.com/three',
      'https://edge.web.push.apple.com/four',
      'https://db3.notify.windows.com/?token=five',
    ]) {
      assert.equal((await subscribe(person, endpoint)).status, 200, endpoint)
    }
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.test/x',
      'https://fcm.googleapis.com@evil.test/x',
      'https://fcm.googleapis.com:8443/x',
      'https://127.0.0.1/x',
      'https://push.example/x',
    ]) {
      const result = await w.json(await subscribe(person, endpoint))
      assert.equal(result.status, 400, endpoint)
      assert.equal(result.error, 'bad_request', endpoint)
      assert.equal(result.next, 'Only subscriptions from a known push service (FCM, Mozilla, Apple or Windows), with their keys, are accepted.')
    }
  } finally { await w.dispose() }
})

test('a sixth push subscription removes the oldest and its topic preferences', async () => {
  const w = await worker()
  try {
    const person = await w.person('push-cap')
    const room = await w.topic(person)
    const endpoint = (n) => `https://fcm.googleapis.com/fcm/send/${n}`
    for (let n = 0; n < 5; n++) assert.equal((await subscribe(person, endpoint(n))).status, 200)
    assert.equal((await person.post('/push/preferences/write', { endpoint: endpoint(0), roomId: room, muted: true })).status, 200)
    assert.equal((await subscribe(person, endpoint(0))).status, 200) // resubscribe does not renew its age
    assert.equal((await subscribe(person, endpoint(5))).status, 200)
    const { results } = await w.db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint').bind(person.id).all()
    assert.deepEqual(results.map((r) => r.endpoint), [1, 2, 3, 4, 5].map(endpoint))
    const muted = await w.db.prepare('SELECT COUNT(*) AS n FROM push_muted_rooms WHERE endpoint = ?').bind(endpoint(0)).first()
    assert.equal(muted.n, 0)
  } finally { await w.dispose() }
})

test('push test is reserved once per person per rolling minute', async () => {
  const w = await worker()
  try {
    const person = await w.person('push-test')
    const other = await w.person('other-test')
    const first = await w.json(await person.post('/push/test'))
    assert.equal(first.status, 200)
    assert.equal(first.sent, 0) // no VAPID key in this local Worker fixture
    const repeated = await person.post('/push/test')
    const body = await w.json(repeated)
    assert.equal(body.status, 429)
    assert.equal(body.error, 'rate_limited')
    assert.ok(Number(repeated.headers.get('retry-after')) >= 1)
    assert.ok(Number(repeated.headers.get('retry-after')) <= 60)
    assert.equal(body.next, `One test notification per minute. Try again in ${repeated.headers.get('retry-after')} s.`)
    assert.equal((await other.post('/push/test')).status, 200)
    await w.db.prepare('UPDATE push_test_limits SET last_at = ? WHERE user_id = ?').bind(Date.now() - 60_001, person.id).run()
    assert.equal((await person.post('/push/test')).status, 200)
  } finally { await w.dispose() }
})
