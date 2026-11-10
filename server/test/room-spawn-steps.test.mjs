import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'
const source = fs.readFileSync(new URL('../../web/public/static/room-spawn-steps.js', import.meta.url), 'utf8')
function node() {
  const listeners = {}, children = {}, classes = new Set()
  return { listeners, dataset: {}, style: {}, innerHTML: '', value: '', selectionStart: 0,
    classList: { add(...xs) { xs.forEach(x => classes.add(x)) }, remove(...xs) { xs.forEach(x => classes.delete(x)) }, contains(x) { return classes.has(x) } },
    addEventListener(k, f) { listeners[k] = f }, setAttribute() {}, appendChild(n) { children['.spl'] = n }, remove() {}, contains() { return false },
    querySelector(s) { return children[s] ||= node() }, focus() {}, setSelectionRange() {}, scrollIntoView() {}, getBoundingClientRect() { return { top: 400, left: 0, bottom: 800, width: 600 } },
  }
}
function fixture(fetch = () => new Promise(() => {}), lang = 'zh', hostPerms = ['ask', 'auto', 'all'], spawnPerm = 'all') {
  const picker = node(), document = { body: node(), activeElement: null, addEventListener() {}, createElement: node }
  const box = { window: { innerWidth: 1280, addEventListener() {} }, document, navigator: { platform: 'MacIntel' }, fetch }
  vm.runInNewContext(source, box)
  const host = { name: 'daemon@kai', owner: 'kai', perms: hostPerms, clis: [{ kind: 'claude', installed: true }, { kind: 'codex', installed: false }] }
  let sent, collapsed = false
  const calls = { spawned: 0 }
  const state = { me: 'kai', members: [{ name: 'web@kai', owner: 'kai', kind: 'agent', status: 'left', handoff: {} }], todo: { items: [{ assignee: 'web@kai', status: 'todo' }] }, messages: [{ from: 'kai', text: '@daemon@kai /spawn claude web ~/work/app task' }] }
  const card = box.window.createSpawnCard({ S: ROOM_STRINGS[lang], lang, spawnPerm, roomId: 'topic', state, picker, isCoarse: () => true,
    escape: x => String(x).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), fill: (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]),
    ownerOf: n => n.split('@').at(-1), hostSeat: n => n === host.name ? host : null, computerOf: () => 'home-mac', spawnedNames: () => { calls.spawned++; return {} },
    send: text => { sent = text }, collapse: () => { collapsed = true; card.close() },
  })
  const click = (key, value) => picker.listeners.click({ target: { closest: () => ({ dataset: { [key]: value }, hasAttribute: attr => attr === 'data-' + key }) } })
  const task = value => picker.listeners.input({ target: { id: 'sp-task', value } })
  const query = value => picker.listeners.input({ target: { classList: { contains: () => true }, value } })
  const key = (key, extra = {}) => picker.listeners.keydown({ key, target: { dataset: {} }, preventDefault() {}, stopPropagation() {}, ...extra })
  card.open(host.name)
  return { card, picker, state, host, click, task, query, key, calls, sent: () => sent, collapsed: () => collapsed }
}
test('default fields, dialog and empty task guard; start emits only non-default arguments', () => {
  const f = fixture()
  assert.equal((f.picker.innerHTML.match(/aria-haspopup="listbox"/g) || []).length, 7)
  assert.match(f.picker.innerHTML, /role="dialog" aria-label="启动 agent"/)
  assert.match(f.picker.innerHTML, /data-start disabled/)
  assert.match(f.picker.innerHTML, /照你的设置：全部放行。|沿用上次的权限。/)
  f.key('Enter', { metaKey: true }); assert.equal(f.sent(), undefined)
  f.task('做登录页'); f.key('Enter', { metaKey: true })
  assert.equal(f.sent(), '@daemon@kai /spawn claude 做登录页')
})
test('takeover restores last directory and paths with spaces use existing quoting', () => {
  const f = fixture(); f.task('做登录页'); f.click('field', 'name'); f.click('option', '1')
  assert.equal(f.card.commandText(), '@daemon@kai /spawn claude web ~/work/app 做登录页')
  assert.match(f.picker.innerHTML, /接管 · 1 件任务/)
  f.click('field', 'dir'); f.query('~/My Project'); f.click('option', '0')
  assert.equal(f.card.commandText(), '@daemon@kai /spawn claude web cwd="~/My Project" 做登录页')
})
test('Esc closes list before card, retaining draft on reopen', () => {
  const f = fixture(); f.task('保留任务'); f.click('field', 'model')
  f.key('Escape'); assert.equal(f.card.isOpen(), true)
  f.key('Escape'); assert.equal(f.collapsed(), true)
  f.card.open('daemon@kai'); assert.match(f.picker.innerHTML, /保留任务/)
})
test('configured descriptions load; explicit default values are omitted', async () => {
  const f = fixture(async () => ({ ok: true, json: async () => ({ claude: { models: [{ id: 'model-a', about: { zh: '模型说明' } }], efforts: [{ id: 'medium' }, { id: 'high' }], default: { model: 'model-a', effort: 'medium' } } }) }))
  await new Promise(resolve => setImmediate(resolve))
  f.task('任务'); f.click('field', 'model'); assert.match(f.picker.querySelector('.spl').innerHTML, /模型说明/)
  f.click('option', '1'); f.click('field', 'effort'); f.click('option', '2')
  assert.equal(f.card.commandText(), '@daemon@kai /spawn claude effort=high 任务')
})
test('uninstalled CLI cannot be selected and invalid name cannot be committed', () => {
  const f = fixture(); f.click('field', 'cli'); f.click('option', '2')
  assert.ok(f.card.commandText().includes('/spawn claude'))
  f.key('Escape'); f.click('field', 'name'); f.query('Invalid Name!')
  assert.doesNotMatch(f.picker.querySelector('.spl').innerHTML, /<b>Invalid Name!<\/b>/)
})

const { parseSpawn } = await import('../../cli/src/daemon/commands.mjs')
test('generated commands round-trip through the unchanged daemon parser without losing task text', () => {
  for (const task of ['Write tests', 'fix login', '修一下登录']) {
    const f = fixture(); f.task(task)
    const parsed = parseSpawn(f.card.commandText().replace(/^@\S+ \/spawn /, ''))
    assert.equal(parsed.prompt, task)
    assert.equal(parsed.name, task === '修一下登录' ? null : 'claude-1')
    assert.equal(parsed.needDir, true)
  }
  const f = fixture(); f.task('Write tests'); f.click('field', 'name'); f.query('reviewer'); f.click('option', '1')
  const parsed = parseSpawn(f.card.commandText().replace(/^@\S+ \/spawn /, ''))
  assert.equal(parsed.prompt, 'Write tests'); assert.equal(parsed.name, 'reviewer')
})
test('task prefixes that the parser consumes block start; choosing a directory resolves only path prefixes', () => {
  for (const task of ['~/a do work', '/a do work', '～/a do work', 'cwd="/a" do work', 'model=x do work', 'effort=high do work', 'handoff=skip do work', 'lane=x do work']) {
    const f = fixture(); f.task(task); f.key('Enter', { ctrlKey: true }); assert.equal(f.sent(), undefined)
    f.click('field', 'dir'); f.query('~/work'); f.click('option', '0'); f.key('Enter', { ctrlKey: true })
    if (/^(model|effort|handoff|lane)=/.test(task)) assert.equal(f.sent(), undefined)
    else assert.equal(parseSpawn(f.sent().replace(/^@\S+ \/spawn /, '')).prompt, task)
  }
})

test('explicit automatic name skips left seats as well as current members', () => {
  const f = fixture(); f.state.members.push({ name: 'claude-1@kai', owner: 'kai', kind: 'agent', status: 'left' })
  f.task('Write tests')
  const parsed = parseSpawn(f.card.commandText().replace(/^@\S+ \/spawn /, ''))
  assert.equal(parsed.name, 'claude-2'); assert.equal(parsed.prompt, 'Write tests')
})
test('CLI list has one current row when its untouched default is selected', () => {
  const f = fixture(); f.click('field', 'cli')
  assert.equal((f.picker.querySelector('.spl').innerHTML.match(/aria-selected="true"/g) || []).length, 1)
})
test('typing a valid new name makes Enter select it instead of the default row', () => {
  const f = fixture(); f.task('任务'); f.click('field', 'name'); f.query('reviewer'); f.key('Enter')
  assert.equal(parseSpawn(f.card.commandText().replace(/^@\S+ \/spawn /, '')).name, 'reviewer')
})
test('unknown takeover directory explains the blocked start on the card; zero task count is omitted', () => {
  const f = fixture(); f.state.messages = []; f.state.todo.items = []; f.task('任务'); f.click('field', 'name')
  assert.doesNotMatch(f.picker.querySelector('.spl').innerHTML, /0 件任务/)
  assert.match(f.picker.querySelector('.spl').innerHTML, /接管 · 有交接/)
  f.click('option', '1')
  const directory = /data-field="dir"[\s\S]*?<\/button>/.exec(f.picker.innerHTML)[0]
  assert.match(directory, /接管 web 要写出目录/)
  assert.doesNotMatch(directory, /默认值/)
  f.key('Enter', { ctrlKey: true }); assert.equal(f.sent(), undefined)
})

// Every key in the card used to scan all messages several times over (3000 messages: 44 ms a key in the name filter).
test('the card scans the messages once per message list, again when one arrives', () => {
  let scans = 0, spawned = 0
  class Counted extends Array { forEach(...a) { scans++; return super.forEach(...a) } }
  const f = fixture()
  f.state.messages = Counted.from(f.state.messages)
  f.click('field', 'name'); scans = 0; f.calls.spawned = 0
  for (const q of ['w', 'we', 'web', 'we', 'w']) f.query(q)
  f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowUp')
  assert.equal(scans, 0); assert.equal(f.calls.spawned, 0)
  f.state.messages.push({ seq: 2, from: 'kai', text: '@daemon@kai /spawn claude api ~/work/api task' })
  f.query('')
  assert.equal(scans, 1); assert.equal(f.calls.spawned, 1)
  f.query('a'); f.key('ArrowDown')
  assert.equal(scans, 1); assert.equal(f.calls.spawned, 1)
})
function oldAgents(f, n) {
  f.state.members = []
  for (let i = 1; i <= n; i++) f.state.members.push({ name: `old-${i}@kai`, owner: 'kai', kind: 'agent', status: 'left', lastActive: i * 1000 })
}
const titles = (f) => [...f.picker.querySelector('.spl').innerHTML.matchAll(/<b>(old-\d+)<\/b>/g)].map((m) => m[1])
test('the takeover group lists every agent that left, most recent first, with its count in the title', () => {
  const f = fixture(); oldAgents(f, 12); f.click('field', 'name')
  const html = f.picker.querySelector('.spl').innerHTML
  assert.deepEqual(titles(f), Array.from({ length: 12 }, (_, i) => `old-${12 - i}`))
  assert.match(html, /<div class="gh">接管已离开的 agent · 12<\/div>/)
  assert.doesNotMatch(html, /class="gm"/)
  f.query('old-1')
  assert.deepEqual(titles(f).sort(), ['old-1', 'old-10', 'old-11', 'old-12'])
  assert.match(f.picker.querySelector('.spl').innerHTML, /接管已离开的 agent · 4/)
})
test('a typed name that no departed agent has gets its own group; an exact departed name does not', () => {
  const f = fixture(); oldAgents(f, 3); f.click('field', 'name')
  assert.doesNotMatch(f.picker.querySelector('.spl').innerHTML, /class="gh">新名称/)
  f.query('review')
  let html = f.picker.querySelector('.spl').innerHTML
  assert.match(html, /<div class="gh">新名称<\/div>[\s\S]*<b>review<\/b><small>启动一个新 agent<\/small>/)
  assert.ok(html.indexOf('使用默认值') < html.indexOf('class="gh">新名称'))
  assert.match(html, /class="it hi"[^>]*>(?:<b>review<\/b>)/)
  f.query('old-2')
  html = f.picker.querySelector('.spl').innerHTML
  assert.doesNotMatch(html, /class="gh">新名称/)
  assert.match(html, /class="it hi"[^>]*><b>old-2<\/b>/)
})
test('Enter on a typed prefix of departed names starts the new name, not a takeover', () => {
  const f = fixture(); oldAgents(f, 3); f.task('任务'); f.click('field', 'name'); f.query('old-'); f.key('Enter')
  assert.equal(parseSpawn(f.card.commandText().replace(/^@\S+ \/spawn /, '')).name, 'old-')
})
test('English takeover note says "1 task" and "2 tasks"; 0 writes nothing', () => {
  const f = fixture(undefined, 'en'); f.click('field', 'name')
  assert.match(f.picker.querySelector('.spl').innerHTML, /takeover · 1 task(?!s)/)
  f.state.todo.items.push({ assignee: 'web@kai', status: 'doing' }); f.query('w')
  assert.match(f.picker.querySelector('.spl').innerHTML, /takeover · 2 tasks/)
  f.state.todo.items = []; f.query('we')
  assert.doesNotMatch(f.picker.querySelector('.spl').innerHTML, /task/)
})


test('the first permission choice follows the setting and sends no argument; every explicit level sends its id', () => {
  const f = fixture(); f.task('做登录页')
  assert.doesNotMatch(f.card.commandText(), /perm=/)
  assert.match(f.picker.innerHTML, /data-field="perm"[^]*?按设置/)
  assert.match(f.picker.innerHTML, /照你的设置：全部放行。/)
  f.click('field', 'perm')
  const html = f.picker.querySelector('.spl').innerHTML
  assert.match(html, /aria-selected="true"[^]*?按设置（现在：全部放行）/)
  assert.match(html, /<code>--ask-for-approval on-request<\/code>/)
  for (const [i, id] of ['all', 'ask', 'auto'].entries()) {
    if (i > 0) f.click('field', 'perm')
    f.click('option', String(i + 1))
    assert.equal(f.card.commandText(), '@daemon@kai /spawn claude perm=' + id + ' 做登录页')
    assert.doesNotMatch(/data-field="perm"[^]*?<\/button>/.exec(f.picker.innerHTML)[0], /默认值/)
    assert.match(f.picker.innerHTML, /只管这个 agent，不改你的设置。/)
  }
  f.click('field', 'perm'); f.click('option', '0')
  assert.doesNotMatch(f.card.commandText(), /perm=/)
})

test('a departed name uses Member.perm for the keep choice, never command history', () => {
  const f = fixture(); f.task('任务')
  f.state.messages[0].text = '@daemon@kai /spawn claude web ~/work/app perm=all task'
  f.state.members[0].perm = { level: 'auto', from: 'parent', parent: 'lead@kai' }
  f.click('field', 'perm'); f.click('option', '1')
  f.click('field', 'name'); f.click('option', '1')
  assert.doesNotMatch(f.card.commandText(), /perm=/)
  assert.match(f.picker.innerHTML, /沿用上次的权限：代我审批。/)
  f.click('field', 'perm')
  assert.match(f.picker.querySelector('.spl').innerHTML, /沿用（上次：代我审批）/)
  f.state.members[0].perm = null; f.key('Escape'); f.click('field', 'perm')
  const row = /data-option="0"[^]*?<\/div>/.exec(f.picker.querySelector('.spl').innerHTML)[0]
  assert.match(row, /沿用/); assert.doesNotMatch(row, /上次：/)
})

test('config without a usable permission list shows the three built-in levels plus the as-set choice', async () => {
  for (const perm of [undefined, [], [{ id: 'all' }], [{ id: 'default', label: { en: 'Old', zh: '旧' } }]]) {
    const f = fixture(async () => ({ ok: true, json: async () => ({ perm }) }))
    await new Promise(resolve => setImmediate(resolve))
    f.click('field', 'perm')
    const html = f.picker.querySelector('.spl').innerHTML
    for (const text of ['按设置（现在：全部放行）', '在 Scorpio 里问我', '代我审批', '全部放行']) assert.ok(html.includes(text))
    assert.equal((html.match(/role="option"/g) || []).length, 4)
  }
})

test('configured permission labels and hints use the page language, with no first-entry default', async () => {
  for (const lang of ['en', 'zh']) {
    const perm = [{ id: 'all', label: { en: 'Custom all', zh: '自定全部' }, about: { en: 'Custom about', zh: '自定说明' }, note: { en: 'Custom note', zh: '自定提示' } }]
    const f = fixture(async () => ({ ok: true, json: async () => ({ perm }) }), lang)
    await new Promise(resolve => setImmediate(resolve))
    f.click('field', 'perm')
    assert.ok(f.picker.querySelector('.spl').innerHTML.includes(perm[0].about[lang]))
    f.click('option', '1')
    assert.ok(f.picker.innerHTML.includes(perm[0].label[lang]))
    assert.ok(f.picker.innerHTML.includes(perm[0].label[lang]))
    assert.match(f.card.commandText(), /perm=all/)
    assert.equal(await f.card.permissionNote('all'), perm[0].note[lang])
  }
})

test('an older daemon has no permission field, shows its explanation, and receives no permission argument', () => {
  for (const lang of ['zh', 'en']) {
    const f = fixture(undefined, lang, null); f.task('任务')
    assert.doesNotMatch(f.picker.innerHTML, /data-field="perm"/)
    assert.ok(f.picker.innerHTML.includes(ROOM_STRINGS[lang].spPermOldDaemon))
    assert.doesNotMatch(f.card.commandText(), /perm=/)
  }
  const f = fixture(); f.click('field', 'perm'); f.click('option', '3')
  f.host.perms = null; f.card.open(f.host.name)
  assert.doesNotMatch(f.card.commandText(), /perm=/, 'a saved explicit choice cannot reach an older daemon')
})

test('unknown setting has no guessed level; changing setting changes the first row and chip stays as set', () => {
  const f = fixture(undefined, 'en', ['ask', 'auto', 'all'], 'ask')
  f.click('field', 'perm')
  assert.match(f.picker.querySelector('.spl').innerHTML, /As set \(now: Ask me in Scorpio\)/)
  const unknown = fixture(undefined, 'zh', ['ask', 'auto', 'all'], null)
  unknown.click('field', 'perm')
  assert.match(unknown.picker.innerHTML, /照你在设置里选的。/)
  const row = /data-option="0"[^]*?<\/div>/.exec(unknown.picker.querySelector('.spl').innerHTML)[0]
  assert.match(row, /按设置/); assert.doesNotMatch(row, /现在：/)
})

// The 「方向」 field (docs/api/topics.md "The lane"): no lane by default, every lane the topic's agents carry, or a new word.
test('the lane field lists the topic\'s lanes, takes a new word, and adds lane= to the command', () => {
  const f = fixture()
  f.state.members.push({ name: 'api@kai', owner: 'kai', kind: 'agent', status: 'active', lane: 'billing' }, { name: 'docs@mei', owner: 'mei', kind: 'agent', status: 'left', lane: 'docs' }, { name: 'x@kai', owner: 'kai', kind: 'agent', status: 'active', lane: 'billing' })
  f.task('任务')
  assert.match(f.picker.innerHTML, /data-field="lane"[^>]*><span class="lab">方向<span class="d"> · 默认值<\/span><\/span><span class="v">没有方向<\/span>/)
  f.click('field', 'lane')
  const list = f.picker.querySelector('.spl').innerHTML
  assert.match(list, /placeholder="新方向"/)
  assert.ok(list.indexOf('<b>billing</b>') < list.indexOf('<b>docs</b>'), 'alphabetic, each once')
  assert.equal((list.match(/<b>billing<\/b>/g) || []).length, 1)
  f.click('option', '2')
  assert.equal(f.card.commandText(), '@daemon@kai /spawn claude lane=docs 任务')
  f.click('field', 'lane'); f.query('release'); f.key('Enter')
  assert.equal(f.card.commandText(), '@daemon@kai /spawn claude lane=release 任务')
  f.click('field', 'lane'); f.query('two words')
  assert.doesNotMatch(f.picker.querySelector('.spl').innerHTML, /<b>two words<\/b>/)
  f.key('Escape'); f.click('field', 'lane'); f.click('option', '0')
  assert.equal(f.card.commandText(), '@daemon@kai /spawn claude 任务')
})
test('a takeover says the seat keeps its lane unless one is chosen', () => {
  const f = fixture(); f.task('任务'); f.click('field', 'name'); f.click('option', '1')
  const lane = /data-field="lane"[\s\S]*?<\/button>/.exec(f.picker.innerHTML)[0]
  assert.match(lane, /沿用/)
  assert.match(lane, /接管沿用席位原来的方向/)
})
