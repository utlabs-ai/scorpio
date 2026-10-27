import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-terminal-'))
process.env.SCORPIO_HOME = home
const { ensureHerdrWorkspace } = await import('../src/up/terminal.mjs')

test('new Scorpio workspace starts in the topics directory', async () => {
  const bin = path.join(home, 'fake-herdr')
  const trace = path.join(home, 'herdr-args.txt')
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$UP_HERDR_TRACE"\nprintf "%s\\n" \'{"result":{"workspace":{"workspace_id":"w-test"}}}\'\n', { mode: 0o755 })
  process.env.UP_HERDR_TRACE = trace
  const id = await ensureHerdrWorkspace(bin)
  const topics = path.join(home, 'topics')
  assert.equal(id, 'w-test')
  assert.equal(fs.statSync(topics).isDirectory(), true)
  assert.match(fs.readFileSync(trace, 'utf8'), new RegExp('workspace create --cwd ' + topics + ' --label Scorpio --no-focus'))
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))

test('Herdr install checks its pinned binary before replacing a command', async () => {
  const { installHerdr, HERDR_VERSION } = await import('../src/up/terminal.mjs')
  const { createHash } = await import('node:crypto')
  const installDir = path.join(home, 'install')
  fs.mkdirSync(installDir)
  fs.writeFileSync(path.join(installDir, 'herdr'), 'old binary')
  const binary = Buffer.from('test binary')
  const seen = []
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, arrayBuffer: async () => binary } }
  await assert.rejects(installHerdr({ platform: 'darwin', arch: 'arm64', installDir, fetchImpl }), /sha256 mismatch/)
  assert.equal(fs.readFileSync(path.join(installDir, 'herdr'), 'utf8'), 'old binary')
  const hashes = { 'macos-aarch64': createHash('sha256').update(binary).digest('hex') }
  const installed = await installHerdr({ platform: 'darwin', arch: 'arm64', installDir, fetchImpl, hashes })
  assert.equal(fs.readFileSync(installed, 'utf8'), 'test binary')
  assert.equal(fs.statSync(installed).mode & 0o111, 0o111)
  assert.equal(HERDR_VERSION, '0.9.5')
  assert.ok(seen.every((url) => url === 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-macos-aarch64'))
  await assert.rejects(installHerdr({ platform: 'win32', arch: 'x64', installDir, fetchImpl }), /support/)
})
