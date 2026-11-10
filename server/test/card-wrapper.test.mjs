import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import fs from 'node:fs'
import { cardWrapper, CARD_THEMES } from '../src/card-wrapper.ts'

function frame() {
  const parent = {}, listeners = {}, posts = [], properties = {}, observed = []
  parent.postMessage = (data, origin) => posts.push({ data, origin })
  const document = { documentElement: { scrollHeight: 200, style: { setProperty: (k,v) => { properties[k] = v } } }, body: { scrollHeight: 250 } }
  const html = cardWrapper('<svg>chart</svg>', 'https://scorpio.test', 'light')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  class ResizeObserver { constructor(fn) { this.fn = fn } observe(node) { observed.push(node); this.fn() } }
  vm.runInNewContext(script, { parent, document, ResizeObserver, addEventListener: (name, fn) => { listeners[name] = fn } })
  return { parent, listeners, posts, properties, observed, document, html }
}
test('wrapper executes its size/ready/ping/theme bridge only with the parent origin', () => {
  const f = frame()
  f.listeners.load()
  assert.equal(f.observed[0], f.document.body)
  assert.ok(f.posts.some(x => x.data.type === 'scorpio:size' && x.data.height === 250))
  assert.equal(f.posts.at(-1).data.type, 'scorpio:ready')
  assert.ok(f.posts.every(x => x.origin === 'https://scorpio.test'))
  const send = (data, origin = 'https://scorpio.test', source = f.parent) => f.listeners.message({ data, origin, source })
  send({ type: 'scorpio:theme', theme: 'dark' }, 'https://evil.test')
  send({ type: 'scorpio:theme', theme: 'dark' }, undefined, {})
  assert.deepEqual(f.properties, {})
  send({ type: 'scorpio:theme', theme: 'dark' })
  assert.deepEqual(f.properties, CARD_THEMES.dark)
  send({ type: 'scorpio:ping', n: 'fresh' })
  assert.equal(f.posts.at(-1).data.type, 'scorpio:pong')
  assert.equal(f.posts.at(-1).data.n, 'fresh')
})
test('script or resource errors before load suppress ready', () => {
  for (const event of ['error', 'unhandledrejection']) {
    const f = frame()
    f.listeners[event]()
    f.listeners.load()
    assert.equal(f.posts.some(x => x.data.type === 'scorpio:ready'), false)
  }
})
test('wrapper keeps the fragment and escapes parent strings; all theme tokens exist and use page colours', () => {
  const css = fs.readFileSync(new URL('../../web/public/static/room-tokens.css', import.meta.url), 'utf8')
  for (const values of Object.values(CARD_THEMES)) {
    for (const key of ['fg', 'muted', 'border', 'grid', 'bg', 'font', 'font-size', 's1', 's2', 's3', 's4', 's5', 's6']) assert.ok(`--sc-${key}` in values)
    for (const value of Object.values(values).filter(v => v.startsWith('#'))) assert.ok(css.includes(value), value)
    assert.equal(values['--sc-bg'], 'transparent')
  }
  const html = cardWrapper('<svg id="chart"></svg>', 'https://test/</script>', 'light')
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<svg id="chart"><\/svg>/)
  assert.equal(html.includes('https://test/</script>'), false)
})
