// The topic's own settings: the settings sheet, the invite panel and card, the read-only bar and quota note, the
// room menu, and the description on top of the members and in its popup. Recorded on the code before the settings code
// moved into room-settings.js, so the move is held to the same bytes. Only load() may change; the cases and the golden stay.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

// clock formats in the local zone.
process.env.TZ = 'Asia/Shanghai'

const staticFile = (name) => new URL(`../../web/public/static/${name}`, import.meta.url)
const roomSource = fs.readFileSync(staticFile('room.js'), 'utf8')
const settingsSource = fs.readFileSync(staticFile('room-settings.js'), 'utf8')
const golden = new URL('./room-settings.golden.json', import.meta.url)

/** A function or var at the given indent (room.js's top level is two spaces, a factory's body four), as written there. */
function piece(source, name, indent = '  ') {
  const one = new RegExp(`^${indent}(function ${name}\\(.*\\}|var ${name} = .*;)(?: *\\/\\/.*)?$`, 'm').exec(source)
  if (one) return one[1]
  const block = new RegExp(`\\n${indent}(function ${name}\\([\\s\\S]*?\\n${indent}\\})\\n`).exec(source)
  assert.ok(block, `no ${name}`)
  return block[1]
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

function classList(start) {
  const set = new Set(start)
  return {
    add(...cs) { cs.forEach((c) => set.add(c)) }, remove(...cs) { cs.forEach((c) => set.delete(c)) }, contains(c) { return set.has(c) },
    toggle(c, on) { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c) },
  }
}
const el = (id, start) => ({
  id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, disabled: false, scrollHeight: 120, scrollTop: 0, focused: false,
  classList: classList(start), focus() { this.focused = true }, setAttribute(k, v) { this[`@${k}`] = v },
})

/**
 * The page's fixed elements, and inside #panel and #item-panel the ones their HTML has: an element exists while its
 * container's HTML has its id, and is a new one each time that HTML changes. A textarea starts with the text its HTML has.
 */
function page() {
  const fixed = {}
  for (const [id, start] of [['panel', ['hidden']], ['panel-scrim', ['hidden']], ['item-panel', ['hidden']], ['item-scrim', ['hidden']],
    ['room-name'], ['room-topic'], ['room-pub', ['hidden']], ['readonly', ['hidden']], ['composer'], ['quotanote', ['hidden']],
    ['room-menu', ['hidden']], ['room-menu-scrim', ['hidden']], ['btn-more']]) fixed[id] = el(id, start)
  const inner = { panel: { html: null, els: {} }, 'item-panel': { html: null, els: {} } }
  const $ = (id) => {
    if (fixed[id]) return fixed[id]
    for (const box of Object.keys(inner)) {
      const html = fixed[box].innerHTML, seen = inner[box]
      if (html !== seen.html) { seen.html = html; seen.els = {} }
      if (!html.includes(`id="${id}"`)) continue
      if (!seen.els[id]) {
        seen.els[id] = el(id, [])
        const text = new RegExp(`<textarea id="${id}"[^>]*>([\\s\\S]*?)</textarea>`).exec(html)
        if (text) seen.els[id].value = unescape(text[1])
      }
      return seen.els[id]
    }
    return null
  }
  // The invite panel's copy buttons, as its HTML has them.
  fixed.panel.querySelectorAll = (selector) => {
    assert.equal(selector, '[data-copy]')
    return [...fixed.panel.innerHTML.matchAll(/data-copy="([^"]*)"/g)].map((m) => ({ dataset: { copy: m[1] }, textContent: '', onclick: null }))
  }
  fixed.panel.querySelector = (selector) => fixed.panel.innerHTML.includes(selector.slice(1, -1)) ? { onclick: null } : null
  return $
}

/** document.createElement for the invite card: its buttons exist while its HTML has them. */
function createElement() {
  const node = { className: '', innerHTML: '' }
  const children = {}
  node.querySelector = (selector) => {
    const attr = /^\[([\w-]+)\]$/.exec(selector)[1]
    return node.innerHTML.includes(attr) ? (children[attr] ||= { onclick: null }) : null
  }
  return node
}

// ---------- the loader: the only part that may change ----------

// Room helpers the settings code uses and does not own.
const fromRoom = ['fill', 'clock', 'isOwner', 'canWrite']
// The settings code, at the top of room-settings.js's factory; its module variables and ctx names are the sandbox's globals.
const settingsCode = [
  'plainLines', 'topicHtml', 'showTopic',
  'membersKnown', 'wantsInvite', 'bindInviteSpawn', 'inviteContent', 'inviteCard', 'invitationText', 'showInvite',
  'RETENTION', 'archiveExpiryNote', 'quota', 'quotaTimer', 'quotaNow', 'applyRoom',
  'settingsNote', 'showSettings', 'sizeTopic', 'renameTopic', 'saveSettingsName', 'NAME_MAX',
  'roomMuted', 'renderRoomMenu',
]
// The members' popup engine, which the settings code reaches through roomMembers.
const fromMembers = ['popup', 'editBox', 'sizePop', 'growBox', 'showCount', 'charCount', 'refreshPopup', 'shown', 'TOPIC_MAX']

/** The settings functions on the code under test, over the given boot and state. */
function load({ boot, state }) {
  const calls = []
  const $ = page()
  const box = {
    boot, state, S: boot.S, viewer: false, $, panel: $('panel'), feed: { scrollTop: 0, scrollHeight: 900 },
    panels: { kind: () => $('panel').dataset.kind, sideView: () => 'members', tab() {} },
    location: { origin: 'https://scorpio.example' },
    navigator: {},
    document: { createElement },
    names: () => new Set(state.members.map((m) => m.name)),
    // @me's count, which room-at.js owns; the world keeps it in state.at.
    atCount: () => ({ loaded: state.at.loaded, total: state.at.total }),
    nearBottom: () => false,
    updateChips: () => calls.push('updateChips'),
    ask: () => Promise.resolve(false), post: () => new Promise(() => {}), copy: (text, label) => calls.push({ text, label }), copyText: () => Promise.resolve(),
    toast() {}, flash() {}, closeItem() {}, openPanel() {}, refreshPanel() {}, renderSide() {}, showTopic() {},
  }
  box.ctx = { mySeats: () => state.members.filter((m) => m.kind === 'host' && m.owner === state.me && m.status === 'active').sort((a, b) => a.name.localeCompare(b.name)), startSpawn: (seat) => calls.push({ spawn: seat }) }
  box.window = box
  vm.createContext(box)
  for (const name of ['md.js', 'bots.js', 'daemon.js', 'room-members.js']) vm.runInContext(fs.readFileSync(staticFile(name), 'utf8'), box, { filename: name })
  // The robots and the computer icon by their classes alone: the drawings are not what this records.
  vm.runInContext('BOT_SVG = "<svg class=\\"__CLS__\\"></svg>"; DAEMON_SVG = "<svg class=\\"__CLS__\\"></svg>"; Date.now = function () { return NOW; };', Object.assign(box, { NOW }))
  vm.runInContext(fromRoom.map((name) => piece(roomSource, name)).join('\n'), box)
  // The real members, for the popup engine: created before the settings, as on the page.
  vm.runInContext('var roomMembers = window.createRoomMembers({ $: $, S: S, ago: function () { return ""; }, ask: ask, boot: boot, canWrite: canWrite, clock: clock, closeItem: closeItem, fill: fill, flash: flash, isOwner: isOwner, names: names, openPanel: openPanel, panels: panels, pendingDone: {}, plainLines: function (t) { return plainLines(t); }, post: post, refreshPanel: refreshPanel, renderSide: renderSide, showTopic: function (e) { return showTopic(e); }, state: state, toast: toast, topicHtml: function () { return topicHtml(); } });', box)
  vm.runInContext(fromMembers.map((name) => `var ${name} = roomMembers.${name};`).join('\n'), box)
  vm.runInContext(settingsCode.map((name) => piece(settingsSource, name, '    ')).join('\n'), box)
  return { box, calls }
}

// ---------- the cases ----------

const NOW = Date.UTC(2026, 9, 18, 4, 0)
const hour = 3600000, day = 24 * hour
const S = ROOM_STRINGS.zh
const longTopic = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 条：主题的描述写得太长了。`).join('\n')

function world() {
  const members = [
    { name: 'kai', kind: 'human', owner: 'kai', status: 'active', online: true },
    { name: 'daemon@kai', kind: 'host', owner: 'kai', status: 'active', online: true },
    { name: 'api@kai', kind: 'agent', owner: 'kai', status: 'active', online: true, work: 'idle', host: 'daemon@kai' },
    { name: 'old@kai', kind: 'agent', owner: 'kai', status: 'left', online: false },
  ]
  const others = [
    { name: 'lee', kind: 'human', owner: 'lee', status: 'active', online: false },
    { name: 'daemon@lee', kind: 'host', owner: 'lee', status: 'active', online: true },
    { name: 'helper@lee', kind: 'agent', owner: 'lee', status: 'active', online: true, work: 'idle', host: 'daemon@lee' },
    { name: 'amy', kind: 'human', owner: 'amy', status: 'active', online: true },
    { name: 'bo<b>', kind: 'human', owner: 'bo<b>', status: 'active', online: false },
    { name: 'gone', kind: 'human', owner: 'gone', status: 'left', online: false },
  ]
  const boot = { lang: 'zh', me: 'kai', roomId: 'r1', S, install: 'curl -fsSL https://scorpio.example/install | sh', retention: { archiveAfterDays: 90, binAfterDays: 90 } }
  const state = {
    me: 'kai', members, others, todo: { items: [], done: null },
    at: { list: [], total: 3, unread: 0, hasMore: false, loading: false, error: null, loaded: true },
    room: { id: 'r1', name: 'Scorpio <测试>', topic: '在 Scorpio 里迭代 **Scorpio**。\n- 第二行', owner: 'kai', hasCode: false, code: null, public: false, archived: false, archivedAt: null, archivedReason: null },
  }
  return { boot, state }
}

// Each case changes the world from its start and puts it back.
const roomCase = (room, more = {}) => ({ room, ...more })
const settingsCases = [
  ['owner, private', roomCase({})],
  ['owner, public', roomCase({ public: true })],
  ['archived', roomCase({ archived: true, archivedAt: NOW - 3 * day })],
  ['with a note', roomCase({}, { note: S.removedNote })],
  ['several accounts', roomCase({}, { several: true })],
  ['a description over the limit', roomCase({ topic: longTopic })],
]
const inviteCases = [
  ['owner, private, with a code', roomCase({ hasCode: true, code: 'K7Q2-P9' })],
  ['owner, private, without a code', roomCase({})],
  ['public', roomCase({ public: true })],
  ['not the owner', roomCase({ hasCode: true, code: 'K7Q2-P9' }, { me: 'lee' })],
]
const cardCases = [
  ['with a code and share support', roomCase({ hasCode: true, code: 'K7Q2-P9' }, { share: true })],
  ['without a code', roomCase({})],
]
const quotaOut = { plan: 'free', used: 200, limit: 200, resetsAt: NOW + 5 * hour }
const quotaNear = { plan: 'free', used: 170, limit: 200, resetsAt: NOW + 5 * hour }
const barCases = [
  ['active, no quota', roomCase({})],
  ['archived by its owner, for the owner', roomCase({ archived: true, archivedAt: NOW - 10 * day })],
  ['archived for retention, for the owner', roomCase({ archived: true, archivedAt: NOW - 10 * day, archivedReason: 'retention' })],
  ['archived for retention, for others', roomCase({ archived: true, archivedAt: NOW - 10 * day, archivedReason: 'retention' }, { me: 'lee' })],
  ['quota out, for the owner', roomCase({}, { quota: quotaOut })],
  ['quota out, for others', roomCase({}, { quota: quotaOut, me: 'lee' })],
  ['the 80% note, for the owner', roomCase({}, { quota: quotaNear })],
  ['the 80% note, for others', roomCase({}, { quota: quotaNear, me: 'lee' })],
  ['quota from a day that ended', roomCase({}, { quota: { ...quotaOut, resetsAt: NOW - hour } })],
  ['a viewer of a public topic', roomCase({ public: true }, { viewer: true, me: 'vic' })],
]
const menuCases = [
  ['viewer', roomCase({ public: true }, { viewer: true, me: 'vic' })],
  ['owner, mute unknown, @me not loaded', roomCase({}, { muted: null, atLoaded: false })],
  ['owner, muted', roomCase({}, { muted: true })],
  ['owner, not muted', roomCase({}, { muted: false })],
  ['member', roomCase({}, { muted: false, me: 'lee' })],
  ['archived, owner', roomCase({ archived: true, archivedAt: NOW - day }, { muted: false })],
  ['archived, member', roomCase({ archived: true, archivedAt: NOW - day }, { muted: false, me: 'lee' })],
]
const topicCases = [
  ['owner, with a description', roomCase({})],
  ['owner, no description', roomCase({ topic: '' })],
  ['member, with a description', roomCase({}, { me: 'lee' })],
  ['member, no description', roomCase({ topic: '  ' }, { me: 'lee' })],
  ['archived, owner, no description', roomCase({ topic: null, archived: true })],
  ['viewer, no description', roomCase({ topic: '' }, { viewer: true, me: 'vic' })],
]
const popupCases = [
  ['owner, reading', roomCase({}), false],
  ['owner, no description', roomCase({ topic: '' }), false],
  ['member, reading', roomCase({}, { me: 'lee' }), false],
  ['member, no description', roomCase({ topic: '' }, { me: 'lee' }), false],
  ['owner, editing', roomCase({}), true],
  ['owner, editing, over the limit', roomCase({ topic: longTopic }), true],
  ['member asks to edit', roomCase({}, { me: 'lee' }), true],
  ['archived, owner asks to edit', roomCase({ archived: true }), true],
]

function record() {
  const w = world()
  const { box, calls } = load(w)
  const start = { room: { ...w.state.room }, members: w.state.members }
  /** Run one case on the world as it says, then put the world back. */
  const inCase = (c, fn) => {
    Object.assign(w.state.room, start.room, c.room)
    w.state.me = c.me || 'kai'
    w.state.members = c.several ? start.members.concat(w.state.others) : start.members
    box.quota = c.quota || null
    w.state.at.loaded = c.atLoaded !== false
    box.viewer = !!c.viewer
    box.roomMuted = c.muted === undefined ? null : c.muted
    box.navigator = c.share ? { share() {} } : {}
    box.settingsNote = null
    box.roomMembers.clearPop()
    const p = box.$('panel'), pop = box.$('item-panel')
    p.innerHTML = ''; p.dataset = {}; p.classList.add('hidden'); box.$('panel-scrim').classList.add('hidden')
    pop.innerHTML = ''; pop.dataset = {}; pop.classList.add('hidden'); box.$('item-scrim').classList.add('hidden')
    calls.length = 0
    try { return fn() } finally { w.state.me = 'kai'; box.viewer = false }
  }
  const hidden = (id) => box.$(id).classList.contains('hidden')
  const out = {}

  out.showSettings = settingsCases.map(([label, c]) => inCase(c, () => {
    if (c.note) box.showSettings(c.note); else box.showSettings(null)
    const p = box.$('panel'), n = box.$('topic-n'), save = box.$('topic-save'), ta = box.$('set-topic')
    return {
      case: label, kind: p.dataset.kind, shown: !hidden('panel') && !hidden('panel-scrim'), html: p.innerHTML,
      topic: ta.value, height: ta.style.height, count: { text: n.textContent, over: n.classList.contains('over'), saveDisabled: save.disabled },
    }
  }))

  out.showInvite = inviteCases.map(([label, c]) => inCase(c, () => {
    box.showInvite()
    const p = box.$('panel')
    return {
      case: label, kind: p.dataset.kind, shown: !hidden('panel') && !hidden('panel-scrim'), html: p.innerHTML,
      invitation: box.$('invite-text').textContent, colleague: box.$('colleague-text').textContent,
    }
  }))

  out.inviteCard = cardCases.map(([label, c]) => inCase(c, () => {
    const card = box.inviteCard()
    card.querySelector('[data-invite-copy-agent]').onclick()
    card.querySelector('[data-invite-copy-colleague]').onclick()
    return { case: label, className: card.className, html: card.innerHTML, copied: calls.slice() }
  }))

  out.applyRoom = barCases.map(([label, c]) => inCase(c, () => {
    box.applyRoom()
    return {
      case: label, name: box.$('room-name').textContent, topic: box.$('room-topic').textContent,
      publicTag: { text: box.$('room-pub').textContent, hidden: hidden('room-pub') },
      composerHidden: hidden('composer'),
      readonly: { hidden: hidden('readonly'), html: box.$('readonly').innerHTML },
      quotaNote: { hidden: hidden('quotanote'), text: box.$('quotanote').textContent },
      calls: calls.slice(),
    }
  }))

  out.renderRoomMenu = menuCases.map(([label, c]) => inCase(c, () => {
    box.renderRoomMenu()
    return { case: label, html: box.$('room-menu').innerHTML }
  }))

  out.topicHtml = topicCases.map(([label, c]) => inCase(c, () => ({ case: label, html: box.topicHtml() })))

  out.showTopic = popupCases.map(([label, c, editing]) => inCase(c, () => {
    box.showTopic(editing)
    const pop = box.$('item-panel')
    const row = { case: label, key: pop.dataset.itemId, shown: !hidden('item-panel') && !hidden('item-scrim'), editing: box.roomMembers.popEdit(), html: pop.innerHTML }
    if (box.roomMembers.popEdit()) {
      const n = box.$('pop-n'), save = box.$('pop-save'), ta = box.$('pop-edit')
      row.count = { text: n.textContent, over: n.classList.contains('over'), saveDisabled: save.disabled, focused: ta.focused, height: ta.style.height }
    }
    return row
  }))
  return out
}

test('the settings sheet, invite, read-only bar, room menu and description render the recorded HTML', () => {
  const actual = record()
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n')
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(golden, 'utf8')))
})
