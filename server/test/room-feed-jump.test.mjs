// Jumps to a message not on the page: one /around request however far back it is, the feed changed only once
// it has come, "↩ Back" through pages, and a wrong number or a failed request leaving the feed as it was.
import assert from 'node:assert/strict'
import test from 'node:test'
import { S, msg, page, range } from './helpers/feed-page.mjs'

const settle = () => new Promise((r) => setImmediate(r))
const seqs = (list) => list.map((m) => m.seq)
/** The server's /around: the target and 50 on either side, out of messages 1..last. */
const around = (last) => (seq) => (seq >= 1 && seq <= last
  ? { body: { messages: range(Math.max(1, seq - 50), Math.min(last, seq + 50)) } }
  : { status: 404, body: { error: 'message_not_found', next: `There is no message #${seq} in this topic.` } })
const hidden = (p, id) => p.$(id).classList.contains('hidden')
/** The row is in the middle part of the 500 px feed, where the jump scrolled it. */
const shown = (p, seq) => { const r = p.row(seq).getBoundingClientRect(); return r.top >= 0 && r.bottom <= 500 }

function latest(opts = {}) {
  const p = page({ around: around(10000), ...opts })
  p.hello(range(9951, 10000), { cursor: 10000, mentionUnread: 0 })
  return p
}

test('a jump far back fetches its page once, and changes the feed only when it has come', async () => {
  const p = latest()
  p.feed.scrollTop = 1000
  p.roomFeed.jumpTo(5121, p.row(9965))
  assert.deepEqual(p.fetched, [5121])
  assert.equal(p.rows()[0], 9951, 'the feed stays until the answer comes')
  assert.equal(p.toasts.at(-1), S.jumpLoading.replace('{n}', 5121))
  assert.ok(!hidden(p, 'toast'), 'the notice stays up while the request runs')
  await settle()
  assert.deepEqual(p.rows(), seqs(range(5071, 5171)))
  assert.ok(shown(p, 5121))
  assert.ok(hidden(p, 'toast'))
  assert.ok(!hidden(p, 'back'))
  assert.deepEqual(p.flashes, [])

  p.roomFeed.goBack()
  assert.deepEqual(p.fetched, [5121], 'the latest feed was kept: no request')
  assert.deepEqual(p.rows(), seqs(range(9951, 10000)))
  assert.equal(p.row(9965).getBoundingClientRect().top, 400, 'back where the jump started')
  assert.ok(hidden(p, 'back'))
})

test('a number the topic does not have says so and leaves the feed as it was', async () => {
  const p = latest()
  p.roomFeed.jumpTo(10001)
  assert.deepEqual(p.fetched, [], 'newer than the latest: known without asking')
  assert.deepEqual(p.flashes, [S.jumpNone.replace('{n}', 10001)])

  const q = page({ around: () => ({ status: 404, body: { error: 'message_not_found' } }) })
  q.hello(range(9951, 10000), { cursor: 10000, mentionUnread: 0 })
  q.roomFeed.jumpTo(42)
  await settle()
  assert.deepEqual(q.flashes, [S.jumpNone.replace('{n}', 42)])
  assert.deepEqual(q.rows(), seqs(range(9951, 10000)))
  assert.ok(hidden(q, 'toast'))
  assert.ok(hidden(q, 'back'))
})

test('a failed request says the jump failed and leaves the feed as it was', async () => {
  const p = latest({ around: () => { throw new Error('offline') } })
  p.roomFeed.jumpTo(42)
  await settle()
  assert.deepEqual(p.flashes, [S.jumpFailed.replace('{n}', 42)])
  assert.deepEqual(p.rows(), seqs(range(9951, 10000)))
  assert.ok(hidden(p, 'toast'))
})

test('on an older page, a newer number in the latest feed goes there; Back brings the older page again', async () => {
  const p = latest()
  p.roomFeed.jumpSearch(5121)
  await settle()
  p.roomFeed.append(msg(10001)) // arrives while the older page shows: it waits with the latest feed
  assert.deepEqual(p.rows(), seqs(range(5071, 5171)))
  p.roomFeed.jumpTo(9990, p.row(5121))
  assert.deepEqual(p.fetched, [5121])
  assert.deepEqual(p.rows(), seqs(range(9951, 10001)))
  assert.deepEqual(p.flashes, [])

  p.roomFeed.goBack()
  await settle()
  assert.deepEqual(p.fetched, [5121, 5121])
  assert.deepEqual(p.rows(), seqs(range(5071, 5171)))
  p.roomFeed.goBack()
  assert.deepEqual(p.rows(), seqs(range(9951, 10001)), 'and from there to where the search started')
})

test('a number between an older page and the latest feed is fetched, not reported missing', async () => {
  const p = latest()
  p.roomFeed.jumpTo(5121)
  await settle()
  p.roomFeed.jumpTo(8000, p.row(5121))
  await settle()
  assert.deepEqual(p.fetched, [5121, 8000])
  assert.deepEqual(p.rows(), seqs(range(7950, 8050)))
  p.roomFeed.jumpDown()
  assert.deepEqual(p.rows(), seqs(range(9951, 10000)))
  assert.ok(hidden(p, 'back'), '↓ Latest drops the trail')
})

test('only the latest jump lands when an earlier answer comes after it', async () => {
  let release
  const slow = new Promise((r) => { release = r })
  const p = latest({ around: (seq) => (seq === 100 ? slow.then(() => around(10000)(100)) : around(10000)(seq)) })
  p.roomFeed.jumpTo(100)
  p.roomFeed.jumpTo(5121)
  await settle()
  release()
  await settle()
  assert.deepEqual(p.rows(), seqs(range(5071, 5171)))
})

test('a jump to a message on the page while another waits: the notice goes, the late answer is dropped', async () => {
  let release
  const slow = new Promise((r) => { release = r })
  const p = latest({ around: (seq) => slow.then(() => around(10000)(seq)) })
  p.roomFeed.jumpTo(5121)
  assert.ok(!hidden(p, 'toast'))
  p.roomFeed.jumpTo(9960)
  assert.ok(hidden(p, 'toast'))
  release()
  await settle()
  assert.deepEqual(p.rows(), seqs(range(9951, 10000)))
  assert.ok(hidden(p, 'toast'))
  assert.ok(shown(p, 9960))
})

test('"↓ Latest" while a jump waits: the late answer does not pull the reader back', async () => {
  let release
  const slow = new Promise((r) => { release = r })
  const p = latest({ around: (seq) => (seq === 5121 ? around(10000)(seq) : slow.then(() => around(10000)(seq))) })
  p.roomFeed.jumpTo(5121)
  await settle()
  p.roomFeed.jumpTo(3000, p.row(5121))
  p.roomFeed.jumpDown()
  assert.ok(hidden(p, 'toast'))
  release()
  await settle()
  assert.deepEqual(p.rows(), seqs(range(9951, 10000)))
  assert.ok(hidden(p, 'toast'))
})

test('with 只看 @我 on, a jump to a message not for me turns it off first', async () => {
  const p = latest({ filtered: true })
  p.roomFeed.jumpTo(9960)
  assert.equal(p.filtered(), false)
  assert.ok(shown(p, 9960))
  const q = latest({ filtered: true })
  q.roomFeed.jumpTo(5121)
  assert.equal(q.filtered(), false)
  await settle()
  assert.deepEqual(q.rows(), seqs(range(5071, 5171)))
  assert.ok(shown(q, 5121))
})

test('Back from a search hit opens the search again on a phone; Back from a #number does not', async () => {
  const p = latest()
  p.box.innerWidth = 400
  p.roomFeed.jumpSearch(5121)
  await settle()
  p.roomFeed.goBack()
  assert.deepEqual(p.opened, ['search'])
  p.roomFeed.jumpTo(5121)
  await settle()
  p.roomFeed.goBack()
  assert.deepEqual(p.opened, ['search'])
})

test('Back from a jump made by a home-page search link goes back to that search', async () => {
  const p = latest()
  p.location.search = '?jump=5121&fromSearch=deploy'
  p.roomFeed.jumpSearch(5121, true)
  await settle()
  p.roomFeed.goBack()
  assert.equal(p.location.href, '/?search=deploy')
})
