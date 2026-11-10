// Text the page writes into the composer (an @ from a member card, the menu's mention, a reply's @, a send) tells the
// schedule button at once, as typing does; before, the button kept its old state until the next keystroke.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

const source = fs.readFileSync(new URL('../../web/public/static/room-composer.js', import.meta.url), 'utf8')

function element() {
  const classes = new Set(), listeners = {}
  return { classList: {
    add(...names) { names.forEach((name) => classes.add(name)) },
    remove(...names) { names.forEach((name) => classes.delete(name)) },
    toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name) },
    contains(name) { return classes.has(name) },
  }, listeners, addEventListener(name, fn) { listeners[name] = fn }, style: {}, dataset: {}, setAttribute() {}, focus() {}, appendChild() {}, contains() { return false }, querySelector() { return null }, querySelectorAll() { return [] }, remove() {}, innerHTML: '', onclick: null }
}

function composer(options = {}) {
  const els = {}
  const $ = (id) => (els[id] ||= element())
  const input = Object.assign(element(), {
    value: '', selectionStart: 0, scrollHeight: 20,
    setSelectionRange(a) { this.selectionStart = a },
  })
  const jumps = element()
  const sandbox = {
    window: { addEventListener() {} },
    document: { createElement: element, body: element(), querySelector: () => jumps, addEventListener() {} },
    sessionStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0', lineHeight: '20' }),
    escapeHtml: (s) => String(s), botStill: options.botStill || (() => ''), daemonSvg: () => '', botSvg: options.botSvg || (() => ''),
    renderMarkdown: (s) => String(s),
    setTimeout: () => 0, clearTimeout() {}, crypto: globalThis.crypto,
    navigator: { platform: 'MacIntel' },
    fetch: options.fetch || (() => new Promise(() => {})),
  }
  vm.runInNewContext(fs.readFileSync(new URL('../../web/public/static/room-spawn-steps.js', import.meta.url), 'utf8'), sandbox)
  vm.runInNewContext(source, sandbox)
  const told = []
  const picker = element()
  picker.querySelector = () => ({ focus() {} })
  const state = { me: 'kai', members: [{ name: 'daemon@kai', kind: 'host', owner: 'kai', status: 'active' }], messages: [], bySeq: new Map([[7, { seq: 7, from: 'web@kai', text: 'hi' }]]), pics: [], replyTo: null, replySnap: null }
  const c = sandbox.window.createRoomComposer({
    $, S: ROOM_STRINGS.zh, boot: { roomId: 'r', lang: 'zh', autoCallBack: options.on ?? true }, state, input, picker, canWrite: () => true, names: () => new Set(), fill: (s) => s,
    isCoarse: () => false, ownerOf: (name) => name.split('@').at(-1), computerOf: () => 'test-mac',
    textChanged: () => told.push(input.value),
    // What send() touches on its way to the outbox; the request itself never answers here.
    feed: element(), nearBottom: () => false, quoteHtml: () => '', avatar: () => '', rowName: () => '', RECEIPT: '', postWithin: options.receipt || (() => new Promise(() => {})),
    post: options.post, append: (m) => state.bySeq.set(m.seq, m), lastSeq: () => 7, readLine() {},
    ago: () => "now", ask: options.ask || (() => Promise.resolve(false)), flash: options.flash || (() => {}),
    ...options.ctx,
  })
  return { c, input, picker, jumps, $, told, state, sandbox }
}

test('an @ from a member card tells the schedule button at once', () => {
  const { c, input, told } = composer()
  c.insertMention('web@kai', false)
  assert.equal(input.value, '@web@kai ')
  assert.deepEqual(told, ['@web@kai '])
})

test('the menu\'s mention, a reply with its @, and a send tell it too', () => {
  const { c, input, told } = composer()
  const menus = {}
  c.hookFeed(() => {}, (slot, fn) => { menus[slot] = fn })
  menus.compose({ seq: 7, from: 'web@kai' }).find((it) => it.act === 'mention').run({ from: 'web@kai' })
  assert.deepEqual(told, ['@web@kai '])

  input.value = 'hello'
  c.setReply(7, { mention: true, quiet: true })
  assert.deepEqual(told.slice(1), ['@web@kai hello'])

  c.send()
  assert.equal(input.value, '')
  assert.equal(told.at(-1), '')
})

function key(input, options = {}) {
  let prevented = false
  input.listeners.keydown({ key: 'Enter', shiftKey: false, isComposing: false, ...options, preventDefault() { prevented = true } })
  return prevented
}

test('handwritten spawn parameters remain plain text and use the existing send path', () => {
  for (const send of [(f) => key(f.input), (f) => f.$('btn-send').onclick()]) {
    const f = composer()
    f.c.listen()
    f.picker.classList.add('hidden')
    f.input.value = '@daemon@kai /spawn claude helper cwd="~/My Project" 修复登录\n并报告结果'
    f.input.selectionStart = f.input.value.length
    f.input.listeners.input()
    assert.equal(f.picker.classList.contains('sp-card'), false)
    assert.equal(key(f.input, { shiftKey: true }), false)
    assert.equal(key(f.input, { isComposing: true }), false)
    const text = f.input.value
    send(f)
    assert.equal(f.c.outbox.length, 1)
    assert.equal(f.c.outbox[0].text, text)
    assert.equal(f.input.value, '')
  }
})

test('jump buttons follow the open picker without overwriting their feed visibility', () => {
  const f = composer()
  f.c.listen()
  f.input.value = '@daemon@kai '
  f.input.selectionStart = f.input.value.length
  f.input.listeners.input()
  assert.equal(f.picker.classList.contains('hidden'), false)
  assert.equal(f.jumps.hidden, true)
  key(f.input, { key: 'Escape' })
  assert.equal(f.picker.classList.contains('hidden'), true)
  assert.equal(f.jumps.hidden, false)
})

const left = (name = 'helper@kai', cmd = '@daemon@kai /spawn codex helper ~/work task') => ({ name, status: 'left', takeover: cmd, takeover_seq: 8 })
const settle = () => new Promise((resolve) => setImmediate(resolve))
function sending(options = {}) {
  const calls = [], errors = []
  let seq = 10
  const f = composer({
    receipt: async () => ({ seq: ++seq, delivery: options.delivery || [left()] }),
    post: async (path, body) => { calls.push(body.text); if (options.fail) throw Error('offline'); return { seq: ++seq } },
    flash: (error) => errors.push(error), ...options,
  })
  const send = () => { f.input.value = '@helper@kai hello'; f.c.send() }
  return { ...f, calls, errors, send }
}

test('auto call-back sends exactly once across queued receipts; each own left agent gets its command', async () => {
  const f = sending({ delivery: [left(), left('other@kai', '@daemon@kai /spawn codex other ~/work task')] })
  f.send(); f.send()
  await settle()
  assert.deepEqual(f.calls, [left().takeover, '@daemon@kai /spawn codex other ~/work task'])
})

test('off, another account, not_member and an already posted command do not auto-send', async () => {
  for (const options of [{ on: false }, { delivery: [left('helper@zoe')] }, { delivery: [{ name: 'missing@kai', status: 'not_member' }] }]) {
    const f = sending(options); f.send(); await settle(); assert.deepEqual(f.calls, [])
  }
  const f = sending()
  f.state.bySeq.set(9, { seq: 9, text: left().takeover })
  f.send(); await settle(); assert.deepEqual(f.calls, [])
  f.state.bySeq.set(9, { seq: 7, text: left().takeover })
  f.send(); await settle(); assert.deepEqual(f.calls, [left().takeover], 'commands before takeover_seq do not suppress a new takeover')
})

test('failure leaves the existing manual call-back available with its confirmation', async () => {
  let asked = 0, posted = 0
  const f = sending({ fail: true, ask: async () => { asked++; return true }, post: async () => {
    if (++posted === 1) throw Error('offline'); return { seq: 20 }
  } })
  f.send(); await settle()
  assert.deepEqual(f.errors, ['offline'])
  f.c.callBack('11:0'); await settle()
  assert.equal(asked, 1); assert.equal(posted, 2)
})

// A reply button's press is a send too: room-ai-cards.js hands its answer to the composer's delivery notes,
// so an agent of mine that left is called back (or noted) exactly as after a send from the input box.
const cardsSource = fs.readFileSync(new URL('../../web/public/static/room-ai-cards.js', import.meta.url), 'utf8')
function pressing(options = {}) {
  const calls = [], errors = []
  let seq = 10
  const f = composer({ on: options.on, post: async (path, body) => { calls.push(body.text); return { seq: ++seq } }, flash: (e) => errors.push(e) })
  vm.runInContext(cardsSource, f.sandbox)
  const feed = element(), hooks = {}
  f.c.hookFeed((name, fn) => { hooks[name] = fn }, () => {})
  const answer = options.answer || (() => { const at = ++seq; return { seq: at, message: { seq: at, from: 'kai', text: '@helper@kai 1 做' }, delivery: [left()] } })
  f.sandbox.window.createRoomAiCards({
    S: ROOM_STRINGS.zh, boot: {}, state: f.state, feed, fill: (s) => s, avatar: () => '', rowName: () => '', fmtTime: () => '', canWrite: () => true,
    post: async (what, body) => { assert.equal(what, 'press'); return answer(body) }, append: (m) => f.state.bySeq.set(m.seq, m), flash: (e) => errors.push(e),
    refusal: () => 'refused', deliveryNotes: f.c.deliveryNotes, rowHook() {},
  })
  const press = (index = 0) => feed.listeners.click({ target: { closest: (sel) => (sel === '[data-press]' ? { dataset: { press: `7:${index}` }, disabled: false } : null) } })
  return { ...f, calls, errors, hooks, press }
}

test('a reply-button press to my left agent sends its takeover once, not again on a redraw or a second press', async () => {
  const f = pressing()
  f.press(0); await settle()
  assert.deepEqual(f.calls, [left().takeover])
  assert.match(f.hooks.notes({ seq: 11 }, { receipt: true }), /class="bring back"/)
  f.press(1); await settle()
  assert.deepEqual(f.calls, [left().takeover])
  assert.deepEqual(f.errors, [])
})

test('with auto call-back off a press only draws the note and its button; an unchanged press does nothing', async () => {
  const off = pressing({ on: false })
  off.press(0); await settle()
  assert.deepEqual(off.calls, [])
  assert.match(off.hooks.notes({ seq: 11 }, { receipt: true }), /data-takeover="11:0"/)
  const same = pressing({ answer: () => ({ unchanged: true }) })
  same.press(0); await settle()
  assert.deepEqual(same.calls, [])
  assert.deepEqual(same.errors, [])
})

test('loading or rendering historical delivery notes never sends a takeover', () => {
  const f = sending()
  const hooks = {}
  f.c.hookFeed((name, fn) => { hooks[name] = fn }, () => {})
  hooks.notes({ seq: 11, delivery: [left()] }, { receipt: true })
  f.c.loadOutbox()
  assert.deepEqual(f.calls, [])
})


test('the invitation opens the existing spawn card and uses the command list host order', () => {
  const f = composer()
  f.state.members.push(
    { name: 'aaa@kai', kind: 'host', owner: 'kai', status: 'active' },
    { name: 'aab@kai', kind: 'host', owner: 'kai', status: 'left' },
    { name: 'aaa@lee', kind: 'host', owner: 'lee', status: 'active' },
    { name: 'agent@kai', kind: 'agent', owner: 'kai', status: 'active' },
  )
  assert.deepEqual(Array.from(f.c.mySeats(), (m) => m.name), ['aaa@kai', 'daemon@kai'])
  f.c.startSpawn(f.c.mySeats()[0].name)
  assert.equal(f.input.value, '@aaa@kai /spawn ')
  assert.equal(f.picker.classList.contains('sp-card'), true)
  assert.match(f.picker.innerHTML, /data-start disabled/)
  assert.deepEqual(f.told, ['@aaa@kai /spawn '])
  assert.equal(f.c.outbox.length, 0)
})

// One moving robot per agent, in the members list (design.md §7): the @ list draws the default still icon, working or not.
test('the @ list draws agents with the default still robot', () => {
  const drawn = []
  const { c, input, picker, state } = composer({
    botStill: (name, st, size) => { drawn.push(['still', name, st, size]); return '' },
    botSvg: (name, st) => { drawn.push(['moving', name, st]); return '' },
    ctx: { shown: () => true, presence: () => '', shownName: (n) => n },
  })
  state.members.push({ name: 'web@kai', kind: 'agent', owner: 'kai', status: 'active', online: true, work: 'working' }, { name: 'api@kai', kind: 'agent', owner: 'kai', status: 'active', online: false })
  c.listen(); input.value = '@'; input.selectionStart = 1; input.listeners.input()
  assert.match(picker.innerHTML, /data-pick="web@kai"/)
  assert.deepEqual(drawn, [['still', 'web@kai', '', 's16'], ['still', 'api@kai', '', 's16']])
})

// My own agents that left are offered too, since an @ calls them back (v0.19.0);
// last, grey, with what sending does per the account setting. Others' left agents and people who left stay out.
function atList(options = {}) {
  const f = composer({ ctx: { shown: (m) => m.kind !== 'host' || m.owner === 'kai', presence: () => 'online', shownName: (n) => n, rowName: (n) => n }, ...options })
  f.state.members.push(
    { name: 'web@kai', kind: 'agent', owner: 'kai', status: 'active', online: true, work: 'working' },
    { name: 'pm@kai', kind: 'agent', owner: 'kai', status: 'left' },
    { name: 'api@kai', kind: 'agent', owner: 'kai', status: 'left' },
    { name: 'pm@zoe', kind: 'agent', owner: 'zoe', status: 'left' },
    { name: 'zoe', kind: 'human', owner: 'zoe', status: 'left' },
    { name: 'old-daemon@kai', kind: 'host', owner: 'kai', status: 'left' },
  )
  f.c.listen()
  f.type = (text) => { f.input.value = text; f.input.selectionStart = text.length; f.input.listeners.input() }
  f.picked = () => Array.from(f.picker.innerHTML.matchAll(/class="pickrow( gone)?" data-pick="([^"]+)"/g), (m) => m[2] + (m[1] ? '!' : ''))
  return f
}

test('the @ list ends with my own agents that left, grey, saying that @ brings them back', () => {
  const f = atList()
  f.type('@')
  assert.deepEqual(f.picked(), ['daemon@kai', 'web@kai', 'api@kai!', 'pm@kai!'])
  assert.match(f.picker.innerHTML, /data-pick="pm@kai">.*?<span class="st">已离开 · @ 会叫回<\/span>/)
  assert.doesNotMatch(f.picker.innerHTML, /pm@zoe|"zoe"|old-daemon@kai/)
})

test('typing filters the left agents as it does the active ones', () => {
  const f = atList()
  f.type('@p')
  assert.deepEqual(f.picked(), ['api@kai!', 'pm@kai!'])
  f.type('@pm')
  assert.deepEqual(f.picked(), ['pm@kai!'])
  f.type('@zoe')
  assert.equal(f.picker.classList.contains('hidden'), true)
})

test('with auto call-back off the left agent says take over, and picking it inserts the full name', () => {
  const f = atList({ on: false })
  f.type('@pm')
  assert.match(f.picker.innerHTML, /data-pick="pm@kai">.*?<span class="st">已离开 · 接班<\/span>/)
  assert.doesNotMatch(f.picker.innerHTML, /会叫回/)
  f.c.insertMention('pm@kai', true)
  assert.equal(f.input.value, '@pm@kai ')
})

test('a left agent of mine without a takeover command gets a note and the not-delivered receipt, no button', async () => {
  const f = sending({ delivery: [{ name: 'helper@kai', status: 'left' }, { name: 'helper@zoe', status: 'left' }] })
  const hooks = {}
  f.c.hookFeed((name, fn) => { hooks[name] = fn }, () => {})
  const message = { seq: 11, delivery: [{ name: 'helper@kai', status: 'left' }, { name: 'helper@zoe', status: 'left' }] }
  const html = hooks.notes(message, { receipt: true })
  assert.match(html, /class="bring gone"/)
  assert.match(html, /没留接班命令/)
  assert.doesNotMatch(html, /data-takeover|helper@zoe/)
  const receipt = hooks.receipt(message)
  assert.equal(receipt.phase, 'gone'); assert.equal(receipt.label, ROOM_STRINGS.zh.receiptGone)
  f.send(); await settle()
  assert.deepEqual(f.calls, [])
})


test('manual call-back note follows the exact permission token or the account setting', async () => {
  for (const [tail, note] of [
    ['perm=all task', '配置中的全部放行说明'],
    ['perm=ask task', '配置中的问我说明'],
    ['perm=auto task', '配置中的代我审批说明'],
    ['task', ROOM_STRINGS.zh.spPermUnknownSetting],
    ['perm=alligator task', ROOM_STRINGS.zh.spPermUnknownSetting],
  ]) {
    let asked
    const cmd = '@daemon@kai /spawn codex helper ~/work ' + tail
    const f = sending({ on: false, delivery: [left('helper@kai', cmd)],
      fetch: async () => ({ ok: true, json: async () => ({ perm: [
        { id: 'ask', label: { en: 'Ask me in Scorpio', zh: '在 Scorpio 里问我' }, note: { zh: '配置中的问我说明' } },
        { id: 'auto', label: { en: 'Approve for me', zh: '代我审批' }, note: { zh: '配置中的代我审批说明' } },
        { id: 'all', label: { en: 'All', zh: '全部' }, note: { zh: '配置中的全部放行说明' } },
      ] }) }),
      ask: async (_, options) => { asked = options; return false },
    })
    f.send(); await settle(); f.c.callBack('11:0'); await settle()
    assert.equal(asked.code, cmd)
    assert.equal(asked.note, note)
  }
})

test('manual call-back with an old config uses the built-in allow-everything note', async () => {
  let asked
  const f = sending({ on: false, delivery: [left('helper@kai', '@daemon@kai /spawn codex helper ~/work perm=all task')],
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    ask: async (_, options) => { asked = options; return false },
  })
  f.send(); await settle(); f.c.callBack('11:0'); await settle()
  assert.equal(asked.note, '这个 agent 跳过所有审批，和以前一样。只管它这一次会话，不改你电脑上的设置。')
})


test('takeover keeps the allow-everything note when the current list omits all or its note', async () => {
  for (const perm of [[{ id: 'ask', label: { en: 'Ask me in Scorpio', zh: '在 Scorpio 里问我' } }],
    [{ id: 'ask', label: { en: 'Ask me in Scorpio', zh: '在 Scorpio 里问我' } }, { id: 'all', label: { en: 'All', zh: '全部' } }]]) {
    let asked
    const f = sending({ on: false, delivery: [left('helper@kai', '@daemon@kai /spawn codex helper ~/work perm=all task')],
      fetch: async () => ({ ok: true, json: async () => ({ perm }) }),
      ask: async (_, options) => { asked = options; return false },
    })
    f.send(); await settle(); f.c.callBack('11:0'); await settle()
    assert.equal(asked.note, '这个 agent 跳过所有审批，和以前一样。只管它这一次会话，不改你电脑上的设置。')
  }
})
