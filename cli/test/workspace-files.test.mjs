import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWorkspaceFiles, validateWorkspaceText } from '../src/daemon/workspace-files.mjs'
const topic = 'aaaaaaaaaaaaaaaaaaaaaa'
async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-reader-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const root = path.join(home, 'topics', topic, 'workspace')
  await fs.mkdir(root, { recursive: true })
  return { home, root, files: createWorkspaceFiles({ home, rootFor: () => root }) }
}
const rejects = async (fn, code) => assert.rejects(fn, e => e.code === code)
test('read preserves UTF-8 BOM, CRLF and exact bytes, and never returns invalid text', async t => {
  const { root, files } = await setup(t), bytes = Buffer.from('\ufeff日本語\r\n🙂\r\n')
  await fs.writeFile(path.join(root, 'file'), bytes)
  const got = await files.read(topic, 'file')
  assert.deepEqual(got.bytes, bytes); assert.equal(got.meta.bom, true); assert.equal(got.meta.eol, 'crlf')
  for (const [data, code] of [[Buffer.from([0, 1]), 'workspace_binary'], [Buffer.from([0xc3]), 'workspace_encoding'], [Buffer.from('a'.repeat(20001)), 'workspace_line_limit'], [Buffer.from('\n'.repeat(20000)), 'workspace_line_limit']]) {
    await fs.writeFile(path.join(root, 'file'), data)
    await rejects(() => files.read(topic, 'file'), code)
  }
})
test('limit-1 and limit bytes succeed, limit+1 fails without a body', async t => {
  const { root, files } = await setup(t)
  for (const size of [1048575, 1048576, 1048577]) {
    const data = Buffer.alloc(size, 97)
    for (let i = 100; i < size; i += 101) data[i] = 10
    await fs.writeFile(path.join(root, 'large'), data)
    if (size > 1048576) await rejects(() => files.read(topic, 'large'), 'workspace_too_large')
    else assert.deepEqual((await files.read(topic, 'large')).bytes, data)
  }
})
test('links, metadata and noncanonical paths never return contents', async t => {
  const { home, root, files } = await setup(t)
  await fs.writeFile(path.join(home, 'outside'), 'private')
  await fs.symlink(path.join(home, 'outside'), path.join(root, 'link'))
  await fs.symlink(home, path.join(root, 'ancestor'))
  await fs.mkdir(path.join(root, '.git')); await fs.writeFile(path.join(root, '.git', 'config'), 'private')
  for (const relative of ['../outside', '/outside', '.git/config', 'a/../link']) await rejects(() => files.read(topic, relative), 'workspace_path_denied')
  await rejects(() => files.read(topic, 'link'), 'workspace_link')
  await rejects(() => files.read(topic, 'ancestor/outside'), 'workspace_link')
  const listing = await files.list(topic)
  assert.equal(listing.entries.some(x => x.name === '.git'), false)
  assert.deepEqual(listing.entries.find(x => x.name === 'link'), { name: 'link', kind: 'link' })
})
test('200/201/3000 entries page without omission and reject changed or borrowed cursors', async t => {
  const { root, files } = await setup(t)
  for (const count of [200, 201, 3000]) {
    const dir = path.join(root, String(count)); await fs.mkdir(dir)
    await Promise.all(Array.from({ length: count }, (_, i) => fs.writeFile(path.join(dir, `f${i}`), 'x')))
    let cursor = null; const names = []
    do { const result = await files.list(topic, String(count), cursor, 'box'); assert.ok(result.entries.length <= 200); names.push(...result.entries.map(x => x.name)); cursor = result.nextCursor } while (cursor)
    assert.equal(new Set(names).size, count)
  }
  const first = await files.list(topic, '3000', null, 'box')
  await rejects(() => files.list(topic, '201', first.nextCursor, 'box'), 'workspace_directory_changed')
  await rejects(() => files.list(topic, '3000', first.nextCursor, 'other'), 'workspace_directory_changed')
  await fs.writeFile(path.join(root, '3000', 'added'), '')
  await rejects(() => files.list(topic, '3000', first.nextCursor, 'box'), 'workspace_directory_changed')
})
test('missing and empty roots stay empty without creation', async t => {
  const { root, files } = await setup(t)
  assert.equal((await files.list(topic)).entries.length, 0)
  await fs.rmdir(root)
  assert.equal((await files.list(topic)).rootMissing, true)
  await assert.rejects(fs.stat(root), e => e.code === 'ENOENT')
  await rejects(() => files.read(topic, 'missing'), 'workspace_file_missing')
})
test('directory replacement is detected on snapshot recheck', async t => {
  const { root, files } = await setup(t)
  await fs.mkdir(path.join(root, 'dir')); await fs.writeFile(path.join(root, 'dir', 'file'), 'before')
  const snapshot = await files.inspect(topic, 'dir/file')
  await fs.rename(path.join(root, 'dir'), path.join(root, 'old')); await fs.mkdir(path.join(root, 'dir')); await fs.writeFile(path.join(root, 'dir', 'file'), 'after')
  await rejects(() => files.recheck(snapshot), 'workspace_file_changed')
})
test('Unicode scalar line limit counts a surrogate pair once', () => {
  assert.doesNotThrow(() => validateWorkspaceText(Buffer.from('🙂'.repeat(20000))))
  assert.throws(() => validateWorkspaceText(Buffer.from('🙂'.repeat(20001))), e => e.code === 'workspace_line_limit')
})
