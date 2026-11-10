// The color-scheme meta decides what the browser paints before the stylesheets apply, as on a reload when coming
// back to a page. A theme picked in Scorpio replaces the layout's "light dark"; the system choice keeps it.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const themeScript = readFileSync(new URL('../../web/public/static/theme.js', import.meta.url), 'utf8')

function load(stored, systemDark) {
  const meta = { content: 'light dark' }
  const root = { dataset: {} }
  const document = {
    documentElement: root, addEventListener: () => {}, dispatchEvent: () => {}, querySelectorAll: () => [],
    querySelector: (s) => (s === 'meta[name="color-scheme"]' ? meta : null),
  }
  const window = { matchMedia: () => ({ matches: systemDark, addEventListener: () => {} }) }
  const localStorage = { getItem: (key) => (key === 'scorpio.theme' ? stored : null), setItem: () => {} }
  vm.runInNewContext(themeScript, { window, document, localStorage, Event: class { constructor(t) { this.type = t } } })
  return { meta, root, window }
}

test('a picked theme sets the color-scheme meta; the system choice keeps "light dark"', () => {
  assert.equal(load('light', true).meta.content, 'light')
  assert.equal(load('dark', false).meta.content, 'dark')
  assert.equal(load(null, true).meta.content, 'light dark')
  assert.equal(load('system', false).meta.content, 'light dark')
})

test('changing the setting changes the meta too', () => {
  const h = load(null, true)
  h.window.scorpioThemeSet('light')
  assert.equal(h.meta.content, 'light')
  assert.equal(h.root.dataset.scorpioEffectiveTheme, 'light')
  h.window.scorpioThemeSet('system')
  assert.equal(h.meta.content, 'light dark')
})
