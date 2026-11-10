// Settings → Devices: the line of what a computer's daemon detected: 「Claude Code 2.1.301 · Codex 未安装 · 检测于 1 小时前」.
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const out = await build({ entryPoints: [new URL('../src/settings-page.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { settingsPage } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)

const HOUR = 3_600_000
const claude = (at) => ({ kind: 'claude', installed: true, version: '2.1.301', at })
const codexNo = (at) => ({ kind: 'codex', installed: false, version: null, at })
async function page(lang, clis) {
  const now = Date.now()
  const devices = [{ id: 'token-one', name: 'work-mac', hostname: 'MBP.local', note: null, device_name: 'MBP.local', created_at: now, last_used_at: now, revoked_at: null, online: true, idleHandoffMinutes: 60, clis: clis(now) }]
  const html = await settingsPage(lang, { handle: 'kai', email: 'kai@x.test' }, {
    drive: null, done: '', displayName: null, devices, providers: [], plan: 'free', trialUntil: null, paid: null,
    limits: { activeRooms: 3, msgsPerRoomDay: 100, msgsPerAccountDay: null, devices: 1 }, space: { used: 0, limit: 1000 },
    activeRooms: 0, messagesToday: 0, visibleRooms: [], invite: null, handoffLocal: false, computers: { n: 1, limit: 1, free: 1, pro: 5 },
  })
  return html.text()
}
const line = (html) => /<div class="l2 clis">([^<]*)<\/div>/.exec(html)?.[1] ?? null

test('the device row says what the daemon detected and how long ago, in both languages', async () => {
  const clis = (now) => [claude(now - HOUR - 60_000), codexNo(now - HOUR - 60_000)]
  assert.equal(line(await page('zh', clis)), 'Claude Code 2.1.301 · Codex 未安装 · 检测于 1\u00a0小时前')
  assert.equal(line(await page('en', clis)), 'Claude Code 2.1.301 · Codex not installed · detected 1\u00a0h ago')
})

test('the device row: nothing installed, a version unknown, minutes and days, and no line for a daemon that never reported', async () => {
  assert.equal(line(await page('en', (now) => [{ ...claude(now - 5 * 60_000), installed: false, version: null }, codexNo(now - 5 * 60_000)])), 'No supported agent detected · detected 5\u00a0min ago')
  assert.equal(line(await page('zh', (now) => [{ ...claude(now), installed: false, version: null }, codexNo(now)])), '未检测到支持的 agent · 检测于 刚刚')
  assert.equal(line(await page('en', (now) => [{ ...claude(now - 3 * 24 * HOUR), version: null }, codexNo(now - 3 * 24 * HOUR)])), 'Claude Code (version unknown) · Codex not installed · detected 3\u00a0d ago')
  assert.equal(line(await page('en', () => null)), null)
  assert.equal(line(await page('en', () => [])), null)
})

test('the detected text cannot carry markup into the page', async () => {
  const html = await page('en', (now) => [{ kind: 'claude', installed: true, version: '<b>1</b>', at: now }])
  assert.ok(!html.includes('<b>1</b>') && html.includes('&lt;b&gt;1&lt;/b&gt;'))
})

test('a computer logged out unexpectedly: the row says so, with a button to approve its relogin code; revoking asks first', async () => {
  const render = async (lang, loggedOut) => {
    const now = Date.now()
    const devices = [{ id: 'token-one', name: 'work-mac', hostname: 'MBP.local', note: null, device_name: 'MBP.local', created_at: now, last_used_at: now, revoked_at: null, online: true, idleHandoffMinutes: 60, clis: null, loggedOut }]
    return (await settingsPage(lang, { handle: 'kai', email: 'kai@x.test' }, {
      drive: null, done: '', displayName: null, devices, providers: [], plan: 'free', trialUntil: null, paid: null,
      limits: { activeRooms: 3, msgsPerRoomDay: 100, msgsPerAccountDay: null, devices: 1 }, space: { used: 0, limit: 1000 },
      activeRooms: 0, messagesToday: 0, visibleRooms: [], invite: null, handoffLocal: false, computers: { n: 1, limit: 1, free: 1, pro: 5 },
    })).text()
  }
  const zh = await render('zh', { at: Date.now(), code: 'BCDF-GHJK' })
  assert.match(zh, /<span class="sd offline"><\/span>.*<span class="st">已掉线 · 等待重新授权<\/span>/s)
  assert.match(zh, /<a class="btn xs" href="\/activate\?code=BCDF-GHJK">重新上线<\/a>/)
  const en = await render('en', { at: Date.now(), code: null })
  assert.match(en, /Logged out · waiting for authorization/)
  assert.ok(!en.includes('/activate?code='), 'no pending code: no button')
  const normal = await render('en', null)
  assert.match(normal, /<span class="st live">Online<\/span>/)
  assert.match(normal, /<form method="post" action="\/devices\/token-one\/revoke\?next=settings" data-confirm-revoke>/)
  const boot = JSON.parse(/<script type="application\/json" id="boot">(.*?)<\/script>/.exec(normal)[1]).S
  assert.deepEqual([boot.revokeTitle, boot.revokeOk, boot.cancel], ['Revoke this computer?', 'Revoke', 'Cancel'])
})
