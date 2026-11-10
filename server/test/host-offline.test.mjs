import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SEND_MEMBERS_SQL, hostOfflineSince } from '../src/host-offline.ts'

const T = Date.UTC(2026, 9, 9, 3, 20)

test('a command to an offline daemon says since when its computer is offline, like one to an agent it carries', () => {
  const daemon = { kind: 'host', offline_since: T }
  // the daemon itself is the computer (this used to come back null, so the note said "not waiting right now")
  assert.equal(hostOfflineSince(daemon, undefined), T)
  // an agent goes offline with the daemon that carries it
  assert.equal(hostOfflineSince({ kind: 'agent', offline_since: null }, daemon), T)
  // online again (the column is cleared on connect), never connected, or an agent no daemon carries
  assert.equal(hostOfflineSince({ kind: 'host', offline_since: null }, undefined), null)
  assert.equal(hostOfflineSince({ kind: 'host' }, undefined), null)
  assert.equal(hostOfflineSince({ kind: 'agent' }, undefined), null)
  assert.equal(hostOfflineSince({ kind: 'agent' }, { kind: 'host', offline_since: null }), null)
  // a daemon's answer is its own, never another row's
  assert.equal(hostOfflineSince({ kind: 'host', offline_since: null }, daemon), null)
})

test('the rows a send reads carry a daemon\'s offline_since (they did not, so the fix above never reached delivery)', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE members (name TEXT PRIMARY KEY, kind TEXT, owner TEXT, status TEXT, host_id TEXT, offline_since INTEGER, role_card TEXT, joined_at INTEGER)')
  const add = db.prepare('INSERT INTO members (name, kind, owner, status, host_id, offline_since) VALUES (?, ?, ?, ?, ?, ?)')
  add.run('daemon-2@kai', 'host', 'kai', 'active', null, T)
  add.run('api@kai', 'agent', 'kai', 'active', 'daemon-2@kai', null)
  const members = new Map(db.prepare(SEND_MEMBERS_SQL).all().map((r) => [r.name, r]))
  assert.equal(hostOfflineSince(members.get('daemon-2@kai'), undefined), T)
  assert.equal(hostOfflineSince(members.get('api@kai'), members.get(members.get('api@kai').host_id)), T)
  db.close()
})
