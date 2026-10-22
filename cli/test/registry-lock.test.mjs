import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { readRegistry, register } from '../src/daemon/registry.mjs'

const run = promisify(execFile)
const registryModule = new URL('../src/daemon/registry.mjs', import.meta.url).href
const child = `
const { register } = await import(process.argv[1])
const [file, worker, start] = process.argv.slice(2)
while (Date.now() < Number(start)) {}
for (let j = 0; j < 25; j += 1) {
  const role = 'a' + worker + '-' + j
  if (!register({ roomId: 'r', name: role + '@k', role, pane: 'p' + worker + '-' + j }, file)) process.exit(1)
}
`

test('concurrent joins keep every registry entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-registry-lock-'))
  const file = path.join(dir, 'registry.json')
  try {
    const start = Date.now() + 300
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      run(process.execPath, ['--input-type=module', '-e', child, registryModule, file, String(i), String(start)])))

    const members = readRegistry(file).r || {}
    assert.equal(Object.keys(members).length, 200, `survived ${Object.keys(members).length}/200`)
    for (let i = 0; i < 8; i += 1) {
      for (let j = 0; j < 25; j += 1) {
        assert.equal(members[`a${i}-${j}@k`]?.pane, `p${i}-${j}`)
      }
    }
    assert.equal(fs.existsSync(`${file}.lock`), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale registry lock is removed before writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-registry-lock-'))
  const file = path.join(dir, 'registry.json')
  const lock = `${file}.lock`
  try {
    fs.writeFileSync(lock, 'old')
    const stale = new Date(Date.now() - 10_000)
    fs.utimesSync(lock, stale, stale)
    assert.equal(register({ roomId: 'r', name: 'a@k', role: 'a', pane: 'p' }, file), true)
    assert.equal(readRegistry(file).r['a@k'].pane, 'p')
    assert.equal(fs.existsSync(lock), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a live owner keeps its registry lock past two seconds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-registry-lock-'))
  const file = path.join(dir, 'registry.json')
  const released = path.join(dir, 'released')
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('node:fs')
    const lock = process.argv[1] + '.lock'
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
    process.stdout.write('locked\\n')
    setTimeout(() => {
      fs.writeFileSync(process.argv[2], 'yes')
      fs.unlinkSync(lock)
    }, 2600)
  `, file, released], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(holder.stdout, 'data')
    assert.equal(register({ roomId: 'r', name: 'a@k', role: 'a', pane: 'p' }, file), true)
    assert.equal(fs.existsSync(released), true, 'the holder released its lock before register returned')
    assert.equal(readRegistry(file).r['a@k'].pane, 'p')
    assert.equal(fs.existsSync(`${file}.lock`), false)
    await once(holder, 'close')
    assert.equal(holder.exitCode, 0)
  } finally {
    if (holder.exitCode === null) holder.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
