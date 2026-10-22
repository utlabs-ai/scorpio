import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDaemonLog, herdrExit } from '../src/daemon/log.mjs'

test('daemon log keeps 500 recent lines and writes timestamped text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-log-'))
  const file = path.join(dir, 'daemon.log')
  const log = createDaemonLog({ file, now: () => new Date('2026-10-17T14:00:00Z'), output: () => {} })
  for (let i = 0; i < 501; i += 1) log(`line ${i}`)
  assert.equal(log.recent().length, 500)
  assert.equal(log.recent()[0].text, 'line 1')
  const [timestamp, level, text] = fs.readFileSync(file, 'utf8').split('\n')[0].split('\t')
  assert.equal(new Date(timestamp).getTime(), new Date('2026-10-17T14:00:00Z').getTime())
  assert.equal(level, 'info')
  assert.equal(text, 'line 0')
  assert.equal(createDaemonLog({ file, output: () => {} }).recent().length, 500)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('daemon log uses explicit levels and keeps each message on one line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-log-'))
  const file = path.join(dir, 'daemon.log')
  const log = createDaemonLog({ file, output: () => {} })
  log.error('first\nsecond')
  assert.match(fs.readFileSync(file, 'utf8'), /\terror\tfirst ⏎ second\n$/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a failed agent prompt log cannot include the message body from the child error', () => {
  const safe = herdrExit('agent prompt', { code: 7, message: 'herdr agent prompt w:p Secret message', stderr: 'Secret message' })
  assert.equal(safe, 'herdr agent prompt exit 7')
})

test('daemon log rotates to one previous file before the size limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-log-'))
  const file = path.join(dir, 'daemon.log')
  const log = createDaemonLog({ file, maxBytes: 90, now: () => new Date('2026-10-17T14:00:00Z'), output: () => {} })
  for (let i = 0; i < 5; i += 1) log(`line ${i}`)
  assert.equal(fs.existsSync(`${file}.2`), false)
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /line 2|line 3/)
  assert.match(log.all().at(-1), /line 4/)
  fs.rmSync(dir, { recursive: true, force: true })
})
