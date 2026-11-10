import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const built = await build({ entryPoints: [new URL('../src/room-page.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false })
const { roomPage } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
test('the mention toggle controls the single feed and keeps the jump controls in the page', async () => {
  const html = await roomPage('en', { id: 'qa', handle: 'qa-kai' }, { id: 'r1', name: 'Topic', topic: '' }, {}).text()
  assert.match(html, /id="mention-only"[^>]*aria-controls="feed"/)
  assert.doesNotMatch(html, /id="mention-feed"/)
  for (const id of ['feed', 'jump', 'jump-at', 'jump-unread']) assert.match(html, new RegExp(`id="${id}"`))
})

test('a public viewer has no addressed-message filter', async () => {
  const html = await roomPage('en', { id: 'qa', handle: 'qa-viewer' }, { id: 'r1', name: 'Topic', topic: '' }, { member: false }).text()
  assert.doesNotMatch(html, /id="mention-only"|class="feed-filters"/)
  assert.match(html, /id="feed"/)
})

test('the spawn card stylesheet precedes approvals, memo follows approvals and cards, and the composer script order holds', async () => {
  const html = await roomPage('en', { id: 'qa', handle: 'qa-kai' }, { id: 'r1', name: 'Topic', topic: '' }, {}).text()
  assert.doesNotMatch(html, /spawn-steps\.css/)
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"?]+)/g)].map(m => m[1])
  assert.deepEqual(styles.slice(-5, -1), ['/static/spawn-card.css', '/static/room-approvals.css', '/static/room-ai-cards.css', '/static/room-memo.css'])
  assert.equal(styles.at(-1), '/static/workspace-panel.css')
  assert.ok(html.indexOf('/static/room-spawn-steps.js') < html.indexOf('/static/room-composer.js'))
  assert.ok(html.indexOf('/static/workspace-panel.js') < html.indexOf('/static/room.js'))
})
