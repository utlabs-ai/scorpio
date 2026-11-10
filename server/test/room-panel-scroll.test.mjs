import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

// The panel's scroll listener in room.js, run on its own: in a sheet the body (.sbody) scrolls, not the panel, and scroll
// does not bubble. @me's next page and closing the link menu hang on this listener.
const source = fs.readFileSync(new URL('../../web/public/static/room.js', import.meta.url), 'utf8')
const block = /\n  panel\.addEventListener\("scroll", [\s\S]*?\n  \}(?:, true)?\);\n/.exec(source)

function setup(kind) {
  const calls = { more: [], closed: 0 }
  const listeners = []
  const panel = { dataset: { kind }, scrollHeight: 600, scrollTop: 0, clientHeight: 600, addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: capture === true || !!(capture && capture.capture) }) } }
  vm.runInNewContext(block[0], { panel, panels: { kind: () => kind }, closeLinkMenu() { calls.closed++ }, loadMentions(reset) { calls.more.push(reset) } })
  const scroll = (target) => listeners.filter((l) => l.type === 'scroll' && (l.capture || target === panel)).forEach((l) => l.fn({ target, type: 'scroll' }))
  const body = (scrollTop) => ({ parentNode: panel, classList: { contains: (c) => c === 'sbody' }, scrollHeight: 3000, clientHeight: 700, scrollTop })
  return { panel, calls, scroll, body }
}

test('the panel scroll listener is in room.js', () => {
  assert.ok(block, 'panel.addEventListener("scroll", …) not found')
})

test('@me: scrolling the sheet body to its end asks for the next page', () => {
  const { calls, scroll, body } = setup('at')
  scroll(body(2250))
  assert.deepEqual(calls.more, [false])
  assert.equal(calls.closed, 1)
})

test('@me: scrolling the sheet body short of its end asks for nothing', () => {
  const { calls, scroll, body } = setup('at')
  scroll(body(1000))
  assert.deepEqual(calls.more, [])
})

test('@me: a code block scrolled sideways inside the list is not the list', () => {
  const { panel, calls, scroll } = setup('at')
  const pre = { parentNode: {}, classList: { contains: () => false }, scrollHeight: 40, clientHeight: 40, scrollTop: 0 }
  scroll(pre)
  assert.deepEqual(calls.more, [])
  assert.equal(calls.closed, 1)
  assert.ok(panel)
})

test('other views never ask for @me pages, but a scroll still closes the link menu', () => {
  for (const kind of ['plan', 'members', 'files']) {
    const { calls, scroll, body } = setup(kind)
    scroll(body(2250))
    assert.deepEqual(calls.more, [], kind)
    assert.equal(calls.closed, 1, kind)
  }
})

test('a view that scrolls the panel itself (invite, settings) still closes the link menu', () => {
  const { panel, calls, scroll } = setup('invite')
  scroll(panel)
  assert.equal(calls.closed, 1)
  assert.deepEqual(calls.more, [])
})
