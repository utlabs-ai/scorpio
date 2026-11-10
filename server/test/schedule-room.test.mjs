import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const built = await build({ entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
} }] })
const { RoomDO } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const domain = await build({ entryPoints: [new URL('../src/room/schedules.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { Schedules } = await import(`data:text/javascript;base64,${Buffer.from(domain.outputFiles[0].text).toString('base64')}`)
const person = { kind: 'human', name: 'kai', account: 'kai' }
const agent = { kind: 'agent', name: 'coach@kai', account: 'kai' }
const other = { kind: 'human', name: 'ana', account: 'ana' }
const once = (offset = 300_000) => ({ kind: 'once', at: Date.now() + offset })

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE schedules (n INTEGER PRIMARY KEY AUTOINCREMENT, by TEXT NOT NULL, by_account TEXT NOT NULL,
    text TEXT NOT NULL, to_names TEXT NOT NULL, rule TEXT NOT NULL, revive INTEGER NOT NULL DEFAULT 1,
    revive_name TEXT, enabled INTEGER NOT NULL DEFAULT 1, next_at INTEGER, last_at INTEGER, last_seq INTEGER,
    last_error TEXT, stopped_by TEXT, stopped_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE members (name TEXT PRIMARY KEY, kind TEXT, owner TEXT, status TEXT, host_id TEXT, offline_since INTEGER);
    CREATE TABLE nonces (sender TEXT NOT NULL, nonce TEXT NOT NULL, result TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(sender, nonce));`)
  const sql = { exec(query, ...args) {
    const stmt = db.prepare(query)
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      const rows = stmt.all(...args)
      return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 }
    }
    const out = stmt.run(...args)
    return { toArray: () => [], one: () => undefined, rowsWritten: Number(out.changes) }
  } }
  Schedules.migrate(sql) // the table above is from before `calendar`: the migration adds the column, as it does in a live topic
  const members = new Map([
    ['kai', { name: 'kai', kind: 'human', owner: 'kai', status: 'active' }],
    ['coach@kai', { name: 'coach@kai', kind: 'agent', owner: 'kai', status: 'active', host_id: 'daemon@kai' }],
    ['daemon@kai', { name: 'daemon@kai', kind: 'host', owner: 'kai', status: 'active', idle_handoff: 60 }],
    ['ana', { name: 'ana', kind: 'human', owner: 'ana', status: 'active' }],
  ])
  for (const member of members.values()) sql.exec('INSERT INTO members (name, kind, owner, status, host_id) VALUES (?, ?, ?, ?, ?)', member.name, member.kind, member.owner, member.status, member.host_id ?? null)
  const kv = new Map()
  const room = Object.create(RoomDO.prototype)
  const effects = { messages: [], sends: [], alarms: [] }
  room.sql = sql
  room.ctx = { storage: {
    kv: { get: (k) => kv.get(k), put: (k, v) => kv.set(k, v), delete: (k) => kv.delete(k) },
    transactionSync: (fn) => fn(), getAlarm: async () => effects.alarms.at(-1) ?? null,
    setAlarm: async (at) => { effects.alarms.push(at) },
  }, getWebSockets: () => [] }
  room.room = () => ({ id: 'room', name: 'Launch', owner: 'kai', archived_at: room.archivedAt ?? null })
  room.requireWritable = () => {}
  room.requireMember = (actor) => { const m = members.get(actor.name); if (!m || m.status !== 'active') throw Error('not member'); return m }
  room.memberRow = (name) => members.get(name)
  room.ownerLimits = async () => ({ plan: room.plan, limits: {} })
  room.plan = 'pro'
  room.insertMessage = (p) => { effects.messages.push(p); return { seq: effects.messages.length } }
  room.doSend = (actor, p, _owner, scheduled) => { effects.sends.push({ actor, p, scheduled }); return { seq: 100 + effects.sends.length } }
  room.takeoverFor = () => room.takeover ?? null
  return { room, sql, members, effects, db }
}

test('a person can schedule without @; an agent must @ and the post is not a broadcast', async () => {
  const { room, effects } = fixture()
  const made = await room.scheduleOp(person, { op: 'add', text: 'quiet note', rule: once() })
  assert.equal(made.ok.item.by, 'kai')
  assert.deepEqual(made.ok.item.to, [])
  assert.deepEqual(effects.messages[0].event.to, [])
  assert.ok(!effects.messages[0].text.includes('→'))
  const denied = await room.scheduleOp(agent, { op: 'add', text: 'quiet note', rule: once() })
  assert.equal(denied.err.code, 'agent_must_mention')
  const sent = await room.scheduleOp(person, { op: 'send', id: made.ok.item.id, nonce: 'press-1' })
  assert.equal(sent.ok.item, null)
  assert.deepEqual(await room.scheduleOp(person, { op: 'send', id: made.ok.item.id, nonce: 'press-1' }), sent)
  assert.equal(effects.sends.length, 1)
  assert.equal(effects.sends[0].actor.name, 'scheduled')
  assert.equal(effects.sends[0].scheduled.by, 'kai')
  assert.equal(effects.sends[0].p.text, 'quiet note')
})

test('due once without takeover stays failed, then send now revives and deletes it', async () => {
  const { room, sql, members, effects } = fixture()
  const made = await room.scheduleOp(agent, { op: 'add', text: '@coach@kai work @kai', rule: once() })
  assert.equal(made.ok.item.reviveName, 'coach@kai')
  members.get('coach@kai').status = 'left'
  const due = sql.exec('SELECT * FROM schedules WHERE n = 1').one()
  await room.fire(due, due.next_at)
  const failed = sql.exec('SELECT * FROM schedules WHERE n = 1').one()
  assert.equal(failed.enabled, 0)
  assert.equal(failed.stopped_reason, 'failed')
  assert.equal(failed.last_error, 'no_takeover')
  assert.equal(effects.sends.length, 0)
  const refused = await room.scheduleOp(person, { op: 'send', id: 'S1' })
  assert.equal(refused.err.code, 'no_takeover')
  assert.equal(refused.err.status, 409)
  room.takeover = { command: '@daemon@kai /spawn claude coach ~/run handoff=skip old prompt', seq: 2 }
  const sent = await room.scheduleOp(person, { op: 'send', id: 'S1' })
  assert.equal(sent.ok.item, null)
  assert.equal(effects.sends.length, 1)
  assert.equal(effects.sends[0].p.text, '@daemon@kai /spawn claude coach ~/run @coach@kai work @kai')
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM schedules').one().n, 0)
})

test('periodic send now keeps next time, due run moves it, and old due retry does not post twice', async () => {
  const { room, sql, effects } = fixture()
  const made = await room.scheduleOp(person, { op: 'add', text: '@kai check', rule: { kind: 'every', minutes: 30 } })
  const first = made.ok.item.nextAt
  const sent = await room.scheduleOp(person, { op: 'send', id: 'S1' })
  assert.equal(sent.ok.item.nextAt, first)
  const due = sql.exec('SELECT * FROM schedules WHERE n = 1').one()
  await room.fire(due, first)
  assert.ok(sql.exec('SELECT next_at FROM schedules WHERE n = 1').one().next_at > Date.now())
  await room.fire(due, first)
  assert.equal(effects.sends.length, 2)
})

test('creator and owner permissions, Pro expiry, and account leaving', async () => {
  const { room, sql, members } = fixture()
  const made = await room.scheduleOp(other, { op: 'add', text: '@ana hi', rule: once() })
  assert.equal(made.ok.item.canEdit, true)
  assert.equal((await room.scheduleOp(person, { op: 'edit', id: 'S1', text: '@ana changed' })).err.code, 'forbidden')
  assert.equal((await room.scheduleOp(person, { op: 'off', id: 'S1' })).ok.item.on, false)
  assert.equal((await room.scheduleOp(person, { op: 'on', id: 'S1' })).ok.item.on, true)
  room.plan = 'free'
  await room.planChanged()
  assert.equal(sql.exec('SELECT stopped_reason FROM schedules WHERE n = 1').one().stopped_reason, 'pro_expired')
  assert.equal((await room.scheduleOp(other, { op: 'on', id: 'S1' })).err.code, 'pro_required')
  assert.equal((await room.scheduleOp(other, { op: 'delete', id: 'S1' })).ok.deleted, 'S1')
  room.plan = 'pro'
  await room.scheduleOp(other, { op: 'add', text: '@ana hi', rule: once() })
  room.dropAccountSchedules('ana')
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM schedules').one().n, 0)
  members.get('ana').status = 'left'
})

test('stop_all reports schedule rows, and send now preserves the original limit error', async () => {
  const { room, sql } = fixture()
  await room.scheduleOp(other, { op: 'add', text: '@ana first', rule: once() })
  await room.scheduleOp(other, { op: 'add', text: '@ana second', rule: once() })
  assert.equal((await room.scheduleOp(person, { op: 'stop_all' })).ok.stopped, 2)
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1').one().n, 0)
  let ErrorType
  try { room.scheduleText('', person) } catch (e) { ErrorType = e.constructor }
  room.doSend = () => { throw new ErrorType('rate_limited', 'Wait 42 seconds.', 429, 42) }
  const failed = await room.scheduleOp(person, { op: 'send', id: 'S1' })
  assert.deepEqual(failed.err, { code: 'rate_limited', next: 'Wait 42 seconds.', status: 429, retryAfter: 42 })
  assert.equal(sql.exec('SELECT last_error FROM schedules WHERE n = 1').one().last_error, 'rate_limited')
})

test('the real send path stores scheduled kind and metadata without sender activity or broadcast', () => {
  const { room, effects } = fixture()
  const touched = []
  room.replaySend = () => null
  room.openCandidates = () => []
  room.lastSeq = () => 0
  room.checkQuota = () => {}
  room.claimFiles = () => []
  room.countMessage = () => null
  room.markActive = () => {}
  room.markSender = (...args) => touched.push(args)
  room.touch = (...args) => touched.push(args)
  room.roomInfo = () => ({ id: 'room' })
  const metadata = { id: 'S4', by: 'kai', at: Date.now() }
  RoomDO.prototype.doSend.call(room, { kind: 'agent', name: 'scheduled', account: 'kai' },
    { text: 'quiet note' }, { plan: 'pro', limits: {} }, metadata)
  assert.equal(effects.messages[0].from, 'scheduled')
  assert.equal(effects.messages[0].fromKind, 'scheduled')
  assert.equal(effects.messages[0].broadcast, false)
  assert.deepEqual(effects.messages[0].scheduled, metadata)
  assert.deepEqual(touched, [])
})

test('calendar: off by default, set on add and edit, kept when an edit leaves it out, refused when not a boolean; rows from before the column read false', async () => {
  const { room, sql } = fixture()
  assert.deepEqual(sql.exec('PRAGMA table_info(schedules)').toArray().map((c) => c.name).filter((n) => n === 'calendar'), ['calendar'])
  const plain = await room.scheduleOp(person, { op: 'add', text: '@kai plain', rule: once() })
  assert.equal(plain.ok.item.calendar, false)
  const marked = await room.scheduleOp(agent, { op: 'add', text: '@kai marked', rule: once(), calendar: true })
  assert.equal(marked.ok.item.calendar, true)
  assert.equal((await room.scheduleOp(agent, { op: 'edit', id: marked.ok.item.id, text: '@kai marked again' })).ok.item.calendar, true)
  assert.equal((await room.scheduleOp(agent, { op: 'edit', id: marked.ok.item.id, calendar: false })).ok.item.calendar, false)
  assert.equal((await room.scheduleOp(agent, { op: 'edit', id: marked.ok.item.id, calendar: true })).ok.item.calendar, true)
  for (const bad of ['true', 1, null]) {
    assert.equal((await room.scheduleOp(person, { op: 'add', text: '@kai x', rule: once(), calendar: bad })).err.code, 'bad_request', String(bad))
    assert.equal((await room.scheduleOp(agent, { op: 'edit', id: marked.ok.item.id, calendar: bad })).err.code, 'bad_request', String(bad))
  }
  // a row written before the column existed (the default fills it)
  sql.exec("INSERT INTO schedules (by, by_account, text, to_names, rule, enabled, next_at, created_at, updated_at) VALUES ('kai', 'kai', '@kai old', '[\"kai\"]', ?, 1, ?, 1, 1)", JSON.stringify(once()), Date.now() + 1000)
  const old = (await room.schedules(person)).ok.items.find((i) => i.text === '@kai old')
  assert.equal(old.calendar, false)
})

test('calendarItems: the on, marked schedules that @ this person, for an active person; agents, outsiders and an archived topic get not_member', async () => {
  const { room, members } = fixture()
  await room.scheduleOp(agent, { op: 'add', text: '@kai for the calendar', rule: once(), calendar: true })
  await room.scheduleOp(agent, { op: 'add', text: '@kai not marked', rule: once() })
  await room.scheduleOp(agent, { op: 'add', text: '@coach@kai agent only', rule: once(), calendar: true })
  const off = await room.scheduleOp(agent, { op: 'add', text: '@kai turned off', rule: once(), calendar: true })
  await room.scheduleOp(person, { op: 'off', id: off.ok.item.id })
  await room.scheduleOp(other, { op: 'add', text: '@kai @ana both', rule: { kind: 'daily', time: '09:00', tz: 'UTC' }, calendar: true })
  const mine = await room.calendarItems('kai')
  assert.deepEqual(mine.ok.items.map((i) => i.text), ['@kai for the calendar', '@kai @ana both'])
  assert.deepEqual(Object.keys(mine.ok.items[0]).sort(), ['by', 'id', 'nextAt', 'rule', 'text', 'updatedAt'])
  assert.equal(mine.ok.items[0].by, 'coach@kai')
  assert.equal(mine.ok.name, 'Launch')
  assert.equal(mine.ok.roomId, 'room')
  assert.deepEqual((await room.calendarItems('ana')).ok.items.map((i) => i.text), ['@kai @ana both'])
  assert.equal((await room.calendarItems('coach@kai')).err.code, 'not_member')
  assert.equal((await room.calendarItems('nobody')).err.code, 'not_member')
  members.get('kai').status = 'left'
  assert.equal((await room.calendarItems('kai')).err.code, 'not_member')
  members.get('kai').status = 'active'
  room.archivedAt = 1
  assert.equal((await room.calendarItems('kai')).err.code, 'not_member')
})
