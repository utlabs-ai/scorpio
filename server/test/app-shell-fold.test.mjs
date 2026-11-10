import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const built = await build({ entryPoints: [new URL('../src/app-page.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
const { shellSide } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const themeScript = readFileSync(new URL('../../web/public/static/theme.js', import.meta.url), 'utf8')

for (const [lang, collapse, expand] of [
  ['en', 'Collapse sidebar', 'Open sidebar'],
  ['zh', '收起侧栏', '展开侧栏'],
]) {
  test(`${lang} sidebar buttons and no executable inline script`, () => {
    const html = shellSide(lang, {})
    assert.match(html, new RegExp(`<button type="button"[^>]*data-sx-side-collapse[^>]*aria-expanded="true"[^>]*aria-label="${collapse}"[^>]*title="${collapse}"`))
    assert.match(html, new RegExp(`<button type="button"[^>]*data-sx-side-expand[^>]*aria-expanded="false"[^>]*aria-label="${expand}"[^>]*title="${expand}"`))
    assert.equal((html.match(/<rect x="3\.5" y="5" width="17" height="14" rx="2\.5"\/>/g) || []).length, 2)
    assert.equal((html.match(/<script\b/g) || []).length, 1)
    assert.match(html, /<script type="application\/json" id="sx-boot">/)
  })
}

test('theme.js folds before body only for stored 0 and tolerates blocked storage', () => {
  for (const [stored, folded] of [[null, false], ['1', false], ['0', true], ['throws', false]]) {
    const root = { dataset: {} }
    const document = { documentElement: root, addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [] }
    const window = { matchMedia: () => ({ matches: false, addEventListener: () => {} }) }
    const localStorage = { getItem: (key) => {
      if (stored === 'throws') throw Error('blocked')
      return key === 'scorpio.leftOpen' ? stored : null
    } }
    assert.doesNotThrow(() => vm.runInNewContext(themeScript, { window, document, localStorage }))
    assert.equal(root.dataset.scorpioSide === 'folded', folded, `stored value ${stored}`)
  }
})
