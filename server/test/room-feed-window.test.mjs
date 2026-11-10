// docs/web.md rules 1–3 with thousands of messages: the page keeps a bounded window of rows and a bounded set of messages
// in memory, an event touches only the rows it changed, and the overlay history watches only the overlays' own elements.
// Everything the feed did before the window still works: each case below names what it keeps.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { S, msg, page, range } from './helpers/feed-page.mjs'

const ROWS_MAX = 260, MSGS_MAX = 1000 // room-feed.js
const settle = () => new Promise((r) => setImmediate(r))
const seqs = (list) => list.map((m) => m.seq)
/** Mine, to lee: a row with a read line counted for lee. */
const mine = (seq) => msg(seq, { from: 'kai', text: `@lee message ${seq}`, mentions: ['lee'] })
/** The server, messages 1..last: /around (the target and 50 on either side) and /history (100 before). */
const server = (last) => ({
  around: (seq) => (seq >= 1 && seq <= last ? { body: { messages: range(Math.max(1, seq - 50), Math.min(last, seq + 50)) } } : { status: 404, body: { error: 'message_not_found' } }),
  history: (before) => ({ body: { messages: range(Math.max(1, before - 100), before - 1) } }),
})
const bottomTop = (p) => p.feed.scrollHeight - p.feed.clientHeight
const hidden = (p, id) => p.$(id).classList.contains('hidden')
/** Within the cap, and the rows are one contiguous run of the messages in memory. */
function bounded(p) {
  const rows = p.rows(), mem = seqs(p.state.messages)
  assert.ok(rows.length <= ROWS_MAX, `${rows.length} rows on the page`)
  assert.ok(mem.length <= MSGS_MAX, `${mem.length} messages in memory`)
  const at = mem.indexOf(rows[0])
  assert.deepEqual(rows, mem.slice(at, at + rows.length), 'the rows are a contiguous slice of memory')
}

/** A page at the bottom of the latest 50 of a topic of last messages. */
function latest(last = 10000, opts = {}) {
  const p = page({ ...server(last), ...opts })
  p.hello(range(last - 49, last), { cursor: last, mentionUnread: 0 })
  return p
}

test('5000 messages arriving at the bottom: rows and messages stay within their caps, the reader stays at the latest', () => {
  const p = page()
  p.hello(range(1, 50), { cursor: 50, mentionUnread: 0 })
  const invite = p.box.document.createElement('div')
  p.feed.insertBefore(invite, p.feed.firstChild) // the invite card sits above everything (room-settings.js placeInvite)
  for (let s = 51; s <= 5050; s++) {
    p.roomFeed.append(msg(s))
    if (s % 500 === 0) bounded(p)
  }
  bounded(p)
  assert.equal(p.rows().at(-1), 5050)
  assert.equal(p.feed.scrollTop, bottomTop(p), 'carried along at the bottom')
  assert.equal(p.marks.at(-1), 5050)
  assert.ok(hidden(p, 'jump'))
  assert.ok(p.feed.children.includes(invite), 'the invite card stays')
  assert.ok(p.arrivedSeqs.includes(5050), 'the outbox hears of every message')
  assert.ok(!p.state.bySeq.has(1), 'messages dropped from memory leave the index too')
})

test('a reader up in history: new ones are counted, not drawn; nothing past what was shown is marked; "↓" brings the latest', () => {
  const p = latest(300)
  p.roomFeed.jumpDown()
  p.scroll(0)
  const top = p.rows()[0]
  for (let s = 301; s <= 2300; s++) p.roomFeed.append(msg(s))
  bounded(p)
  assert.equal(p.rows()[0], top, 'what the reader looks at stays')
  assert.equal(p.feed.scrollTop, 0)
  assert.equal(p.jumpText(), S.newBelow.replace('{n}', 2000))
  assert.ok(p.marks.every((n) => n <= 300), 'nothing past what the page showed is marked')

  p.roomFeed.jumpDown()
  bounded(p)
  assert.equal(p.rows().at(-1), 2300)
  assert.equal(p.feed.scrollTop, bottomTop(p))
  assert.ok(hidden(p, 'jump'))
  assert.equal(p.marks.at(-1), 2300)
})

test('scrolling up draws from memory first, then fetches; far up the latest is held; scrolling down comes back to it', async () => {
  const p = latest()
  p.feed.scrollTop = 4000
  for (let i = 0; i < 40; i++) {
    p.scroll(Math.min(p.feed.scrollTop, 100))
    p.scroll(0)
    const first = p.rows()[0], at = p.row(first).getBoundingClientRect().top
    await settle() // the page fetched from the server goes in above
    bounded(p)
    assert.equal(p.row(first).getBoundingClientRect().top, at, 'the view stays put')
  }
  const loads = p.fetched.filter((f) => String(f).startsWith('before')).length
  assert.ok(loads >= 30, `${loads} pages fetched`)
  assert.ok(p.rows()[0] < 7000, 'far up the history')
  assert.equal(p.jumpText(), S.toLatest, 'the latest is held: "↓ Latest" is offered')
  assert.ok(p.marks.every((n) => n <= 10000))

  // Back down by scrolling: memory first, then /around pages until the held latest feed joins.
  for (let i = 0; i < 400 && p.rows().at(-1) !== 10000; i++) {
    p.scroll(Math.max(0, bottomTop(p) - 400))
    p.scroll(bottomTop(p))
    await settle()
    bounded(p)
  }
  assert.equal(p.rows().at(-1), 10000)
  p.scroll(bottomTop(p))
  assert.ok(hidden(p, 'jump'), 'at the latest again')
})

test('jumps near and far: on the page, in memory (no request), on the server; Back retraces each', async () => {
  const p = latest()
  for (let i = 0; i < 6; i++) { p.scroll(100); p.scroll(0); await settle() }
  const mem = seqs(p.state.messages), rows = p.rows()
  const inMemory = mem.find((s) => s > rows.at(-1) + 50)
  assert.ok(inMemory, 'a message in memory below the window')
  const before = p.fetched.length

  p.roomFeed.jumpTo(rows[3]) // on the page
  p.roomFeed.jumpTo(inMemory, p.row(rows[3])) // in memory: drawn around it
  assert.equal(p.fetched.length, before, 'no request for a message in memory')
  assert.ok(p.row(inMemory))
  bounded(p)
  p.roomFeed.jumpSearch(500) // far: one /around
  await settle()
  assert.deepEqual(p.fetched.slice(before), [500])
  assert.ok(p.row(500))
  bounded(p)

  p.roomFeed.goBack()
  await settle()
  assert.ok(p.row(inMemory), 'Back to the in-memory jump')
  p.roomFeed.goBack()
  await settle()
  assert.ok(p.row(rows[3]))
  assert.equal(p.row(rows[3]).getBoundingClientRect().top >= 0, true)
  p.roomFeed.jumpDown()
  assert.equal(p.rows().at(-1), 10000)
  assert.ok(hidden(p, 'back'))
})

test('the unread line goes with its row when trimmed and comes back with it; an open menu closes with its row', () => {
  const p = page()
  p.hello(range(1, 50), { cursor: 10, mentionUnread: 0 })
  assert.ok(p.$('unread'), 'above #11')
  p.roomFeed.jumpDown()
  p.click({ closest: (s) => (s === '[data-menu]' ? { dataset: { menu: '45' }, getBoundingClientRect: () => ({ top: 0, bottom: 0, right: 0 }) } : null) })
  assert.equal(p.roomFeed.menuOpen(), true)
  for (let s = 51; s <= 400; s++) p.roomFeed.append(msg(s))
  assert.equal(p.$('unread'), null)
  assert.equal(p.roomFeed.menuOpen(), false, 'the menu of a trimmed row closes')
  p.roomFeed.jumpTo(11)
  assert.ok(p.$('unread'))
  assert.equal(p.feed.children[p.feed.children.indexOf(p.row(11)) - 1], p.$('unread'), 'the line is above its message again')
})

test('an opened long message stays open after its row is trimmed and drawn again', () => {
  const LONG = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n')
  const p = page()
  p.hello(range(1, 50).map((m) => (m.seq === 40 ? { ...m, text: LONG } : m)), { cursor: 50, mentionUnread: 0 })
  p.unfold(40)
  for (let s = 51; s <= 400; s++) p.roomFeed.append(msg(s))
  assert.equal(p.row(40), null)
  p.roomFeed.jumpTo(40)
  assert.doesNotMatch(p.row(40).innerHTML, /fm-fold/)
})

test('a reconnect after two thousand messages matches the window by seq; nothing on it is drawn again', () => {
  const p = page()
  p.hello(range(1, 50), { cursor: 50, mentionUnread: 0 })
  for (let s = 51; s <= 2000; s++) p.roomFeed.append(msg(s))
  const kept = p.rows().map((s) => p.row(s))
  p.hello(range(1951, 2003))
  bounded(p)
  kept.forEach((el) => { if (el.parent) assert.equal(p.row(Number(el.dataset.seq)), el) })
  assert.equal(p.rows().at(-1), 2003)
  assert.equal(p.feed.scrollTop, bottomTop(p))
})

test('只看 @我: rows for me in memory above the window come before any request; the mark is the last one shown', async () => {
  const forMe = (seq) => msg(seq, { text: `@kai hi ${seq}`, mentions: ['kai'] })
  const p = page({ filtered: true, ...server(3000) })
  p.hello(range(2951, 3000), { cursor: 2900, mentionUnread: 0 })
  p.filter(false)
  for (let i = 0; i < 4; i++) { p.scroll(100); p.scroll(0); await settle() } // memory now reaches far above the window
  p.roomFeed.jumpDown()
  // Below the window, one for me arrives.
  p.roomFeed.append(forMe(3001))
  p.filter(true)
  assert.equal(p.marks.at(-1), 3001, 'the last row for me is what is marked')
  const before = p.fetched.length
  p.state.messages.forEach((m) => { if (m.seq === p.state.messages[0].seq + 3) Object.assign(m, { text: '@kai old one', mentions: ['kai'], validMentions: undefined }) })
  p.roomFeed.loadEarlier()
  assert.equal(p.fetched.length, before, 'memory first')
  assert.ok(p.row(p.state.messages[3].seq), 'the row for me from memory is drawn')
  // The hidden rows between two rows on screen stay: the window is bounded by memory here, not by ROWS_MAX.
  const rows = p.rows(), mem = seqs(p.state.messages)
  assert.ok(rows.length <= MSGS_MAX)
  assert.deepEqual(rows, mem.slice(mem.indexOf(rows[0]), mem.indexOf(rows[0]) + rows.length))
})

test('one cursor frame writes only the read lines it changes', () => {
  const p = page()
  const lee = p.state.members[0]
  lee.cursor = 0
  p.hello(Array.from({ length: 50 }, (_, i) => mine(i + 1)), { cursor: 50, mentionUnread: 0 })
  for (let s = 51; s <= 5000; s++) p.roomFeed.append(mine(s))
  const move = (name, to) => {
    const who = p.state.members.find((x) => x.name === name), was = who.cursor, w = p.writes.rc
    who.cursor = to
    p.roomFeed.readLinesMoved(name, was, to)
    return p.writes.rc - w
  }
  move('lee', 4990)
  assert.equal(move('lee', 4991), 1, 'one row read')
  assert.equal(move('lee', 4996), 5)
  const w0 = p.writes.rc
  assert.equal(p.roomFeed.readLinesMoved('lee', 100, 1000), undefined)
  assert.equal(p.writes.rc, w0, 'a move outside the window writes nothing')
  p.state.members.push({ name: 'max', kind: 'human', status: 'active', cursor: 0 })
  assert.equal(move('max', 5000), 0, 'not in these messages\' audience')
  const w = p.writes.rc
  p.roomFeed.refreshReadLines() // a members frame: every row in the window recomputed, none changed
  assert.equal(p.writes.rc, w)
})

test('one todo frame writes only the task lines of the item that changed', () => {
  const p = page({ tasks: true })
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `T${i + 1}`, title: `task ${i + 1}`, status: 'todo', assignee: 'lee', createdSeq: 4000 + 10 * i, updatedMs: 1 }))
  p.tasks.applyTodo(items, [])
  p.hello(range(1, 50), { cursor: 50, mentionUnread: 0 })
  for (let s = 51; s <= 5000; s++) p.roomFeed.append(msg(s))
  p.tasks.refreshTodo()
  let w = p.writes.todo
  p.tasks.applyTodo(items.map((x) => (x.id === 'T95' ? { ...x, status: 'doing', updatedMs: 2 } : x)), [])
  p.tasks.refreshTodo()
  assert.equal(p.writes.todo - w, 1)
  assert.match(p.row(4940).todos[0].outerHTML, /T95/)
  w = p.writes.todo
  p.tasks.applyTodo(items.map((x) => (x.id === 'T95' ? { ...x, status: 'doing', updatedMs: 3 } : x)), [])
  p.tasks.refreshTodo()
  assert.equal(p.writes.todo - w, 0, 'a frame that changes nothing shown writes nothing')
})

// ---------- the overlay history (room-overlay-history.js) ----------

function overlays() {
  const observed = [], callbacks = []
  /** An element whose class changes reach the observers watching it, as the browser does. */
  const element = (open) => {
    let cls = open ? '' : 'hidden'
    const el = { get className() { return cls }, set className(v) { cls = v; observed.filter((o) => o.el === el).forEach((o) => o.fn([])) } }
    el.open = () => { el.className = '' }
    el.close = () => { el.className = 'hidden' }
    el.isOpen = () => !el.className.includes('hidden')
    return el
  }
  const entries = [{ state: null }]
  let index = 0, onPop = null
  const history = {
    get state() { return entries[index].state },
    get length() { return entries.length },
    pushState(state) { entries.splice(index + 1); entries.push({ state }); index++ },
    replaceState(state) { entries[index] = { state } },
    go(n) { index += n; setImmediate(() => onPop({ state: entries[index].state })) },
    back() { this.go(-1) },
  }
  const body = { id: 'body' }
  const box = {
    history, location: { href: '/r/r1' }, queueMicrotask, document: { body },
    matchMedia: () => ({ matches: true }), // a phone
    addEventListener: (type, fn) => { if (type === 'popstate') onPop = fn },
    MutationObserver: class {
      constructor(fn) { this.fn = fn }
      observe(el, opts) { observed.push({ el, opts, fn: this.fn }) }
    },
  }
  box.window = box
  vm.createContext(box)
  vm.runInContext(fs.readFileSync(new URL('../../web/public/static/room-overlay-history.js', import.meta.url), 'utf8'), box)
  return { api: box.scorpioRoomOverlays, observed, body, element, history, depth: () => index }
}

test('the overlay history watches only the overlays\' own elements, never the page', () => {
  const o = overlays(), menu = o.element(false)
  o.api.register('menu', menu.isOpen, menu.close, menu)
  o.api.register('tall', () => false, () => {})
  assert.ok(o.observed.every((x) => x.el !== o.body), 'document.body is not observed')
  assert.deepEqual(o.observed.map((x) => [x.el, x.opts.subtree, x.opts.childList]), [[menu, undefined, undefined]])
  assert.deepEqual([...o.observed[0].opts.attributeFilter], ['class', 'hidden'])
})

test('phone Back: an overlay opened adds one history entry, Back closes it, closing it takes the entry back', async () => {
  const o = overlays(), menu = o.element(false)
  let tall = false
  o.api.register('menu', menu.isOpen, menu.close, menu)
  o.api.register('tall', () => tall, () => { tall = false; o.api.changed() })
  await settle()
  assert.equal(o.depth(), 0)

  menu.open()
  await settle()
  assert.equal(o.depth(), 1, 'one entry for the open menu')
  o.history.back()
  await settle()
  assert.equal(menu.isOpen(), false, 'Back closed it')
  assert.equal(o.depth(), 0)

  menu.open()
  await settle()
  assert.equal(o.depth(), 1)
  menu.close() // closed on the page, not by Back
  await settle()
  await settle()
  assert.equal(o.depth(), 0, 'its entry is taken back')

  tall = true
  o.api.changed() // an overlay without an element says so itself
  await settle()
  assert.equal(o.depth(), 1)
  o.history.back()
  await settle()
  assert.equal(tall, false)
  assert.equal(o.depth(), 0)
})
