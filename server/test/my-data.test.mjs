import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { DAY_MS, MY_FILES_SQL, ROOM_DAILY_SQL, ROOM_TOTALS_SQL, mapSix, thirtyDays, within } from '../src/my-data.ts'

test('room aggregation counts only this person and their agents, including old messages', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE messages (from_name TEXT, from_kind TEXT, ts INTEGER)')
  const put = db.prepare('INSERT INTO messages VALUES (?, ?, ?)')
  const today = Math.floor(Date.now() / DAY_MS)
  put.run('alice', 'human', (today - 31) * DAY_MS)
  put.run('alice', 'human', today * DAY_MS)
  put.run('api@alice', 'agent', today * DAY_MS + 10)
  put.run('other@alice', 'agent', today * DAY_MS + 20)
  put.run('bob', 'human', today * DAY_MS + 30)
  put.run('api@bob', 'agent', today * DAY_MS + 40)
  put.run('alice', 'system', today * DAY_MS + 50)
  const total = db.prepare(ROOM_TOTALS_SQL).get('alice', 'alice')
  assert.equal(total.human, 2)
  assert.equal(total.agents, 2)
  assert.equal(total.last_active, today * DAY_MS + 40)
  const daily = db.prepare(ROOM_DAILY_SQL).all((today - 29) * DAY_MS, 'alice', 'alice')
  assert.deepEqual(daily.map((row) => ({ ...row })), [{ day: today, human: 1, agents: 2 }])
  db.close()
})

test('file bytes come from this account’s charged bytes in each room', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE account_files (room_id TEXT, user_id TEXT, charged INTEGER)')
  const put = db.prepare('INSERT INTO account_files VALUES (?, ?, ?)')
  put.run('r1', 'u1', 1024); put.run('r1', 'u1', 0); put.run('r1', 'u2', 4096); put.run('r2', 'u1', 512)
  assert.deepEqual(db.prepare(MY_FILES_SQL).all('u1').map((row) => ({ ...row })), [{ room_id: 'r1', bytes: 1024 }, { room_id: 'r2', bytes: 512 }])
  db.close()
})

test('thirty-day chart fills quiet days and bounded fanout never exceeds six rooms', async () => {
  const today = Math.floor(Date.now() / DAY_MS)
  const rows = thirtyDays([
    { daily: [{ day: today - 2, human: 1, agents: 2 }] },
    { daily: [{ day: today - 2, human: 3, agents: 1 }, { day: today, human: 0, agents: 1 }] },
  ], today * DAY_MS)
  assert.equal(rows.length, 30)
  assert.deepEqual(rows.at(-3), { day: today - 2, human: 4, agents: 3 })
  assert.deepEqual(rows.at(-2), { day: today - 1, human: 0, agents: 0 })
  assert.deepEqual(rows.at(-1), { day: today, human: 0, agents: 1 })
  let active = 0, peak = 0
  const done = await mapSix(Array.from({ length: 13 }, (_, i) => i), async (i) => {
    active += 1; peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active -= 1
    return i * 2
  })
  assert.equal(peak, 6)
  assert.equal(done[12], 24)
  await assert.rejects(within(new Promise(() => {}), 1), /room data timeout/)
})
