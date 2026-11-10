import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

// A topic keeps every task it ever had, nearly all done long ago. listen, send and the task views read the open
// items and the ones done within a day; with items_status_done they read those, not every item (workerd's rowsRead).
const append = `
let rowsRead = 0, cursors = [];
export class RowsRoom extends RoomDO {
  constructor(ctx, env) {
    super(ctx, env);
    const exec = (q, ...a) => { const c = ctx.storage.sql.exec(q, ...a); cursors.push(c); return c; };
    this.sql = new Proxy(ctx.storage.sql, { get: (t, p) => (p === 'exec' ? exec : (typeof t[p] === 'function' ? t[p].bind(t) : t[p])) });
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/__age') { this.ctx.storage.sql.exec("UPDATE items SET done_ms = done_ms - 7 * 86400000 WHERE status = 'done'"); this.ctx.storage.sql.exec("UPDATE messages SET ts = ts - 7 * 86400000"); return new Response('ok'); }
    if (path !== '/__rows') return super.fetch(req);
    for (const c of cursors) rowsRead += c.rowsRead;
    const out = rowsRead; rowsRead = 0; cursors = [];
    return Response.json({ rowsRead: out });
  }
}`

test('listen, send and task views read the open and recent items, not every item ever made', async () => {
  const limits = { msgsPerRoomMinute: 1e6, msgsPerRoomDay: 1e6, todoWritesPerRoomMinute: 1e6 }
  const w = await worker({ TEST_LIMITS: JSON.stringify({ self: limits, free: limits, pro: limits }) }, { append, className: 'RowsRoom' })
  try {
    const kai = await w.person('kai')
    const room = await w.topic(kai)
    await w.join(kai, room, 'api')
    const send = async (body) => {
      const r = await w.json(await kai.apiPost(`/rooms/${room}/send`, { text: '@kai x', ...body }, 'api'))
      assert.equal(r.error, undefined, JSON.stringify(r))
      return r
    }
    const DONE = 300, OPEN = 3
    for (let i = 0; i < DONE + OPEN; i++) await send({ add: `task ${i}` })
    for (let n = 1; n <= DONE; n++) await send({ done: `T${n}` })
    const ns = await w.mf.getDurableObjectNamespace('ROOMS')
    const stub = ns.get(ns.idFromName(room))
    const rows = async () => (await (await stub.fetch('http://x/__rows')).json()).rowsRead
    await stub.fetch('http://x/__age') // a week ago: the done items leave the visible list and the messages the quota's last minute
    const last = await w.json(await kai.api(`/rooms/${room}/listen`, {}, 'api'))
    await w.json(await kai.apiPost(`/rooms/${room}/mark`, { upTo: last.total }, 'api'))
    await new Promise((r) => setTimeout(r, 1200)) // the 1 s todo frame
    await rows()

    const measured = {}
    const op = async (name, fn) => { await fn(); await new Promise((r) => setTimeout(r, 1200)); measured[name] = await rows() }
    await op('listen', () => kai.api(`/rooms/${room}/listen`, {}, 'api'))
    await op('send', () => send({}))
    await op('taskMine', () => kai.api(`/rooms/${room}/todo?mine=1`, {}, 'api'))
    await op('taskAdd', () => send({ add: 'one more' }))
    console.log(`rowsRead with ${DONE} done and ${OPEN} open items: ${JSON.stringify(measured)}`)
    // Every one of these read all items at least once before the index (listen and the task views twice, a task add six
    // times through the frame and the alarm): at least DONE rows each.
    for (const [name, n] of Object.entries(measured)) assert.ok(n < DONE, `${name} read ${n} rows`)
  } finally {
    await w.dispose()
  }
})
