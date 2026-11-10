// Select mode on a phone: "Select text" in the message menu puts the selection bar under the row's header, turns ⋯
// into Done and selects the text; leaving it restores the row. The row is the one renderMessage draws today, so a
// selector the row no longer has (the old .meta) fails here as it does in the browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

const staticFile = (name) => new URL(`../../web/public/static/${name}`, import.meta.url)
const S = ROOM_STRINGS.zh

/** Its classes as a list, from a class attribute or className. */
const classesOf = (value) => String(value || '').split(/\s+/).filter(Boolean)

/**
 * A minimal element. A row answers querySelector('.x') from its own HTML: an element with class x in innerHTML, or a
 * node inserted after one of them. Nothing else of the DOM is modelled.
 */
function element(tag) {
  const el = {
    tagName: tag.toUpperCase(), dataset: {}, id: '', className: '', innerHTML: '', textContent: '', parts: {}, inserted: [],
    classList: {
      add(c) { if (!this.contains(c)) el.className = [...classesOf(el.className), c].join(' ') },
      remove(c) { el.className = classesOf(el.className).filter((x) => x !== c).join(' ') },
      contains(c) { return classesOf(el.className).includes(c) },
    },
    querySelector(selector) {
      const cls = /^\.([\w-]+)$/.exec(selector)?.[1]
      assert.ok(cls, `unexpected selector ${selector}`)
      const added = el.inserted.find((x) => !x.node.removed && x.node.classList.contains(cls))
      if (added) return added.node
      const m = new RegExp(`<(\\w+)[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>([^<]*)`).exec(el.innerHTML)
      if (!m) return null
      if (!el.parts[cls]) {
        const part = element(m[1])
        part.className = /class="([^"]*)"/.exec(m[0])[1]
        part.textContent = m[2]
        part.after = (node) => { el.inserted.push({ after: cls, node }) }
        part.owner = el
        el.parts[cls] = part
      }
      return el.parts[cls]
    },
    contains(node) { return !!node && (node === el || node.owner === el) },
    scrollIntoView() {},
    remove() { el.removed = true },
  }
  return el
}

function load({ locked }) {
  const selection = { ranges: [], get anchorNode() { return this.ranges[0]?.node || null }, removeAllRanges() { this.ranges = [] }, addRange(r) { this.ranges.push(r) } }
  const box = {
    document: { createElement: element, body: element('body'), addEventListener() {}, createRange: () => ({ selectNodeContents(n) { this.node = n } }) },
    matchMedia: (query) => ({ matches: locked && query === '(hover: none) and (pointer: coarse)' }),
    getSelection: () => selection,
    innerWidth: 390, innerHeight: 844,
  }
  box.window = box
  vm.createContext(box)
  for (const name of ['md.js', 'room-feed.js']) vm.runInContext(fs.readFileSync(staticFile(name), 'utf8'), box, { filename: name })

  const m = { seq: 7, ts: Date.UTC(2026, 0, 5, 1, 0), from: 'lee', fromKind: 'human', text: 'Pick some words from this message', mentions: [] }
  const state = { me: 'kai', members: [], room: { archived: false }, messages: [m], bySeq: new Map([[7, m]]), todo: { items: [] } }
  const els = { msgmenu: element('div'), 'msgmenu-scrim': element('div'), linkmenu: element('div') }
  const listeners = new Map()
  const on = (target) => { target.addEventListener = (type, fn) => listeners.set(target, { ...listeners.get(target), [type]: fn }); return target }
  for (const el of Object.values(els)) on(el)
  els.msgmenu.style = {}
  els.msgmenu.offsetWidth = 220
  els.msgmenu.offsetHeight = 160
  els['msgmenu-scrim'].style = {}
  // The feed draws the row in place of its card (filesChanged → renderMessage), then finds it as #m7.
  els.m7 = { replaceWith(row) { els.m7 = row } }
  const $ = (id) => els[id] || on({ style: {} })
  const feed = on({})
  const roomFeed = box.createRoomFeed({
    $, S, state, boot: { lang: 'zh', me: 'kai', S }, feed, viewer: false,
    fill: (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => o[k]),
    ownerOf: (n) => n, shownName: (n) => n, canWrite: () => true, copy() {}, setReply() {}, toast() {},
  })
  roomFeed.listen()
  roomFeed.filesChanged(7, undefined)
  return {
    roomFeed, selection, row: () => els.m7,
    /** "Select text" as a phone reaches it: ⋯ opens the menu, then a tap on the item. */
    selectText() {
      const dots = { dataset: { menu: '7' }, getBoundingClientRect: () => ({ top: 100, bottom: 120, right: 380 }) }
      listeners.get(feed).click({ target: { closest: (s) => (s === '[data-menu]' ? dots : null) } })
      const item = { dataset: { act: 'select' } }
      listeners.get(els.msgmenu).click({ target: { closest: (s) => (s === '[data-act]' ? item : null) } })
    },
  }
}

test('Select text puts the bar under the header, turns ⋯ into Done and selects the text; leaving restores the row', () => {
  const page = load({ locked: true })
  page.selectText()
  const row = page.row()
  assert.equal(page.roomFeed.selecting(), true)
  assert.ok(row.classList.contains('selecting'))
  const bar = row.inserted.find((x) => x.node.className === 'selbar')
  assert.ok(bar, 'a selection bar is in the row')
  assert.equal(bar.after, 'fm-top', 'the bar goes right under the header')
  assert.match(bar.node.innerHTML, /data-sel="copy".*data-sel="all".*data-sel="reply"/)
  const dots = row.querySelector('.dots')
  assert.equal(dots.textContent, S.selDone)
  assert.ok(dots.classList.contains('done'))
  assert.equal(page.selection.anchorNode, row.querySelector('.body'), 'the text is selected')

  page.roomFeed.exitSelect()
  assert.equal(page.roomFeed.selecting(), false)
  assert.ok(!row.classList.contains('selecting'))
  assert.equal(row.querySelector('.selbar'), null)
  assert.equal(dots.textContent, '⋯')
  assert.ok(!dots.classList.contains('done'))
  assert.equal(page.selection.ranges.length, 0)
})
