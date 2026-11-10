import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

// The left column's topic menu offers 归档 on the creator's own active topics: app-shell.js against a stub
// document, driven by its own listeners (right click, long press, clicks in the menu and the dialog).
const shell = readFileSync(new URL('../../web/public/static/app-shell.js', import.meta.url), 'utf8')
const built = await build({ entryPoints: [new URL('../src/strings.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { strings } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

function el() {
  const on = {}
  const e = {
    innerHTML: '', textContent: '', className: '', dataset: {}, style: {}, scrollTop: 0, hidden: false, on,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener(type, fn) { (on[type] ||= []).push(fn) }, setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    appendChild(child) { (e.kids ||= []).push(child) }, remove() { e.removed = true }, focus() {},
    querySelector: () => el(), querySelectorAll: () => [], closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20 }),
  }
  return e
}

const topic = (id, extra) => ({ id, name: id, desc: '', owned: true, active: true, pinnedAt: null, archivedAt: null, archived: false, public: false, lastMs: Date.now(), agents: 0, humans: 1, working: 0, open: 0, mine: 0, mineSince: null, unread: null, mentionUnread: 0, known: true, ...extra })

/** A target whose closest(sel) answers only for the selectors given. */
function target(map) {
  return { closest: (sel) => (sel in map ? map[sel] : null) }
}
const rowEl = (id, arch) => ({ dataset: { sxId: id }, classList: { contains: (c) => c === 'sx-arch' && !!arch }, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20 }) })

function start(lang, topics, { archiveReply = { ok: true, body: { roomId: 'x' } }, confirm = true } = {}) {
  const S = strings(lang).shell
  const boot = el()
  boot.textContent = JSON.stringify({ S, lang, topics, me: { handle: 'kai' }, binAfterDays: 30, current: null })
  const side = el()
  const byId = { 'sx-boot': boot, 'sx-list': side, 'sx-ph-groups': el(), 'sx-side': el() }
  const docOn = {}
  const made = []
  const document = {
    ...el(),
    hidden: false, body: el(), documentElement: el(), activeElement: null,
    addEventListener(type, fn) { (docOn[type] ||= []).push(fn) },
    getElementById: (id) => byId[id] || null,
    createElement: () => { const e = el(); made.push(e); return e },
    querySelector: (q) => (q === '[data-sx-ask]' ? null : el()),
    querySelectorAll: () => [],
  }
  const calls = [], alerts = [], timers = []
  const fetch = (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    if (url === '/app/topics.json') return Promise.resolve({ ok: true, json: () => Promise.resolve({ topics: topics.map((t) => ({ ...t, archived: true, archivedAt: Date.now() })), me: { handle: 'kai' }, binAfterDays: 30 }) })
    return Promise.resolve({ ok: archiveReply.ok, json: () => Promise.resolve(archiveReply.body) })
  }
  const window = { matchMedia: () => ({ matches: true, addEventListener() {} }) }
  const storage = { getItem: () => null, setItem() {} }
  vm.runInNewContext(shell, {
    document, window, localStorage: storage, sessionStorage: storage, setInterval() {}, setTimeout: (fn) => { timers.push(fn); return timers.length }, clearTimeout() {},
    fetch, alert: (m) => alerts.push(m), location: {}, navigator: {}, innerWidth: 1280, innerHeight: 800,
  })
  const menu = made[0]
  const fire = (type, e) => (docOn[type] || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10, ...e }))
  const rightClick = (id, arch) => fire('contextmenu', { target: target({ '.sx-trow[data-sx-id]': rowEl(id, arch) }) })
  const longPress = (id) => { fire('touchstart', { target: target({ '.sx-trow[data-sx-id]': rowEl(id) }), touches: [{ clientX: 10, clientY: 10 }] }); timers.splice(0).forEach((fn) => fn()) }
  const click = (map) => fire('click', { target: target(map) })
  const dialog = () => made.filter((e) => e.className === 'sx-dlg').at(-1)
  const answer = (yes) => { const d = dialog(); d.on.click.forEach((fn) => fn({ target: target({ '[data-sx-dlg]': { dataset: { sxDlg: yes ? '1' : '0' } } }) })) }
  return { S, menu, rightClick, longPress, click, dialog, answer, calls, alerts, side, confirm }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const items = (html) => [...html.matchAll(/<button type="button" role="menuitem" ([^>]*)>([^<]*)<\/button>/g)].map((m) => [m[1].match(/data-sx-(\w+)=/)[1], m[2]])

for (const [lang, archive, pin] of [['zh', '归档', '置顶'], ['en', 'Archive', 'Pin']]) {
  test(`${lang}: the creator's active topic offers pin and archive, a member's topic only pin`, () => {
    const s = start(lang, [topic('mine'), topic('theirs', { owned: false })])
    s.rightClick('mine')
    assert.deepEqual(items(s.menu.innerHTML), [['pin', pin], ['archive', archive]])
    s.rightClick('theirs')
    assert.deepEqual(items(s.menu.innerHTML), [['pin', pin]])
  })
}

test('a long press on a phone opens the same menu', () => {
  const s = start('zh', [topic('mine')])
  s.longPress('mine')
  assert.deepEqual(items(s.menu.innerHTML), [['pin', '置顶'], ['archive', '归档']])
})

test('an archived row opens no menu, even if it is mine', () => {
  const s = start('zh', [topic('old', { archived: true, archivedAt: Date.now() })])
  s.menu.innerHTML = ''
  s.rightClick('old', true)
  assert.equal(s.menu.innerHTML, '')
  // and a row the list knows as archived but drawn without the class: rowMenu itself refuses
  s.rightClick('old', false)
  assert.equal(s.menu.innerHTML, '')
})

test('archive asks the settings question with the retention days, then posts archived:true and reloads the list', async () => {
  const s = start('zh', [topic('mine')])
  s.rightClick('mine')
  s.click({ '[data-sx-archive]': { dataset: { sxArchive: 'mine' } } })
  const d = s.dialog()
  assert.ok(d, 'a dialog opened')
  assert.match(d.innerHTML, /归档这个主题？归档后只读：历史保留，不能发送消息、置顶或修改任务。可随时恢复；30 天未恢复即永久删除。/)
  assert.match(d.innerHTML, /data-sx-dlg="0">取消<\/button>/)
  assert.match(d.innerHTML, /data-sx-dlg="1">归档<\/button>/)
  assert.equal(s.calls.filter((c) => c.method === 'POST').length, 0, 'nothing is sent before OK')
  s.answer(true)
  await tick(); await tick(); await tick()
  assert.deepEqual(s.calls.filter((c) => c.method === 'POST'), [{ url: '/r/mine/archive', method: 'POST', body: { archived: true } }])
  assert.ok(s.calls.some((c) => c.url === '/app/topics.json'), 'the list is fetched again')
  assert.ok(d.removed)
  // the refreshed list draws it under 已归档 with 恢复
  assert.match(s.side.innerHTML, /data-sx-fold="archived"/)
  assert.deepEqual(s.alerts, [])
})

test('cancel sends nothing', async () => {
  const s = start('en', [topic('mine')])
  s.rightClick('mine')
  s.click({ '[data-sx-archive]': { dataset: { sxArchive: 'mine' } } })
  s.answer(false)
  await tick(); await tick()
  assert.deepEqual(s.calls.filter((c) => c.method === 'POST'), [])
  assert.ok(s.dialog().removed)
})

test('a refusal shows the server next, or the shell words when there is none; the list is not reloaded', async () => {
  for (const [body, said] of [[{ error: 'forbidden', next: 'Only the creator can archive.' }, 'Only the creator can archive.'], [{ error: 'x' }, 'Archive failed']]) {
    const s = start('en', [topic('mine')], { archiveReply: { ok: false, body } })
    s.rightClick('mine')
    s.click({ '[data-sx-archive]': { dataset: { sxArchive: 'mine' } } })
    s.answer(true)
    await tick(); await tick(); await tick()
    assert.deepEqual(s.alerts, [said])
    assert.ok(!s.calls.some((c) => c.url === '/app/topics.json'))
  }
})
