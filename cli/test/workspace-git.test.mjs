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
test('staged delete then recreated path compares HEAD with disk once', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q'); await fs.writeFile(path.join(root, 'file'), 'before'); git('add', '.'); git('commit', '-qm', 'Initial file')
  git('rm', '-q', 'file'); await fs.writeFile(path.join(root, 'file'), 'recreated')
  const result = await reader.changes(topic), changes = result.repositories[0].changes
  assert.equal(changes.length, 1); assert.equal(changes[0].beforeExists, true); assert.equal(changes[0].afterExists, true); assert.equal(changes[0].kind, 'modified')
  const diff = await reader.diff(topic, '', 'file'); assert.equal(diff.before.bytes.toString(), 'before'); assert.equal(diff.after.bytes.toString(), 'recreated')
})
test('more than 500 actual changes are bounded and explicitly truncated', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q')
  await Promise.all(Array.from({ length: 505 }, (_, i) => fs.writeFile(path.join(root, `f${i}`), 'x')))
  const result = await reader.changes(topic)
  assert.equal(result.repositories[0].changes.length, 500); assert.equal(result.changesTruncated, true)
})
test('Git metadata discovery respects actual filesystem case aliases', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q'); await fs.writeFile(path.join(root, 'file'), 'text')
  await fs.rename(path.join(root, '.git'), path.join(root, '.GIT'))
  const upper = await fs.stat(path.join(root, '.GIT')), lower = await fs.stat(path.join(root, '.git')).catch(() => null)
  const result = await reader.changes(topic)
  if (lower?.ino === upper.ino && lower.dev === upper.dev) { assert.equal(result.repositories.length, 1); assert.equal(result.unavailable.length, 0) }
  else assert.equal(result.repositories.length, 0)
})
test('AM and disabled rename detection compare each actual HEAD and disk side', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q'); await fs.writeFile(path.join(root, 'old'), 'before'); git('add', '.'); git('commit', '-qm', 'Initial file')
  await fs.rename(path.join(root, 'old'), path.join(root, 'renamed')); git('add', '-A')
  await fs.writeFile(path.join(root, 'new'), 'staged'); git('add', 'new'); await fs.writeFile(path.join(root, 'new'), 'disk')
  const result = await reader.changes(topic), changes = result.repositories[0].changes
  assert.equal(changes.find(x => x.path === 'new').status, 'AM')
  assert.equal(changes.find(x => x.path === 'old').kind, 'deleted'); assert.equal(changes.find(x => x.path === 'renamed').kind, 'added')
  assert.equal(changes.some(x => x.status.includes('R')), false)
  const diff = await reader.diff(topic, '', 'new'); assert.equal(diff.before.exists, false); assert.equal(diff.after.bytes.toString(), 'disk')
})
test('an actual merge conflict retains its conflict status and disk markers', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q'); await fs.writeFile(path.join(root, 'file'), 'base\n'); git('add', '.'); git('commit', '-qm', 'Base')
  const branch = git('branch', '--show-current').trim(); git('checkout', '-qb', 'other'); await fs.writeFile(path.join(root, 'file'), 'other\n'); git('commit', '-qam', 'Other')
  git('checkout', '-q', branch); await fs.writeFile(path.join(root, 'file'), 'current\n'); git('commit', '-qam', 'Current')
  assert.throws(() => git('merge', 'other'))
  const changes = (await reader.changes(topic)).repositories[0].changes
  assert.equal(changes.find(x => x.path === 'file').kind, 'conflict')
  const diff = await reader.diff(topic, '', 'file'); assert.equal(diff.before.bytes.toString(), 'current\n'); assert.ok(diff.after.bytes.toString().includes('<<<<<<<'))
})
test('sibling repositories are grouped separately and discovery limits remain explicit', async t => {
  const { root, reader, git } = await setup(t)
  for (const name of ['app-a', 'app-b']) {
    await fs.mkdir(path.join(root, name)); git('-C', name, 'init', '-q'); await fs.writeFile(path.join(root, name, 'file'), name); git('-C', name, 'add', '.'); git('-C', name, 'commit', '-qm', 'Initial')
    await fs.writeFile(path.join(root, name, 'file'), 'now')
  }
  const result = await reader.changes(topic)
  assert.deepEqual(new Set(result.repositories.map(x => x.repo)), new Set(['app-a', 'app-b']))
  assert.equal((await reader.diff(topic, 'app-a', 'file')).before.bytes.toString(), 'app-a')
  await fs.mkdir(path.join(root, 'one/two/three/four/five'), { recursive: true })
  assert.equal((await reader.changes(topic)).discoveryTruncated, true)
})
test('an actual clean filter tripwire is never executed by the viewer Git path', async t => {
  const { root, reader, git } = await setup(t)
  git('init', '-q'); await fs.writeFile(path.join(root, 'file'), 'alpha'); git('add', '.'); git('commit', '-qm', 'Initial')
  await fs.writeFile(path.join(root, '.gitattributes'), 'file filter=tripwire\n')
  await fs.writeFile(path.join(root, 'filter.sh'), '#!/bin/sh\nprintf ran > tripwire\ncat\n', { mode: 0o755 })
  git('config', 'filter.tripwire.clean', './filter.sh'); await fs.writeFile(path.join(root, 'file'), 'bravo')
  const future = new Date(Date.now() + 2000); await fs.utimes(path.join(root, 'file'), future, future)
  git('status', '--porcelain=v1')
  assert.equal(await fs.readFile(path.join(root, 'tripwire'), 'utf8'), 'ran')
  await fs.unlink(path.join(root, 'tripwire'))
  assert.equal((await reader.changes(topic)).unavailable.length, 1)
  assert.equal(await fs.stat(path.join(root, 'tripwire')).catch(() => null), null)
})
