import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { baseHandle } from '../src/handle-base.ts'

test('new dev handles use qa- and a real suggested qa- handle is moved out of the reserved prefix', () => {
  assert.equal(baseHandle('alice', true), 'qa-alice')
  assert.equal(baseHandle('qa-alice', true), 'qa-alice')
  assert.equal(baseHandle('QA-Alice', false), 'user-qa-alice')
  assert.equal(baseHandle('normal', false), 'normal')
})

test('migrations mark the seven legacy test accounts and existing qa- names without renaming them', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT UNIQUE)')
  const insert = db.prepare('INSERT INTO users VALUES (?, ?)')
  const legacy = ['impltest', 'impltest2', 'impltest3', 'impltestb', 'demo', 'kai', 'storagetest']
  for (const name of [...legacy, 'qa-new', 'zoe', 'ana']) insert.run(name, name)
  db.exec(fs.readFileSync(new URL('../migrations/0015_users_is_test.sql', import.meta.url), 'utf8'))
  db.exec(fs.readFileSync(new URL('../migrations/0016_mark_legacy_tests.sql', import.meta.url), 'utf8'))
  const rows = db.prepare('SELECT handle, is_test FROM users ORDER BY handle').all()
  assert.deepEqual(rows.filter((row) => row.is_test === 1).map((row) => row.handle).sort(), [...legacy, 'qa-new'].sort())
  assert.deepEqual(rows.filter((row) => row.is_test === 0).map((row) => row.handle), ['ana', 'zoe'])
  db.close()
})
