// The members' HTML: presence words, member rows, role-card previews, the member popup and the folded panel,
// recorded on the code before the member code moved into room-members.js, so the move is held to the same bytes.
// Only load() may change; the cases and the golden stay.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

// handoffWhen and clock format in the local zone.
process.env.TZ = 'Asia/Shanghai'

const staticFile = (name) => new URL(`../../web/public/static/${name}`, import.meta.url)
const roomSource = fs.readFileSync(staticFile('room.js'), 'utf8')
const membersSource = fs.readFileSync(staticFile('room-members.js'), 'utf8')
const settingsSource = fs.readFileSync(staticFile('room-settings.js'), 'utf8')
const golden = new URL('./room-members.golden.json', import.meta.url)

/** A function or var at the given indent (room.js's top level is two spaces, a factory's body four), as written there. */
function piece(source, name, indent = '  ') {
  const one = new RegExp(`^${indent}(function ${name}\\(.*\\}|var ${name} = .*;)(?: *\\/\\/.*)?$`, 'm').exec(source)
  if (one) return one[1]
  const block = new RegExp(`\\n${indent}(function ${name}\\([\\s\\S]*?\\n${indent}\\})\\n`).exec(source)
  assert.ok(block, `no ${name}`)
  return block[1]
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** The item panel and what popup() and sizePop() reach in it: the edit box, its count and Save exist while its HTML has them. */
function page() {
  const classList = (start) => {
    const set = new Set(start)
    return {
      add(c) { set.add(c) }, remove(c) { set.delete(c) }, contains(c) { return set.has(c) },
      toggle(c, on) { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c) },
      has: (c) => set.has(c),
    }
  }
  const el = (id, start) => ({ id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, disabled: false, scrollHeight: 120, focused: false, classList: classList(start), focus() { this.focused = true } })
  const els = { 'item-panel': el('item-panel', ['hidden']), 'item-scrim': el('item-scrim', ['hidden']) }
  let shownHtml = null, inner = {}
  return (id) => {
    if (els[id]) return els[id]
    const html = els['item-panel'].innerHTML
    if (html !== shownHtml) { shownHtml = html; inner = {} }
    if (!html.includes(`id="${id}"`)) return null
    if (!inner[id]) {
      inner[id] = el(id, [])
      const text = id === 'pop-edit' && /<textarea id="pop-edit"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)
      if (text) inner[id].value = unescape(text[1])
    }
    return inner[id]
  }
}

// ---------- the loader: the only part that may change ----------

// Room helpers the member code uses and does not own, and the description's, from the settings factory.
const fromRoom = ['fill', 'ago', 'clock', 'canWrite', 'isOwner']
const fromSettings = ['plainLines', 'topicHtml']
// The member code, at the top of room-members.js's factory; its ctx names are the sandbox's globals.
const memberCode = [
  'shownName', 'myAgents', 'isWorkingAgent', 'shown', 'presence', 'waitsOnMe', 'robot', 'memberRow',
  'SPAWN_CARD', 'CARD_MAX', 'roleCardOf', 'cardPreview',
  'charCount', 'countText', 'showCount', 'growBox', 'popEdit', 'popup', 'editBox', 'sizePop',
  'showMember', 'handoffWhen', 'handoffRow', 'overviewLink', 'laneMine', 'laneRow',
  'memberQuery', 'memberFilterHtml', 'filteredMembersHtml', 'filterInput', 'membersPanelHtml',
  'MEMBER_FOLD_KEY', 'memberFold', 'memberIsFolded', 'toggleMemberFold', 'computerOf', 'computerLabel',
]

/** The member functions on the code under test, over the given boot and state. */
function load({ boot, state }) {
  const calls = []
  const box = {
    boot, state, S: boot.S, viewer: false, $: page(),
    pendingDone: {},
    panels: { kind: () => 'members', sideView: () => 'members' },
    names: () => new Set(state.members.map((m) => m.name)),
    closeItem: () => calls.push('closeItem'),
    openPanel: (kind) => calls.push(`openPanel ${kind}`),
    renderSide: () => calls.push('renderSide'),
  }
  box.window = box
  vm.createContext(box)
  for (const name of ['md.js', 'bots.js', 'daemon.js']) vm.runInContext(fs.readFileSync(staticFile(name), 'utf8'), box, { filename: name })
  // The robots and the computer icon by their classes alone: the drawings are not what this records.
  vm.runInContext('BOT_SVG = "<svg class=\\"__CLS__\\"></svg>"; DAEMON_SVG = "<svg class=\\"__CLS__\\"></svg>"; Date.now = function () { return NOW; };', Object.assign(box, { NOW }))
  vm.runInContext(fromRoom.map((name) => piece(roomSource, name)).join('\n'), box)
  vm.runInContext(fromSettings.map((name) => piece(settingsSource, name, '    ')).join('\n'), box)
  vm.runInContext(memberCode.map((name) => piece(membersSource, name, '    ')).join('\n'), box)
  vm.runInContext(piece(membersSource, 'membersHtml', '    '), box)
  return { box, calls }
}

// ---------- the cases ----------

const NOW = Date.UTC(2026, 9, 18, 4, 0)
const minute = 60000, hour = 60 * minute, day = 24 * hour
const S = ROOM_STRINGS.zh
const longCard = Array.from({ length: 66 }, (_, i) => `第 ${i + 1} 条：负责服务端的拆分。`).join('\n')

function world() {
  const members = [
    { name: 'kai', kind: 'human', owner: 'kai', status: 'active', displayName: 'Kai', online: true, lastActive: NOW },
    { name: 'lee', kind: 'human', owner: 'lee', status: 'active', displayName: '小李', online: false, lastActive: NOW - 3 * hour },
    { name: 'zed', kind: 'human', owner: 'zed', status: 'active', online: false },
    { name: 'daemon@kai', kind: 'host', owner: 'kai', status: 'active', online: true, device: { name: 'MacBook', hostname: 'kai-mbp', note: 'office' }, roleCard: 'Scorpio daemon. This computer: kai-mbp. Detected: claude' },
    { name: 'mini@kai', kind: 'host', owner: 'kai', status: 'active', online: false, roleCard: 'This computer: kai-mini; at home' },
    { name: 'daemon@lee', kind: 'host', owner: 'lee', status: 'active', online: true, roleCard: 'This computer: lee-pc.' },
    { name: 'api@kai', kind: 'agent', owner: 'kai', status: 'active', online: true, work: 'working', host: 'daemon@kai', roleCard: '**API** seat: builds the server.\n- reviews `PRs`\n- [docs](https://example.com/docs)\n\n| a | b |\n|---|---|' },
    { name: 'wait@kai', kind: 'agent', owner: 'kai', status: 'active', online: true, work: 'idle', host: 'daemon@kai', roleCard: 'wait: started by kai with /spawn; takes work from kai' },
    { name: 'ask@kai', kind: 'agent', owner: 'kai', status: 'active', online: true, work: 'blocked', host: 'daemon@kai', roleCard: 'ask：Answers questions about the split.' },
    { name: 'idle@kai', kind: 'agent', owner: 'kai', status: 'active', online: true, work: 'idle', host: 'daemon@kai' },
    { name: 'off@kai', kind: 'agent', owner: 'kai', status: 'active', online: false, work: 'idle', host: 'mini@kai', hostOfflineSince: NOW - 20 * minute, roleCard: 'Runs at home.' },
    { name: 'nohost@kai', kind: 'agent', owner: 'kai', status: 'active', online: false, host: null, lastActive: NOW - 2 * day, roleCard: 'Not on any computer.' },
    { name: 'old@kai', kind: 'agent', owner: 'kai', status: 'left', online: false, host: null, roleCard: 'The old seat.', handoff: { updatedAt: NOW - day - 95 * minute, computer: 'kai-mbp', size: 900 } },
    { name: 'past@kai', kind: 'agent', owner: 'kai', status: 'left', online: false, host: null, handoff: { updatedAt: NOW - 5 * day, size: 10 } },
    { name: 'helper@lee', kind: 'agent', owner: 'lee', status: 'active', online: true, work: 'idle', host: 'daemon@lee', roleCard: 'Helps 小李 with <the> page & tests.' },
  ]
  const items = [
    { id: 'T1', title: 'Look at the golden', createdBy: 'wait@kai', assignee: 'kai', status: 'todo' },
    { id: 'T2', title: 'Done already', createdBy: 'idle@kai', assignee: 'kai', status: 'done' },
    { id: 'T3', title: 'Review the move', createdBy: 'helper@lee', assignee: 'kai', status: 'doing' },
    { id: 'T4', title: 'An offline agent asks', createdBy: 'nohost@kai', assignee: 'kai', status: 'todo' },
  ]
  const boot = { lang: 'zh', me: 'kai', meDisplayName: 'Kai', roomId: 'r1', S }
  const state = {
    me: 'kai', members, todo: { items, done: null },
    room: { id: 'r1', name: 'Scorpio', topic: '在 Scorpio 里迭代 **Scorpio**。\n- 第二行', owner: 'kai', archived: false },
  }
  return { boot, state }
}

const presenceCases = [
  ['online person', 'kai'],
  ['offline person, active before', 'lee'],
  ['offline person, never active', 'zed'],
  ['online computer', 'daemon@kai'],
  ['host off', 'off@kai'],
  ['working', 'api@kai'],
  ['blocked', 'ask@kai'],
  ['idle', 'idle@kai'],
  ['waiting on me', 'wait@kai'],
  ['someone else\'s agent waiting on me', 'helper@lee'],
  ['offline agent with an item on me', 'nohost@kai'],
]
const rowCases = [
  ['an agent of mine', 'api@kai'],
  ['someone else\'s agent', 'helper@lee'],
  ['a computer seat', 'daemon@kai'],
  ['a person', 'lee'],
  ['me', 'kai'],
]
const previewCases = [
  ['a written card', 'api@kai'],
  ['a /spawn card', 'wait@kai'],
  ['a card that repeats the role', 'ask@kai'],
  ['no card', 'idle@kai'],
]
const popupCases = [
  ['my agent', 'api@kai', false],
  ['my agent while editing, over the limit', 'api@kai', true, longCard],
  ['someone else\'s agent', 'helper@lee', false],
  ['a left agent with a handoff', 'old@kai', false],
  ['an agent with no host', 'nohost@kai', false],
]
const foldSteps = [
  ['mine open, others folded', null],
  ['lee opened', 'lee'],
  ['my left agents opened', 'left:kai'],
  ['mine folded', 'kai'],
]

function record() {
  const w = world()
  const { box, calls } = load(w)
  const member = (name) => w.state.members.find((m) => m.name === name)
  const out = {}
  out.presence = presenceCases.map(([label, name]) => ({ case: label, text: box.presence(member(name)) }))
  out.memberRow = rowCases.map(([label, name]) => ({ case: label, html: box.memberRow(member(name)) }))
  out.cardPreview = previewCases.map(([label, name]) => ({ case: label, html: box.cardPreview(member(name)) }))
  out.showMember = popupCases.map(([label, name, editing, card]) => {
    const m = member(name), before = m.roleCard
    if (card) m.roleCard = card
    box.showMember(name, editing)
    m.roleCard = before
    const panel = box.$('item-panel')
    const row = { case: label, key: panel.dataset.itemId, shown: !panel.classList.contains('hidden'), html: panel.innerHTML }
    if (editing) {
      const n = box.$('pop-n'), save = box.$('pop-save')
      row.count = { text: n.textContent, over: n.classList.contains('over'), saveDisabled: save.disabled, focused: box.$('pop-edit').focused }
    }
    return row
  })
  out.membersHtml = foldSteps.map(([label, fold]) => {
    calls.length = 0
    if (fold) box.toggleMemberFold(fold)
    return { case: label, calls: calls.slice(), html: box.membersHtml() }
  })
  return out
}

test('the members\' words, rows, cards, popup and folds render the recorded HTML', () => {
  const actual = record()
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(golden, JSON.stringify(actual, null, 2) + '\n')
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(golden, 'utf8')))
})

test('computer labels omit missing hostname and note without empty punctuation', () => {
  const w = world(), { box } = load(w)
  const host = w.state.members.find((m) => m.kind === 'host')
  host.device = { name: 'computer-1', hostname: 'box.local', note: 'desk' }
  assert.equal(box.computerOf(host), 'computer-1')
  assert.equal(box.computerLabel(host), 'computer-1 (box.local) · desk')
  host.device = { name: 'computer-1', note: 'desk' }
  assert.equal(box.computerLabel(host), 'computer-1 · desk')
  assert.ok(!box.memberRow(host).includes('undefined'))
  host.device = { name: 'computer-1', note: null }
  assert.equal(box.computerOf(host), 'computer-1')
  assert.ok(!box.memberRow(host).includes('()'))
})

test('trimmed viewer rows render every kind without presence, cards or empty groups', () => {
  const w = world()
  w.state.members = [
    { name: 'kai', displayName: 'Kai', kind: 'human' },
    { name: 'web@mei', displayName: null, kind: 'agent' },
    { name: 'api@kai', displayName: null, kind: 'agent' },
    { name: 'computer-1-daemon@kai', displayName: null, kind: 'host' },
    { name: 'mei', displayName: null, kind: 'human' },
  ]
  const { box } = load(w)
  const html = box.membersHtml()
  for (const name of ['Kai', 'api@kai', 'computer-1', 'mei', 'web@mei']) assert.ok(html.includes(name))
  assert.ok(html.includes('本主题成员：4 · 2 人'))
  assert.ok(!html.includes('>human<') && !html.includes('>host<'))
  assert.ok(html.includes('>电脑<'))
  assert.ok(html.indexOf('Kai') < html.indexOf('api@kai') && html.indexOf('api@kai') < html.indexOf('computer-1'))
  assert.ok(html.indexOf('computer-1') < html.indexOf('>mei<') && html.indexOf('>mei<') < html.indexOf('web@mei'))
  for (const text of ['活跃', '离线', '运行中', 'undefined', '()']) assert.ok(!html.includes(text), text)
})


test('member filter matches names, display names and role cards without a request', () => {
  const w = world(), { box } = load(w)
  for (const [q, expected] of [['API', 'api@kai'], ['小李', 'lee'], ['Runs at home', 'off@kai']]) {
    box.memberQuery = q
    const html = box.filteredMembersHtml()
    assert.ok(html.includes(expected), q)
    assert.ok(!html.includes('data-name="idle@kai"'), q)
  }
  box.memberQuery = 'no such member'
  assert.equal(box.filteredMembersHtml(), '<ul class="seats"></ul>')
  assert.ok(box.membersPanelHtml().includes('筛选成员'))
})
