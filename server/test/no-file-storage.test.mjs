import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

// A deployment may run without file storage (no FILES binding: R2 needs a payment method on Cloudflare's free plan).
// Then uploads are refused with a reason, the page offers no attach buttons, and deleting a topic still deletes it.

// A room whose SQLite can be read, to see that the purge emptied it.
const probe = { className: 'ProbeRoom', append: `
class ProbeRoom extends RoomDO {
  testSql(query, args = []) { return this.ctx.storage.sql.exec(query, ...args).toArray(); }
}
export { ProbeRoom };
` }
const upload = (p, room) => p.web(`/r/${room}/files`, { method: 'POST', body: '# Notes', headers: { 'content-type': 'text/markdown', 'x-file-name': 'notes.md' } })
const left = async (w, room) => ({
  row: (await w.db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE id = ?').bind(room).first()).n,
  members: (await w.db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?').bind(room).first()).n,
  tables: (await (await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room).testSql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")).length,
})

test('without file storage: an upload says why it is refused (web and API), the page has no attach buttons, and deleting a topic purges it', async () => {
  const w = await worker({}, { ...probe, noFiles: true })
  try {
    const kai = await w.person('kai')
    const room = await w.topic(kai)
    await w.join(kai, room, 'arch')
    const web = await w.json(await upload(kai, room))
    assert.equal(web.status, 501)
    assert.equal(web.error, 'no_file_storage')
    assert.match(web.next, /no file storage/)
    const api = await w.json(await kai.api(`/rooms/${room}/files`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain', 'x-file-name': 'x.txt' } }, 'arch'))
    assert.equal(api.error, 'no_file_storage')
    const page = await (await kai.web(`/r/${room}`)).text()
    assert.match(page, /"fileStorage":false/)
    assert.ok(!page.includes('id="btn-pic"') && !page.includes('id="btn-file"') && !page.includes('id="file-input"'))
    assert.ok(page.includes('id="btn-send"'))
    assert.equal((await w.json(await kai.post(`/r/${room}/delete`, {}))).status, 200)
    assert.deepEqual(await left(w, room), { row: 0, members: 0, tables: 0 })
  } finally { await w.dispose() }
})

test('with file storage: uploads, the attach buttons and the purge of the topic\'s files are as before', async () => {
  const w = await worker({}, probe)
  try {
    const kai = await w.person('kai')
    const room = await w.topic(kai)
    const file = await w.json(await upload(kai, room))
    assert.equal(file.status, 200, JSON.stringify(file))
    const r2 = await w.mf.getR2Bucket('FILES')
    assert.equal((await r2.list({ prefix: `rooms/${room}/` })).objects.length, 1)
    const page = await (await kai.web(`/r/${room}`)).text()
    assert.match(page, /"fileStorage":true/)
    assert.ok(page.includes('id="btn-pic"') && page.includes('id="btn-file"'))
    assert.equal((await w.json(await kai.post(`/r/${room}/delete`, {}))).status, 200)
    assert.deepEqual(await left(w, room), { row: 0, members: 0, tables: 0 })
    assert.equal((await r2.list({ prefix: `rooms/${room}/` })).objects.length, 0)
  } finally { await w.dispose() }
})
