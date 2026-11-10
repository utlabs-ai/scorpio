// A page with just enough of the DOM for the feed (room-feed.js), for the feed's tests.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../../src/strings.ts'

const staticFile = (name) => new URL(`../../../web/public/static/${name}`, import.meta.url)
export const S = ROOM_STRINGS.zh

/** What the server sends: a person's message, files making it taller on the page. */
export const msg = (seq, extra = {}) => ({ seq, ts: Date.UTC(2026, 0, 5, 1, seq), from: 'lee', fromKind: 'human', text: `message ${seq}`, mentions: [], ...extra })
export const range = (a, b, extra) => Array.from({ length: b - a + 1 }, (_, i) => msg(a + i, extra))

/**
 * Just enough of the DOM for the feed: one list of children, a row 100 px tall plus 50 px per file, and scrolling.
 * A row's own HTML is only a string; inside it only the read line (.rc), the foot and its task line are modelled, each
 * write to them counted in writes. tasks: room-tasks.js fills the rows' task lines.
 */
/**
 * cards: room-ai-cards.js runs too (reply buttons and chart cards): {frame: the boot's card frame settings or null,
 * canWrite, respond(what, body): the answer to its post, a value or a promise}. Its observers are fakes the test drives
 * (io.fire), its timers wait for timers.run() and its frames' windows record what they are sent.
 */
export function page({ filtered = false, viewer = false, tasks: withTasks = false, cards = null, around = () => ({ status: 404, body: { error: 'message_not_found' } }), history = () => ({ body: { messages: [] } }) } = {}) {
  const state = { me: 'kai', members: [{ name: 'lee', kind: 'human', status: 'active' }], room: { archived: false }, cursor: 0, mentionUnread: 0, messages: [], bySeq: new Map(), todo: { items: [] } }
  const classList = (el) => ({
    add(c) { if (!this.contains(c)) el.className = `${el.className} ${c}`.trim() },
    remove(c) { el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(' ') },
    contains(c) { return el.className.split(/\s+/).includes(c) },
    toggle(c, on) { if (on === undefined ? !this.contains(c) : on) this.add(c); else this.remove(c) },
  })
  const writes = { rc: 0, todo: 0 }
  /** The read line: its writes counted. */
  const receiptLine = () => {
    let html = ''
    return { className: '', get innerHTML() { return html }, set innerHTML(v) { writes.rc++; html = v } }
  }
  /** A row's task lines in its foot, first in it; each written one counted. */
  const todoLine = (row, html) => {
    const line = {
      outerHTML: html,
      remove() { const i = row.todos.indexOf(line); if (i >= 0) row.todos.splice(i, 1) },
      insertAdjacentHTML(where, h) { assert.equal(where, 'afterend'); writes.todo++; row.todos.splice(row.todos.indexOf(line) + 1, 0, todoLine(row, h)) },
    }
    return line
  }
  const todosOf = (row) => {
    if (!row.todos) { const m = /<div class="todoline">.*?<\/div>/.exec(row.html); row.todos = m ? [todoLine(row, m[0])] : [] }
    return row.todos
  }
  const node = (tag) => {
    const el = { tagName: tag.toUpperCase(), id: '', className: '', dataset: {}, textContent: '', html: '', parent: null, style: {}, attrs: {}, children: [], parts: {} }
    el.classList = classList(el)
    Object.defineProperty(el, 'innerHTML', { get: () => el.html, set: (v) => { el.html = v; el.parts = {}; if (el === feed && v === '') feed.children.forEach((c) => { c.parent = null }), (feed.children = []) } })
    // On the page: in the feed, or in what holds it (the full screen card).
    Object.defineProperty(el, 'isConnected', { get: () => { for (let n = el; n; n = n.parent) if (n === feed || n === shell) return true; return false } })
    el.setAttribute = (k, v) => { el.attrs[k] = String(v) }
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null)
    el.removeAttribute = (k) => { delete el.attrs[k] }
    el.appendChild = (c) => { c.remove(); el.children.push(c); c.parent = el; return c }
    el.addEventListener = (type, fn) => { el.on = el.on || {}; el.on[type] = fn }
    el.focus = () => { focused = el }
    if (tag === 'iframe') el.contentWindow = { sent: [], postMessage(data, origin) { this.sent.push({ data, origin }) } }
    el.remove = () => { if (el.parent) { el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null } }
    el.replaceWith = (other) => { const p = el.parent, i = p.children.indexOf(el); other.remove(); p.children.splice(i, 1, other); other.parent = p; el.parent = null }
    el.querySelector = (sel) => {
      if (sel === '.rc') return /class="rc"/.test(el.html) ? el.rc || (el.rc = receiptLine()) : null
      if (sel === '.todoline') return todosOf(el)[0] || null
      if (sel === '.fm-foot') {
        if (!/class="fm-foot"/.test(el.html)) return null
        return { insertAdjacentHTML(where, h) { if (where !== 'afterbegin') return; writes.todo++; todosOf(el).unshift(todoLine(el, h)) } }
      }
      return part(el, sel)
    }
    // A row's code blocks: one per block in its HTML, each with the wrap button and the pre it switches.
    el.querySelectorAll = (sel) => {
      if (sel === '.bring') return []
    if (sel !== '.codeblock') return []
      if (!el.blocks) {
        el.blocks = (el.html.match(/class="codeblock"/g) || []).map(() => {
          const pre = node('pre'), button = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, textContent: '' }
          pre.className = 'code'
          const block = { pre, button, row: el, querySelector: (q) => (q === 'pre.code' ? pre : q === '[data-wrapcode]' ? button : null), closest: () => el }
          button.closest = () => block
          return block
        })
      }
      return el.blocks
    }
    Object.defineProperty(el, 'nextSibling', { get: () => (el.parent ? el.parent.children[el.parent.children.indexOf(el) + 1] || null : null) })
    el.getBoundingClientRect = () => {
      let top = -feed.scrollTop
      for (const c of feed.children) { if (c === el) break; top += height(c) }
      return { top, bottom: top + height(el), height: height(el) }
    }
    el.scrollIntoView = () => { feed.scrollTop += el.getBoundingClientRect().top }
    return el
  }
  /** An element inside el's HTML by one class (.aib, .aic, .aic-box…): made once, inside el, holding the same HTML. */
  const part = (el, sel) => {
    const cls = /^\.([\w-]+)$/.exec(sel)
    if (!cls || !new RegExp(`class="(?:[^"]* )?${cls[1]}(?: [^"]*)?"`).test(el.html)) return null
    if (!el.parts[sel]) {
      const p = node('div')
      p.className = cls[1]
      p.html = el.html
      p.parent = el
      el.parts[sel] = p
    }
    return el.parts[sel]
  }
  let focused = null
  const isRow = (c) => c.dataset.seq != null && ` ${c.className} `.includes(' msg ')
  const height = (c) => (filtered && isRow(c) && !c.classList.contains('forme') ? 0 : isRow(c) ? 100 + 50 * ((state.bySeq.get(Number(c.dataset.seq)) || {}).files || []).length : 0)
  const feed = node('main')
  feed.children = []
  feed.clientHeight = 500
  let top = 0
  Object.defineProperty(feed, 'scrollHeight', { get: () => feed.children.reduce((n, c) => n + height(c), 0) })
  Object.defineProperty(feed, 'scrollTop', { get: () => top, set: (v) => { top = Math.max(0, Math.min(v, feed.scrollHeight - feed.clientHeight)) } })
  feed.getBoundingClientRect = () => ({ top: 0, bottom: feed.clientHeight })
  feed.appendChild = (c) => {
    if (c.fragment) { c.children.splice(0).forEach((x) => feed.appendChild(x)); return c }
    c.remove(); feed.children.push(c); c.parent = feed; return c
  }
  feed.insertBefore = (c, ref) => {
    if (!ref || ref.parent !== feed) return feed.appendChild(c)
    if (c.fragment) { c.children.splice(0).forEach((x) => { x.parent = null; feed.insertBefore(x, ref) }); return c }
    c.remove(); feed.children.splice(feed.children.indexOf(ref), 0, c); c.parent = feed; return c
  }
  feed.contains = (c) => c.parent === feed || (!!c.row && c.row.parent === feed)
  Object.defineProperty(feed, 'firstChild', { get: () => feed.children[0] || null })
  feed.querySelectorAll = (s) => { assert.equal(s, '.msg[data-seq]'); return feed.children.filter(isRow) }
  feed.querySelector = (s) => {
    const seq = /^\.msg\[data-seq="(\d+)"\]$/.exec(s)
    if (seq) return feed.children.find((c) => isRow(c) && String(c.dataset.seq) === seq[1]) || null
    if (s === '.msg[data-seq]') return feed.children.find(isRow) || null
    if (s === '.mention-older') return null
    if (s === '.empty') return feed.children.find((c) => c.className === 'empty') || null
    throw new Error(`unexpected selector ${s}`)
  }
  /** A fragment: its children move into the feed where it is inserted. */
  function createDocumentFragment() {
    const f = node('#fragment')
    f.fragment = true
    f.children = []
    f.appendChild = (c) => { c.remove(); f.children.push(c); c.parent = f; return c }
    return f
  }
  // Every listener on the feed hears its events, in the order they were added.
  const listeners = {}, added = {}
  feed.addEventListener = (type, fn) => { (added[type] = added[type] || []).push(fn); listeners[type] = (e) => added[type].forEach((f) => f(e)) }
  const shell = node('div')
  feed.parentNode = shell

  const stubs = {}
  const $ = (id) => {
    if (/^m\d+$/.test(id) || id === 'unread' || id === 'earlier') return feed.children.find((c) => c.id === id) || null
    if (!stubs[id]) { stubs[id] = node('div'); stubs[id].addEventListener = () => {} }
    return stubs[id]
  }
  const marks = [], toasts = [], flashes = [], opened = [], fetched = [], arrivedSeqs = []
  // /around answers from around(seq): {status, body}; a throw is a network error.
  const fetch = (url) => {
    const before = /history\?before=(\d+)/.exec(url)
    if (before) {
      fetched.push(`before ${before[1]}`)
      return Promise.resolve().then(() => history(Number(before[1]))).then(({ body }) => ({ ok: true, json: () => Promise.resolve(body) }))
    }
    const seq = Number(/around\?seq=(\d+)/.exec(url)[1])
    fetched.push(seq)
    return Promise.resolve().then(() => around(seq)).then(({ status = 200, body }) => ({ ok: status < 400, json: () => Promise.resolve(body) }))
  }
  const location = { search: '', href: '' }
  // With cards, timers wait until the test runs them: the card's 8 s wait for scorpio:ready is one.
  const queue = new Map()
  let nextTimer = 1
  const timers = { run() { const due = [...queue.values()]; queue.clear(); due.forEach((fn) => fn()) }, size: () => queue.size }
  const on = { window: {}, document: {} }
  const listen = (where) => (type, fn) => { (on[where][type] = on[where][type] || []).push(fn) }
  const emit = (where, type, e) => (on[where][type] || []).forEach((fn) => fn(e))
  /** A fake observer: what it watches, and fire(target, intersecting) to call it back as the browser would. */
  const observer = (kind) => class {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.watched = new Set(); observers[kind] = this }
    observe(el) { this.watched.add(el) }
    unobserve(el) { this.watched.delete(el) }
    fire(target, isIntersecting = true) { this.cb([{ target, isIntersecting, contentRect: { width: 300 } }]) }
  }
  const observers = {}
  const box = {
    fetch, location, URLSearchParams, URL,
    document: { createElement: node, createDocumentFragment, body: node('body'), visibilityState: 'visible', addEventListener: listen('document'),
      documentElement: { dataset: { scorpioEffectiveTheme: 'light' } }, get activeElement() { return focused } },
    matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800,
    setTimeout: cards ? (fn) => { const id = nextTimer++; queue.set(id, fn); return id } : (fn) => { fn(); return 0 },
    clearTimeout: cards ? (id) => { queue.delete(id) } : () => {},
    addEventListener: listen('window'), queueMicrotask, requestAnimationFrame: (fn) => { fn(); return 0 }, cancelAnimationFrame() {},
    getComputedStyle: () => ({ columnGap: '10px' }),
    IntersectionObserver: observer('near'), ResizeObserver: observer('widths'),
    // bots.js's marks for an agent's or a daemon's row: only that one is there.
    botStill: () => '<span class="bot"></span>', daemonSvg: () => '<span class="dmn"></span>',
  }
  box.window = box
  vm.createContext(box)
  for (const name of ['md.js', 'room-feed.js']) vm.runInContext(fs.readFileSync(staticFile(name), 'utf8'), box, { filename: name })
  const outEl = node('div')
  const roomFeed = box.createRoomFeed({
    $, S, state, boot: { lang: 'zh', me: 'kai', roomId: 'r1', S }, feed, outEl, outbox: [], viewer,
    // The @me filter: its own pages are not modelled, only that it takes rows for me from memory first (room-mention-feed.js).
    mentionFilter: () => ({ active: () => filtered, hasMore: () => false, loading: () => false, reset() {}, sync() {}, off() { filtered = false }, loadEarlier: () => Promise.resolve(roomFeed.growUp()) }),
    fill: (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => o[k]),
    ownerOf: (n) => n.slice(n.lastIndexOf('@') + 1), shownName: (n) => n, canWrite: () => true, copy() {}, setReply() {},
    toast: (t) => { toasts.push(t); $('toast').classList.remove('hidden') }, flash: (t) => flashes.push(t),
    arrived: (m) => arrivedSeqs.push(m.seq), placeOutbox() {}, placeInvite() {}, updateChips() {}, openPanel: (k) => opened.push(k), panels: { kind: () => null },
    post: (what, body) => { marks.push(body.upTo); return Promise.resolve({ cursor: body.upTo }) },
    writeFeed: {
      cursor: (v) => { state.cursor = v }, mentionUnread: (v) => { state.mentionUnread = v },
      messages: (v) => { state.messages = v }, bySeq: (v) => { state.bySeq = v },
    },
  })
  roomFeed.listen()
  let tasks = null
  if (withTasks) {
    vm.runInContext(fs.readFileSync(staticFile('room-tasks.js'), 'utf8'), box, { filename: 'room-tasks.js' })
    tasks = box.createRoomTasks({
      $, S, boot: { lang: 'zh', me: 'kai', roomId: 'r1' }, feed, shell: {}, state, viewer,
      fill: (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => o[k]), updateChips() {}, refreshPanel() {},
      rowHook: roomFeed.rowHook, menuHook: roomFeed.menuHook, writeTodo: (v) => { state.todo = v },
      panels: { tab() {}, refresh() {}, kind() {}, sideView() {}, sideOpen() {}, isOpen() {}, renderSide() {} },
    })
  }
  let ai = null
  const posts = [], overlays = [], notes = []
  if (cards) {
    box.scorpioRoomOverlays = { register: (id, isOpen, close, el) => overlays.push({ id, isOpen, close, el }) }
    vm.runInContext(fs.readFileSync(staticFile('room-ai-cards.js'), 'utf8'), box, { filename: 'room-ai-cards.js' })
    box.createRoomAiCards({
      S, boot: { card: cards.frame === undefined ? { sandbox: 'allow-scripts allow-same-origin', csp: 'default-src x' } : cards.frame }, state, feed,
      fill: (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => o[k]), avatar: roomFeed.avatar, rowName: roomFeed.rowName, fmtTime: roomFeed.fmtTime,
      canWrite: () => cards.canWrite !== false, append: roomFeed.append, flash: (t) => flashes.push(t), refusal: (e) => `refused ${e && e.error}`,
      post: (what, body) => { posts.push({ what, body }); return Promise.resolve().then(() => (cards.respond || (() => ({})))(what, body)) },
      deliveryNotes: (list, seq) => { notes.push({ list, seq }) }, rowHook: roomFeed.rowHook,
    })
    ai = { posts, overlays, notes, observers, timers, shell, emit, focused: () => focused }
  }
  return {
    roomFeed, tasks, writes, state, feed, marks, $, toasts, flashes, opened, fetched, location, box, arrivedSeqs, ai, observers,
    filtered: () => filtered,
    filter(on) { filtered = on; roomFeed.updateJump(); roomFeed.maybeMark() },
    row: (seq) => $('m' + seq),
    rows: () => feed.children.filter(isRow).map((c) => Number(c.dataset.seq)),
    hello(list, me = { cursor: state.cursor, mentionUnread: state.mentionUnread }) { roomFeed.helloMe(me); roomFeed.helloMessages(list) },
    /** 展开全文 on a row, as the click reaches the feed. */
    unfold(seq) {
      const row = $('m' + seq), body = { classList: { remove: (c) => { row.html = row.html.replace(` ${c}`, '') } } }
      const button = { closest: () => row, previousElementSibling: body, remove: () => { row.html = row.html.replace(/<button[^>]*data-unfold[^>]*>[^<]*<\/button>/, '') } }
      listeners.click({ target: { closest: (s) => (s === '[data-unfold]' ? button : null) } })
    },
    jumpText: () => $('jump').textContent,
    click: (target) => listeners.click({ target }),
    /** The reader scrolls the feed to top, as the browser reports it. */
    scroll(top) { feed.scrollTop = top; listeners.scroll() },
  }
}
