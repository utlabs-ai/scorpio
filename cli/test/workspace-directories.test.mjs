import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWorkspaceDirectories } from '../src/daemon/workspace-directories.mjs'
import { createWorkspaceFiles } from '../src/daemon/workspace-files.mjs'
import { createWorkspaceGit } from '../src/daemon/workspace-git.mjs'
import { workspaceRequest, workspaceJsonResult, workspaceDirectoryMeta } from '../src/workspace-protocol.mjs'
const topic = 'aaaaaaaaaaaaaaaaaaaaaa', id = '00000000-0000-4000-8000-000000000000'
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code)
async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-reader-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const root = path.join(home, 'topics', topic, 'workspace'), a = path.join(home, 'outside-a'), b = path.join(home, 'outside-b')
  await Promise.all([root, a, b].map(p => fs.mkdir(p, { recursive: true })))
  const options = { home, rootFor: () => root, systemHome: () => home }
  return { home, root, a, b, directories: createWorkspaceDirectories(options), files: createWorkspaceFiles(options) }
}
test('wire requires an explicit bound directory after initial list and rejects malformed extensions', () => {
  const base = { connectionId: id, connectionToken: 'a'.repeat(43), epoch: id, requestId: id }
  const initial = { ...base, op: 'list', path: '', directory: { path: '/home/kai' } }
  assert.deepEqual(workspaceRequest(initial), initial)
  assert.doesNotThrow(() => workspaceRequest({ ...base, op: 'locations' }))
  for (const request of [ { ...initial, op: 'read', path: 'file' }, { ...initial, cursor: 'page' }, { ...initial, directory: null }, { ...initial, directory: { path: '/home/kai', extra: true } }, ...['relative', '/a/', '/a//b', '/a/../b', '/a\\b', '/a\0b'].map(path => ({ ...initial, directory: { path } })), { ...base, op: 'locations', path: '' }, { ...base, op: 'locations', directory: { path: '/' } } ]) assert.throws(() => workspaceRequest(request), e => e.code === 'workspace_protocol_error')
  assert.doesNotThrow(() => workspaceRequest({ ...initial, op: 'read', path: '.env', directory: { path: '/', id: '1:2' } }))
  assert.throws(() => workspaceDirectoryMeta({ directory: { path: '/' }, defaultWorkspace: false }, false))
  const value = { defaultPath: '/default', homePath: '/home', entries: [{ path: '/project', kinds: ['agent'], agents: ['api@kai'] }], truncated: false }
  assert.deepEqual(workspaceJsonResult('locations', value), value)
  for (const agents of [null, 'api@kai', ['<b>@kai'], ['x'.repeat(63) + '@kai'], Array(33).fill('api@kai'), [1]]) assert.throws(() => workspaceJsonResult('locations', { ...value, entries: [{ ...value.entries[0], agents }] }))
  assert.doesNotThrow(() => workspaceJsonResult('locations', { ...value, entries: [{ path: '/project', kinds: ['agent'] }] }))
})
test('two external scopes read different exact bytes, permit dot files, and never change cwd', async t => {
  const { a, b, directories, files } = await setup(t), cwd = process.cwd()
  await fs.mkdir(path.join(a, '.ssh')); await fs.writeFile(path.join(a, '.ssh', 'fixture'), 'key fixture')
  await fs.writeFile(path.join(a, '.env'), 'A=one'); await fs.writeFile(path.join(b, '.env'), 'B=two')
  const [sa, sb] = await Promise.all([a, b].map(path => directories.select(topic, { path })))
  assert.equal(sa.path, await fs.realpath(a)); assert.match(sa.id, /^\d+:\d+$/); assert.equal(sa.defaultWorkspace, false)
  const got = await Promise.all([files.read(topic, '.env', { scope: sa }), files.read(topic, '.env', { scope: sb })])
  assert.deepEqual(got.map(x => x.bytes.toString()), ['A=one', 'B=two'])
  assert.equal((await files.read(topic, '.ssh/fixture', { scope: sa })).bytes.toString(), 'key fixture')
  assert.equal(process.cwd(), cwd)
  await fs.writeFile(path.join(a, 'new-child'), '')
  assert.equal((await directories.select(topic, { path: sa.path, id: sa.id })).id, sa.id)
  await fs.rename(a, a + '-old'); await fs.mkdir(a)
  await rejects(() => directories.select(topic, { path: a, id: sa.id }), 'workspace_directory_changed')
  await rejects(() => files.read(topic, '.env', { scope: sa }), 'workspace_directory_changed')
})
test('root aliases are canonicalized but Git metadata roots, aliases and content links are refused', async t => {
  const { home, a, directories, files } = await setup(t)
  await fs.mkdir(path.join(a, '.git')); await fs.writeFile(path.join(a, '.git', 'config'), 'metadata')
  await fs.symlink(a, path.join(home, 'alias')); await fs.symlink(path.join(a, '.git'), path.join(home, 'metadata-alias'))
  const scope = await directories.select(topic, { path: path.join(home, 'alias') })
  assert.equal(scope.path, await fs.realpath(a))
  for (const candidate of [path.join(a, '.git'), path.join(a, '.git/config'), path.join(home, 'metadata-alias')]) await rejects(() => directories.select(topic, { path: candidate }), 'workspace_path_denied')
  const lower = await fs.stat(path.join(a, '.git')), upper = await fs.stat(path.join(a, '.GIT')).catch(() => null)
  if (upper && lower.ino === upper.ino) await rejects(() => directories.select(topic, { path: path.join(a, '.GIT') }), 'workspace_path_denied')
  else { await fs.mkdir(path.join(a, '.GIT')); await fs.writeFile(path.join(a, '.GIT', 'file'), 'ordinary'); const independent = await directories.select(topic, { path: path.join(a, '.GIT') }); assert.equal((await files.read(topic, 'file', { scope: independent })).bytes.toString(), 'ordinary') }
  await fs.symlink(home, path.join(a, 'link'))
  await rejects(() => files.read(topic, 'link/other', { scope }), 'workspace_link')
  assert.equal((await files.list(topic, '', null, 'box', scope)).entries.some(e => e.name === '.git'), false)
})
test('default missing, other missing, non-directory, denied and empty have distinct real results', async t => {
  const { root, a, b, directories, files } = await setup(t)
  await fs.rmdir(root)
  const missing = await directories.select(topic, { path: root })
  assert.equal(missing.defaultWorkspace, true); assert.equal(missing.id, undefined)
  assert.equal((await files.list(topic, '', null, 'box', missing)).rootMissing, true)
  await assert.rejects(fs.stat(root), e => e.code === 'ENOENT')
  await rejects(() => directories.select(topic, { path: path.join(a, 'missing') }), 'workspace_directory_missing')
  await fs.writeFile(path.join(a, 'file'), '')
  await rejects(() => directories.select(topic, { path: path.join(a, 'file') }), 'workspace_not_directory')
  const empty = await directories.select(topic, { path: b })
  assert.deepEqual((await files.list(topic, '', null, 'box', empty)).entries, [])
  await fs.chmod(b, 0); t.after(() => fs.chmod(b, 0o700).catch(() => {}))
  if (process.getuid?.() !== 0) await rejects(() => directories.select(topic, { path: b }), 'workspace_directory_denied')
})
test('external pagination binds physical root and computer as well as directory version', async t => {
  const { a, b, directories, files } = await setup(t)
  await Promise.all(Array.from({ length: 201 }, (_, i) => fs.writeFile(path.join(a, `f${i}`), 'x')))
  const sa = await directories.select(topic, { path: a }), sb = await directories.select(topic, { path: b })
  const page = await files.list(topic, '', null, 'box', sa)
  assert.equal(page.entries.length, 200); assert.ok(page.nextCursor.length <= 512)
  assert.equal((await files.list(topic, '', page.nextCursor, 'box', sa)).entries.length, 1)
  await rejects(() => files.list(topic, '', page.nextCursor, 'box', sb), 'workspace_directory_changed')
  await rejects(() => files.list(topic, '', page.nextCursor, 'other', sa), 'workspace_directory_changed')
  await fs.writeFile(path.join(a, 'added'), '')
  const renewed = await directories.select(topic, { path: a, id: sa.id })
  await rejects(() => files.list(topic, '', page.nextCursor, 'box', renewed), 'workspace_directory_changed')
})
test('locations use only this topic records and authenticated filename identities, merging labels and bounds', async t => {
  const { home, root, a, directories } = await setup(t), records = path.join(home, 'spawns', topic)
  await fs.mkdir(records, { recursive: true })
  const write = (name, dir) => fs.writeFile(path.join(records, `${name}.json`), JSON.stringify({ dir, name: 'fake@zoe', account: 'zoe' }))
  await write('api', a); await write('web', a); await write('pm', root); await write('bad name', a); await write('invalid', 'relative')
  await fs.writeFile(path.join(records, 'broken.json'), '{')
  await fs.mkdir(path.join(home, 'spawns', 'bbbbbbbbbbbbbbbbbbbbbb')); await fs.writeFile(path.join(home, 'spawns', 'bbbbbbbbbbbbbbbbbbbbbb', 'other.json'), JSON.stringify({ dir: '/other-topic' }))
  let value = await directories.locations(topic, 'kai')
  assert.equal(value.homePath, home); assert.equal(value.defaultPath, root)
  assert.deepEqual(value.entries.find(e => e.path === a).agents, ['api@kai', 'web@kai'])
  assert.deepEqual(value.entries.find(e => e.path === root), { path: root, kinds: ['default', 'agent'], agents: ['pm@kai'] })
  assert.equal(value.entries.some(e => e.path === '/other-topic'), false)
  for (let i = 0; i < 40; i++) await write(`role${String(i).padStart(2, '0')}`, a)
  value = await directories.locations(topic, 'kai')
  assert.equal(value.truncated, true); assert.equal(value.entries.find(e => e.path === a).agents.length, 32)
  assert.deepEqual(value.entries.find(e => e.path === a).agents, ['api@kai', ...Array.from({ length: 31 }, (_, i) => `role${String(i).padStart(2, '0')}@kai`)])
  for (let i = 0; i < 205; i++) await write(`dir${i}`, `/candidate-${i}`)
  value = await directories.locations(topic, 'kai')
  assert.equal(value.entries.length, 200); assert.equal(value.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 262144); assert.doesNotThrow(() => workspaceJsonResult('locations', value))
})
test('Git and files share an external scope and selecting an inner directory never scans up', async t => {
  const { a, directories, files } = await setup(t), git = createWorkspaceGit(files)
  const command = (...args) => execFileSync('git', ['-C', a, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  command('init', '-q'); command('config', 'user.name', 'kai'); command('config', 'user.email', 'kai@example.com')
  await fs.mkdir(path.join(a, 'src')); await fs.writeFile(path.join(a, 'src/file'), 'before\n')
  command('add', '.'); command('commit', '-qm', 'Initial content'); await fs.writeFile(path.join(a, 'src/file'), 'after\n')
  const scope = await directories.select(topic, { path: a })
  const changes = await git.changes(topic, { scope })
  assert.equal(changes.repositories[0].repo, ''); assert.equal(changes.repositories[0].changes[0].path, 'src/file')
  const diff = await git.diff(topic, '', 'src/file', { scope })
  assert.equal(diff.before.bytes.toString(), 'before\n'); assert.equal(diff.after.bytes.toString(), 'after\n')
  const inner = await directories.select(topic, { path: path.join(a, 'src') })
  assert.deepEqual((await git.changes(topic, { scope: inner })).repositories, [])
})
