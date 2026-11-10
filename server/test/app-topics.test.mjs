import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { CAN_SEE_SQL, MY_TOPICS_SQL } from '../src/app-topics-sql.ts'

// The real schema: every migration, in order, on an in-memory database.
function schema() {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../migrations/', import.meta.url).pathname
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  return db
}

function seed(db) {
  const user = db.prepare("INSERT INTO users (id, handle, primary_email, created_at) VALUES (?, ?, ? || '@example.com', 0)")
  for (const [id, h] of [['u-kai', 'kai'], ['u-mei', 'mei'], ['u-zed', 'zed']]) user.run(id, h, h)
  const room = db.prepare("INSERT INTO rooms (id, owner_id, name, topic, status, created_at) VALUES (?, ?, ?, '', ?, ?)")
  room.run('r-own', 'u-kai', 'mine', 'active', 1)
  room.run('r-arch', 'u-kai', 'mine archived', 'archived', 2)
  room.run('r-del', 'u-kai', 'mine deleted', 'deleted', 3)
  room.run('r-in', 'u-mei', 'mei invited me', 'active', 4)
  room.run('r-left', 'u-mei', 'I left it', 'active', 5)
  db.exec("UPDATE rooms SET visibility = 'link' WHERE id = 'r-left'")
  room.run('r-other', 'u-mei', 'never been in', 'active', 6)
  const member = db.prepare('INSERT INTO room_members (room_id, user_id, active, updated_at) VALUES (?, ?, ?, 0)')
  member.run('r-own', 'u-kai', 1)
  member.run('r-in', 'u-kai', 1)
  member.run('r-left', 'u-kai', 0)
  member.run('r-other', 'u-zed', 1)
  const pin = db.prepare('INSERT INTO pins (user_id, room_id, pinned_at) VALUES (?, ?, ?)')
  pin.run('u-kai', 'r-in', 500)
  pin.run('u-mei', 'r-own', 900) // someone else's pin on my topic is not mine
}

test('the column lists what I created or have been in, newest first, with my own pins', () => {
  const db = schema()
  seed(db)
  const rows = db.prepare(MY_TOPICS_SQL).all('u-kai')
  assert.deepEqual(rows.map((r) => r.id), ['r-left', 'r-in', 'r-arch', 'r-own'])
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(by['r-own'].owned, 1)
  assert.equal(by['r-in'].owned, 0)
  assert.equal(by['r-in'].active, 1)
  assert.equal(by['r-left'].active, 0, 'a topic I left stays in my list, marked not active')
  assert.equal(by['r-in'].pinned_at, 500)
  assert.equal(by['r-own'].pinned_at, null, "mei's pin is hers")
})

test('only a topic I can see can be pinned', () => {
  const db = schema()
  seed(db)
  const can = (topic) => !!db.prepare(CAN_SEE_SQL).get('u-kai', topic)
  assert.equal(can('r-own'), true)
  assert.equal(can('r-arch'), true)
  assert.equal(can('r-in'), true)
  assert.equal(can('r-left'), true)
  assert.equal(can('r-other'), false)
  assert.equal(can('r-del'), false)
  assert.equal(can('no-such'), false)
})

test('a pin is one row per person and topic; pinning again moves it up', () => {
  const db = schema()
  seed(db)
  const upsert = db.prepare('INSERT INTO pins (user_id, room_id, pinned_at) VALUES (?, ?, ?) ON CONFLICT (user_id, room_id) DO UPDATE SET pinned_at = excluded.pinned_at')
  upsert.run('u-kai', 'r-in', 700)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pins WHERE user_id = ?').get('u-kai').n, 1)
  assert.equal(db.prepare(MY_TOPICS_SQL).all('u-kai').find((r) => r.id === 'r-in').pinned_at, 700)
})


test('private past membership cannot list or pin, while public past membership stays visible', () => {
  const db = schema()
  seed(db)
  db.exec("UPDATE rooms SET visibility = 'private' WHERE id = 'r-left'")
  assert.equal(db.prepare(MY_TOPICS_SQL).all('u-kai').some((r) => r.id === 'r-left'), false)
  assert.equal(db.prepare(CAN_SEE_SQL).get('u-kai', 'r-left'), undefined)
  assert.equal(db.prepare(MY_TOPICS_SQL).all('u-kai').some((r) => r.id === 'r-in'), true)
})

test('a refused summary drops the row, while an unavailable summary keeps the indexed row', async () => {
  const built = await build({ entryPoints: [new URL('../src/app-topics.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  const { myTopics } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const rows = ['refused', 'offline', 'allowed'].map((id) => ({ id, name: id, topic: 'description', owned: 0, active: 1 }))
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
    ROOMS: { getByName: (id) => ({ summary: async () => {
      if (id === 'offline') throw new Error('unavailable')
      return id === 'refused' ? { err: { code: 'not_member' } } : { ok: { public: false } }
    } }) },
  }
  const topics = await myTopics(env, { id: 'u-kai', handle: 'kai' })
  assert.deepEqual(topics.map((r) => r.id), ['offline', 'allowed'])
  assert.equal(topics[0].summary, null)
  assert.deepEqual(topics[1].summary, { public: false })
})

test('each row carries what I have not read there and how many of those @ me; null and 0 without a summary', async () => {
  const built = await build({ entryPoints: [new URL('../src/app-topics.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  const { topicsForPage } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const base = { id: 'r', name: 'r', topic: '', owned: false, active: true, archivedAt: null, archivedReason: null, pinnedAt: null }
  const summary = { counts: { todo: 0, doing: 0, done: 0 }, mine: [], public: false, archived: false, lastMs: 1, humans: 1, agents: 0, working: 0 }
  const [inIt, onlyLooked, offline] = topicsForPage([
    { ...base, id: 'in', summary: { ...summary, unread: 3, mentionUnread: 1 } },
    { ...base, id: 'looked', summary: { ...summary, unread: null, mentionUnread: 0 } }, // a public topic I only looked at
    { ...base, id: 'offline', summary: null },
  ])
  assert.equal(inIt.unread, 3)
  assert.equal(inIt.mentionUnread, 1)
  assert.equal(onlyLooked.unread, null)
  assert.equal(onlyLooked.mentionUnread, 0)
  assert.equal(offline.unread, null)
  assert.equal(offline.mentionUnread, 0)
})
