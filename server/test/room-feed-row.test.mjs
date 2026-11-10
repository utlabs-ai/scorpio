// The message row's HTML for every kind of message: recorded on the code before the feed moved into room-feed.js,
// so the move and its row hooks are held to the same bytes. Only load() may change; the cases and the golden stay, but
// for the time every row now carries (shown or hidden by the feed, not by the row's HTML).
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

// fmtTime and the schedule lines format in the local zone; every timestamp is in the past, so no row reads as today.
process.env.TZ = 'Asia/Shanghai'

const staticFile = (name) => new URL(`../../web/public/static/${name}`, import.meta.url)
const roomSource = fs.readFileSync(staticFile('room.js'), 'utf8')
const golden = new URL('./room-feed-row.golden.json', import.meta.url)

/** A top-level function or var of room.js, as written there. */
function piece(source, name) {
  const one = new RegExp(`^  (function ${name}\\(.*\\}|var ${name} = .*;)(?: *\\/\\/.*)?$`, 'm').exec(source)
  if (one) return one[1]
  const block = new RegExp(`\\n  (function ${name}\\([\\s\\S]*?\\n  \\})\\n`).exec(source)
  assert.ok(block, `room.js has no ${name}`)
  return block[1]
}

/** The elements renderMessage makes, and the .rc span readLine writes into. */
function element(tag) {
  return {
    tagName: tag.toUpperCase(), dataset: {}, id: '', className: '', innerHTML: '', textContent: '', rc: null,
    querySelector(selector) {
      assert.equal(selector, '.rc')
      return this.rc || (this.rc = { className: '', innerHTML: '' })
    },
  }
}
const quiet = () => ({ addEventListener() {} })

function sandbox() {
  const box = {
    document: { createElement: element, body: null, addEventListener() {} },
    navigator: { standalone: false },
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} },
    localStorage: { getItem() { return null }, setItem() {} },
    sessionStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
  }
  box.window = box
  vm.createContext(box)
  for (const name of ['md.js', 'bots.js', 'daemon.js', 'room-feed.js', 'room-schedules.js', 'room-tasks.js', 'room-composer.js', 'room-members.js']) {
    vm.runInContext(fs.readFileSync(staticFile(name), 'utf8'), box, { filename: name })
  }
  return box
}

const fromRoom = [
  'fill', 'RECEIPT',
  'STANDALONE', 'PAGE_TARGET', 'GO_PAGE', 'GO_DOWN', 'pageOf', 'fileLinkAttrs', 'picAttrs', 'isPic', 'isVideo', 'sizeText', 'extOf', 'fileChips',
  'ago',
]
// room.js registers the files hook and has the composer register its delivery hooks right after it creates the feed.
const roomHooks = /\n(  roomFeed\.rowHook\('chips'.*\n  composer\.hookFeed\(.*)\n/.exec(roomSource)[1]

/** render(m) on the code under test, with boot, state and the composer's notes as given. */
function load({ boot, state, notes }) {
  const box = sandbox()
  let drawn = null
  // filesChanged draws a row again in place of its card: that is renderMessage, reached through the feed's API.
  const $ = () => ({ addEventListener() {}, replaceWith(el) { drawn = el } })
  Object.assign(box, { boot, state, S: boot.S, $ })
  vm.runInContext(fromRoom.map((name) => piece(roomSource, name)).join('\n'), box)
  // The composer reads its delivery notes from this tab's session storage when it is created.
  box.sessionStorage.getItem = (key) => (key === 'scorpio.notes.' + boot.roomId ? JSON.stringify(notes) : null)
  const panels = { tab() {}, refresh() {}, kind() {}, isOpen() {}, sideOpen() {}, sideView() {} }
  // Names come from the members: the rows read them through its ownerOf and shownName.
  const members = box.createRoomMembers({ S: boot.S, boot, state, fill: box.fill, panels })
  box.composer = box.createRoomComposer({ $, S: boot.S, boot, state, fill: box.fill, ownerOf: members.ownerOf, ago: box.ago })
  box.roomFeed = box.createRoomFeed({ $, RECEIPT: box.RECEIPT, S: boot.S, boot, state, fill: box.fill, ownerOf: members.ownerOf, shownName: members.shownName })
  vm.runInContext(roomHooks, box)
  const rowHook = box.roomFeed.rowHook
  box.schedules = box.createRoomSchedules({ $: quiet, S: boot.S, boot, state, fill: box.fill, socket: { on() {} }, panels, rowHook })
  box.tasks = box.createRoomTasks({ S: boot.S, boot, state, fill: box.fill, panels, rowHook, menuHook: box.roomFeed.menuHook })
  return (m) => {
    drawn = null
    box.roomFeed.filesChanged(m.seq, m.files)
    return drawn
  }
}

// ---------- the cases ----------

const T0 = Date.UTC(2026, 0, 5, 1, 0)
const minute = 60000
const S = ROOM_STRINGS.zh
const members = [
  { name: 'kai', kind: 'human', owner: 'kai', status: 'active', displayName: 'Kai', cursor: 40 },
  { name: 'lee', kind: 'human', owner: 'lee', status: 'active', displayName: '小李', cursor: 9 },
  { name: 'api@kai', kind: 'agent', owner: 'kai', status: 'active', cursor: 40 },
  { name: 'helper@lee', kind: 'agent', owner: 'lee', status: 'active', cursor: 2 },
  { name: 'daemon@kai', kind: 'host', owner: 'kai', status: 'active', cursor: 40 },
]
const items = [
  { id: 'T1', title: 'Review the page split', assignee: 'kai', status: 'todo', createdSeq: 14, doneSeq: null },
  { id: 'T2', title: 'Write the golden', assignee: 'api@kai', status: 'doing', createdSeq: 14, doneSeq: null },
  { id: 'T3', title: 'Ship W2', assignee: 'lee', status: 'done', createdSeq: 3, doneSeq: 15 },
  { id: 'T4', title: 'Footer order', assignee: 'helper@lee', status: 'todo', createdSeq: 26, doneSeq: null, blocked: true },
]
const file = (id, name, type, size, extra) => ({ id, name, type, size, url: `/f/${id}`, ...extra })
const longText = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long message that folds.`).join('\n')

const cases = [
  ['system join', { fromKind: 'system', from: 'system', text: 'lee joined', event: { type: 'join', name: 'lee' } }],
  ['system leave', { fromKind: 'system', from: 'system', text: 'helper@lee left', event: { type: 'leave', name: 'helper@lee' } }],
  ['system renamed', { fromKind: 'system', from: 'system', text: 'renamed', event: { type: 'renamed', from: 'old@kai', to: 'api@kai' } }],
  ['system topic_renamed', { fromKind: 'system', from: 'system', text: 'renamed', event: { type: 'topic_renamed', by: 'kai', from: 'Old name', to: 'New name' } }],
  ['system evicted', { fromKind: 'system', from: 'system', text: 'evicted', event: { type: 'evicted', name: 'lee', files: ['a.png', 'b.png', 'c.md', 'd.zip', 'e.txt', 'f.pdf'].map((name) => ({ name })) } }],
  ['system schedule_created once', { fromKind: 'system', from: 'system', text: 'created', event: { type: 'schedule_created', who: 'kai', id: 'S1', rule: { kind: 'once', at: T0 + 86400000 }, to: ['api@kai', 'lee'] } }],
  ['system schedule_created daily', { fromKind: 'system', from: 'system', text: 'created', event: { type: 'schedule_created', who: 'api@kai', id: 'S2', rule: { kind: 'daily', time: '10:00', tz: 'Asia/Shanghai' }, to: [], first: T0 + 2 * 86400000 } }],
  ['system schedule_deleted', { fromKind: 'system', from: 'system', text: 'deleted', event: { type: 'schedule_deleted', who: 'lee', id: 'S3', rule: { kind: 'every', minutes: 120 }, to: ['helper@lee'] } }],
  ['system other', { fromKind: 'system', from: 'system', text: 'Plain system text', event: { type: 'archived' } }],
  ['mine, one reader', { from: 'kai', fromKind: 'human', text: '@lee 看一下 W3a', mentions: ['lee'] }],
  ['mine, same minute, read', { from: 'kai', fromKind: 'human', text: '@api@kai go', mentions: ['api@kai'], gap: 0.5 }],
  ['mine, broadcast', { from: 'kai', fromKind: 'human', text: 'Everyone: release at five.', broadcast: true }],
  ['my agent, to me', { from: 'api@kai', fromKind: 'agent', text: '@kai **done**, see `room-feed.js`', mentions: ['kai'] }],
  ['their agent, to my agent', { from: 'helper@lee', fromKind: 'agent', text: '@api@kai can you check?', mentions: ['api@kai'] }],
  ['task source', { from: 'lee', fromKind: 'human', text: '@kai @api@kai two tasks', mentions: ['kai', 'api@kai'] }],
  ['task result', { from: 'lee', fromKind: 'human', displayName: '小李', text: '@kai shipped', mentions: ['kai'] }],
  ['scheduled', { from: 'scheduled', fromKind: 'scheduled', text: '@api@kai check CI', mentions: ['api@kai'], scheduled: { id: 'S2', by: 'kai' } }],
  ['delivery later', { from: 'kai', fromKind: 'human', text: '@helper@lee @lee ping', mentions: ['helper@lee', 'lee'], delivery: [{ name: 'helper@lee', status: 'queued' }, { name: 'lee', status: 'online' }] }],
  ['delivery to owner', { from: 'api@kai', fromKind: 'agent', text: '@helper@lee hi', mentions: ['helper@lee'], delivery: [{ name: 'helper@lee', status: 'to_owner' }] }],
  ['delivery gone', { from: 'kai', fromKind: 'human', text: '@old@kai are you there', mentions: ['old@kai'], delivery: [{ name: 'old@kai', status: 'left', takeover: '@daemon@kai /spawn claude old /x' }] }],
  ['delivery sent', { from: 'kai', fromKind: 'human', text: '@old@kai again', mentions: ['old@kai'], delivery: [{ name: 'old@kai', status: 'left', takeover: '@daemon@kai /spawn claude old /x' }] }],
  ['reply to mine', { from: 'lee', fromKind: 'human', text: '@kai ok', mentions: ['kai'], reply: { seq: 9, from: 'kai', text: '@lee  看一下\n W3a' } }],
  ['reply to theirs, pictures only', { from: 'kai', fromKind: 'human', text: '@lee 收到', mentions: ['lee'], reply: { seq: 15, from: 'lee', displayName: '小李', text: '' } }],
  ['long folded', { from: 'lee', fromKind: 'human', text: longText }],
  ['long by characters', { from: 'api@kai', fromKind: 'agent', text: 'x'.repeat(361) }],
  ['pictures, video, files', { from: 'lee', fromKind: 'human', text: 'files', files: [
    file('p1', 'shot.png', 'image/png', 2000), file('p2', 'b.webp', 'image/webp', 3000),
    file('v1', 'demo.mp4', 'video/mp4', 5000000), file('f1', 'notes.md', 'text/markdown', 900, { view: true }),
    file('f2', 'build.tar.gz', 'application/gzip', 3500000), file('f3', 'README', 'text/plain', 20000),
  ] }],
  ['foot order: schedule, todo, notes', { from: 'scheduled', fromKind: 'scheduled', text: '@helper@lee @lee nightly', mentions: ['helper@lee', 'lee'], scheduled: { id: 'S2', by: 'kai' }, delivery: [{ name: 'helper@lee', status: 'queued' }] }],
  ['deleted files', { from: 'kai', fromKind: 'human', text: '', files: [
    file('p3', 'gone.png', 'image/png', 10, { deleted: true }), file('p4', 'kept.gif', 'image/gif', 10),
    file('v2', 'gone.mov', 'video/quicktime', 10, { deleted: true }), file('f4', 'gone.zip', 'application/zip', 10, { deleted: true }),
  ] }],
  ['their agent, at me via my agent', { from: 'helper@lee', fromKind: 'agent', text: '@api@kai @lee status', mentions: ['api@kai', 'lee'], todo: [{ id: 'T9', title: 'Old snapshot', assignee: 'api@kai', status: 'todo', rel: 'source' }, { id: 'T8', rel: 'thread' }] }],
]

function world() {
  let ts = T0
  const messages = cases.map(([, c], i) => {
    const { gap = 3, ...m } = c
    ts += gap * minute
    return { seq: i + 1, ts, mentions: [], ...m }
  })
  const boot = { lang: 'zh', me: 'kai', meDisplayName: 'Kai', roomId: 'r1', S }
  const state = { me: 'kai', members, messages, bySeq: new Map(messages.map((m) => [m.seq, m])), todo: { items, done: null } }
  const notes = [[20, [{ phase: 'gone', t: 'old@kai has left', name: 'old@kai', bot: 'gone', cmd: '@daemon@kai /spawn claude old /x', sent: 31 }]]]
  return { boot, state, notes, messages }
}

function record(el) {
  const out = { tagName: el.tagName, id: el.id, seq: el.dataset.seq, className: el.className }
  if (el.textContent) out.textContent = el.textContent
  if (el.innerHTML) out.innerHTML = el.innerHTML
  if (el.rc) out.rc = { className: el.rc.className, innerHTML: el.rc.innerHTML }
  return out
}

test('every kind of message row renders the recorded HTML', () => {
  const w = world()
  const render = load(w)
  const actual = w.messages.map((m, i) => ({ case: cases[i][0], ...record(render(m)) }))
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n')
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(golden, 'utf8')))
})

test('a computer logged out: the line is in the page language, not the stored English', () => {
  const m = { seq: 1, ts: T0, mentions: [], fromKind: 'system', from: 'system', text: 'mbp is logged out: its agents receive no messages', event: { type: 'logged_out', name: 'mbp-daemon@kai', device: 'mbp' } }
  for (const [lang, text] of [['zh', 'mbp 掉线了，它的 agent 收不到消息'], ['en', 'mbp is logged out: its agents receive no messages']]) {
    const w = world()
    w.boot = { ...w.boot, lang, S: ROOM_STRINGS[lang] }
    const el = load({ ...w, state: { ...w.state, messages: [m], bySeq: new Map([[1, m]]) } })(m)
    assert.deepEqual([el.className, el.textContent], ['msg system sys', text])
  }
})

test('pane screens render as escaped code, with the hint only when strings were hidden', () => {
  const text = '<script>alert("pane")</script>\n```\n**plain** & @kai'
  for (const lang of ['zh', 'en']) for (const hidden of [0, 1]) {
    const w = world()
    w.boot = { ...w.boot, lang, S: ROOM_STRINGS[lang] }
    const m = { seq: 999, ts: T0, from: 'box-daemon@kai', fromKind: 'host', text: '@kai screen report', mentions: ['kai'], screen: { text, hidden } }
    const render = load({ ...w, state: { ...w.state, messages: [m], bySeq: new Map([[m.seq, m]]) } })
    const html = render(m).innerHTML
    assert.ok(html.includes('<pre class="code"><code>&lt;script&gt;alert(&quot;pane&quot;)&lt;/script&gt;\n```\n**plain** &amp; @kai</code></pre>'))
    assert.doesNotMatch(html, /<script>|<strong>plain<\/strong>/)
    assert.equal(html.includes(ROOM_STRINGS[lang].screenHidden.replace(/&/g, '&amp;').replace(/'/g, '&#39;')), hidden > 0)
    const plain = { ...m, screen: undefined }
    const ordinary = load({ ...w, state: { ...w.state, messages: [plain], bySeq: new Map([[plain.seq, plain]]) } })(plain).innerHTML
    assert.ok(!ordinary.includes('pane-screen'))
  }
})
