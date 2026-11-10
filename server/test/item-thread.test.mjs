import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { CARRIED_SQL, CURRENT_SQL, JOIN_SQL, LAST_REPLY_SQL, THREAD_SQL, joins, lineOf, tNumbers } from '../src/item-thread.ts'
import { proseOf } from '../src/mentions.ts'

async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
  } }] })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const { MESSAGE_THREAD_VIEW_SQL } = await load('room/messages.ts')
const { Tasks } = await load('room/tasks.ts')

// The tables as RoomDO makes them, with the columns these queries read, and a small stand-in for its send path:
// sources, (b)/(c) joins through joins(), results — as room-do.ts does them (docs/api/tasks.md).
function room(people = ['kai']) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE messages (seq INTEGER PRIMARY KEY, from_name TEXT NOT NULL, from_kind TEXT NOT NULL, text TEXT, files TEXT, mentions TEXT, reply_to INTEGER, ts INTEGER NOT NULL, scheduled TEXT);
    CREATE TABLE items (n INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT, created_by TEXT NOT NULL, created_seq INTEGER, done_seq INTEGER, round INTEGER);
    CREATE TABLE item_messages (n INTEGER NOT NULL, seq INTEGER NOT NULL, rel TEXT NOT NULL, PRIMARY KEY (n, seq));
    CREATE INDEX item_messages_seq ON item_messages (seq);
    CREATE TABLE item_log (n INTEGER, op TEXT, from_json TEXT, to_json TEXT);
    CREATE TABLE item_replies (n INTEGER, seq INTEGER);
  `)
  db.exec(MESSAGE_THREAD_VIEW_SQL)
  const kind = (name) => (people.includes(name) ? 'human' : name === 'box@kai' ? 'host' : 'agent')
  const tasks = new Tasks({
    sql: () => ({ exec(query, ...args) {
      const rows = db.prepare(query).all(...args)
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0] } }
    } }),
    members: { get: (name) => ({ kind: kind(name) }) },
  })
  const open = () => db.prepare("SELECT n, assignee, created_by FROM items WHERE status IN ('todo', 'doing')").all().map((it) => ({
    n: it.n, assignee: it.assignee, createdBy: it.created_by, personAssignee: !!it.assignee && kind(it.assignee) === 'human',
    has: (seq) => !!db.prepare('SELECT 1 FROM item_messages WHERE n = ? AND seq = ?').get(it.n, seq),
  }))
  function send(seq, from, text, { replyTo = null, add = null, done = null } = {}) {
    const mentions = [...text.matchAll(/@([A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?)/g)].map((m) => m[1])
    const route = tasks.route({ ...(add ? { add: add.title } : {}), ...(done ? { done: `T${done}` } : {}) }, { name: from }, text, replyTo, undefined, mentions, open())
    const j = route.joined
    for (const x of j) db.prepare(JOIN_SQL).run(x.n, seq, x.rel)
    if (add) {
      db.prepare("INSERT INTO items (n, title, status, assignee, created_by, created_seq) VALUES (?, ?, 'todo', ?, ?, ?)").run(add.n, add.title, add.to, from, seq)
      db.prepare(JOIN_SQL).run(add.n, seq, 'source')
    }
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL)').run(seq, from, kind(from), text, JSON.stringify(mentions), replyTo, seq * 1000)
    if (done) {
      db.prepare(JOIN_SQL).run(done, seq, 'result')
      db.prepare("UPDATE items SET status = 'done', done_seq = ? WHERE n = ?").run(seq, done)
    }
    return route
  }
  const item = (n) => db.prepare('SELECT * FROM items WHERE n = ?').get(n)
  const current = (n) => { const it = item(n); return db.prepare(CURRENT_SQL).get(n, it.assignee ?? it.created_by)?.seq ?? null }
  const reply = (n) => db.prepare(LAST_REPLY_SQL).get(n, current(n) ?? 0)?.seq ?? null
  const thread = (n) => db.prepare(THREAD_SQL).all(n).map((t) => `${t.seq}:${t.rel}`)
  return { db, send, current, reply, thread, replay: () => tasks.backfillThreads() }
}

test('a task thread replayed: source, a T number, the person replies, an answer, an aside, a reply, done', () => {
  const r = room(['zoe'])
  r.send(3106, 'supervisor@zoe', '@zoe sign-up fails on Safari again; please fix it.', { add: { n: 309, title: 'Fix sign-up on Safari', to: 'zoe' } })
  assert.deepEqual(r.thread(309), ['3106:source'])
  assert.equal(r.current(309), 3106)
  r.send(3211, 'web@zoe', '@zoe for T309: the form needs a fallback there. Steps below.')
  assert.deepEqual(r.thread(309), ['3106:source', '3211:thread'], '(c): @ the assignee and its one T number')
  assert.equal(r.current(309), 3211)
  r.send(3216, 'zoe', '@web@zoe done, fixed', { replyTo: 3211 })
  assert.equal(r.reply(309), 3216, '(b) by the person: their report waits')
  r.send(3217, 'web@zoe', '@zoe thanks — one more thing: the home page link', { replyTo: 3216 })
  assert.equal(r.current(309), 3217, '(b): it answers the assignee')
  assert.equal(r.reply(309), null, 'something was said to them since: the reply no longer waits')
  r.send(3220, 'supervisor@zoe', '@web@zoe can you check the footer too?', { replyTo: 3217 })
  assert.deepEqual(r.thread(309).map((x) => +x.split(':')[0]), [3106, 3211, 3216, 3217], '(b) not met: neither by, to, nor answering the assignee')
  r.send(3222, 'zoe', '@web@zoe fixed the link too', { replyTo: 3217 })
  assert.equal(r.reply(309), 3222)
  r.send(3223, 'supervisor@zoe', '@zoe verified, closing', { done: 309 })
  assert.deepEqual(r.thread(309), ['3106:source', '3211:thread', '3216:reply', '3217:thread', '3222:reply', '3223:result'])
  r.send(3224, 'web@zoe', '@zoe about T309, one last note')
  assert.equal(r.thread(309).length, 6, 'closed: nothing joins any more')
})

test('one row per message and item: source, then result, then reply, then thread wins', () => {
  const { db } = room()
  const join = (seq, rel) => db.prepare(JOIN_SQL).run(1, seq, rel)
  join(5, 'thread'); join(5, 'reply'); join(5, 'thread')
  join(6, 'reply'); join(6, 'result')
  join(7, 'source'); join(7, 'result'); join(7, 'thread')
  assert.deepEqual(db.prepare('SELECT seq, rel FROM item_messages ORDER BY seq').all().map((r) => `${r.seq}:${r.rel}`), ['5:reply', '6:result', '7:source'])
})

test('(c) needs exactly one distinct T number in prose, by or to the assignee, and not another item\'s source or result', () => {
  assert.deepEqual(tNumbers(proseOf('T309 and again T309, see `T12` and https://x.test/T13')), [309])
  assert.deepEqual(tNumbers('T3090 xT309 #309 T309a'), [3090])
  assert.deepEqual(tNumbers('看T7了'), [7])
  const it = { n: 7, assignee: 'kai', createdBy: 'lead@kai', personAssignee: true, has: () => false }
  const base = { daemonCommand: false, author: 'lead@kai', mentions: ['kai'], replyTo: null, replyToAuthor: null, tNumbers: [7], sourceOrResultOf: [] }
  assert.deepEqual(joins(base, [it]), [{ n: 7, rel: 'thread', by: 'c' }])
  assert.deepEqual(joins({ ...base, tNumbers: [7, 8] }, [it]), [], 'two distinct numbers: none')
  assert.deepEqual(joins({ ...base, mentions: ['ana'] }, [it]), [], 'neither by nor to the assignee')
  assert.deepEqual(joins({ ...base, sourceOrResultOf: [9] }, [it]), [], 'the source of another item')
  assert.deepEqual(joins({ ...base, sourceOrResultOf: [7] }, [it]), [{ n: 7, rel: 'thread', by: 'c' }], 'its own source: still joins (as source, which wins)')
  assert.deepEqual(joins({ ...base, author: 'kai', mentions: [] }, [it]), [{ n: 7, rel: 'reply', by: 'c' }], 'the person naming it: a reply')
  const unassigned = { ...it, assignee: null, personAssignee: false }
  assert.deepEqual(joins({ ...base, author: 'x@kai', mentions: ['lead@kai'] }, [unassigned]), [{ n: 7, rel: 'thread', by: 'c' }], 'no assignee: the creator stands in')
})

test('current is the latest thread message not by the assignee; the creator stands in; its line is the 加到 TODO title', () => {
  const r = room(['kai'])
  r.send(1, 'lead@kai', '@kai please review', { add: { n: 1, title: 'Review', to: 'kai' } })
  r.send(2, 'kai', '@lead@kai on it', { replyTo: 1 })
  assert.equal(r.current(1), 1, 'their own reply is not what they are asked')
  r.send(3, 'lead@kai', 'note to self T2', { add: { n: 2, title: 'Self', to: null } })
  assert.equal(r.current(2), null, 'no assignee: only messages not by the creator count')
  assert.equal(lineOf('@kai @ana  \n\n  Fix the footer  \nmore', [], 9), 'Fix the footer')
  assert.equal(lineOf('', [{ name: 'shot.png' }], 9), 'shot.png')
  assert.equal(lineOf('@kai', [], 9), '#9')
  assert.equal(lineOf('x'.repeat(100), [], 9).length, 80)
})

test('a message carries every item whose thread it is in, with how it joined', () => {
  const r = room(['kai'])
  r.send(1, 'lead@kai', '@kai two things', { add: { n: 1, title: 'One', to: 'kai' } })
  r.db.prepare("INSERT INTO items (n, title, status, assignee, created_by, created_seq) VALUES (2, 'Two', 'todo', 'kai', 'lead@kai', 1)").run()
  r.db.prepare(JOIN_SQL).run(2, 1, 'source')
  r.send(2, 'kai', '@lead@kai about both', { replyTo: 1 })
  assert.deepEqual(r.db.prepare(CARRIED_SQL).all(2).map((x) => `T${x.n}:${x.rel}`), ['T1:reply', 'T2:reply'])
})

function commandRoom() {
  const r = room()
  r.send(1, 'lead@kai', '@kai please review', { add: { n: 5, title: 'Review', to: 'kai' } })
  return r
}

test('daemon slash command naming one task joins no thread and wakes no closer', () => {
  const r = commandRoom()
  const route = r.send(2, 'kai', '@box@kai /spawn claude x T5 investigate')
  assert.deepEqual(route, { joined: [], closers: [] })
  assert.deepEqual(r.thread(5), ['1:source'])
  assert.equal(r.reply(5), null)
})

test('daemon slash command replying into a task thread also joins nothing', () => {
  const r = commandRoom()
  assert.deepEqual(r.send(2, 'kai', '@box@kai /spawn claude x T5 investigate', { replyTo: 1 }), { joined: [], closers: [] })
  assert.deepEqual(r.thread(5), ['1:source'])
  assert.equal(r.reply(5), null)
})

test('ordinary text mentioning a daemon still reports by its single task number', () => {
  const r = commandRoom()
  const route = r.send(2, 'kai', '@box@kai spawn claude x T5 investigate')
  assert.equal(route.joined[0].rel, 'reply')
  assert.deepEqual(route.closers, ['lead@kai'])
  assert.equal(r.reply(5), 2)
})

test('slash command mentioning only an agent still reports by its single task number', () => {
  const r = commandRoom()
  const route = r.send(2, 'kai', '@api@kai /spawn claude x T5 investigate')
  assert.equal(route.joined[0].rel, 'reply')
  assert.deepEqual(route.closers, ['lead@kai'])
  assert.equal(r.reply(5), 2)
})

test('backfill replays stored daemon commands without joining by reply or task number', () => {
  const r = commandRoom()
  r.send(2, 'kai', '@box@kai /spawn claude x T5 investigate', { replyTo: 1 })
  r.send(3, 'kai', '@box@kai spawn claude x T5 investigate')
  r.db.exec('DELETE FROM item_messages')
  r.replay()
  assert.deepEqual(r.thread(5), ['1:source', '3:reply'])
  assert.equal(r.reply(5), 3)
})
