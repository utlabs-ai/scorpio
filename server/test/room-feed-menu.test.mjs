// The message menu's HTML: recorded on the code before the menu moved into room-feed.js and became hooks, so
// the old cases retain their bytes except the new writable memo entry after the task action, and the full time on top.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

// The full time atop the menu is in the local zone: fixed so the golden reads the same everywhere.
process.env.TZ = 'Asia/Shanghai'

const staticFile = (name) => new URL(`../../web/public/static/${name}`, import.meta.url)
const roomSource = fs.readFileSync(staticFile('room.js'), 'utf8')
const golden = new URL('./room-feed-menu.golden.json', import.meta.url)

/** A top-level function or var of room.js, as written there. */
function piece(source, name) {
  const one = new RegExp(`^  (function ${name}\\(.*\\}|var ${name} = .*;)(?: *\\/\\/.*)?$`, 'm').exec(source)
  if (one) return one[1]
  const block = new RegExp(`\\n  (function ${name}\\([\\s\\S]*?\\n  \\}|var ${name} = \\{[\\s\\S]*?\\n  \\};)\\n`).exec(source)
  assert.ok(block, `room.js has no ${name}`)
  return block[1]
}

const classList = () => ({ add() {}, remove() {}, contains() { return false } })
const quiet = () => ({ addEventListener() {} })
/** The menu, its scrim and the cards, as openMenu reads and writes them; the feed's other targets take listeners. */
function elements() {
  const els = {
    msgmenu: { innerHTML: '', style: {}, classList: classList(), offsetWidth: 220, offsetHeight: 160, addEventListener() {} },
    'msgmenu-scrim': { classList: classList(), addEventListener() {} },
  }
  const card = { classList: classList(), querySelector() { return { getBoundingClientRect: () => ({ top: 0, bottom: 20 }) } } }
  return (id) => els[id] || (/^m\d+$/.test(id) ? card : quiet())
}

function sandbox(locked) {
  const box = {
    // The composer makes its outbox element when it is created.
    document: { body: { classList: classList() }, addEventListener() {}, createElement: () => ({}) },
    // A phone (no hover, coarse pointer) locks card text, which is when the menu offers "Select text".
    matchMedia: (query) => ({ matches: locked && query === '(hover: none) and (pointer: coarse)' }),
    innerWidth: 1280,
    innerHeight: 800,
  }
  box.window = box
  vm.createContext(box)
  for (const name of ['md.js', 'room-feed.js', 'room-tasks.js', 'room-composer.js', 'room-memo.js']) vm.runInContext(fs.readFileSync(staticFile(name), 'utf8'), box, { filename: name })
  return box
}

const fromRoom = ['fill', 'canWrite']
// room.js has the composer register its row and compose hooks right after it creates the feed.
const roomHooks = /\n  (composer\.hookFeed\(.*)\n/.exec(roomSource)[1]

/** open(seq) on the code under test: the menu's HTML for that message, opened by its ⋯ button. */
function load({ boot, state, viewer, locked }) {
  const box = sandbox(locked)
  const $ = elements()
  const panels = { tab() {}, refresh() {}, kind() {}, isOpen() {}, sideOpen() {}, sideView() {} }
  Object.assign(box, { boot, state, viewer, S: boot.S, $ })
  vm.runInContext(fromRoom.map((name) => piece(roomSource, name)).join('\n'), box)
  const listeners = {}
  const feed = { addEventListener(type, fn) { listeners[type] = fn } }
  box.composer = box.createRoomComposer({ $, S: boot.S, boot, state, fill: box.fill, canWrite: box.canWrite })
  box.roomFeed = box.createRoomFeed({ $, S: boot.S, boot, state, feed, fill: box.fill, canWrite: box.canWrite })
  vm.runInContext(roomHooks, box)
  box.tasks = box.createRoomTasks({ S: boot.S, boot, state, fill: box.fill, panels, canWrite: box.canWrite, rowHook() {}, menuHook: box.roomFeed.menuHook })
  box.memo = box.createRoomMemo({ $, S: boot.S, boot, state, viewer, canWrite: box.canWrite, fill: box.fill, panels, rowHook() {}, menuHook: box.roomFeed.menuHook })
  box.roomFeed.listen()
  return (seq) => {
    const dots = { dataset: { menu: String(seq) }, getBoundingClientRect: () => ({ top: 100, bottom: 120, right: 600 }) }
    listeners.click({ target: { closest: (selector) => (selector === '[data-menu]' ? dots : null) } })
    return $('msgmenu').innerHTML
  }
}

// ---------- the cases ----------

const S = ROOM_STRINGS.zh
const messages = [
  { seq: 1, from: 'kai', label: 'mine, no tasks' },
  { seq: 2, from: 'kai', label: 'mine, one task' },
  { seq: 3, from: 'kai', label: 'mine, two tasks' },
  { seq: 4, from: 'api@kai', label: 'theirs, no tasks' },
  { seq: 5, from: 'api@kai', label: 'theirs, one task' },
  { seq: 6, from: 'api@kai', label: 'theirs, two tasks' },
].map(({ label, ...m }) => ({ label, m: { ts: 0, fromKind: m.from === 'kai' ? 'human' : 'agent', text: 'hello', mentions: [], ...m } }))
// The "two tasks" messages carry T2 twice (it was made and delivered there) and T3: the menu names each once.
const items = [
  { id: 'T1', title: 'one', assignee: 'kai', status: 'todo', createdSeq: 2, doneSeq: null },
  { id: 'T4', title: 'one', assignee: 'kai', status: 'todo', createdSeq: 5, doneSeq: null },
  { id: 'T2', title: 'twice', assignee: 'kai', status: 'done', createdSeq: 3, doneSeq: 3 },
  { id: 'T3', title: 'other', assignee: 'kai', status: 'todo', createdSeq: 3, doneSeq: null },
  { id: 'T5', title: 'twice', assignee: 'kai', status: 'done', createdSeq: 6, doneSeq: 6 },
  { id: 'T6', title: 'other', assignee: 'kai', status: 'todo', createdSeq: 6, doneSeq: null },
]
const access = [
  ['can write', { archived: false, viewer: false }],
  ['archived', { archived: true, viewer: false }],
  ['viewer', { archived: false, viewer: true }],
]
const pointers = [['mouse', false], ['phone', true]]

function world({ archived }) {
  const list = messages.map((x) => x.m)
  const boot = { lang: 'zh', me: 'kai', roomId: 'r1', S }
  const state = { me: 'kai', room: { archived }, members: [], messages: list, bySeq: new Map(list.map((m) => [m.seq, m])), todo: { items, done: null } }
  return { boot, state }
}

test('the message menu renders the recorded HTML for every reader and message', () => {
  const actual = []
  for (const [who, a] of access) {
    for (const [pointer, locked] of pointers) {
      const open = load({ ...world(a), viewer: a.viewer, locked })
      for (const { label, m } of messages) actual.push({ case: `${label} · ${who} · ${pointer}`, html: open(m.seq) })
    }
  }
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n')
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(golden, 'utf8')))
})

test('the full time atop the menu follows the page language, with the year only when it is not this year', () => {
  const year = new Date().getFullYear()
  const at = (y) => new Date(y, 10, 2, 11, 4).getTime() // 2 Nov, 11:04 local
  const top = (lang, y) => {
    const m = { seq: 1, from: 'kai', fromKind: 'human', text: 'hello', mentions: [], ts: at(y) }
    const boot = { lang, me: 'kai', roomId: 'r1', S: ROOM_STRINGS[lang] }
    const state = { me: 'kai', room: { archived: false }, members: [], messages: [m], bySeq: new Map([[1, m]]), todo: { items: [], done: null } }
    return /^<div class="mtime">([^<]*)<\/div><button type="button" role="menuitem"/.exec(load({ boot, state, viewer: false, locked: false })(1))[1]
  }
  const weekday = (y, lang) => new Date(at(y)).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en', { weekday: 'short' })
  assert.equal(top('zh', year), `11月2日 ${weekday(year, 'zh')} 11:04`)
  assert.equal(top('zh', 2025), '2025年11月2日 周日 11:04')
  assert.equal(top('en', 2025), 'Sun, Nov 2, 2025, 11:04 AM')
  assert.equal(top('en', year), `${weekday(year, 'en')}, Nov 2, 11:04 AM`)
})
