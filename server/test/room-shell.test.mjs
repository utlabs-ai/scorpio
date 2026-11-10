import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

const source = new URL('../../web/public/static/room-shell.js', import.meta.url)

function setup() {
  const timers = new Map(); let id = 0
  const line = { textContent: '', innerHTML: '', hidden: true, classList: {
    add(name) { if (name === 'hidden') line.hidden = true },
    remove(name) { if (name === 'hidden') line.hidden = false },
  } }
  const sandbox = { window: {}, setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, ms }); return key }, clearTimeout(key) { timers.delete(key) } }
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), sandbox)
  const shell = sandbox.window.createRoomShell({ statusEl: line })
  return { shell, line, timers, advance(ms) { const due = [...timers].filter(([, t]) => t.ms === ms); for (const [key, timer] of due) { timers.delete(key); timer.fn() } } }
}

test('undo and error keep their full time across reconnect updates, then reveal connection', () => {
  const h = setup()
  h.shell.status('connection', 'retrying')
  h.shell.status('undo', '<button>undo</button>', { html: true, ms: 5200 })
  h.shell.status('connection', 'retrying again')
  assert.equal(h.line.innerHTML, '<button>undo</button>')
  h.advance(5200); assert.equal(h.line.textContent, 'retrying again')
  h.shell.status('error', 'failed', { ms: 6000 })
  h.shell.status('connection', 'retrying once more')
  assert.equal(h.line.textContent, 'failed')
  h.advance(6000); assert.equal(h.line.textContent, 'retrying once more')
})

test('connection clears alone; undo click clears only undo', () => {
  const h = setup()
  h.shell.status('connection', 'retrying')
  h.shell.status('undo', '<button>undo</button>', { html: true, ms: 5200 })
  h.shell.clear('connection')
  assert.equal(h.line.innerHTML, '<button>undo</button>')
  h.shell.clear('undo')
  assert.equal(h.line.hidden, true)
  h.shell.status('connection', '<a href="/app">gone</a>', { html: true })
  h.shell.status('error', 'failed', { ms: 6000 })
  h.advance(6000)
  assert.equal(h.line.innerHTML, '<a href="/app">gone</a>')
  h.shell.status('error', '')
  assert.equal(h.line.innerHTML, '<a href="/app">gone</a>')
})

test('the latest error or undo notice wins without discarding the older one', () => {
  const h = setup()
  h.shell.status('error', 'first', { ms: 6000 })
  h.shell.status('undo', '<button>undo</button>', { html: true, ms: 5200 })
  assert.equal(h.line.innerHTML, '<button>undo</button>')
  h.shell.status('error', 'second', { ms: 6000 })
  assert.equal(h.line.textContent, 'second')
  h.shell.clear('error')
  assert.equal(h.line.innerHTML, '<button>undo</button>')
})

test('an error before the first connection expires after six seconds', () => {
  const h = setup()
  h.shell.status('error', 'failed', { ms: 6000 })
  assert.equal(h.line.hidden, false)
  h.advance(6000)
  assert.equal(h.line.hidden, true)
})

test('a reconnect update keeps the visible undo button element', () => {
  const h = setup()
  let html = '', button = null
  Object.defineProperty(h.line, 'innerHTML', {
    get() { return html },
    set(value) { html = value; button = { value } },
  })
  h.shell.status('connection', 'retrying')
  h.shell.status('undo', '<button>undo</button>', { html: true, ms: 5200 })
  const pressedButton = button
  h.shell.status('connection', 'retrying again')
  assert.strictEqual(button, pressedButton)
})

function panelHarness(width) {
  const calls = [], listeners = {}
  let tabScrolls = 0
  function classes(initial = []) {
    const values = new Set(initial)
    return { add(...names) { names.forEach((n) => values.add(n)) }, remove(...names) { names.forEach((n) => values.delete(n)) },
      contains(name) { return values.has(name) }, toggle(name, on) { if (on) values.add(name); else values.delete(name) } }
  }
  const tabsBar = { scrollWidth: 410, clientWidth: 300, classList: classes(), querySelector() { return { scrollIntoView(options) { assert.equal(options.inline, 'nearest'); assert.equal(options.block, 'nearest'); tabScrolls++ } } } }
  function element(initial = []) {
    let html = '', writes = 0, scroll = { scrollTop: 0 }
    return { classList: classes(initial), dataset: { kind: '' },
      get innerHTML() { return html }, set innerHTML(value) { html = value; writes++; scroll = { scrollTop: 0 } },
      get writes() { return writes }, querySelector(selector) { return selector === '.scroll' ? scroll : selector === '.sh .seg' ? tabsBar : null },
      querySelectorAll() { return [] },
    }
  }
  const panel = element(['hidden']), side = element(), scrim = element(['hidden']), desk = element()
  const topic = {}, elements = { 'desktop-side': side, 'panel-scrim': scrim, 'set-topic': topic }
  const document = { body: element(), activeElement: null, querySelector(selector) { return selector === '.ui.desk' ? desk : null } }
  const storage = { getItem() { return null }, setItem() {} }
  const sandbox = { window: { addEventListener(type, fn) { listeners[type] = fn }, matchMedia(query) { return { matches: query.includes('min-width') ? width >= 761 : width <= 760 } } },
    document, localStorage: storage, requestAnimationFrame(fn) { fn() }, setTimeout() {}, clearTimeout() {} }
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), sandbox)
  const shell = sandbox.window.createRoomShell({ statusEl: element(['hidden']) })
  const panels = shell.panels({ panel, $: (id) => elements[id], S: { sideClose: 'Close', cancel: 'Close' }, escapeHtml: (s) => s,
    renderMain() { calls.push('renderMain') }, roomSearch: { open(value) { calls.push(`search:${value}`) }, closed() { calls.push('searchClosed') } } })
  let plan = 'plan', members = 'members'
  panels.tab('plan', { label: () => 'Plan', html: () => plan, side: true, long: true })
  panels.tab('schedules', { label: () => 'Schedules', html: () => 'schedules', side: true, long: true, firstOpen() { calls.push('firstOpen') } })
  panels.tab('members', { label: () => 'Members', html: () => members, side: true,
    panelBefore() { calls.push('panelBefore'); return 'robots' }, panelAfter(_, token) { calls.push(`panelAfter:${token}`) } })
  panels.tab('memo', { label: () => 'memo', html: () => 'memo', side: true, long: true });
  panels.tab('files', { label: () => 'Files', html: () => 'files', side: true, long: true,
    before() { calls.push('filesBefore') }, after() { calls.push('filesAfter') } })
  panels.tab('at', { html: () => 'mentions', opened() { calls.push('opened'); panels.openPanel('at') } })
  return { panels, panel, side, scrim, desk, document, topic, calls, tabsBar, tabScrolls: () => tabScrolls, resize(value) { width = value; listeners.resize() },
    changePlan(value) { plan = value }, changeMembers(value) { members = value } }
}

test('side redraw preserves scroll across tabs and never runs phone robot hooks', () => {
  const h = panelHarness(1280)
  h.panels.openPanel('plan')
  h.side.querySelector('.scroll').scrollTop = 73
  h.panels.openPanel('members')
  assert.equal(h.side.querySelector('.scroll').scrollTop, 73)
  assert.ok(!h.calls.includes('panelBefore'))
  assert.ok(!h.calls.some((v) => v.startsWith('panelAfter')))
})

test('unchanged HTML is a no-op in both paths', () => {
  const phone = panelHarness(390)
  phone.panels.openPanel('plan')
  const panelWrites = phone.panel.writes
  phone.panels.openPanel('plan')
  assert.equal(phone.panel.writes, panelWrites)
  const desktop = panelHarness(1280)
  desktop.panels.renderSide()
  const sideWrites = desktop.side.writes
  desktop.panels.renderSide()
  assert.equal(desktop.side.writes, sideWrites)
  desktop.panels.renderSide({ force: true })
  assert.equal(desktop.side.writes, sideWrites + 1)
})

test('phone hooks run at their original points; firstOpen and opened run only for a fresh opening', () => {
  const h = panelHarness(390)
  h.panels.openPanel('members')
  assert.deepEqual(h.calls.filter((v) => v.startsWith('panel')), ['panelAfter:undefined'])
  h.changeMembers('new members')
  h.panels.openPanel('members')
  assert.deepEqual(h.calls.filter((v) => v.startsWith('panel')), ['panelAfter:undefined', 'panelBefore', 'panelAfter:robots'])
  h.panels.openPanel('schedules'); h.panels.openPanel('schedules')
  assert.equal(h.calls.filter((v) => v === 'firstOpen').length, 1)
  h.panels.closePanel(); h.panels.openPanel('schedules')
  assert.equal(h.calls.filter((v) => v === 'firstOpen').length, 2)
  h.panels.openPanel('at'); h.panels.openPanel('at')
  assert.equal(h.calls.filter((v) => v === 'opened').length, 1)
})

test('settings refresh can preserve the focused topic; wait maps to plan', () => {
  const h = panelHarness(390)
  h.panels.refresh('settings', () => { if (h.document.activeElement !== h.topic) h.calls.push('settingsRefresh') })
  h.panel.dataset.kind = 'settings'; h.document.activeElement = h.topic
  h.panels.refreshPanel()
  assert.ok(!h.calls.includes('settingsRefresh'))
  h.document.activeElement = null; h.panels.refreshPanel()
  assert.ok(h.calls.includes('settingsRefresh'))
  h.panels.openPanel('wait')
  assert.equal(h.panels.kind(), 'plan')
})

test('togglePanel closes an already shown desktop side tab', () => {
  const h = panelHarness(1280)
  h.panels.openPanel('plan')
  assert.equal(h.panels.sideOpen(), true)
  h.panels.togglePanel('plan')
  assert.equal(h.panels.sideOpen(), false)
})


test('phone tabs detect overflow and reveal the selected tab on open, redraw and resize', () => {
  const h = panelHarness(390)
  h.panels.openPanel('members')
  assert.equal(h.tabsBar.classList.contains('over'), true)
  assert.equal(h.tabScrolls(), 1)
  h.panels.openPanel('files')
  assert.equal(h.tabScrolls(), 2)
  h.tabsBar.clientWidth = 410
  h.resize(760)
  assert.equal(h.tabsBar.classList.contains('over'), false)
  assert.equal(h.tabScrolls(), 3)
  h.resize(1280)
  assert.equal(h.tabScrolls(), 3)
  h.panels.closePanel(); h.resize(390)
  assert.equal(h.tabScrolls(), 3)
})
