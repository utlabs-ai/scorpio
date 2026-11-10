import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

const worker = new URL('../../web/public/sw.js', import.meta.url)
const goldenFile = new URL('./push-text.golden.json', import.meta.url)
const room = { id: 'r1', name: 'The room' }
const item = { id: 'T3', title: 'Review the plan' }
const cases = [
  ['todo room no sender', { type: 'todo_assigned', room, item }],
  ['todo no room', { type: 'todo_assigned', item }],
  ['todo sender', { type: 'todo_assigned', room, item, by: 'kai' }],
  ['todo same display', { type: 'todo_assigned', room, item, by: 'kai', byDisplayName: 'kai' }],
  ['todo different display', { type: 'todo_assigned', room, item, by: 'kai', byDisplayName: 'Mei' }],
  ['todo missing item', { type: 'todo_assigned', room, by: 'kai' }],
  ['test', { type: 'test' }],
  ['mention room', { type: 'mention', room }],
  ['mention no room', { type: 'mention' }],
  ['quota room', { type: 'quota_warn', room, used: 90, limit: 100 }],
  ['quota no room', { type: 'quota_warn', used: 90, limit: 100 }],
  ['blocked approval', { type: 'agent_blocked', room, name: 'api@kai', reason: 'approval' }],
  ['blocked approval detail', { type: 'agent_blocked', room, name: 'api@kai', reason: 'approval: Bash rm -rf x' }],
  ['blocked question', { type: 'agent_blocked', room, name: 'api@kai', reason: 'question' }],
  ['blocked prompt', { type: 'agent_blocked', room, name: 'api@kai', reason: 'prompt' }],
  ['blocked empty reason', { type: 'agent_blocked', room, name: 'api@kai', reason: '' }],
  ['blocked missing name', { type: 'agent_blocked', room, reason: 'approval' }],
  ['blocked no room', { type: 'agent_blocked', name: 'api@kai', reason: 'approval' }],
  ['alert text', { type: 'alert', text: 'Disk is almost full.' }],
  ['alert no text', { type: 'alert' }],
  ['unknown type', { type: 'unknown' }],
].map(([name, value], i) => [name, { tag: `tag:${i}`, url: `/r/r1#${i}`, silent: i % 2 === 0, ...value }])

async function shownByWorker(lang, payload) {
  const listeners = {}, calls = []
  const self = {
    navigator: { language: lang },
    addEventListener: (name, fn) => { listeners[name] = fn },
    registration: {
      showNotification: async (title, options) => { calls.push(JSON.parse(JSON.stringify({ title, ...options }))) },
      getNotifications: async () => [],
    },
  }
  vm.runInNewContext(fs.readFileSync(worker, 'utf8'), { self, URL, fetch })
  let pending
  listeners.push({ data: { json: () => payload }, waitUntil: (p) => { pending = p } })
  await pending
  assert.equal(calls.length, 1)
  return calls[0]
}

async function capture() {
  const out = {}
  for (const [name, payload] of cases) {
    out[name] = { en: await shownByWorker('en-US', payload), zh: await shownByWorker('zh-CN', payload) }
  }
  return out
}

if (process.env.UPDATE_PUSH_GOLDEN === '1') {
  fs.writeFileSync(goldenFile, `${JSON.stringify(await capture(), null, 2)}\n`)
}

const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'))

test('server text matches each current zh/en notification in the golden', async () => {
  const { pushText } = await import('../src/push-text.ts')
  for (const [name, payload] of cases) {
    const shown = pushText(payload)
    for (const lang of ['en', 'zh']) {
      assert.equal(shown[lang].title, golden[name][lang].title, `${name} ${lang} title`)
      assert.equal(shown[lang].body ?? (payload.text || ''), golden[name][lang].body, `${name} ${lang} body`)
    }
  }
})

test('the new service worker renders the server text and keeps every notification option', async () => {
  const { pushText } = await import('../src/push-text.ts')
  for (const [name, payload] of cases) {
    for (const [lang, browser] of [['en', 'en-US'], ['zh', 'zh-CN']]) {
      assert.deepEqual(await shownByWorker(browser, { ...payload, shown: pushText(payload) }), golden[name][lang], `${name} ${lang}`)
    }
  }
})

test('a push queued by the old server falls back to Scorpio and its text', async () => {
  const base = { type: 'alert', tag: 'old', url: '/r/r1', text: 'Old alert' }
  for (const lang of ['en-US', 'zh-CN']) {
    const withText = await shownByWorker(lang, base)
    assert.deepEqual([withText.title, withText.body], ['Scorpio', 'Old alert'])
    const withoutText = await shownByWorker(lang, { ...base, text: undefined })
    assert.deepEqual([withoutText.title, withoutText.body], ['Scorpio', ''])
  }
})

test('a phone approval push invites an answer only when a card id exists', async () => {
  const { pushText } = await import('../src/push-text.ts')
  const base = { type: 'agent_blocked', room, name: 'api@kai', reason: 'approval: Bash' }
  assert.deepEqual(pushText({ ...base, approval: 'card-id' }), {
    en: { title: room.name, body: 'api is waiting for your approval (Bash). Tap to answer.' },
    zh: { title: room.name, body: 'api 在等你确认（Bash），点开就能答。' },
  })
})

test('a blocked push without a card keeps its computer instruction', async () => {
  const { pushText } = await import('../src/push-text.ts')
  const shown = pushText({ type: 'agent_blocked', room, name: 'api@kai', reason: 'approval: Bash' })
  assert.equal(shown.en.body, 'api is stuck at an approval (Bash); have a look on that computer.')
  assert.equal(shown.zh.body, 'api 停在审批上（Bash），请到那台电脑查看。')
})
