import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { worker } from './helpers/worker.mjs'
import { ROOM_STRINGS } from '../src/strings.ts'
import { DEFAULT_SPAWN } from '../src/spawn-config.ts'

const perm = { level: 'auto', from: 'parent', parent: 'lead@kai' }
const boot = (html) => JSON.parse(/<script type="application\/json" id="boot">(.*?)<\/script>/.exec(html)[1])

test('existing accounts default to all, save all three levels, reject invalid values and require session + same origin', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), mei = await w.person('mei')
    assert.equal((await w.fetch('/api/v1/account/spawn-perm')).status, 401)
    assert.equal((await kai.web('/api/v1/account/spawn-perm')).status, 401, 'a web session is not an agent token')
    assert.deepEqual(await (await kai.api('/account/spawn-perm')).json(), { perm: 'all' })
    assert.equal((await w.db.prepare('SELECT spawn_perm FROM users WHERE id = ?').bind(kai.id).first()).spawn_perm, 'all')
    for (const value of ['ask', 'auto', 'all']) {
      assert.deepEqual(await (await kai.post('/settings/spawn-perm', { perm: value })).json(), { perm: value })
      const res = await kai.api('/account/spawn-perm')
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await res.json(), { perm: value }, 'read reflects every save without a cache')
    }
    for (const value of ['default', '', 'ALL', null, 1, {}, ['ask']]) {
      const res = await kai.post('/settings/spawn-perm', { perm: value })
      assert.equal(res.status, 400)
      assert.equal((await res.json()).error, 'bad_request')
    }
    assert.equal((await kai.post('/settings/spawn-perm', { perm: 'ask' }, { origin: 'https://other.test' })).status, 403)
    assert.notEqual((await w.fetch('/settings/spawn-perm', { method: 'POST', headers: { origin: 'https://scorpio.test' }, body: '{"perm":"ask"}' })).status, 200)
    assert.equal((await kai.apiPost('/settings/spawn-perm', { perm: 'ask' })).status, 404)
    assert.deepEqual(await (await mei.api('/account/spawn-perm')).json(), { perm: 'all' })
  } finally { await w.dispose() }
})

test('settings renders the KV labels and hints, escapes markup, and room boot carries the current setting', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai')
    const options = DEFAULT_SPAWN.perm.map((p) => ({ ...p, label: { en: `KV ${p.id}`, zh: `KV档 ${p.id}` }, about: { en: '<img src=x onerror=alert(1)> --permission-mode auto', zh: 'KV提示 --permission-mode auto' } }))
    await w.kv.put('config:spawn', JSON.stringify({ ...DEFAULT_SPAWN, perm: options }))
    await kai.post('/settings/spawn-perm', { perm: 'auto' })
    for (const lang of ['zh', 'en']) {
      const html = await (await kai.web('/settings', { headers: { cookie: kai.cookie + `; lang=${lang}` } })).text()
      assert.ok(html.indexOf('id="notifications"') < html.indexOf('id="spawn-perm"'))
      assert.ok(html.indexOf('id="spawn-perm"') < html.indexOf('id="appearance"'))
      assert.match(html, /name="spawn-perm" value="auto" checked/)
      assert.equal((html.match(/name="spawn-perm"/g) || []).length, 3)
      for (const p of options) assert.ok(html.includes(p.label[lang]))
      assert.match(html, /<code>--permission-mode auto<\/code>/)
      assert.doesNotMatch(html, /<img src=x/)
      assert.equal(boot(html).S.setSpawnPermSaved, ROOM_STRINGS[lang].setSpawnPermSaved)
    }
    const room = await w.topic(kai)
    assert.equal(boot(await (await kai.web(`/r/${room}`)).text()).spawnPerm, 'auto')
  } finally { await w.dispose() }
})

async function socket(response) {
  assert.equal(response.status, 101)
  const ws = response.webSocket, frames = [], waits = []
  ws.addEventListener('message', (e) => {
    const frame = JSON.parse(e.data)
    const i = waits.findIndex((p) => p.type === frame.type && p.match(frame))
    if (i < 0) frames.push(frame)
    else { const p = waits.splice(i, 1)[0]; clearTimeout(p.timer); p.resolve(frame) }
  })
  ws.accept()
  return { ws, discard: () => { frames.length = 0 }, next: (type, match = () => true) => {
    const i = frames.findIndex((f) => f.type === type && match(f))
    if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0])
    return new Promise((resolve, reject) => waits.push({ type, match, resolve, timer: setTimeout(() => reject(Error(`No ${type} frame`)), 5000) }))
  } }
}

test('only host carry writes own active agents; bad entries clear safely, missing entries clear, left members retain their last level', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), mei = await w.person('mei'), room = await w.topic(kai)
    await mei.post(`/r/${room}/enter`)
    for (const role of ['api', 'helper']) await w.join(kai, room, role)
    await w.join(mei, room, 'api')
    const host = await w.json(await kai.apiPost(`/rooms/${room}/join`, { host: true, machine: 'box.local', perms: ['ask', 'auto', 'all', 'default', 42, 'all'] }))
    const role = host.name.split('@')[0]
    const list = async (who = kai) => (await (await who.api(`/rooms/${room}/members?status=all`, {}, who === kai ? 'helper' : 'api')).json()).members
    const member = async (name = 'api@kai', who = kai) => (await list(who)).find((m) => m.name === name)
    assert.deepEqual((await member(host.name)).perms, ['ask', 'auto', 'all'])
    const s = await socket(await kai.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, role))
    const carry = async (entries, names = ['api@kai']) => {
      s.ws.send(JSON.stringify({ type: 'carry', names, ...(entries === undefined ? {} : { perm: entries }) }))
      return s.next('carried')
    }
    const result = await carry({ 'api@kai': perm, 'api@mei': perm, 'kai': perm }, ['api@kai', 'api@mei', 'kai'])
    assert.deepEqual(result.names, ['api@kai'])
    assert.deepEqual((await member()).perm, perm)
    assert.equal((await member('api@mei', mei)).perm, null)
    assert.equal((await member('api@kai', mei)).perm, null)
    assert.equal((await member(host.name, mei)).perms, null)
    await kai.apiPost(`/rooms/${room}/join`, { role: 'api', resume: true, perm: { level: 'all', from: 'spawn', parent: null }, perms: ['all'] })
    await kai.apiPost(`/rooms/${room}/send`, { text: '@helper@kai hello', perm: { level: 'all', from: 'spawn', parent: null } }, 'api')
    assert.deepEqual((await member()).perm, perm, 'agent requests cannot overwrite it')
    assert.equal((await member()).perms, null)
    const agent = await socket(await kai.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, 'api'))
    agent.ws.send(JSON.stringify({ type: 'carry', names: ['helper@kai'], perm: { 'helper@kai': perm } }))
    assert.equal((await member('helper@kai')).perm, null)
    await carry(undefined)
    assert.equal((await member()).perm, null, 'manual restart of the same name clears its former spawn permission')
    for (const bad of [{ ...perm, level: 'default' }, { ...perm, from: 'unknown' }, { ...perm, parent: 1 }, { level: 'ask', from: 'setting' }, [], 'all']) {
      await carry({ 'api@kai': perm, 'helper@kai': bad }, ['api@kai', 'helper@kai'])
      assert.deepEqual((await member()).perm, perm, 'one malformed entry does not reject carry')
      assert.equal((await member('helper@kai')).perm, null)
    }
    await kai.apiPost(`/rooms/${room}/leave`, {}, 'api')
    assert.equal((await member()).status, 'left')
    await carry({}, ['api@kai'])
    assert.deepEqual((await member()).perm, perm, 'left seat keeps its last value for takeover')
    await kai.apiPost(`/rooms/${room}/join`, { host: true, machine: 'box.local', resume: true })
    assert.equal((await member(host.name)).perms, null, 'an older daemon rejoining does not advertise new capabilities')
  } finally { await w.dispose() }
})

// Browser control logic in isolation: an unsuccessful POST restores the last saved radio, and allows a retry.
test('settings radios POST immediately, show saved, and restore the previous choice on HTTP or network errors', async () => {
  const source = fs.readFileSync(new URL('../../web/public/static/settings.js', import.meta.url), 'utf8')
  for (const failure of ['http', 'network']) {
    const choices = ['all', 'ask', 'auto'].map((value) => ({ value, checked: value === 'all', disabled: false, addEventListener(k, f) { this[k] = f } }))
    const classes = new Set(), result = { hidden: true, textContent: '', classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } }
    let fail = false, calls = []
    const document = { documentElement: { lang: 'zh-CN', dataset: {} }, addEventListener() {},
      querySelectorAll: (s) => s === 'input[name="spawn-perm"]' ? choices : [],
      getElementById: (id) => id === 'boot' ? { textContent: JSON.stringify({ S: ROOM_STRINGS.zh }) } : id === 'spawn-perm-result' ? result : null }
    const fetch = async (url, options) => {
      calls.push([url, options])
      if (fail && failure === 'network') throw Error('offline')
      return { ok: !fail, json: async () => fail ? { error: 'failed' } : { perm: JSON.parse(options.body).perm } }
    }
    vm.runInNewContext(source, { document, window: { addEventListener() {} }, location: { hash: '' }, navigator: { userAgent: '', platform: '' }, fetch })
    choices[1].checked = true; choices[0].checked = false; choices[1].change()
    assert.ok(choices.every((c) => c.disabled))
    await new Promise(setImmediate)
    assert.equal(calls[0][0], '/settings/spawn-perm')
    assert.equal(calls[0][1].method, 'POST')
    assert.deepEqual(JSON.parse(calls[0][1].body), { perm: 'ask' })
    assert.equal(result.textContent, ROOM_STRINGS.zh.setSpawnPermSaved)
    assert.ok(classes.has('ok'))
    assert.ok(!classes.has('err'))
    fail = true; choices[2].checked = true; choices[1].checked = false; choices[2].change()
    await new Promise(setImmediate)
    assert.equal(result.textContent, '没存上，再点一次')
    assert.ok(classes.has('err'))
    assert.ok(!classes.has('ok'))
    assert.deepEqual(choices.map((c) => c.checked), [false, true, false])
    assert.ok(choices.every((c) => !c.disabled))
  }
})


test('carry permission changes and clearing broadcast fresh members to the page and room to the daemon', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), room = await w.topic(kai)
    await w.join(kai, room, 'api')
    const host = await w.json(await kai.apiPost(`/rooms/${room}/join`, { host: true, machine: 'box.local', perms: ['ask', 'auto', 'all'] }))
    const daemon = await socket(await kai.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, host.name.split('@')[0]))
    const page = await socket(await kai.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: 'https://scorpio.test' } }))
    await page.next('hello')
    await daemon.next('room')
    for (const value of [perm, null]) {
      daemon.discard(); page.discard()
      daemon.ws.send(JSON.stringify({ type: 'carry', names: ['api@kai'], ...(value ? { perm: { 'api@kai': value } } : {}) }))
      await daemon.next('carried')
      for (const [s, type] of [[page, 'members'], [daemon, 'room']]) {
        const frame = await s.next(type, (f) => JSON.stringify(f.members.find((m) => m.name === 'api@kai').perm) === JSON.stringify(value))
        assert.deepEqual(frame.members.find((m) => m.name === 'api@kai').perm, value)
      }
    }
  } finally { await w.dispose() }
})
