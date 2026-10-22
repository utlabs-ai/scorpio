import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const target = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-workspace-test-'))
const home = `${target}-link`
fs.symlinkSync(target, home)
process.env.SCORPIO_HOME = home
const { workspaceFor, topicFilesDir, ensureDir } = await import('../src/workspace.mjs')
const ID = 'AbCdEf0123456789_-ghIJ'

test.after(() => {
  fs.rmSync(home, { force: true })
  fs.rmSync(target, { recursive: true, force: true })
})

test('a symlinked Scorpio home is allowed while topic directories stay beneath it', () => {
  assert.ok(fs.lstatSync(home).isSymbolicLink())
  assert.equal(ensureDir(workspaceFor(ID)), path.join(home, 'topics', ID, 'workspace'))
  assert.ok(fs.statSync(path.join(target, 'topics', ID, 'workspace')).isDirectory())
})

test('topic paths are direct children of Scorpio home and use the server ID format', () => {
  assert.equal(workspaceFor(ID), path.join(home, 'topics', ID, 'workspace'))
  assert.equal(topicFilesDir(ID), path.join(home, 'topics', ID, 'files'))
  for (const id of ['', '.', '..', '../outside', 'a'.repeat(21), 'a'.repeat(23), 'a'.repeat(21) + '/']) {
    assert.throws(() => workspaceFor(id), /Invalid topic id/)
  }
})

test('ensureDir creates both topic folders and rejects files and symlinks', () => {
  assert.equal(ensureDir(workspaceFor(ID)), workspaceFor(ID))
  assert.equal(ensureDir(topicFilesDir(ID)), topicFilesDir(ID))
  assert.ok(fs.statSync(workspaceFor(ID)).isDirectory())
  const fileId = '1234567890123456789012'
  fs.mkdirSync(path.join(home, 'topics', fileId))
  fs.writeFileSync(path.join(home, 'topics', fileId, 'workspace'), 'x')
  assert.throws(() => ensureDir(workspaceFor(fileId)), /Not a directory/)
  fs.symlinkSync(home, topicFilesDir(fileId))
  assert.throws(() => ensureDir(topicFilesDir(fileId)), /Not a directory/)
  const linkId = 'abcdefghijklmnopqrstuv'
  fs.symlinkSync(home, path.join(home, 'topics', linkId))
  assert.throws(() => ensureDir(workspaceFor(linkId)), /Not a directory/)
})
