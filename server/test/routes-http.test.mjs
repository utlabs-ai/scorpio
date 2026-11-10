import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { worker, ORIGIN } from './helpers/worker.mjs'

const UNKNOWN = '______________________'
const check = async (res, status, needle, path = '') => {
  const body = await res.text()
  assert.equal(res.status, status, `${path}: ${body.slice(0, 240)}`)
  assert.ok(body.includes(needle), `${path}: expected ${JSON.stringify(needle)} in ${body.slice(0, 300)}`)
}

test('public, signed-in, and agent routes reach their own handlers', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops')
    const room = await w.topic(p)
    assert.equal((await w.join(p, room, 'worker')).status, 200)
    const web = p.web, api = p.api

    for (const [path, status, body] of [
      ['/', 303, ''], ['/login', 303, ''], ['/lang?to=zh', 303, ''], ['/signup', 410, 'Scorpio'],
      ['/home', 200, '"mine"'], ['/app', 200, 'Scorpio'], ['/app/new', 200, 'Scorpio'],
      ['/app/topics.json', 200, '"topics"'], ['/search?q=none', 200, '"rooms"'],
      ['/settings', 200, 'Scorpio'], ['/settings/drive', 303, ''], ['/settings/invite', 404, 'Not found.'],
      ['/devices', 303, ''], ['/me/data', 200, 'Scorpio'], ['/activate', 200, 'Scorpio'],
      ['/billing/done', 200, 'Scorpio'], ['/admin', 200, 'Scorpio'], ['/admin/stats', 303, ''],
      [`/r/${room}`, 200, 'Scorpio'], [`/r/${room}/history`, 200, '"'],
      [`/r/${room}/around?seq=1`, 200, '"'], [`/r/${room}/search?q=none`, 200, '"'],
      [`/r/${room}/files`, 200, '"'], [`/r/${room}/todo`, 200, '"'],
      [`/r/${room}/schedules`, 200, '"'], [`/r/${room}/mentions`, 200, '"'],
      [`/r/${room}/handoff?name=worker@ops`, 200, 'Scorpio'],
    ]) {
      const res = await web(path)
      await check(res, status, body, path)
    }
    for (const [path, status, body] of [
      ['/config/keys', 200, '"keys"'], ['/whoami', 200, '"account"'], ['/rooms', 200, '"rooms"'],
      [`/rooms/${room}/files`, 200, '"'], [`/rooms/${room}/messages`, 200, '"'],
      [`/rooms/${room}/search?q=none`, 200, '"'], [`/rooms/${room}/listen`, 200, '"'],
      [`/rooms/${room}/todo`, 200, '"'], [`/rooms/${room}/schedules`, 200, '"'],
      [`/rooms/${room}/members`, 200, '"'], [`/rooms/${room}/handoff?name=worker@ops`, 404, 'handoff_not_found'],
    ]) await check(await api(path, {}, 'worker'), status, body, path)

    await check(await web('/no-such-page'), 404, 'Not found.')

    await check(await p.post('/app/pin', { topicId: room, pinned: true }), 200, '"')
    await check(await p.post('/settings/handoff', { local: true }), 200, '"local":true')
    await check(await p.post('/settings/invite-code', { code: 'bogus' }), 404, '')
    await check(await p.post(`/r/${room}/mark`, { upTo: 0 }), 200, '"')
    await check(await p.apiPost(`/rooms/${room}/mark`, { upTo: 0 }, 'worker'), 200, '"')
  } finally { await w.dispose() }
})

test('gates and path-based errors retain precedence without JSON request headers', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops')
    const room = await w.topic(p)
    const missing = `${ORIGIN}/r/${UNKNOWN}`
    const jsonErr = async (path, status, error) => {
      const r = await p.web(path)
      assert.equal(r.status, status)
      assert.match(r.headers.get('content-type') || '', /application\/json/)
      assert.equal((await r.json()).error, error)
    }
    await jsonErr(`/r/${UNKNOWN}/history`, 404, 'room_not_found')
    await jsonErr(`/r/${UNKNOWN}/send`, 404, 'room_not_found')
    await jsonErr('/search?q=x', 400, 'bad_request')
    const page = await p.web(`/r/${UNKNOWN}`, { headers: { accept: 'application/json' } })
    assert.equal(page.status, 404)
    assert.match(page.headers.get('content-type') || '', /text\/html/)
    const postPage = await p.web(`/r/${UNKNOWN}`, { method: 'POST', body: '{}', headers: { origin: ORIGIN, accept: 'application/json' } })
    assert.equal(postPage.status, 404)
    assert.match(postPage.headers.get('content-type') || '', /text\/html/)
    await check(await p.web(`/r/${room}/ws`), 426, 'expected websocket')
    await jsonErr(`/r/${room}/send/anything`, 404, 'bad_request')
    const unknownApi = await w.fetch('/api/v1/nope')
    assert.equal(unknownApi.status, 401)
    assert.equal((await unknownApi.json()).error, 'not_logged_in')
    await check(await w.fetch('/api/v1/config/keys'), 200, '"keys"')
    const old = await w.fetch('/api/v1/config/keys', { headers: { 'x-scorpio-cli': '0.1.0' } })
    assert.equal(old.status, 426)
    assert.equal((await old.json()).error, 'upgrade_required')
    const noRole = await p.api(`/rooms/${room}/messages`)
    assert.equal(noRole.status, 400)
    assert.equal((await noRole.json()).error, 'role_unknown')
    const join = await p.apiPost(`/rooms/${room}/join`, { role: 'another' })
    assert.equal(join.status, 200)
    const rejoin = await p.apiPost(`/rooms/${room}/rejoin`)
    assert.notEqual(rejoin.status, 400)
    const cross = await p.web(`/r/${room}/schedules`, { method: 'POST', body: '{}', headers: { origin: 'https://elsewhere.test' } })
    assert.equal(cross.status, 403)
    assert.equal((await cross.json()).error, 'forbidden')
    const admin = await p.web('/admin', { method: 'POST', headers: { origin: 'https://elsewhere.test' } })
    assert.equal(admin.status, 404)
    const snapshot = await w.fetch(`/r/${room}`)
    assert.equal(snapshot.status, 303, 'without a KV snapshot the signed-out request falls through')
    const signedOutPost = await w.fetch('/rooms', { method: 'POST', headers: { origin: ORIGIN }, body: '{}' })
    assert.equal(signedOutPost.status, 401)
    assert.equal((await signedOutPost.json()).error, 'not_logged_in')
    const fileTicket = await p.web('/v/______________________/ticket')
    assert.equal(fileTicket.status, 404)
    assert.match(fileTicket.headers.get('content-type') || '', /application\/json/)
    const dev = await w.fetch('/auth/dev', { method: 'POST', body: JSON.stringify({ key: 'bad', email: 'x@y.z' }), headers: { origin: ORIGIN, 'content-type': 'application/json' } })
    assert.equal(dev.status, 404)
  } finally { await w.dispose() }
})

test('negotiated thrown errors answer HTML or JSON from headers', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops')
    const bad = await p.web('/r/______________________/delete')
    assert.equal(bad.status, 404)
    assert.match(bad.headers.get('content-type') || '', /text\/html/)
    const asJson = await p.web('/r/______________________/delete', { headers: { accept: 'application/json' } })
    assert.equal(asJson.status, 404)
    assert.equal((await asJson.json()).error, 'room_not_found')
  } finally { await w.dispose() }
})

test('every room-sub path keeps its error format even when lookup throws before routing', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops')
    for (const sub of ['send', 'mark', 'todo', 'schedules', 'code', 'topic', 'roleCard', 'lane', 'visibility', 'remove', 'removeComputer', 'leave', 'archive', 'history', 'around', 'mentions', 'search', 'ws', 'files', 'handoffDelete', 'schedules/abc']) {
      const res = await p.web(`/r/${UNKNOWN}/${sub}`)
      assert.equal(res.status, 404, sub)
      assert.match(res.headers.get('content-type') || '', /application\/json/, sub)
      assert.equal((await res.json()).error, 'room_not_found', sub)
    }
    for (const sub of ['enter', 'handoff', 'view', 'delete', 'anything', 'send/extra', 'handoff/extra']) {
      const path = `/r/${UNKNOWN}/${sub}`
      const html = await p.web(path)
      assert.equal(html.status, 404, sub)
      assert.match(html.headers.get('content-type') || '', /text\/html/, sub)
      const asJson = await p.web(path, { headers: { accept: 'application/json' } })
      assert.equal(asJson.status, 404, sub)
      assert.equal((await asJson.json()).error, 'room_not_found', sub)
    }
  } finally { await w.dispose() }
})

test('a signed-out snapshot never replaces the signed-in topic page', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    await w.kv.put(`public:${room}`, JSON.stringify({ name: 'Snapshot marker', topic: '', archived: false, total: 0, messages: [] }))
    const signedOut = await w.fetch(`/r/${room}`)
    assert.equal(signedOut.status, 200)
    assert.equal(signedOut.headers.get('cache-control'), 'private, no-store')
    assert.match(await signedOut.text(), /Snapshot marker/)
    await w.kv.delete(`public:${room}`)
    const cached = await w.fetch(`/r/${room}`)
    assert.equal(cached.status, 200, 'the internal render cache is still used')
    assert.equal(cached.headers.get('cache-control'), 'private, no-store')
    assert.match(await cached.text(), /Snapshot marker/)
    const signedIn = await p.web(`/r/${room}`)
    assert.equal(signedIn.status, 200)
    assert.doesNotMatch(await signedIn.text(), /Snapshot marker/)
  } finally { await w.dispose() }
})

test('stage-one routes and agent config do not parse an unrelated malformed cookie', async () => {
  const w = await worker()
  try {
    const headers = { cookie: 'x=%E0' }
    await check(await w.fetch('/api/v1/config/keys', { headers }), 200, '"keys"')
    const device = await w.fetch('/oauth/device/code', { method: 'POST', headers, body: '{}' })
    assert.equal(device.status, 200)
    assert.ok((await device.json()).device_code)
    const webhook = await w.fetch('/billing/creem/webhook', { method: 'POST', headers, body: '{}' })
    assert.equal(webhook.status, 401)
    assert.match(await webhook.text(), /signature/i)
    const canonical = await w.fetch('https://other.test/login', { headers })
    assert.equal(canonical.status, 301)
    assert.equal(canonical.headers.get('location'), `${ORIGIN}/login`)
  } finally { await w.dispose() }
})

test('without a website of its own, / is the app and no page links to pricing, terms or a changelog', async () => {
  const w = await worker()
  try {
    const home = await w.fetch('/')
    assert.equal(home.status, 303)
    assert.equal(home.headers.get('location'), '/app')
    const p = await w.person('ops')
    const pages = [await (await w.fetch('/login')).text(), await (await p.web('/settings')).text(), await (await p.web('/no-such-page')).text()]
    for (const html of pages) {
      for (const link of ['href="/pricing"', 'href="/privacy"', 'href="/terms"', 'href="/changelog"', 'mailto:support@']) assert.ok(!html.includes(link), link)
    }
    assert.ok(pages[0].includes('href="https://github.com/utlabs-ai/scorpio"'))
    const version = JSON.parse(fs.readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8')).version
    assert.ok(pages[1].includes(`<span class="v">${version}</span>`))
    for (const path of ['/pricing', '/privacy', '/changelog', '/robots.txt']) assert.equal((await p.web(path)).status, 404, path)
  } finally { await w.dispose() }
})

const snapshotFaults = `
export class SnapshotTestRoom extends RoomDO {
  async testWriteSnapshot() { await this.writeSnapshot(); }
  async testKv(k) { return this.ctx.storage.kv.get(k) ?? null; }
  async testArmFailures() {
    const env = this.env;
    let deletes = 1, writes = 1;
    this.env = { ...env,
      KV: { get: (...a) => env.KV.get(...a), put: (...a) => env.KV.put(...a), delete: async (...a) => {
        if (deletes-- > 0) throw Error('snapshot test KV delete failed once');
        return env.KV.delete(...a);
      } },
      DB: { prepare: (sql) => {
        const statement = env.DB.prepare(sql);
        if (!sql.startsWith('UPDATE rooms SET visibility = ?')) return statement;
        return { bind: (...a) => ({ run: async () => {
          if (writes-- > 0) throw Error('snapshot test D1 visibility write failed once');
          return statement.bind(...a).run();
        } }) };
      } },
    };
  }
  async testRunSnapshotAlarm() {
    this.ctx.storage.kv.put('publicDue', Date.now());
    await this.alarm();
    if (this.nextDue() === Infinity) await this.ctx.storage.deleteAlarm();
  }
}
`

test('a cached public snapshot is withheld after making the topic private despite a failed KV delete', async () => {
  const w = await worker({}, { append: snapshotFaults, className: 'SnapshotTestRoom' })
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    const stub = (await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room)
    await stub.testWriteSnapshot()
    const publicPage = await w.fetch(`/r/${room}`)
    assert.equal(publicPage.status, 200)
    assert.match(await publicPage.text(), /Route test topic/)
    await stub.testArmFailures()
    const changed = await p.post(`/r/${room}/visibility`, { public: false })
    assert.equal(changed.status, 200)
    assert.ok(await w.kv.get(`public:${room}`), 'failed delete leaves a real stale KV snapshot')
    assert.equal(await stub.testKv('publicSnap'), 1, 'the retry marker survives failure')
    const hidden = await w.fetch(`/r/${room}`)
    assert.equal(hidden.status, 303, 'D1 must be checked before the warmed page cache')
    assert.doesNotMatch(await hidden.text(), /Route test topic/)
    assert.ok(await w.kv.get(`public:${room}`), 'anonymous refusal leaves KV cleanup to the topic alarm')
    await stub.testRunSnapshotAlarm() // Injected D1 failure must leave the alarm armed.
    assert.ok(await stub.testKv('publicDue'))
    const deadline = Date.now() + 15_000
    while ((await stub.testKv('publicDue')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await w.kv.get(`public:${room}`), null)
    assert.equal(await stub.testKv('publicSnap'), null)
    assert.equal(await stub.testKv('snapshot:privateIndexPending'), null)
    assert.equal(await stub.testKv('publicDue'), null)
    assert.equal((await w.db.prepare('SELECT visibility FROM rooms WHERE id = ?').bind(room).first()).visibility, 'private')
  } finally { await w.dispose() }
})

test('the snapshot alarm repairs stale D1 visibility even before the first snapshot exists', async () => {
  const w = await worker({}, { append: snapshotFaults, className: 'SnapshotTestRoom' })
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    const stub = (await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room)
    await stub.testArmFailures()
    const result = await stub.setVisibility({ kind: 'human', account: 'ops', name: 'ops' }, false, '234-567-89A')
    assert.ok(result.ok)
    assert.equal((await w.db.prepare('SELECT visibility FROM rooms WHERE id = ?').bind(room).first()).visibility, 'link', 'simulate the visibility action leaving its index behind')
    await stub.testRunSnapshotAlarm()
    assert.ok(await stub.testKv('snapshot:privateIndexPending'), 'D1 failure retains its durable pending flag')
    await stub.testRunSnapshotAlarm()
    assert.equal((await w.db.prepare('SELECT visibility FROM rooms WHERE id = ?').bind(room).first()).visibility, 'private')
    assert.equal(await stub.testKv('publicDue'), null)
    assert.equal(await stub.testKv('snapshot:privateIndexPending'), null)
    assert.equal((await w.fetch(`/r/${room}`)).status, 303)
  } finally { await w.dispose() }
})

test('deleted, missing and private D1 topics do not serve leftover snapshots', async () => {
  const w = await worker()
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    for (const state of ['archived', 'deleted', 'private', 'missing']) {
      const id = state === 'missing' ? UNKNOWN : room
      await w.kv.put(`public:${id}`, JSON.stringify({ name: 'Stale marker', topic: '', archived: false, total: 0, messages: [] }))
      if (state === 'private') await w.db.prepare("UPDATE rooms SET status = 'active', visibility = 'private' WHERE id = ?").bind(room).run()
      else if (state !== 'missing') await w.db.prepare('UPDATE rooms SET status = ? WHERE id = ?').bind(state, room).run()
      const page = await w.fetch(`/r/${id}`)
      assert.equal(page.status, state === 'archived' ? 200 : 303, state)
      if (state === 'archived') assert.match(await page.text(), /Stale marker/)
      else assert.doesNotMatch(await page.text(), /Stale marker/)
    }
  } finally { await w.dispose() }
})

test('making a private topic public again cancels the old private-index repair', async () => {
  const w = await worker({}, { append: snapshotFaults, className: 'SnapshotTestRoom' })
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    const stub = (await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room)
    assert.equal((await p.post(`/r/${room}/visibility`, { public: false })).status, 200)
    assert.ok(await stub.testKv('snapshot:privateIndexPending'))
    assert.equal((await p.post(`/r/${room}/visibility`, { public: true })).status, 200)
    assert.equal(await stub.testKv('snapshot:privateIndexPending'), null)
    await stub.testRunSnapshotAlarm()
    assert.equal((await w.db.prepare('SELECT visibility FROM rooms WHERE id = ?').bind(room).first()).visibility, 'link')
    const page = await w.fetch(`/r/${room}`)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('cache-control'), 'private, no-store')
    const { keys } = await w.kv.list({ prefix: `public:${room}` })
    assert.ok(keys[0].expiration >= Math.floor(Date.now() / 1000) + 86390, 'real KV writes carry the one-day expiration')
  } finally { await w.dispose() }
})
