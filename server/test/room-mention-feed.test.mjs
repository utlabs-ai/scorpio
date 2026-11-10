import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

function setup(initial = []) {
  const requests = [], responses = [], anchors = [], restores = [], jumps = [], errors = [], listeners = {}
  let selected = false, selecting = false, menu = false, bottom = false
  const state = { messages: initial, bySeq: new Map(initial.map(m => [m.seq, m])), mentionUnread: 7 }
  function element() {
    const el = { children: [], dataset: {}, className: '', attrs: {}, listeners: {}, parent: null,
      setAttribute(k, v) { this.attrs[k] = v }, addEventListener(k, fn) { this.listeners[k] = fn },
      getBoundingClientRect: () => ({ top: 25, bottom: 125 }),
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null },
      appendChild(c) { return this.insertBefore(c, null) },
      insertBefore(c, next) {
        if (c.fragment) { [...c.children].forEach(row => this.insertBefore(row, next)); return c }
        c.remove(); const i = next ? this.children.indexOf(next) : this.children.length
        this.children.splice(i, 0, c); c.parent = this; return c
      },
      querySelector(s) { return this.children.find(c => '#'+c.id === s) || null },
      querySelectorAll() { return this.children.flatMap(c => c.dataset.seq ? [c] : c.querySelectorAll()) },
    }
    Object.defineProperty(el, 'firstChild', { get: () => el.children[0] || null })
    el.classList = { contains: k => el.className.split(' ').includes(k), toggle(k, on) { el.className = el.className.split(' ').filter(x => x !== k).concat(on ? [k] : []).join(' ') } }
    return el
  }
  function row(m) { const el = element(); el.dataset.seq = String(m.seq); el.className = 'msg forme'; return el }
  const button = element(), feed = element()
  initial.forEach(m => feed.appendChild(row(m)))
  let a = initial.length ? { seq: String(initial[0].seq), off: 25 } : null
  const rows = {
    menuOpen: () => menu, selecting: () => selecting, nearBottom: () => bottom,
    indexSparse(list) { list.forEach(m => state.bySeq.set(m.seq, m)) },
    dropSparse(list) { list.forEach(m => { if(state.bySeq.get(m.seq) === m) state.bySeq.delete(m.seq) }) },
    anchor(onlyMe) { anchors.push(onlyMe); return a }, restore(a) { restores.push(a) },
    renderMessage: row, refreshTop() {}, updateJump() {}, maybeMark() {}, placeTimes() {},
    // The feed's window: its rows for me, and nothing in memory above it.
    formeRows: () => feed.children.filter(c => c.dataset.seq && c.classList.contains('forme')), growUp: () => false }
  const box = { window: { getSelection: () => ({ isCollapsed: !selected }) }, document: { addEventListener(k, fn) { listeners[k] = fn }, createElement: element, createDocumentFragment() { return { ...element(), fragment: true } } }, fetch(url) {
    requests.push(url); return Promise.resolve({ ok: true, json: async () => responses.shift() })
  } }
  vm.runInNewContext(fs.readFileSync(new URL('../../web/public/static/room-mention-feed.js', import.meta.url), 'utf8'), box)
  const api = box.window.createRoomMentionFeed({ button, feed, state, rows, roomId: 'r1', S: ROOM_STRINGS.en,
    fill: (s, v) => s.replace('{n}', v.n), jumpTo: n => jumps.push(n), flash: e => errors.push(e) })
  return { api, button, feed, state, requests, responses, anchors, restores, jumps, errors,
    bottom: value => { bottom = value }, select: value => { selected = value }, selecting: value => { selecting = value }, menu(value) { menu = value; listeners.click() }, dismissMenu() { menu = false },
    anchor: value => { a = value }, rows: () => feed.querySelectorAll().map(el => Number(el.dataset.seq)) }
}

test('toggle filters the existing feed, preserves the anchor and uses the existing unread count without a fetch', () => {
  const h = setup([{ seq: 80 }]), row = h.feed.children[0]
  h.button.onclick()
  assert.equal(h.button.textContent, '@me only · 7 unread')
  assert.equal(h.button.attrs['aria-pressed'], 'true')
  assert.ok(h.feed.classList.contains('only-me'))
  assert.equal(h.feed.children[0], row)
  assert.equal(h.anchors[0], true)
  assert.equal(h.restores[0].seq, '80')
  assert.equal(h.requests.length, 0)
  h.state.mentionUnread = 0; h.api.label()
  assert.equal(h.button.textContent, '@me only · 0 unread')
  h.button.onclick()
  assert.equal(h.api.active(), false)
  assert.equal(h.feed.classList.contains('only-me'), false)
})

test('sparse pages ascend above continuous history, enter only bySeq, preserve rows and drop on exit', async () => {
  const h = setup([{ seq: 80 }]), row = h.feed.children[0]
  h.button.onclick()
  h.responses.push({ mentions: [{ seq: 30 }, { seq: 10 }], hasMore: true })
  await h.api.loadEarlier()
  assert.match(h.requests[0], /kind=human,agent,system,scheduled&before=80$/)
  assert.deepEqual(h.rows(), [10, 30, 80])
  assert.equal(h.state.messages.length, 1)
  assert.equal(h.state.bySeq.size, 3)
  h.responses.push({ mentions: [{ seq: 2 }], hasMore: false })
  await h.api.loadEarlier()
  assert.match(h.requests[1], /&before=10$/)
  assert.deepEqual(h.rows(), [2, 10, 30, 80])
  assert.equal(h.feed.children[1], row)
  assert.equal(h.api.hasMore(), false)
  h.button.onclick()
  assert.deepEqual(h.rows(), [80])
  assert.equal(h.state.bySeq.size, 1)
})

test('exit from a sparse anchor restores context; clicking a continuous row exits in place; links and buttons stay active', async () => {
  const h = setup([{ seq: 80 }])
  h.button.onclick(); h.responses.push({ mentions: [{ seq: 10 }], hasMore: false }); await h.api.loadEarlier()
  h.anchor({ seq: '10', off: 0 }); h.button.onclick()
  assert.deepEqual(h.jumps, [10])
  h.button.onclick()
  h.feed.listeners.click({ target: { closest: s => s === 'a, button, input, textarea, img, .rc' ? {} : null } })
  assert.equal(h.api.active(), true)
  h.feed.listeners.click({ target: { closest: s => s === '.msg[data-seq]' ? h.feed.children[0] : null } })
  assert.equal(h.api.active(), false)
  assert.equal(h.restores.at(-1).seq, '80')
})

test('hello drops sparse rows and pending pages; the next upward load starts again', async () => {
  const h = setup([{ seq: 80 }]); h.button.onclick()
  h.responses.push({ mentions: [{ seq: 10 }], hasMore: true }); await h.api.loadEarlier()
  h.responses.push({ mentions: [{ seq: 2 }], hasMore: false })
  const pending = h.api.loadEarlier()
  h.api.reset(); await pending
  assert.equal(h.api.active(), true)
  assert.deepEqual(h.rows(), [80]); assert.equal(h.state.bySeq.size, 1)
  assert.equal(h.api.hasMore(), true)
  h.responses.push({ mentions: [{ seq: 10 }], hasMore: false }); await h.api.loadEarlier()
  assert.match(h.requests.at(-1), /&before=80$/)
})

test('a topic with no addressed rows loads one page then shows the existing empty copy and exits', async () => {
  const h = setup()
  h.responses.push({ mentions: [], hasMore: false }); const loaded = h.button.onclick()
  assert.equal(h.feed.children.length, 0, 'empty state waits until the first page finishes')
  await loaded
  assert.equal(h.requests.length, 1)
  assert.equal(h.feed.children[0].textContent, ROOM_STRINGS.en.mentionOnlyEmpty)
  h.api.sync()
  assert.equal(h.feed.children.length, 1)
  h.button.onclick()
  assert.equal(h.feed.children.length, 0)
})

test('text selection, selection mode, receipts and menu dismissal do not exit the filter', () => {
  const h = setup([{ seq: 80 }]); h.button.onclick()
  const click = receipt => h.feed.listeners.click({ target: { closest: s => s === '.msg[data-seq]' ? h.feed.children[0] : receipt ? {} : null } })
  h.select(true); click(false); assert.equal(h.api.active(), true)
  h.select(false); h.selecting(true); click(false); assert.equal(h.api.active(), true)
  h.selecting(false); click(true); assert.equal(h.api.active(), true)
  h.menu(true); h.dismissMenu(); click(false); assert.equal(h.api.active(), true)
  h.menu(false); click(false); assert.equal(h.api.active(), false)
})

test('closing at the bottom anchors the last shown row; closing higher anchors the first visible row', () => {
  const h = setup([{ seq: 60 }, { seq: 80 }])
  h.button.onclick(); h.bottom(true); h.button.onclick()
  assert.equal(h.restores.at(-1).seq, '80')
  h.button.onclick(); h.bottom(false); h.button.onclick()
  assert.equal(h.restores.at(-1).seq, '60')
})

test('off for a jump drops the sparse rows without moving or jumping; the jump scrolls itself', async () => {
  const h = setup([{ seq: 80 }])
  h.button.onclick(); h.responses.push({ mentions: [{ seq: 10 }], hasMore: false }); await h.api.loadEarlier()
  h.anchor({ seq: '10', off: 0 })
  const restored = h.restores.length
  h.api.off()
  assert.equal(h.api.active(), false)
  assert.equal(h.feed.classList.contains('only-me'), false)
  assert.equal(h.button.attrs['aria-pressed'], 'false')
  assert.deepEqual(h.rows(), [80])
  assert.deepEqual(h.jumps, [])
  assert.equal(h.restores.length, restored)
  h.api.off()
  assert.equal(h.api.active(), false)
})
