import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import { worker } from './helpers/worker.mjs'

const vapid = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
const browserKey = crypto.createECDH('prime256v1')
browserKey.generateKeys()
// Catch the real encrypted Web Push request inside the local Worker, never contacting a push service.
const append = `
let pushCount = 0;
const originalFetch = globalThis.fetch;
export class PushProbe extends RoomDO {
  constructor(ctx, env) {
    super(ctx, env);
    globalThis.fetch = async (input, init) => {
      if (String(input?.url || input).startsWith('https://fcm.googleapis.com/')) {
        await env.KV.put('test:pushCount', String(++pushCount));
        return new Response(null, { status: 201 });
      }
      return originalFetch(input, init);
    };
  }
}`
const w = await worker({ VAPID_PRIVATE_JWK: JSON.stringify(vapid) }, { append, className: 'PushProbe' })
test.after(() => w.dispose())
const owner = await w.person('page-owner')
const stranger = await w.person('page-outsider')
const member = await w.person('page-member')
const made = await w.json(await owner.apiPost('/rooms', { name: 'PRIVATE-NAME', topic: 'PRIVATE-DESCRIPTION', code: 'ABC-DEF-GHJ' }))
assert.ok(made.roomId)
const path = `/r/${made.roomId}`
await owner.web(path)
await owner.apiPost(`/rooms/${made.roomId}/join`, { role: 'writer' })
const enter = (person, code = made.code, next) => person.web(`${path}/enter`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, ...(next ? { next } : {}) }).toString(),
})
assert.equal((await enter(member)).status, 303)

const upload = await w.json(await owner.web(`${path}/files`, { method: 'POST', body: '# Private file', headers: { 'content-type': 'text/markdown', 'x-file-name': 'private.md' } }))
assert.ok(upload.id)
await owner.post(`${path}/send`, { text: 'Attached', files: [upload.id] })

test('passcode pages hide topic metadata for topic, attachment, handoff and wrong-code routes', async () => {
  const destinations = [path, `/v/${upload.id}`, `${path}/handoff?name=writer%40page-owner`]
  for (const lang of ['en', 'zh']) {
    for (const destination of destinations) {
      const page = await stranger.web(destination, { headers: { cookie: `${stranger.cookie}; lang=${lang}` } })
      const html = await page.text()
      assert.equal(page.status, 200)
      assert.doesNotMatch(html, /PRIVATE-NAME|PRIVATE-DESCRIPTION/)
      assert.match(html, /<title>Scorpio<\/title>/)
      assert.match(html, /type="password"/)
      assert.ok(html.includes(lang === 'zh' ? '<b>私密主题</b>' : '<b>Private topic</b>'))
      if (destination !== path) assert.match(html, /name="next"/)
    }
  }
  const bad = await enter(stranger, 'WRONG-CODE', `/v/${upload.id}`)
  const html = await bad.text()
  assert.doesNotMatch(html, /PRIVATE-NAME|PRIVATE-DESCRIPTION/)
  assert.match(html, /<title>Scorpio<\/title>/)
  assert.match(html, /sx-bad/)
  assert.match(html, /name="next"/)
  assert.equal((await enter(stranger, made.code, `/v/${upload.id}`)).headers.get('location'), `/v/${upload.id}`)
  assert.match(await (await stranger.web(path)).text(), /PRIVATE-NAME/)
  await stranger.post(`${path}/leave`)
})

test('owner-only refusals hide creator account from outsiders and active non-owners', async () => {
  for (const person of [stranger, member]) {
    for (const [action, body] of [['visibility', { public: true }], ['archive', { archived: true }], ['remove', { account: owner.handle }]]) {
      const result = await w.json(await person.post(`${path}/${action}`, body))
      assert.equal(result.status, 403)
      assert.doesNotMatch(result.next, /page-owner/)
    }
  }
  assert.equal((await owner.post(`${path}/archive`, { archived: true })).status, 200)
  assert.equal((await owner.post(`${path}/archive`, { archived: false })).status, 200)
})

test('non-member role-card probes are refused identically before target lookup', async () => {
  const answers = []
  for (const name of ['writer@page-owner', 'absent@page-owner']) {
    answers.push(await w.json(await stranger.post(`${path}/roleCard`, { name, roleCard: 'probe' })))
  }
  assert.equal(answers[0].status, 403)
  assert.equal(answers[0].error, 'not_member')
  assert.deepEqual(answers[0], answers[1])
})

test('non-member computer probes are refused identically before target lookup', async () => {
  const host = await w.json(await owner.apiPost(`/rooms/${made.roomId}/join`, { host: true, device_id: 'page-device', machine: { name: 'test-computer' } }))
  assert.ok(host.name)
  const answers = []
  for (const name of [host.name, 'absent-daemon@page-owner']) answers.push(await w.json(await stranger.post(`${path}/removeComputer`, { name })))
  assert.equal(answers[0].status, 403)
  assert.equal(answers[0].error, 'not_member')
  assert.deepEqual(answers[0], answers[1])
})

async function pushCount() { return Number(await w.kv.get('test:pushCount') || 0) }
async function waitPush(expected) {
  for (let i = 0; i < 100; i++) {
    if (await pushCount() >= expected) return
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail('Expected local outbound push was not observed')
}

test('task thread pushes stop after leaving or removal and resume after rejoining', async () => {
  const person = await w.person('page-push')
  await enter(person)
  const sub = await person.post('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/local-page-test', keys: { p256dh: browserKey.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
  assert.equal(sub.status, 200)
  const sent = await w.json(await owner.apiPost(`/rooms/${made.roomId}/send`, { text: '@page-push please decide', add: 'Private task', to: person.handle }, 'writer'))
  assert.ok(sent.item)
  await waitPush(1)
  let expected = await pushCount()
  const reply = () => owner.apiPost(`/rooms/${made.roomId}/send`, { text: '@page-push new task reply', replyTo: sent.seq }, 'writer')
  for (const action of ['leave', 'remove']) {
    if (action === 'leave') assert.equal((await person.post(`${path}/leave`)).status, 200)
    else assert.equal((await owner.post(`${path}/remove`, { account: person.handle })).status, 200)
    assert.equal((await reply()).status, 200)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(await pushCount(), expected, `${action}: no push to an inactive task assignee`)
    await enter(person)
    await reply()
    await waitPush(expected + 1)
    expected = await pushCount()
  }
})
