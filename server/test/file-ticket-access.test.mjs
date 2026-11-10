import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

async function fixture() {
  const w = await worker({}, {className: 'TicketProbe', append: `
class TicketProbe extends RoomDO {
  async fetch(req) {
    const {sql, args = []} = await req.json();
    return Response.json(this.ctx.storage.sql.exec(sql, ...args).toArray());
  }
}
export { TicketProbe };
`})
  const owner = await w.person('ticketowner')
  const viewer = await w.person('ticketviewer')
  const room = await w.topic(owner, 'private-code')
  assert.equal((await viewer.post(`/r/${room}/enter`, { code: 'private-code' })).status, 200)
  const file = await w.json(await owner.web(`/r/${room}/files`, {
    method: 'POST', body: '# Private attachment\nTicket evidence.',
    headers: { 'content-type': 'text/markdown', 'x-file-name': 'private.md' },
  }))
  assert.equal(file.status, 200, JSON.stringify(file))
  assert.ok(file.id)
  const ticket = async (theme = 'light') => {
    const r = await w.json(await viewer.post(`/v/${file.id}/ticket`, { theme }))
    assert.equal(r.status, 200, JSON.stringify(r))
    assert.ok(r.url)
    const { readTicket } = await import('../src/view-ticket.ts')
    const u = new URL(r.url)
    const decoded = await readTicket('route-test-key-0123456789abcdef0123456789', u.hostname.split('.')[0], u.pathname.slice(1))
    assert.equal(decoded?.a, viewer.handle, JSON.stringify(decoded))
    return r.url
  }
  return { ...w, owner, viewer, room, file, ticket }
}

test('content reads reject a ticket after its account leaves or is removed, including cached renders', async () => {
  const w = await fixture()
  try {
    const first = await w.fetch(await w.ticket())
    assert.equal(first.status, 200, first.status === 200 ? "" : await first.text())
    assert.match(await first.text(), /Ticket evidence/)
    const left = await w.ticket()
    assert.equal((await w.viewer.post(`/r/${w.room}/leave`)).status, 200)
    assert.equal((await w.fetch(left)).status, 403)
    assert.equal((await w.viewer.post(`/r/${w.room}/enter`, { code: 'private-code' })).status, 200)
    const removed = await w.ticket()
    assert.equal((await w.owner.post(`/r/${w.room}/remove`, { account: w.viewer.handle })).status, 200)
    assert.equal((await w.fetch(removed)).status, 403)
  } finally { await w.dispose() }
})

test('one ticket allows one GET even concurrently; HEAD does not consume or expose bytes; a fresh theme ticket opens', async () => {
  const w = await fixture()
  try {
    const url = await w.ticket()
    const head = await w.fetch(url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    const responses = await Promise.all(Array.from({ length: 4 }, () => w.fetch(url)))
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 403, 403, 403])
    assert.equal((await w.fetch(url)).status, 403)
    const dark = await w.fetch(await w.ticket('dark'))
    assert.equal(dark.status, 200)
    assert.match(await dark.text(), /Ticket evidence/)
  } finally { await w.dispose() }
})

test('public signed-in viewers can preview without joining; legacy tickets without handle are refused', async () => {
  const w = await fixture()
  try {
    assert.equal((await w.owner.post(`/r/${w.room}/visibility`, { public: true })).status, 200)
    const visitor = await w.person('ticketvisitor')
    const t = await w.json(await visitor.post(`/v/${w.file.id}/ticket`))
    assert.equal(t.status, 200)
    assert.equal((await w.fetch(t.url)).status, 200)
    const { signTicket } = await import('../src/view-ticket.ts')
    const { label, token } = await signTicket('route-test-key-0123456789abcdef0123456789', {
      u: visitor.id, r: w.room, f: w.file.id, h: 'a'.repeat(64), k: 'markdown', t: 'light', o: 'https://scorpio.test',
    })
    assert.equal((await w.fetch(`https://${label}.content.test/${token}`)).status, 403)
  } finally { await w.dispose() }
})


test('a removed file or changed hash is rejected before reading an existing render cache', async () => {
  const w = await fixture()
  try {
    const first = await w.fetch(await w.ticket())
    assert.equal(first.status, 200)
    await first.text()
    const changed = await w.ticket()
    const removed = await w.ticket()
    const ns = await w.mf.getDurableObjectNamespace('ROOMS')
    const stub = ns.get(ns.idFromName(w.room))
    const sql = (sql, args) => stub.fetch('http://probe/', {method:'POST', body:JSON.stringify({sql,args})})
    await sql('UPDATE files SET hash = ? WHERE id = ?', ['different-hash', w.file.id])
    assert.equal((await w.fetch(changed)).status, 404)
    await sql('DELETE FROM files WHERE id = ?', [w.file.id])
    assert.equal((await w.fetch(removed)).status, 404)
  } finally { await w.dispose() }
})
