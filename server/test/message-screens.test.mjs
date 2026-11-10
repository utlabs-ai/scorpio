import assert from 'node:assert/strict'
import test from 'node:test'
import { worker, ORIGIN } from './helpers/worker.mjs'
import { messageScreen, screenFor, SCREEN_MAX } from '../src/room-screen.ts'

const screen = { text: 'pane-only-marker <script> & ```\n[hidden]', hidden: 1 }
const actor = (account, role) => ({ kind: role ? 'agent' : 'human', account, name: role ? `${role}@${account}` : account })
const kaiActor = actor('kai')
const options = { className: 'ScreenRoom', append: `
export class ScreenRoom extends RoomDO {
  testSql(query, args = []) { return this.sql.exec(query, ...args).toArray(); }
  testSnapshot() { return this.writeSnapshot(); }
  testWakeAll(from, screen) {
    return this.insertMessage({ from, fromKind: 'host', text: '@api@kai @api@mei screen report', mentions: ['api@kai', 'api@mei'], wake: ['api@kai', 'api@mei'], screen }).seq;
  }
  testAtomic() {
    try { this.insertMessage({ from: 'box-daemon@kai', fromKind: 'host', text: 'atomic-marker', screen: { text: 'rollback-marker', hidden: 0 } }, () => { throw new Error('forced'); }); }
    catch { return true; }
    return false;
  }
}` }

async function fixture(t) {
  const w = await worker({ TEST_LIMITS: JSON.stringify({ self: { msgsPerRoomMinute: 1000 } }) }, options)
  t.after(() => w.dispose())
  const kai = await w.person('kai'), mei = await w.person('mei'), zoe = await w.person('zoe')
  const id = await w.topic(kai)
  await mei.post(`/r/${id}/enter`, {})
  await w.join(kai, id, 'api'); await w.join(mei, id, 'api')
  const ns = await w.mf.getDurableObjectNamespace('ROOMS'), stub = ns.getByName(id)
  const host = async (person) => {
    const joined = await w.json(await person.apiPost(`/rooms/${id}/join`, { role: 'box-daemon', host: true, machine: 'box' }))
    assert.equal(joined.status, 200, JSON.stringify(joined))
    return joined.name.split('@')[0]
  }
  const role = await host(kai), otherRole = await host(mei)
  const send = async (person, role, extra = {}) => w.json(await person.apiPost(`/rooms/${id}/send`, { text: '@kai @mei @api@kai @api@mei screen report', screen, ...extra }, role))
  return { w, kai, mei, zoe, id, stub, role, otherRole, send }
}

async function until(check) {
  const end = Date.now() + 10_000
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
  assert.ok(check(), 'expected socket frame')
}
async function socket(res, t) {
  assert.equal(res.status, 101, await res.text().catch(() => ''))
  const frames = [], ws = res.webSocket
  ws.addEventListener('message', (e) => frames.push(JSON.parse(e.data)))
  ws.accept()
  t.after(() => { try { ws.close() } catch {} })
  return { frames, ws }
}

const hasScreen = (m, own) => {
  if (own) assert.deepEqual(m.screen, screen)
  else assert.equal(Object.hasOwn(m, 'screen'), false)
}

test('screen validation accepts only command seats and checks UTF-8 size and hidden count', () => {
  assert.deepEqual(messageScreen('host', screen), { screen })
  assert.deepEqual(messageScreen('host', undefined), {})
  for (const kind of ['human', 'agent', 'scheduled']) assert.equal(messageScreen(kind, screen).error.code, 'bad_request')
  for (const value of [null, [], 'screen', {}, { text: 1, hidden: 0 }, { text: '', hidden: -1 }, { text: '', hidden: 0.5 }, { text: '', hidden: '0' }, { text: '', hidden: Infinity }, { text: '', hidden: NaN }]) assert.equal(messageScreen('host', value).error.code, 'bad_request')
  assert.ok(messageScreen('host', { text: 'é'.repeat(SCREEN_MAX / 2), hidden: 0 }).screen)
  assert.equal(messageScreen('host', { text: 'é'.repeat(SCREEN_MAX / 2) + 'x', hidden: 0 }).error.code, 'bad_request')
  assert.deepEqual(screenFor({ ...screen, account: 'kai' }, 'kai'), { screen })
  for (const account of ['mei', undefined, null]) assert.deepEqual(screenFor({ ...screen, account: 'kai' }, account), {})
})

test('HTTP send and every read path keep screens with the sending account', async (t) => {
  const { w, kai, mei, zoe, id, stub, role, send } = await fixture(t)
  for (const [person, seat] of [[kai, 'api'], [mei, 'api']]) {
    const refused = await send(person, seat)
    assert.equal(refused.status, 400, JSON.stringify(refused))
    assert.equal(refused.error, 'bad_request')
  }
  assert.equal((await w.json(await kai.post(`/r/${id}/send`, { text: 'screen', screen }))).error, 'bad_request')
  for (const invalid of [{ text: 'é'.repeat(SCREEN_MAX / 2) + 'x', hidden: 0 }, { text: '', hidden: -1 }, null]) assert.equal((await send(kai, role, { screen: invalid })).error, 'bad_request')
  const sent = await send(kai, role, { nonce: 'screen-send' })
  assert.equal(sent.status, 200, JSON.stringify(sent))
  const stored = await stub.testSql('SELECT * FROM message_screens WHERE seq = ?', [sent.seq])
  assert.deepEqual(stored, [{ seq: sent.seq, account: 'kai', ...screen }])
  assert.equal((await send(kai, role, { nonce: 'screen-send' })).seq, sent.seq)
  for (const [person, seat, own] of [[kai, undefined, true], [kai, 'api', true], [mei, undefined, false], [mei, 'api', false], [zoe, undefined, false]]) {
    const one = seat ? await w.json(await person.api(`/rooms/${id}/messages/${sent.seq}`, {}, seat)) : { status: 200, ...(await stub.message(actor(person.handle), sent.seq)).ok }
    assert.equal(one.status, 200, JSON.stringify(one)); hasScreen(one.message, own)
    if (person === zoe) assert.equal((await stub.messages(actor('zoe'), {})).err.code, 'not_member')
    else {
      const list = seat ? await w.json(await person.api(`/rooms/${id}/messages`, {}, seat)) : (await stub.messages(actor(person.handle), {})).ok
      hasScreen(list.messages.find((m) => m.seq === sent.seq), own)
    }
    const history = await w.json(await person.web(`/r/${id}/history?before=999999`))
    hasScreen(history.messages.find((m) => m.seq === sent.seq), own)
    const around = await w.json(await person.web(`/r/${id}/around?seq=${sent.seq}`))
    hasScreen(around.messages.find((m) => m.seq === sent.seq), own)
    if (seat) {
      const listen = await w.json(await person.api(`/rooms/${id}/listen`, {}, seat))
      const pending = [...listen.mentions, ...listen.broadcasts].find((m) => m.seq === sent.seq)
      if (own) hasScreen(pending, true)
      else assert.equal(pending, undefined, 'another account cannot wake this agent')
    }
  }
  const size = await send(kai, role, { screen: { text: 'x'.repeat(SCREEN_MAX), hidden: 0 } })
  assert.equal(size.status, 200, JSON.stringify(size))
  assert.equal((await stub.testSql('SELECT length(text) AS n FROM message_screens WHERE seq = ?', [size.seq]))[0].n, SCREEN_MAX)
  assert.equal(await stub.testAtomic(), true)
  assert.deepEqual(await stub.testSql("SELECT * FROM messages WHERE text = 'atomic-marker'"), [])
  assert.deepEqual(await stub.testSql("SELECT * FROM message_screens WHERE text = 'rollback-marker'"), [])
})

test('browser hello, live frames, agent pushes and carried pending are shaped per account', async (t) => {
  const { w, kai, mei, zoe, id, stub, role, otherRole, send } = await fixture(t)
  const first = await send(kai, role)
  const browsers = []
  for (const person of [kai, mei, zoe]) {
    const s = await socket(await person.web(`/r/${id}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } }), t)
    await until(() => s.frames.some((f) => f.type === 'hello'))
    hasScreen(s.frames.find((f) => f.type === 'hello').messages.find((m) => m.seq === first.seq), person === kai)
    browsers.push(s)
  }
  const agents = []
  for (const person of [kai, mei]) {
    const s = await socket(await person.api(`/rooms/${id}/ws`, { headers: { upgrade: 'websocket' } }, 'api'), t)
    await until(() => s.frames.some((f) => f.type === 'ready'))
    const pending = s.frames.find((f) => f.type === 'ready').pending.find((m) => m.seq === first.seq)
    if (person === kai) hasScreen(pending, true)
    else assert.equal(pending, undefined, 'another account cannot wake this agent')
    agents.push(s)
  }
  // Counterfactual wake list checks account filtering even if an internal caller targets both accounts.
  const second = { seq: await stub.testWakeAll(`${role}@kai`, screen) }
  for (const [i, s] of browsers.entries()) {
    await until(() => s.frames.some((f) => f.type === 'message' && f.message.seq === second.seq))
    hasScreen(s.frames.find((f) => f.type === 'message' && f.message.seq === second.seq).message, i === 0)
  }
  for (const [i, s] of agents.entries()) {
    await until(() => s.frames.some((f) => f.type === 'push' && f.message.seq === second.seq))
    hasScreen(s.frames.find((f) => f.type === 'push' && f.message.seq === second.seq).message, i === 0)
  }
  const hosts = []
  for (const [person, seat] of [[kai, role], [mei, otherRole]]) {
    const s = await socket(await person.api(`/rooms/${id}/ws`, { headers: { upgrade: 'websocket' } }, seat), t)
    await until(() => s.frames.some((f) => f.type === 'ready'))
    s.ws.send(JSON.stringify({ type: 'carry', names: [`api@${person.handle}`] }))
    await until(() => s.frames.some((f) => f.type === 'carried'))
    hasScreen(s.frames.find((f) => f.type === 'carried').pending[`api@${person.handle}`].find((m) => m.seq === second.seq), person === kai)
    hosts.push(s)
  }
  const third = { seq: await stub.testWakeAll(`${role}@kai`, screen) }
  for (const [i, s] of hosts.entries()) {
    await until(() => s.frames.some((f) => f.type === 'push' && f.message.seq === third.seq))
    hasScreen(s.frames.find((f) => f.type === 'push' && f.message.seq === third.seq).message, i === 0)
  }
})

test('screens stay out of search, snapshots and my data, and all deletion paths remove them', async (t) => {
  const { w, kai, mei, id, stub, role, otherRole, send } = await fixture(t)
  const own = await send(kai, role), other = await send(mei, otherRole)
  assert.equal((await stub.testSql("SELECT * FROM messages_fts WHERE text LIKE '%pane-only-marker%'" )).length, 0)
  for (const person of [kai, mei]) {
    const search = await w.json(await person.api(`/rooms/${id}/search?q=pane-only-marker`, {}, 'api'))
    assert.equal(search.status, 200, JSON.stringify(search))
    assert.deepEqual(search.groups.messages, [])
    const ordinarySearch = await w.json(await person.api(`/rooms/${id}/search?q=report`, {}, 'api'))
    assert.equal(ordinarySearch.status, 200, JSON.stringify(ordinarySearch))
    assert.ok(ordinarySearch.groups.messages.length > 0)
    assert.doesNotMatch(JSON.stringify(ordinarySearch), /pane-only-marker|"screen"/)
    const data = await stub.myData(actor(person.handle), 0)
    assert.ok(data.ok, JSON.stringify(data))
    assert.doesNotMatch(JSON.stringify(data), /pane-only-marker|"screen"/)
  }
  await stub.testSnapshot()
  const snapshot = await w.kv.get(`public:${id}`)
  assert.ok(snapshot)
  assert.doesNotMatch(snapshot, /pane-only-marker|"screen"/)
  await stub.testSql('DELETE FROM messages WHERE seq = ?', [own.seq])
  assert.deepEqual(await stub.testSql('SELECT * FROM message_screens WHERE seq = ?', [own.seq]), [])
  assert.ok((await stub.removeAccount(kaiActor, 'mei')).ok)
  assert.deepEqual(await stub.testSql('SELECT * FROM message_screens WHERE seq = ?', [other.seq]), [])
  await send(kai, role)
  // Cleanup also runs for an account whose member rows have already gone.
  await stub.testSql('INSERT INTO message_screens VALUES (?, ?, ?, ?)', [999999, 'zoe', 'orphan-screen', 0])
  assert.deepEqual((await stub.accountGone('zoe')).removed, [])
  assert.deepEqual(await stub.testSql("SELECT * FROM message_screens WHERE account = 'zoe'"), [])
  await stub.accountGone('kai')
  assert.deepEqual(await stub.testSql('SELECT * FROM message_screens'), [])
  // Purge removes the table with all SQLite storage.
  const purgeId = await w.topic(kai)
  const ns = await w.mf.getDurableObjectNamespace('ROOMS'), purge = ns.getByName(purgeId)
  await purge.testSql('INSERT INTO message_screens VALUES (1, ?, ?, 0)', ['kai', 'purge-screen'])
  assert.ok((await purge.deleteRoom(kaiActor)).ok)
  assert.ok((await purge.purgeRoom()).ok)
  assert.deepEqual(await purge.testSql("SELECT name FROM sqlite_master WHERE name = 'message_screens'"), [])
})
