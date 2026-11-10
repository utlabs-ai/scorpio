import assert from 'node:assert/strict'
import test from 'node:test'
import { worker, ORIGIN } from './helpers/worker.mjs'
import { membersFor } from '../src/member-visibility.ts'

const append = `export class VisibilityRoom extends RoomDO {
  async testSql(query, args = []) { return this.ctx.storage.sql.exec(query, ...args).toArray(); }
}`
const actor = (account, role) => ({ kind: role ? 'agent' : 'human', account, name: role ? `${role}@${account}` : account })
const clis = [{ kind: 'claude', installed: true, version: '2.1.301', at: 1 }]
async function socket(res) {
  assert.equal(res.status, 101)
  const ws = res.webSocket, frames = [], pending = []
  ws.addEventListener('message', (e) => {
    const frame = JSON.parse(e.data); frames.push(frame)
    for (const p of pending.slice()) if (p.match(frame)) { pending.splice(pending.indexOf(p), 1); clearTimeout(p.timer); p.resolve(frame) }
  })
  ws.accept()
  return { ws, frames, next: (match) => {
    const found = frames.find(match)
    return found ? Promise.resolve(found) : new Promise((resolve, reject) => {
      const p = { match, resolve, timer: setTimeout(() => reject(new Error('frame timeout')), 12000) }; pending.push(p)
    })
  } }
}
async function setup() {
  const w = await worker({}, { append, className: 'VisibilityRoom' })
  const ns = await w.mf.getDurableObjectNamespace('ROOMS')
  const stub = (id) => ns.get(ns.idFromName(id))
  const host = async (p, room) => w.json(await p.apiPost(`/rooms/${room}/join`, { host: true, machine: 'box.local', clis, resume: true }))
  return { ...w, stub, host }
}
function check(rows, account) {
  const m = rows.find((m) => m.kind === 'host')
  if (account === null) {
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['displayName', 'kind', 'name'])
  } else if (account === 'kai') {
    assert.equal(m.device.hostname, 'box.local')
    assert.deepEqual(m.clis, clis)
  } else {
    assert.deepEqual(m.device, { name: 'computer-1', note: 'desk' })
    assert.ok(!Object.hasOwn(m, 'clis'))
  }
}

test('member visibility is per recipient and does not mutate the stored view', () => {
  const rows = [{ name: 'computer-1-daemon@kai', kind: 'host', owner: 'kai', displayName: null, device: { name: 'computer-1', hostname: 'box.local', note: 'desk' }, clis }]
  for (const account of ['kai', 'mei', null]) check(membersFor(rows, account), account)
  assert.equal(rows[0].device.hostname, 'box.local')
  assert.deepEqual(rows[0].clis, clis)
})

test('hello, members, listen and immediate/delayed host frames use recipient visibility; viewers receive no cursor', async () => {
  const w = await setup()
  try {
    const kai = await w.person('kai'), mei = await w.person('mei'), zoe = await w.person('zoe')
    const room = await w.topic(kai)
    await w.db.prepare("UPDATE agent_tokens SET device_id = 'device-kai', device_name = 'box.local' WHERE user_id = ?").bind(kai.id).run()
    const joined = await w.host(kai, room)
    assert.equal(joined.name, 'computer-1-daemon@kai')
    const stub = w.stub(room)
    await stub.deviceChanged('kai', 'device-kai', 'computer-1-daemon', null, { name: 'computer-1', hostname: 'box.local', note: 'desk' })
    await mei.web(`/r/${room}/enter`, { method: 'POST', headers: { origin: ORIGIN } })
    await w.join(mei, room, 'api')
    await w.join(kai, room, 'api')
    const sockets = []
    for (const [p, account] of [[kai, 'kai'], [kai, 'kai'], [mei, 'mei'], [zoe, null]]) {
      const s = await socket(await p.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } }))
      sockets.push([s, account]); check((await s.next((f) => f.type === 'hello')).members, account)
    }
    for (const [p, account] of [[kai, 'kai'], [mei, 'mei']]) {
      check((await w.json(await p.api(`/rooms/${room}/members`, {}, 'api'))).members, account)
      check((await w.json(await p.api(`/rooms/${room}/listen`, {}, 'api'))).members, account)
    }
    const ownHost = await socket(await kai.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, 'computer-1-daemon'))
    check((await ownHost.next((f) => f.type === 'room')).members, 'kai')
    const otherJoin = await w.host(mei, room)
    const otherHost = await socket(await mei.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, otherJoin.name.split('@')[0]))
    check((await otherHost.next((f) => f.type === 'room')).members, 'mei')
    for (const [s] of sockets) s.frames.length = 0
    ownHost.frames.length = 0; otherHost.frames.length = 0
    await stub.setRoleCard(actor('kai', 'api'), 'Updated card')
    for (const [s, account] of sockets) check((await s.next((f) => f.type === 'members')).members, account)
    check((await ownHost.next((f) => f.type === 'room')).members, 'kai')
    check((await otherHost.next((f) => f.type === 'room')).members, 'mei')
    // A topic edit used to send an unfiltered host room frame through a separate path.
    ownHost.frames.length = 0; otherHost.frames.length = 0
    await stub.setTopic(actor('kai'), 'Updated topic')
    check((await ownHost.next((f) => f.type === 'room')).members, 'kai')
    check((await otherHost.next((f) => f.type === 'room')).members, 'mei')
    ownHost.frames.length = 0; otherHost.frames.length = 0
    ownHost.ws.send(JSON.stringify({ type: 'carry', names: ['api@kai'] }))
    check((await ownHost.next((f) => f.type === 'room')).members, 'kai')
    check((await otherHost.next((f) => f.type === 'room')).members, 'mei')
    const mine = sockets[0][0], viewer = sockets.at(-1)[0]
    mine.frames.length = 0; viewer.frames.length = 0
    await stub.send(actor('kai'), { text: 'A new message' })
    const marked = await stub.mark(actor('kai', 'api'), 99999)
    assert.ok(marked.ok.cursor > 0)
    await mine.next((f) => f.type === 'cursor')
    assert.ok(!viewer.frames.some((f) => f.type === 'cursor'))
  } finally { await w.dispose() }
})

test('a legacy device is renamed once across its topics and a person-named computer stays; handoff uses token device', async () => {
  const w = await setup()
  try {
    const kai = await w.person('kai')
    const rooms = [await w.topic(kai), await w.topic(kai)]
    await w.db.prepare("UPDATE agent_tokens SET device_id = 'device-kai', device_name = 'box.local' WHERE user_id = ?").bind(kai.id).run()
    await w.db.prepare("INSERT INTO devices (user_id, device_id, device_name, created_at, daemon_no, name, machine, seat) VALUES (?, 'device-kai', 'box.local', ?, 1, 'box', 'box', 'box-daemon')").bind(kai.id, Date.now()).run()
    for (const room of rooms) {
      const stub = w.stub(room)
      await stub.join(actor('kai', 'box-daemon'), { role: 'box-daemon', host: true, seat: 'box-daemon@kai', deviceId: 'device-kai', device: { name: 'box', hostname: 'box.local', note: null } })
      await w.join(kai, room, 'api')
      await stub.testSql("UPDATE members SET host_id = 'box-daemon@kai', seat_id = 'box-daemon@kai' WHERE name = 'api@kai'")
    }
    const renamed = await w.host(kai, rooms[0])
    assert.equal(renamed.name, 'computer-1-daemon@kai')
    for (const room of rooms) {
      const stub = w.stub(room)
      // waitUntil propagates the same rename through the existing deviceChanged flow.
      const end = Date.now() + 5000
      let events
      do { events = await stub.testSql("SELECT event FROM messages WHERE json_extract(event, '$.type') = 'renamed'") } while (!events.length && Date.now() < end)
      assert.deepEqual(events.map((r) => JSON.parse(r.event)), [{ type: 'renamed', from: 'box-daemon@kai', to: 'computer-1-daemon@kai' }])
      assert.equal((await stub.testSql("SELECT seat_id FROM members WHERE name = 'api@kai'"))[0].seat_id, renamed.name)
      await w.host(kai, room)
      assert.equal((await stub.testSql("SELECT event FROM messages WHERE json_extract(event, '$.type') = 'renamed'")).length, 1)
    }
    const body = '# Handoff'
    const saved = await w.json(await kai.api(`/rooms/${rooms[0]}/handoff`, { method: 'PUT', body, headers: { 'x-scorpio-computer': 'caller-hostname' } }, 'api'))
    assert.equal(saved.computer, 'computer-1')
    await w.db.prepare("UPDATE devices SET name = 'desk', seat = 'desk-daemon' WHERE user_id = ?").bind(kai.id).run()
    assert.equal((await w.host(kai, rooms[0])).device.name, 'desk')
  } finally { await w.dispose() }
})
