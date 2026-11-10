// Message times, about one a screen: every row carries its time, the feed shows it on the first row
// and then on each row a screen or more below the last one showing; what it decided stays as rows come and go.
import assert from 'node:assert/strict'
import test from 'node:test'
import { msg, page, range } from './helpers/feed-page.mjs'

// The page's rows are 100 px tall (50 px more per file) and the feed 500 px high: a screen is five rows.
const settle = () => new Promise((r) => setImmediate(r))
const shown = (p) => p.rows().filter((seq) => p.row(seq).classList.contains('t-show'))
const every5 = (from, to) => range(from, to).map((m) => m.seq).filter((seq) => (seq - from) % 5 === 0)

test('the first row shows its time, then each row a screen or more below the last one showing; system lines do not count', () => {
  const p = page()
  const list = range(1, 12)
  list[5] = { seq: 6, ts: list[5].ts, from: 'system', fromKind: 'system', text: 'lee joined', event: { type: 'join', name: 'lee' } }
  p.hello(list, { cursor: 12, mentionUnread: 0 })
  // 1 at 0 px; 6 is a system line (it takes room, has no time); 7 at 600 px; 12 at 1100 px.
  assert.deepEqual(shown(p), [1, 7, 12])
  assert.ok(p.row(1).html.includes('<time>') && p.row(2).html.includes('<time>'), 'every row carries its time')
})

test('new rows at the bottom go on from the last one showing and change nothing above, also when a row above grew', () => {
  const p = page()
  p.hello(range(1, 50), { cursor: 50, mentionUnread: 0 })
  const before = shown(p)
  assert.deepEqual(before, every5(1, 50))
  p.state.bySeq.get(3).files = [{}, {}, {}, {}] // a row above grows by 200 px (a picture loaded): not followed
  for (let s = 51; s <= 60; s++) p.roomFeed.append(msg(s))
  assert.deepEqual(shown(p).filter((s) => s <= 50), before, 'the rows above keep what they had')
  assert.deepEqual(shown(p).filter((s) => s > 50), [51, 56], 'the new ones go on from 46')
  // A row drawn again in its place (its message changed) shows the same.
  p.roomFeed.updated({ ...p.state.bySeq.get(46), text: 'edited buttons' })
  assert.ok(p.row(46).classList.contains('t-show'))
  p.roomFeed.updated({ ...p.state.bySeq.get(47), text: 'edited buttons' })
  assert.ok(!p.row(47).classList.contains('t-show'))
})

test('earlier rows loaded above go up from the first one showing; what was decided stays', async () => {
  const p = page({ history: (before) => ({ body: { messages: range(Math.max(1, before - 100), before - 1) } }) })
  p.hello(range(103, 150), { cursor: 150, mentionUnread: 0 })
  const before = shown(p)
  assert.deepEqual(before, every5(103, 150))
  p.scroll(200)
  p.scroll(0) // scrolling up near the top loads the page before 103
  await settle()
  assert.equal(p.rows()[0], 3, 'the earlier page is on the page')
  assert.deepEqual(shown(p).filter((s) => s >= 103), before, 'the rows already there keep what they had')
  // Up from 103: 98 is a screen above it, then 93 … 3; a fresh pass from the top would have shown 1, 6 ….
  assert.deepEqual(shown(p).filter((s) => s < 103), every5(3, 98))
})

test('rows taken out of the window and drawn again keep their answer; a whole redraw or a new width places every time again, a new height does not', () => {
  const p = page()
  p.hello(range(1, 50), { cursor: 50, mentionUnread: 0 })
  const first50 = shown(p)
  for (let s = 51; s <= 400; s++) p.roomFeed.append(msg(s)) // the window trims its top as it grows
  assert.ok(p.rows()[0] > 50, 'the first rows left the page')
  const all = new Map(p.rows().map((seq) => [seq, p.row(seq).classList.contains('t-show')]))
  // Up again: the rows come back from memory, a step at a time, each with the answer it had.
  for (let i = 0; i < 20 && p.rows()[0] > 1; i++) { p.scroll(100); p.scroll(0) }
  assert.equal(p.rows()[0], 1)
  assert.deepEqual(shown(p).filter((s) => s <= 50), first50)
  for (const [seq, on] of all) if (p.row(seq)) assert.equal(p.row(seq).classList.contains('t-show'), on, `#${seq}`)

  p.roomFeed.jumpDown() // the window drawn anew at the latest: placed again from its first row
  const rows = p.rows()
  assert.deepEqual(shown(p), rows.filter((seq) => (seq - rows[0]) % 5 === 0))

  // A new width (a window resized, a phone turned): every time placed again, now from the window's first row.
  p.feed.clientWidth = 800
  p.feed.clientHeight = 300
  p.observers.widths.fire(p.feed)
  assert.deepEqual(shown(p), rows.filter((seq) => (seq - rows[0]) % 3 === 0), 'a screen is now three rows')
  // A new height alone (a phone's keyboard, a taller composer): what was decided stays; only new rows use it.
  const before = shown(p)
  p.feed.clientHeight = 500
  p.observers.widths.fire(p.feed)
  assert.deepEqual(shown(p), before)
  const lastShown = before.at(-1)
  for (let s = 401; s <= 410; s++) p.roomFeed.append(msg(s))
  assert.deepEqual(shown(p).filter((s) => s > 400), range(401, 410).map((m) => m.seq).filter((s) => (s - lastShown) % 5 === 0))
})
