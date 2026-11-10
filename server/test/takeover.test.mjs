import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { TAKEOVER_CANDIDATES_SQL, takeoverFromCandidates } from '../src/takeover.ts'

test('an old takeover command survives 60 newer spawn messages', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE members (name TEXT PRIMARY KEY, owner TEXT); CREATE TABLE messages (seq INTEGER PRIMARY KEY, from_name TEXT, text TEXT)')
  const member = db.prepare('INSERT INTO members VALUES (?, ?)')
  const message = db.prepare('INSERT INTO messages VALUES (?, ?, ?)')
  member.run('design@kai', 'kai')
  member.run('lead@kai', 'kai')
  member.run('stranger@zoe', 'zoe')
  const oldCommand = '@daemon@kai /spawn claude design /work'
  message.run(1, 'design@kai', ['@kai takeover command:', '```', oldCommand, '```'].join('\n'))
  for (let seq = 2; seq <= 61; seq++) {
    message.run(seq, 'lead@kai', ['```', `@daemon@kai /spawn claude other-${seq} /work`, '```'].join('\n'))
  }
  message.run(62, 'stranger@zoe', ['```', '@daemon@kai /spawn claude design /elsewhere', '```'].join('\n'))
  message.run(63, 'lead@kai', ['```', '@daemon@kai /spawn claude design-extra /work', '```'].join('\n'))
  message.run(64, 'lead@kai', 'Example only: /spawn claude design /work')

  const rows = db.prepare(TAKEOVER_CANDIDATES_SQL).all('kai', 'design', 0)
  assert.deepEqual(takeoverFromCandidates(rows, 'design@kai', 'kai', (candidate) => candidate === 'daemon@kai' ? candidate : null),
    { command: oldCommand, seq: 1 })
  db.close()
})

test('a command written by the old daemon seat is found after that sender row was renamed', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE messages (seq INTEGER PRIMARY KEY, from_name TEXT, text TEXT)')
  db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(1, 'daemon-2@kai', 'Take over:\n```\n@daemon-2@kai /spawn claude api /work\n```')
  const rows = db.prepare(TAKEOVER_CANDIDATES_SQL).all('kai', 'api', 0)
  assert.deepEqual(takeoverFromCandidates(rows, 'api@kai', 'kai', (name) => name === 'daemon-2@kai' ? 'mbp-daemon@kai' : null),
    { command: '@mbp-daemon@kai /spawn claude api /work', seq: 1 })
  db.close()
})

test('takeover candidates include only the owner and that account’s seats after removing the members join', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE messages (seq INTEGER PRIMARY KEY, from_name TEXT, text TEXT)')
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?)')
  const line = '```\n@daemon@kai /spawn claude api /work\n```'
  for (const [i, sender] of ['pm@akai', 'akai', 'kai2', 'kai', 'pm@kai', 'daemon-2@kai'].entries()) insert.run(i + 1, sender, line)
  assert.deepEqual(db.prepare(TAKEOVER_CANDIDATES_SQL).all('kai', 'api', 0).map((r) => r.seq), [6, 5, 4])
  assert.deepEqual(db.prepare(TAKEOVER_CANDIDATES_SQL).all('kai', 'api', 4).map((r) => r.seq), [6, 5])
  db.close()
})
