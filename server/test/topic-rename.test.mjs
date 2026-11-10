import assert from 'node:assert/strict'
import test from 'node:test'
import { worker, ORIGIN } from './helpers/worker.mjs'

// The snapshot is rewritten by the alarm 10 s after a change; the test runs that write itself.
const append = `export class RenameRoom extends RoomDO {
  async testSnapshot() { return RoomDO.snapshotOf(this).writeSnapshot(); }
}`

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

test('rename: creator account only, cleaned as at creation, system line, D1 row, room frame and snapshot follow; archived refuses', async () => {
  const w = await worker({}, { append, className: 'RenameRoom' })
  try {
    const kai = await w.person('kai'), mei = await w.person('mei')
    const room = await w.topic(kai) // public: no passcode
    await mei.web(`/r/${room}/enter`, { method: 'POST', headers: { origin: ORIGIN } })
    await w.join(mei, room, 'api')
    await w.join(kai, room, 'api')
    const page = await socket(await mei.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } }))
    await page.next((f) => f.type === 'hello')

    // Another account's agent, even a member, may not.
    const other = await w.json(await mei.apiPost(`/rooms/${room}/name`, { name: 'Theirs' }, 'api'))
    assert.equal(other.status, 403); assert.equal(other.error, 'forbidden')
    // Empty after trimming is refused, on the web route as on the API.
    for (const name of ['', '   ', undefined]) {
      const r = await w.json(await kai.post(`/r/${room}/name`, name === undefined ? {} : { name }))
      assert.equal(r.status, 400, JSON.stringify(r)); assert.equal(r.error, 'bad_request')
    }
    assert.equal((await w.db.prepare('SELECT name FROM rooms WHERE id = ?').bind(room).first()).name, 'Route test topic')

    // The creator's agent renames: cut at 80 as creation does (the web rename below shows the trim).
    const long = 'n'.repeat(100)
    const renamed = await w.json(await kai.apiPost(`/rooms/${room}/name`, { name: long }, 'api'))
    assert.deepEqual(renamed, { status: 200, roomId: room, name: 'n'.repeat(80) })
    assert.equal((await w.db.prepare('SELECT name FROM rooms WHERE id = ?').bind(room).first()).name, 'n'.repeat(80))
    const frame = await page.next((f) => f.type === 'room' && f.room.name === 'n'.repeat(80))
    assert.ok(frame)
    const line = await page.next((f) => f.type === 'message' && f.message.event?.type === 'topic_renamed')
    assert.deepEqual(line.message.event, { type: 'topic_renamed', by: 'api@kai', from: 'Route test topic', to: 'n'.repeat(80) })
    assert.equal(line.message.fromKind, 'system')
    const listed = await w.json(await mei.api(`/rooms/${room}/messages?limit=5`, {}, 'api'))
    const sys = listed.messages.find((m) => m.event?.type === 'topic_renamed')
    assert.equal(sys.text, `api@kai renamed the topic to ${'n'.repeat(80)}`)

    // The person renames from the web; the public snapshot carries the new name once written.
    const web = await w.json(await kai.post(`/r/${room}/name`, { name: ' Final name ' }))
    assert.deepEqual(web, { status: 200, roomId: room, name: 'Final name' })
    const ns = await w.mf.getDurableObjectNamespace('ROOMS')
    await ns.get(ns.idFromName(room)).testSnapshot()
    assert.equal((await w.kv.get(`public:${room}`, 'json')).name, 'Final name')
    const lines = (await w.json(await mei.api(`/rooms/${room}/messages?limit=10`, {}, 'api'))).messages.filter((m) => m.event?.type === 'topic_renamed')
    assert.deepEqual(lines.map((m) => [m.event.by, m.event.from, m.event.to]), [['api@kai', 'Route test topic', 'n'.repeat(80)], ['kai', 'n'.repeat(80), 'Final name']])

    // Archived: read-only, so no rename and no line.
    const archived = await w.json(await kai.post(`/r/${room}/archive`, { archived: true }))
    assert.equal(archived.status, 200, JSON.stringify(archived))
    const refused = await w.json(await kai.post(`/r/${room}/name`, { name: 'Later' }))
    assert.equal(refused.status, 409); assert.equal(refused.error, 'room_archived')
    assert.equal((await w.db.prepare('SELECT name FROM rooms WHERE id = ?').bind(room).first()).name, 'Final name')
  } finally { await w.dispose() }
})
