import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWorkspaceFiles } from '../src/daemon/workspace-files.mjs'
import { createWorkspaceGit } from '../src/daemon/workspace-git.mjs'
const topic = 'aaaaaaaaaaaaaaaaaaaaaa'
async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-git-')), root = path.join(home, 'topics', topic, 'workspace')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.mkdir(root, { recursive: true })
  const files = createWorkspaceFiles({ home, rootFor: () => root }), reader = createWorkspaceGit(files)
  const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Kai', GIT_AUTHOR_EMAIL: 'kai@example.com', GIT_COMMITTER_NAME: 'Kai', GIT_COMMITTER_EMAIL: 'kai@example.com' } }).toString()
  return { root, home, reader, git }
}
test('HEAD to disk includes staged and unstaged changes, added and deleted sides', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q'); await fs.writeFile(path.join(root, 'file'), 'head\n'); await fs.writeFile(path.join(root, 'deleted'), 'old\n')
  git('add', '.'); git('commit', '-qm', 'Initial files')
  await fs.writeFile(path.join(root, 'file'), 'staged\n'); git('add', 'file'); await fs.writeFile(path.join(root, 'file'), 'disk\n')
  await fs.unlink(path.join(root, 'deleted')); await fs.writeFile(path.join(root, 'added'), '')
  const result = await reader.changes(topic)
  assert.equal(result.unavailable.length, 0); assert.equal(result.repositories.length, 1)
  const changed = result.repositories[0].changes
  assert.equal(changed.find(x => x.path === 'file').status, 'MM')
  assert.equal(changed.find(x => x.path === 'added').beforeExists, false)
  assert.equal(changed.find(x => x.path === 'deleted').afterExists, false)
  const diff = await reader.diff(topic, '', 'file')
  assert.equal(diff.before.bytes.toString(), 'head\n'); assert.equal(diff.after.bytes.toString(), 'disk\n')
  const added = await reader.diff(topic, '', 'added'); assert.equal(added.before.exists, false); assert.equal(added.after.exists, true)
  const deleted = await reader.diff(topic, '', 'deleted'); assert.equal(deleted.before.exists, true); assert.equal(deleted.after.exists, false)
})
test('no repositories and unborn repositories have distinct results', async t => {
  const { root, reader, git } = await setup(t)
  assert.equal((await reader.changes(topic)).repositories.length, 0)
  git('init', '-q'); await fs.writeFile(path.join(root, 'new'), 'new')
  const result = await reader.changes(topic)
  assert.equal(result.repositories[0].headOid, null)
  assert.equal(result.repositories[0].changes[0].kind, 'added')
  assert.equal((await reader.diff(topic, '', 'new')).before.exists, false)
})
test('config includes, filters, alternate stores and metadata links are unavailable and never execute', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q'); await fs.writeFile(path.join(root, 'new'), 'new')
  const config = await fs.readFile(path.join(root, '.git/config'))
  for (const malicious of ['\n[include]\npath = /outside\n', '\n[filter "run"]\nclean = touch never\n', '\n[core]\nworktree = /outside\n']) {
    await fs.writeFile(path.join(root, '.git/config'), Buffer.concat([config, Buffer.from(malicious)]))
    assert.equal((await reader.changes(topic)).unavailable.length, 1)
  }
  await fs.writeFile(path.join(root, '.git/config'), config)
  await fs.writeFile(path.join(root, '.git/objects/info/alternates'), '/outside\n')
  assert.equal((await reader.changes(topic)).unavailable.length, 1)
  await fs.unlink(path.join(root, '.git/objects/info/alternates'))
  await fs.symlink('/outside', path.join(root, '.git/linked'))
  assert.equal((await reader.changes(topic)).unavailable.length, 1)
  assert.equal(await fs.stat(path.join(root, 'never')).catch(() => null), null)
})
test('linked worktree .git files report unavailable and ordinary files still read', async t => {
  const { root, reader } = await setup(t)
  await fs.writeFile(path.join(root, '.git'), 'gitdir: /outside\n')
  const result = await reader.changes(topic)
  assert.equal(result.repositories.length, 0); assert.equal(result.unavailable.length, 1)
})
test('names with newline and spaces preserve the two status columns', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q'); await fs.writeFile(path.join(root, 'has\nspace name'), 'text')
  const result = await reader.changes(topic)
  assert.equal(result.repositories[0].changes[0].path, 'has\nspace name')
})
