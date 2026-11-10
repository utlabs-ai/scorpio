import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ACCESS_SQL, DRIVE_ROWS_SQL, LEFTOVER_SQL, PREVIEW_SQL, PURGE_DUE_SQL, PURGE_FILES_SQL, PURGE_SQL, RESTORE_DAYS, RESTORE_SQL, TRIED_SQL, UNFINISHED_SQL, CLAIM_SQL, UNCLAIM_SQL, bindFor, purgeChunkSql } from '../src/account-delete-sql.ts'

// D1 as the migrations make it, every one of them in order, so the SQL runs against the real tables.
function d1() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const dir = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, dir), 'utf8'))
  return db
}
const DAY = 86_400_000
const T = Date.UTC(2026, 9, 10)

function people(db) {
  const user = (id, handle, email) => db.prepare('INSERT INTO users (id, handle, primary_email, created_at) VALUES (?, ?, ?, ?)').run(id, handle, email, T - 30 * DAY)
  user('u1', 'kai', 'kai@example.com')
  user('u2', 'mei', 'mei@example.com')
  db.prepare('INSERT INTO identities (provider, subject, email, user_id, created_at) VALUES (?, ?, ?, ?, ?)').run('google', 'g-kai', 'kai@example.com', 'u1', T)
  const room = (id, owner, name) => db.prepare("INSERT INTO rooms (id, owner_id, name, topic, visibility, status, created_at) VALUES (?, ?, ?, '', 'private', 'active', ?)").run(id, owner, name, T)
  room('R1', 'u1', 'kai topic')
  room('R2', 'u2', 'mei topic')
  const member = (r, u) => db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, active, updated_at) VALUES (?, ?, 1, ?)').run(r, u, T)
  member('R1', 'u1'); member('R2', 'u2'); member('R2', 'u1')
  const file = (r, f, u, size) => db.prepare('INSERT INTO account_files (room_id, file_id, user_id, size, charged, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)').run(r, f, u, size, size, T)
  file('R1', 'f1', 'u1', 100); file('R2', 'f2', 'u1', 50); file('R2', 'f3', 'u2', 7)
  db.prepare("INSERT INTO agent_tokens (id, user_id, hash, device_name, created_at, expires_at) VALUES ('t1', 'u1', 'h1', 'box', ?, ?)").run(T, T + DAY)
  db.prepare("INSERT INTO devices (user_id, device_id, device_name, created_at) VALUES ('u1', 'd1', 'box', ?)").run(T)
  db.prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES ('https://push/1', 'u1', 'k', 'a', ?)").run(T)
  db.prepare("INSERT INTO push_muted_rooms (endpoint, room_id) VALUES ('https://push/1', 'R2')").run()
  db.prepare("INSERT INTO push_test_limits (user_id, last_at) VALUES ('u1', ?)").run(T)
  db.prepare("INSERT INTO calendar_tokens (user_id, token, created_at) VALUES ('u1', 'cal-token-kai', ?)").run(T)
  db.prepare("INSERT INTO drive_links (user_id, email, token_enc, connected_at) VALUES ('u1', 'kai@gmail.com', 'sealed', ?)").run(T)
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, subscription_id, updated_at) VALUES ('u1', 'pro', 'active', ?, 'creem', 'sub_1', ?)").run(T + 20 * DAY, T)
  db.prepare("INSERT INTO payments (id, user_id, kind, product, amount, currency, mode, created_at) VALUES ('tx1', 'u1', 'paid', 'prod_m', 900, 'USD', 'live', ?)").run(T)
  db.prepare("INSERT INTO storage_usage (user_id, bytes) VALUES ('u1', 150)").run()
  const pin = (u, r) => db.prepare('INSERT INTO pins (user_id, room_id, pinned_at) VALUES (?, ?, ?)').run(u, r, T)
  pin('u1', 'R2'); pin('u2', 'R2')
}
const one = (db, sql, ...a) => db.prepare(sql).get(...a)
const run = (db, list, ...v) => { for (const sql of list) db.prepare(sql).run(...bindFor(sql, ...v)) }
// What account-delete.ts does after access went, its room objects aside: its topic deleted (the purge takes the
// topic's member rows), the other topic took it off, Drive's rows.
function finish(db) {
  db.prepare("UPDATE rooms SET status = 'deleted' WHERE owner_id = 'u1'").run()
  db.prepare("DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE owner_id = 'u1')").run()
  for (const r of db.prepare(LEFTOVER_SQL.joined).all('u1')) db.prepare('DELETE FROM room_members WHERE user_id = ? AND room_id = ?').run('u1', r.room_id)
  run(db, DRIVE_ROWS_SQL, 'u1')
}
function deleteNow(db, at) {
  run(db, ACCESS_SQL, 'u1', at)
  finish(db)
}
const count = (db, table, where = "user_id = 'u1'") => one(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).n

test('the ops page list: topics it created, its files (and how many sit in other people\'s topics), devices, push, Drive, a live subscription', () => {
  const db = d1()
  people(db)
  assert.equal(one(db, PREVIEW_SQL.user, 'kai').email, 'kai@example.com')
  assert.deepEqual(db.prepare(PREVIEW_SQL.topics).all('u1').map((r) => r.name), ['kai topic'])
  assert.deepEqual({ ...one(db, PREVIEW_SQL.files, 'u1') }, { n: 2, bytes: 150, elsewhere: 1 })
  assert.equal(one(db, PREVIEW_SQL.tokens, 'u1').n, 1)
  assert.equal(one(db, PREVIEW_SQL.devices, 'u1').n, 1)
  assert.equal(one(db, PREVIEW_SQL.push, 'u1').n, 1)
  assert.deepEqual({ ...one(db, PREVIEW_SQL.drive, 'u1') }, { email: 'kai@gmail.com', connected: 1 })
  assert.equal(one(db, PREVIEW_SQL.creem, 'u1').subscription_id, 'sub_1')
  assert.deepEqual(db.prepare(PREVIEW_SQL.joined).all('u1').map((r) => r.room_id), ['R2'])
})

test('deleting: access goes first, before anything is deleted; the row becomes a tombstone that keeps the handle', () => {
  const db = d1()
  people(db)
  run(db, ACCESS_SQL, 'u1', T)
  for (const t of ['devices', 'push_subscriptions', 'push_test_limits', 'calendar_tokens']) assert.equal(count(db, t), 0, t) // the calendar address stops with access
  // Its tokens are revoked, not deleted, so its computers are told why (docs/api/auth.md); they go with the purge.
  assert.deepEqual({ ...one(db, "SELECT revoked_at, revoked_reason FROM agent_tokens WHERE user_id = 'u1'") }, { revoked_at: T, revoked_reason: 'revoked' })
  assert.equal(one(db, PREVIEW_SQL.tokens, 'u1').n, 0)
  assert.equal(count(db, 'push_muted_rooms', "endpoint = 'https://push/1'"), 0)
  const u = one(db, 'SELECT handle, primary_email, deleted_email, deleted_at, display_name FROM users WHERE id = ?', 'u1')
  assert.deepEqual({ ...u }, { handle: 'kai', primary_email: 'deleted:u1', deleted_email: 'kai@example.com', deleted_at: T, display_name: null })
  // The entitlement stays, cancelled: no plan, and a refund still finds the account by its subscription.
  assert.deepEqual({ ...one(db, "SELECT status, canceled_at, subscription_id FROM entitlements WHERE user_id = 'u1'") }, { status: 'canceled', canceled_at: T, subscription_id: 'sub_1' })
  // Nothing deleted yet: its topic, its places in others' topics and Drive are what is left to do.
  assert.deepEqual(db.prepare(LEFTOVER_SQL.topics).all('u1').map((r) => r.id), ['R1'])
  assert.deepEqual(db.prepare(LEFTOVER_SQL.joined).all('u1').map((r) => ({ ...r })), [{ room_id: 'R2', gone: 0 }])
  assert.ok(one(db, LEFTOVER_SQL.drive, 'u1'))
  assert.deepEqual(db.prepare(UNFINISHED_SQL).all().map((r) => r.handle), ['kai'])
  finish(db)
  assert.deepEqual(db.prepare(UNFINISHED_SQL).all(), [])
  for (const t of ['drive_links', 'room_members']) assert.equal(count(db, t), 0, t)
  // Kept for the 7 days: identities (undo), files and usage. Kept for good: payments, the other person's rows.
  assert.equal(count(db, 'identities'), 1)
  assert.equal(count(db, 'account_files'), 2)
  assert.equal(count(db, 'payments'), 1)
  assert.equal(count(db, 'room_members', "user_id = 'u2'"), 1)
  // The handle is taken for good; the e-mail is free for a new account.
  assert.throws(() => db.prepare("INSERT INTO users (id, handle, primary_email, created_at) VALUES ('u3', 'kai', 'x@example.com', 1)").run())
  db.prepare("INSERT INTO users (id, handle, primary_email, created_at) VALUES ('u4', 'kai2', 'kai@example.com', 1)").run()
  // Deleting twice changes nothing.
  run(db, ACCESS_SQL, 'u1', T + 5)
  assert.equal(one(db, 'SELECT deleted_at FROM users WHERE id = ?', 'u1').deleted_at, T)
  assert.equal(one(db, "SELECT canceled_at FROM entitlements WHERE user_id = 'u1'").canceled_at, T)
})

test('a deleted topic it is listed in has no object to ask: its row just goes', () => {
  const db = d1()
  people(db)
  db.prepare("UPDATE rooms SET status = 'deleted' WHERE id = 'R2'").run()
  assert.deepEqual(db.prepare(LEFTOVER_SQL.joined).all('u1').map((r) => ({ ...r })), [{ room_id: 'R2', gone: 1 }])
})

test('the daily job takes the least recently tried first, so accounts that keep failing do not hold up the rest', () => {
  const db = d1()
  people(db)
  for (const id of ['u1', 'u2']) run(db, ACCESS_SQL, id, T + (id === 'u1' ? 0 : 1))
  assert.deepEqual(db.prepare(UNFINISHED_SQL).all().map((r) => r.id), ['u1', 'u2'])
  db.prepare(TRIED_SQL).run('u1', T + DAY)
  assert.deepEqual(db.prepare(UNFINISHED_SQL).all().map((r) => r.id), ['u2', 'u1'])
  db.prepare(RESTORE_SQL).run('u1')
  assert.equal(one(db, 'SELECT deletion_tried_at FROM users WHERE id = ?', 'u1').deletion_tried_at, null, 'undo starts it over')
  assert.deepEqual(db.prepare(UNFINISHED_SQL).all().map((r) => r.id), ['u2'], 'a restored account is not finished')
})

test('one request deletes an account: a second one within the minute is told it is in progress; a refusal lets go', () => {
  const db = d1()
  people(db)
  const claim = (at) => db.prepare(CLAIM_SQL).run('u1', at, at - 60_000).changes
  assert.equal(claim(T), 1)
  assert.equal(claim(T + 2_000), 0, 'a second tap two seconds later')
  db.prepare(UNCLAIM_SQL).run('u1') // Creem refused: nothing was deleted
  assert.equal(claim(T + 3_000), 1)
  assert.equal(claim(T + 70_000), 1, 'a request that died a minute ago does not hold it for good')
  run(db, ACCESS_SQL, 'u1', T + 70_000)
  assert.equal(claim(T + 200_000), 0, 'deleted: nothing to claim')
})

test('a topic marked deleted whose deletion was cut short (purge pending) is left to do, and holds the purge', () => {
  const db = d1()
  people(db)
  run(db, ACCESS_SQL, 'u1', T)
  db.prepare("UPDATE rooms SET status = 'deleted', purge_pending = 1 WHERE id = 'R1'").run()
  assert.deepEqual(db.prepare(LEFTOVER_SQL.topics).all('u1').map((r) => r.id), ['R1'])
  db.prepare("DELETE FROM room_members WHERE user_id = 'u1' AND room_id = 'R2'").run()
  run(db, DRIVE_ROWS_SQL, 'u1')
  assert.deepEqual(db.prepare(UNFINISHED_SQL).all().map((r) => r.id), ['u1'])
  assert.equal(db.prepare(PURGE_DUE_SQL).all(T + 30 * DAY).length, 0)
  db.prepare("UPDATE rooms SET purge_pending = 0 WHERE id = 'R1'").run() // its purge finished (the row goes with it in the Worker)
  assert.deepEqual(db.prepare(UNFINISHED_SQL).all(), [])
})

test('undo within the 7 days gives the e-mail back, unless another account took it meanwhile', () => {
  const db = d1()
  people(db)
  deleteNow(db, T)
  db.prepare(RESTORE_SQL).run('u1')
  assert.deepEqual({ ...one(db, 'SELECT primary_email, deleted_at, deleted_email FROM users WHERE id = ?', 'u1') }, { primary_email: 'kai@example.com', deleted_at: null, deleted_email: null })
  assert.equal(count(db, 'pins'), 1, 'its pin on the other topic is still there')
  // Deleted again; this time someone signs up with that e-mail first.
  run(db, ACCESS_SQL, 'u1', T)
  db.prepare("INSERT INTO users (id, handle, primary_email, created_at) VALUES ('u5', 'other', 'kai@example.com', 1)").run()
  db.prepare(RESTORE_SQL).run('u1')
  assert.deepEqual({ ...one(db, 'SELECT primary_email, deleted_at FROM users WHERE id = ?', 'u1') }, { primary_email: 'deleted:u1', deleted_at: null })
})

test('after the 7 days, once nothing is left to do: due, its files listed, then identities, files, usage and pins go; nothing comes back', () => {
  const db = d1()
  people(db)
  run(db, ACCESS_SQL, 'u1', T)
  assert.equal(RESTORE_DAYS, 7)
  const cutoff = (at) => at - RESTORE_DAYS * DAY // the query takes now minus the 7 days
  assert.equal(db.prepare(PURGE_DUE_SQL).all(cutoff(T + 8 * DAY)).length, 0, 'day 8, but still listed in a topic: not yet')
  finish(db)
  assert.equal(db.prepare(PURGE_DUE_SQL).all(cutoff(T + 6 * DAY)).length, 0, 'day 6: not yet')
  assert.deepEqual(db.prepare(PURGE_DUE_SQL).all(cutoff(T + 8 * DAY)).map((r) => r.handle), ['kai'])
  assert.deepEqual(db.prepare(PURGE_FILES_SQL).all('u1').map((r) => `${r.room_id}/${r.file_id}`), ['R1/f1', 'R2/f2'])
  // Each topic's chunk, once evicted there: out of the index and without its own page (file_rooms).
  for (const [r, f] of [['R1', 'f1'], ['R2', 'f2'], ['R2', 'f3']]) db.prepare('INSERT INTO file_rooms (file_id, room_id) VALUES (?, ?)').run(f, r)
  run(db, purgeChunkSql(1), 'u1', 'R1', 'f1')
  run(db, purgeChunkSql(1), 'u1', 'R2', 'f2')
  assert.deepEqual(db.prepare('SELECT file_id FROM file_rooms ORDER BY file_id').all().map((r) => r.file_id), ['f3'], "its files' pages go; the other person's stays")
  assert.equal(count(db, 'account_files', "user_id = 'u1'"), 0)
  run(db, PURGE_SQL, 'u1', T + 7 * DAY)
  for (const t of ['identities', 'agent_tokens', 'account_files', 'storage_usage', 'pins']) assert.equal(count(db, t), 0, t)
  assert.equal(count(db, 'pins', "user_id = 'u2'"), 1, "the other person's pin stays")
  assert.deepEqual({ ...one(db, 'SELECT handle, deleted_email, purged_at FROM users WHERE id = ?', 'u1') }, { handle: 'kai', deleted_email: null, purged_at: T + 7 * DAY })
  assert.equal(db.prepare(PURGE_DUE_SQL).all(cutoff(T + 30 * DAY)).length, 0, 'purged once')
  db.prepare(RESTORE_SQL).run('u1')
  assert.notEqual(one(db, 'SELECT deleted_at FROM users WHERE id = ?', 'u1').deleted_at, null, 'no undo after the purge')
  assert.equal(count(db, 'payments'), 1)
  assert.equal(count(db, 'account_files', "user_id = 'u2'"), 1, "the other person's files stay")
})

test('bindFor gives a statement exactly the values it names', () => {
  assert.deepEqual(bindFor('DELETE FROM x WHERE user_id = ?1', 'u1', 5), ['u1'])
  assert.deepEqual(bindFor('UPDATE x SET t = ?2 WHERE id = ?1', 'u1', 5), ['u1', 5])
  assert.deepEqual(bindFor('SELECT 1', 'u1'), [])
})
