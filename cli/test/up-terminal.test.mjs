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
