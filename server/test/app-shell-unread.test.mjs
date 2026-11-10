import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

// The left column's unread count: app-shell.js rendered against a stub document, with the page's own strings.
const shell = readFileSync(new URL('../../web/public/static/app-shell.js', import.meta.url), 'utf8')
const built = await build({ entryPoints: [new URL('../src/strings.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { strings } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

function el() {
  const e = {
    innerHTML: '', textContent: '', className: '', dataset: {}, style: {}, scrollTop: 0, children: [],
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {}, appendChild() {}, remove() {}, focus() {},
    querySelector: () => el(), querySelectorAll: () => [], closest: () => null, contains: () => false,
  }
  return e
}

/** Renders the list once for these topics: the side column's and the phone list's HTML. */
function render(lang, topics, current) {
  const side = el(), phone = el()
  const S = strings(lang).shell
  const boot = el()
  boot.textContent = JSON.stringify({ S, lang, topics, me: { handle: 'kai' }, binAfterDays: 30, current })
  const byId = { 'sx-boot': boot, 'sx-list': side, 'sx-ph-groups': phone, 'sx-side': el() }
  const document = {
    ...el(),
    hidden: false, body: el(), documentElement: el(),
    getElementById: (id) => byId[id] || null,
    createElement: () => el(),
    querySelector: (q) => (q === '[data-sx-ask]' ? null : el()),
    querySelectorAll: () => [],
  }
  const window = { matchMedia: () => ({ matches: true, addEventListener() {} }) }
  const storage = { getItem: () => null, setItem() {} }
  vm.runInNewContext(shell, { document, window, localStorage: storage, sessionStorage: storage, setInterval() {}, fetch: () => Promise.reject(new Error('no')), location: {}, navigator: {} })
  return { side: side.innerHTML, phone: phone.innerHTML }
}

const topic = (id, extra) => ({ id, name: id, desc: '', owned: true, active: true, pinnedAt: null, archivedAt: null, archived: false, public: false, lastMs: Date.now(), agents: 0, humans: 1, working: 0, open: 0, mine: 0, mineSince: null, unread: null, mentionUnread: 0, known: true, ...extra })
const badges = (html) => [...html.matchAll(/<span class="sx-unread([^"]*)" title="([^"]*)" aria-label="([^"]*)">([^<]*)<\/span>/g)].map((m) => ({ cls: m[1], title: m[2], label: m[3], text: m[4] }))
const rowOf = (html, id) => html.match(new RegExp(`<div class="sx-trow[^"]*" data-sx-id="${id}">.*?</div>`))[0]

test('a grey count for unread messages, red when one of them @s me, nothing for 0 or null', () => {
  const { side, phone } = render('zh', [topic('a', { unread: 3 }), topic('b', { unread: 3, mentionUnread: 1 }), topic('c', { unread: 0 }), topic('d', { unread: null }), topic('e', {})])
  for (const html of [side, phone]) {
    assert.deepEqual(badges(html), [
      { cls: '', title: '未读 3', label: '未读 3', text: '3' },
      { cls: ' sx-you', title: '未读 3，其中 @你 1', label: '未读 3，其中 @你 1', text: '3' },
    ])
    assert.doesNotMatch(rowOf(html, 'c'), /sx-unread/)
    assert.doesNotMatch(rowOf(html, 'd'), /sx-unread/)
    assert.doesNotMatch(rowOf(html, 'e'), /sx-unread/, 'an old cached row without the fields draws nothing')
  }
  // the count sits before the pill, inside the link
  assert.match(rowOf(side, 'a'), /<span class="sx-nm">a<\/span><span class="sx-unread"[^>]*>3<\/span><span class="sx-pill"/)
  assert.match(rowOf(phone, 'a'), /<\/span><span class="sx-unread"[^>]*>3<\/span><span class="sx-pill"/)
})

test('the topic I am looking at shows no count, and 100 or more reads 99+', () => {
  const { side, phone } = render('en', [topic('here', { unread: 5, mentionUnread: 2 }), topic('many', { unread: 100 }), topic('edge', { unread: 99 })], 'here')
  for (const html of [side, phone]) {
    assert.doesNotMatch(rowOf(html, 'here'), /sx-unread/)
    assert.deepEqual(badges(html), [
      { cls: '', title: '100 unread', label: '100 unread', text: '99+' },
      { cls: '', title: '99 unread', label: '99 unread', text: '99' },
    ])
  }
  assert.match(rowOf(side, 'here'), /sx-on/)
})
