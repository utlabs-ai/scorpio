import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { serverUrl, verificationUrl } from '../src/server-url.mjs'
import { paneTextError } from '../src/pane-text.mjs'
import { terminalText } from '../src/terminal-text.mjs'
import { shellQuote } from '../src/shell.mjs'
import { parseSpawn, parseText } from '../src/daemon/commands.mjs'
import { withModel } from '../src/adapters/cli/index.mjs'
import { createHerdr } from '../src/adapters/terminal/herdr.mjs'
import { selfUpdate } from '../src/daemon/update.mjs'
import { execFileSync } from 'node:child_process'

test('only https or explicit local development server URLs are accepted', () => {
  for (const url of ['https://scorpio.example.com/', 'http://localhost:1234', 'http://127.0.0.1:1234']) assert.equal(serverUrl(url), url.replace(/\/$/, ''))
  for (const url of ['http://example.com', 'http://localhost.example.com', 'ftp://localhost', 'https://kai@example.com', 'https://example.com\n', 'https://example.com/#x']) assert.throws(() => serverUrl(url))
  assert.equal(verificationUrl('https://scorpio.example.com/activate?code=123', 'https://scorpio.example.com'), 'https://scorpio.example.com/activate?code=123')
  for (const url of ['https://elsewhere.example.com/activate', 'http://scorpio.example.com/activate', 'https://scorpio.example.com:444/activate', 'https://kai@scorpio.example.com/activate']) assert.throws(() => verificationUrl(url, 'https://scorpio.example.com'))
})

test('model and effort values cannot turn into permission flags', () => {
  for (const key of ['model', 'effort']) {
    assert.ok(parseSpawn(`claude api ${key}=--dangerously-skip-permissions`).error)
    for (const kind of ['claude', 'codex']) assert.throws(() => withModel(kind, [], { [key]: '--dangerously-skip-permissions' }), /Invalid/)
  }
  assert.equal(parseSpawn('claude api model=claude-opus-5-5 effort=high').model, 'claude-opus-5-5')
})

test('pane text refuses control characters and shell mode prefixes', () => {
  for (const text of ['!touch file', '  !touch file', 'a\nb', 'a\tb', 'a\x1bb', 'a\x9bb']) {
    assert.ok(paneTextError(text))
    assert.ok(parseText('api ' + text, 'kai').error)
  }
  assert.equal(paneTextError('Please continue.'), null)
  assert.equal(terminalText('name\x1b\x07\x9b\r\n'), 'name')
})

test('hook launcher shell quoting preserves spaces, quotes and metacharacters', () => {
  const launcher = "/tmp/a b'c;$(printf no)/scorpio"
  const actual = execFileSync('/bin/sh', ['-c', 'printf %s ' + shellQuote(launcher)], { encoding: 'utf8' })
  assert.equal(actual, launcher)
})

test('terminal text operands follow an option terminator', async () => {
  const calls = []
  const terminal = createHerdr({ exec: async (args) => { calls.push(args); return '{}' } })
  await terminal.sendText('w:p1', '--help')
  await terminal.inject('w:p1', '--help')
  await terminal.injectAndWatch('w:p1', '--help')
  await terminal.run('w:p1', '--help')
  for (const args of calls) assert.deepEqual(args.slice(-2), ['--', '--help'])
})

test('update fetches never follow redirects or use a clear-text remote server', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-update-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const seen = [], checked = []
  const bytes = Buffer.from('archive')
  const manifest = { file: 'scorpio.tgz', version: '1.0.0', build: 'a'.repeat(64), sha256: createHash('sha256').update(bytes).digest('hex') }
  await selfUpdate({ home, serverUrl: 'https://scorpio.example.com', currentVersion: '0.0.0', newer: () => true,
    checked: (state) => checked.push(state), fetchImpl: async (url, options) => {
      seen.push({ url, options })
      if (url.endsWith('.json')) return { ok: true, json: async () => manifest }
      throw new Error('redirect refused')
    } })
  assert.equal(seen.length, 2)
  assert.ok(seen.every(({ options }) => options.redirect === 'error'))
  assert.equal(checked.at(-1).state, 'failed')
  let fetched = false
  await selfUpdate({ serverUrl: 'http://example.com', checked: () => {}, fetchImpl: async () => { fetched = true } })
  assert.equal(fetched, false)
})
