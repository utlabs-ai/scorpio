// A reconnect does not draw the feed again: the hello after it is matched to the rows by seq, so the
// reader's place, the rows they opened and the rows that did not change stay as they are; new messages come in below.
import assert from 'node:assert/strict'
import test from 'node:test'
import { S, msg, page, range } from './helpers/feed-page.mjs'

const LONG = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n')

test('a reconnect keeps every unchanged row as it is, an opened long message stays open, new ones come in below', () => {
  const p = page()
  p.hello(range(1, 5).map((m) => (m.seq === 3 ? { ...m, text: LONG } : m)), { cursor: 5, mentionUnread: 0 })
  assert.deepEqual(p.rows(), [1, 2, 3, 4, 5])
  assert.match(p.row(3).innerHTML, /fm-fold/)
  p.unfold(3)
  assert.doesNotMatch(p.row(3).innerHTML, /fm-fold/)
  const before = p.feed.children.slice()

  p.hello(range(1, 7).map((m) => (m.seq === 3 ? { ...m, text: LONG } : m)))
  assert.deepEqual(p.rows(), [1, 2, 3, 4, 5, 6, 7])
  for (let i = 0; i < 5; i++) assert.equal(p.feed.children[i], before[i], `row ${i + 1} is the same element`)
  assert.doesNotMatch(p.row(3).innerHTML, /fm-fold/)
  assert.deepEqual(p.state.messages.map((m) => m.seq), [1, 2, 3, 4, 5, 6, 7])
})

test('a changed message is drawn again in its place, still open; the reader above it does not move', () => {
  const p = page()
  p.hello(range(1, 10).map((m) => (m.seq === 6 ? { ...m, text: LONG } : m)), { cursor: 10, mentionUnread: 0 })
  p.unfold(6)
  p.feed.scrollTop = 250 // row 3 at the top, half of it showing
  const top = p.row(4).getBoundingClientRect().top, kept = p.row(4)

  // Row 2 lost a file while away (taller before, shorter now is the same rule): its height changes above the reader.
  const changed = range(1, 10).map((m) => (m.seq === 6 ? { ...m, text: LONG, files: [{ id: 'f' }] } : m.seq === 2 ? { ...m, files: [{ id: 'a' }, { id: 'b' }] } : m))
  p.hello(changed)
  assert.equal(p.row(4), kept)
  assert.equal(p.row(4).getBoundingClientRect().top, top, 'what the reader looks at stays where it was')
  assert.doesNotMatch(p.row(6).innerHTML, /fm-fold/, 'drawn again from the new message, the row stays open')
})

test('a reader scrolled up sees "↓ N new"; a reader at the bottom is carried along', () => {
  const p = page()
  p.hello(range(1, 10), { cursor: 10, mentionUnread: 0 })
  p.feed.scrollTop = 0
  p.hello(range(1, 13))
  assert.equal(p.feed.scrollTop, 0)
  assert.equal(p.jumpText(), S.newBelow.replace('{n}', 3))

  const q = page()
  q.hello(range(1, 10), { cursor: 10, mentionUnread: 0 })
  q.hello(range(1, 12))
  assert.equal(q.feed.scrollTop, q.feed.scrollHeight - q.feed.clientHeight)
  assert.deepEqual(q.marks, [12])
})

test('a message gone from the hello leaves; one the page missed goes in its place', () => {
  const p = page()
  p.hello([msg(1), msg(2), msg(4), msg(5), msg(6)], { cursor: 6, mentionUnread: 0 })
  p.hello([msg(1), msg(3), msg(4), msg(6), msg(7)])
  assert.deepEqual(p.rows(), [1, 3, 4, 6, 7])
  assert.deepEqual(p.state.messages.map((m) => m.seq), [1, 3, 4, 6, 7])
})

test('rows older than the hello stay, and the mention count is the hello\'s, not added to', () => {
  const p = page()
  p.hello(range(1, 60), { cursor: 60, mentionUnread: 0 })
  const first = p.row(1)
  p.hello(range(13, 62).map((m) => (m.seq === 62 ? { ...m, text: '@kai look', mentions: ['kai'] } : m)), { cursor: 60, mentionUnread: 1 })
  assert.equal(p.row(1), first)
  assert.equal(p.rows().length, 62)
  assert.equal(p.state.mentionUnread, 1)
})

test('more than one hello carries: the page stays, nothing past it is marked, ↓ shows the count and then the latest', () => {
  const p = page()
  p.hello(range(1, 10), { cursor: 10, mentionUnread: 0 })
  const kept = p.feed.children.slice()
  p.hello(range(71, 120))
  assert.deepEqual(p.feed.children, kept, 'the page is not touched')
  assert.deepEqual(p.state.messages.map((m) => m.seq), range(1, 10).map((m) => m.seq))
  assert.equal(p.jumpText(), S.newBelow.replace('{n}', 110))
  assert.ok(p.$('back').classList.contains('hidden'), 'no ↩ Back: nothing was jumped from')
  p.roomFeed.maybeMark()
  assert.deepEqual(p.marks, [], 'the reader at the bottom of the page has read only what is on it')

  p.roomFeed.jumpDown()
  assert.deepEqual(p.rows(), range(71, 120).map((m) => m.seq))
  assert.deepEqual(p.marks, [120])
})

test('with an older page open after a search jump, the latest feed is updated where it waits', () => {
  const p = page()
  p.hello(range(1, 10), { cursor: 10, mentionUnread: 0 })
  p.hello(range(81, 130)) // the latest is held, as after a jump to an older page
  const kept = p.feed.children.slice()
  p.hello(range(83, 132))
  assert.deepEqual(p.feed.children, kept)
  p.roomFeed.jumpDown()
  assert.deepEqual(p.rows(), range(81, 132).map((m) => m.seq))
})

test('a code block with wrapping turned off stays off when its row is drawn again', () => {
  const p = page()
  p.hello([msg(1), msg(2, { text: 'two blocks\n```\na\n```\n```\nb\n```' })], { cursor: 2, mentionUnread: 0 })
  const second = p.row(2).querySelectorAll('.codeblock')[1]
  p.click({ closest: (s) => (s === '[data-wrapcode]' ? second.button : null) })
  assert.ok(second.pre.classList.contains('nowrap'))

  p.roomFeed.filesChanged(2, [{ id: 'f' }]) // a file went: the row is drawn again
  const [a, b] = p.row(2).querySelectorAll('.codeblock')
  assert.ok(!a.pre.classList.contains('nowrap'))
  assert.ok(b.pre.classList.contains('nowrap'))
  assert.equal(b.button.textContent, S.wrapOff)
  assert.equal(b.button.attrs['aria-pressed'], 'false')
})

for (const [label, by, target, addressed] of [
  ['set by me, to my agent', 'kai', 'api@kai', false],
  ['set by my agent, to my other agent', 'worker@kai', 'api@kai', false],
  ['set by someone else, to my agent', 'helper@lee', 'api@kai', true],
  ['set by me, directly to me', 'kai', 'kai', true],
]) {
  test(`scheduled message ${label}: row and unread count follow the setter`, () => {
    const p = page({ filtered: true })
    p.hello([], { cursor: 0, mentionUnread: 0 })
    p.roomFeed.append(msg(1, {
      from: 'scheduled', fromKind: 'scheduled', scheduled: { id: 'S1', by },
      text: `@${target} check CI`, mentions: [target],
    }))
    assert.equal(p.row(1).classList.contains('forme'), addressed)
    assert.equal(p.state.mentionUnread, addressed ? 1 : 0)
  })
}

test('filtered feed keeps hidden arrivals for exit, counts only addressed rows, and preserves row identity and scroll', () => {
  const p = page({ filtered: true })
  p.hello(range(1, 30, { mentions: ['kai'], text: '@kai message' }), { cursor: 0, mentionUnread: 30 })
  p.feed.scrollTop = 500
  const top = p.feed.scrollTop, row = p.row(10)
  p.roomFeed.append(msg(31))
  assert.equal(p.feed.scrollTop, top)
  assert.equal(p.row(10), row)
  assert.doesNotMatch(p.jumpText(), /1 条新消息/)
  p.roomFeed.append(msg(32, { mentions: ['kai'], text: '@kai new' }))
  assert.equal(p.feed.scrollTop, top)
  assert.equal(p.row(10), row)
  assert.equal(p.jumpText(), '↓ 1 条新消息')
  p.filter(false)
  assert.equal(p.jumpText(), '↓ 2 条新消息')
})

test('filtered bottom follows addressed arrivals and marks the latest shown seq, leaving hidden trailing messages unread', async () => {
  const p = page({ filtered: true })
  p.hello(range(1, 10, { mentions: ['kai'], text: '@kai message' }), { cursor: 0, mentionUnread: 10 })
  p.feed.scrollTop = p.feed.scrollHeight
  p.roomFeed.append(msg(11, { mentions: ['kai'], text: '@kai new' }))
  await Promise.resolve()
  assert.equal(p.feed.scrollTop, p.feed.scrollHeight - p.feed.clientHeight)
  assert.equal(p.marks.at(-1), 11)
  p.roomFeed.append(msg(12)); await Promise.resolve()
  assert.equal(p.state.cursor, 11)
  assert.equal(p.marks.at(-1), 11)
})

test('filtered anchor ignores zero-height hidden rows and viewer never marks', () => {
  const p = page({ filtered: true, viewer: true })
  p.hello([msg(1), msg(2, { mentions: ['kai'], text: '@kai hi' }), msg(3)])
  assert.equal(Number(p.roomFeed.anchor().seq), 2)
  p.roomFeed.maybeMark()
  assert.deepEqual(p.marks, [])
})
