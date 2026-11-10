import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const built = await build({ entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
} }] })
const { RoomDO } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const KAI = { kind: 'human', account: 'kai', name: 'kai' }
const HOST = { kind: 'agent', account: 'kai', name: 'daemon-2@kai' }

function room(id = 'topic-one') {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE members (name TEXT PRIMARY KEY, kind TEXT, owner TEXT, status TEXT, seat_id TEXT, host_id TEXT,
    role_card TEXT, role_card_by TEXT, role_card_at INTEGER, lane TEXT, lane_by TEXT, lane_at INTEGER, last_active INTEGER, runtime TEXT, backing TEXT,
    takeover_checked INTEGER, takeover_command TEXT, takeover_seq INTEGER, cursor INTEGER, born_seq INTEGER DEFAULT 0, joined_at INTEGER, idle_handoff INTEGER,
    device_id TEXT, device TEXT, clis TEXT, perm_level TEXT, perm_from TEXT, perm_parent TEXT, perms TEXT);
    CREATE TABLE removed_computers (name TEXT PRIMARY KEY, owner TEXT, device_id TEXT);
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL, host TEXT NOT NULL, cli TEXT NOT NULL,
      detail TEXT, menu TEXT, screen TEXT, status TEXT NOT NULL, answer TEXT, result TEXT,
      opened_ms INTEGER NOT NULL, closed_ms INTEGER
    );`)
  const sent = [], released = [], left = [], messages = []
  const sockets = new Map()
  const sql = { exec(query, ...args) {
    const statement = db.prepare(query)
    if (/^SELECT/i.test(query)) {
      const rows = statement.all(...args)
      return { toArray: () => rows }
    }
    const result = statement.run(...args)
    return { rowsWritten: Number(result.changes) }
  } }
  const target = {
    sql, ctx: { storage: { kv: new Map() }, getWebSockets: (tag) => sockets.get(tag) || [], waitUntil: () => {} },
    schedule: async () => {},
    wrap: (fn) => ({ ok: fn() }), room: () => ({ id, owner: 'kai', public: 1 }),
    requireMember: (actor) => RoomDO.prototype.requireMember.call(target, actor),
    memberRow: (name) => sql.exec('SELECT * FROM members WHERE name = ?', name).toArray()[0],
    releaseItems: (names) => released.push(...names),
    safeSend: (ws, frame) => sent.push([ws.id, JSON.parse(frame)]),
    broadcastMembers: () => {}, replay: () => null, lastSeq: () => 0,
    systemMessage: (type, name) => { if (type === 'leave') left.push(name) }, roomInfo: () => ({ id, name: id, topic: '', owner: 'kai' }),
    remember: (_name, _nonce, out) => out, yours: () => [],
    insertMessage: (m) => messages.push(m), renameHost: RoomDO.prototype.renameHost,
  }
  const add = (name, kind, owner, seat = null, host = null) => sql.exec(
    "INSERT INTO members (name, kind, owner, status, seat_id, host_id, cursor, joined_at) VALUES (?, ?, ?, 'active', ?, ?, 0, 1)",
    name, kind, owner, seat, host,
  )
  const names = () => sql.exec('SELECT name FROM members ORDER BY name').toArray().map((r) => r.name)
  return { target, sql, add, names, sockets, sent, released, left, messages, db }
}

test('a renamed host keeps its row and carried agents, writes one system line, and closes its old connection', async () => {
  const r = room()
  r.add('daemon-2@kai', 'host', 'kai', 'daemon-2@kai')
  r.add('api@kai', 'agent', 'kai', 'daemon-2@kai', 'daemon-2@kai')
  r.sql.exec("UPDATE members SET device_id = 'device-one', cursor = 19 WHERE name = 'daemon-2@kai'")
  const closed = []
  r.sockets.set('host:daemon-2@kai', [{ close: (code) => closed.push(code) }])
  const device = { name: 'mbp', hostname: 'MBP.local', note: 'Work Mac' }
  assert.equal((await RoomDO.prototype.deviceChanged.call(r.target, 'kai', 'device-one', 'mbp-daemon', 'daemon-2', device)).ok, true)
  assert.deepEqual({ ...r.sql.exec("SELECT name, cursor, device_id FROM members WHERE kind = 'host'").toArray()[0] }, { name: 'mbp-daemon@kai', cursor: 19, device_id: 'device-one' })
  assert.deepEqual({ ...r.sql.exec("SELECT host_id, seat_id FROM members WHERE name = 'api@kai'").toArray()[0] }, { host_id: 'mbp-daemon@kai', seat_id: 'mbp-daemon@kai' })
  assert.deepEqual(r.messages.map((m) => m.event), [{ type: 'renamed', from: 'daemon-2@kai', to: 'mbp-daemon@kai' }])
  assert.deepEqual(closed, [4002])
})

test('only the seat account can remove it; only that seat and its agents disappear from this topic', async () => {
  const a = room(), b = room('topic-two')
  for (const r of [a, b]) {
    r.add('kai', 'human', 'kai')
    r.add(HOST.name, 'host', 'kai', HOST.name)
    r.add('api@kai', 'agent', 'kai', HOST.name)
    r.add('old@kai', 'agent', 'kai', null, HOST.name)
    r.add('remote@kai', 'agent', 'kai', 'daemon@kai')
    r.add('daemon@zoe', 'host', 'zoe', 'daemon@zoe')
  }
  await assert.rejects(RoomDO.prototype.removeOwnComputer.call(a.target, { kind: 'human', account: 'zoe', name: 'zoe' }, HOST.name), (e) => e.code === 'not_member')
  await assert.rejects(RoomDO.prototype.removeOwnComputer.call(a.target, HOST, HOST.name), (e) => e.code === 'forbidden')
  assert.equal(a.names().length, 6)
  a.sql.exec("INSERT INTO approvals (id, name, account, host, cli, status, opened_ms) VALUES (?, ?, ?, ?, ?, 'open', 1)",
    'card-one', 'api@kai', 'kai', HOST.name, 'claude')
  const result = await RoomDO.prototype.removeOwnComputer.call(a.target, KAI, HOST.name)
  assert.equal(a.sql.exec('SELECT status FROM approvals WHERE id = ?', 'card-one').toArray()[0].status, 'gone')
  // The computer's seat goes; its agents leave and keep their rows (docs/api/files.md): a takeover elsewhere continues them.
  assert.deepEqual(result.ok.removed, [HOST.name])
  assert.deepEqual(result.ok.left.sort(), ['api@kai', 'old@kai'])
  assert.deepEqual(a.names(), ['api@kai', 'daemon@zoe', 'kai', 'old@kai', 'remote@kai'])
  const row = (n) => a.sql.exec('SELECT status, host_id FROM members WHERE name = ?', n).toArray()[0]
  assert.deepEqual({ ...row('api@kai') }, { status: 'left', host_id: null })
  assert.deepEqual({ ...row('old@kai') }, { status: 'left', host_id: null })
  assert.equal(row('remote@kai').status, 'active')
  assert.deepEqual(a.left, ['api@kai', 'old@kai'], 'one leave line for each that was in the topic')
  assert.equal(b.names().length, 6, 'another topic is unchanged')
  assert.deepEqual(a.released.sort(), [HOST.name, 'api@kai', 'old@kai'].sort())
})

test('removed computer cannot join until its own device clears the block', async () => {
  const r = room()
  r.add('kai', 'human', 'kai')
  r.add(HOST.name, 'host', 'kai', HOST.name)
  await RoomDO.prototype.removeOwnComputer.call(r.target, KAI, HOST.name)
  const join = () => RoomDO.prototype.join.call(r.target, HOST, { role: 'daemon-2', host: true, seat: HOST.name, resume: true })
  await assert.rejects(join(), (e) => e.code === 'computer_removed')
  await assert.rejects(RoomDO.prototype.join.call(r.target, { kind: 'agent', account: 'kai', name: 'api@kai' }, { role: 'api', seat: HOST.name }), (e) => e.code === 'computer_removed')
  await assert.rejects(RoomDO.prototype.rejoinComputer.call(r.target, { ...HOST, name: 'daemon@kai' }, HOST.name), (e) => e.code === 'forbidden')
  assert.deepEqual((await RoomDO.prototype.rejoinComputer.call(r.target, HOST, HOST.name)).ok, { roomId: 'topic-one', name: HOST.name, rejoined: true })
  assert.equal((await RoomDO.prototype.rejoinComputer.call(r.target, HOST, HOST.name)).ok.rejoined, false, 'a retry after a lost response is safe')
  assert.equal((await join()).ok.name, HOST.name)
})

test('a host join keeps the CLIs its daemon detected on the seat; a join without them (an older daemon) leaves them', async () => {
  const r = room()
  const clis = [{ kind: 'claude', installed: true, version: '2.1.301', at: 5 }, { kind: 'codex', installed: false, version: null, at: 5 }]
  const join = (extra = {}) => RoomDO.prototype.join.call(r.target, HOST, { role: 'daemon-2', host: true, seat: HOST.name, resume: true, ...extra })
  const stored = () => r.sql.exec('SELECT clis FROM members WHERE name = ?', HOST.name).toArray()[0].clis
  await join()
  assert.equal(stored(), null)
  await join({ clis })
  assert.deepEqual(JSON.parse(stored()), clis)
  await join()
  assert.deepEqual(JSON.parse(stored()), clis)
})

test('a computer logged out unexpectedly: one line where its daemon seat is active, waking nobody; none where it left or is not there', async () => {
  const here = room(), gone = room('topic-two'), other = room('topic-three')
  here.add('mbp-daemon@kai', 'host', 'kai', 'mbp-daemon@kai')
  gone.add('mbp-daemon@kai', 'host', 'kai', 'mbp-daemon@kai')
  other.add('mbp-daemon@zoe', 'host', 'zoe', 'mbp-daemon@zoe')
  for (const r of [here, gone, other]) r.sql.exec("UPDATE members SET device_id = 'device-one'")
  gone.sql.exec("UPDATE members SET status = 'left'")
  const line = (r) => RoomDO.prototype.loggedOutLine.call(r.target, 'kai', 'device-one', 'mbp')
  assert.deepEqual(await line(here), { ok: true })
  assert.deepEqual(here.messages, [{ from: 'system', fromKind: 'system', text: 'mbp is logged out: its agents receive no messages', event: { type: 'logged_out', name: 'mbp-daemon@kai', device: 'mbp' } }])
  assert.ok(!('wake' in here.messages[0]))
  assert.deepEqual(await line(gone), { ok: false })
  assert.deepEqual(await line(other), { ok: false }, "another account's computer with the same device id is not this one")
  assert.deepEqual([gone.messages, other.messages], [[], []])
})
