// dl/latest, the install command that never changes. npx keeps a tarball by its URL, so that URL holds a
// small starter (tools/latest) that installs whatever latest.json names each time it runs.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'

const CLI_DIR = fileURLToPath(new URL('..', import.meta.url))

test('pack --dir writes the starter as dl/latest, with its server in it, next to the versioned package', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-pack-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  execFileSync(process.execPath, [path.join(CLI_DIR, 'tools', 'pack.mjs'), '--server', 'https://scorpio.example/', '--dir', dir], { stdio: 'ignore' })
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'))
  assert.ok(fs.existsSync(path.join(dir, latest.file)))
  assert.match(latest.sha256, /^[0-9a-f]{64}$/)
  assert.equal(latest.sha256, createHash('sha256').update(fs.readFileSync(path.join(dir, latest.file))).digest('hex'))
  const out = path.join(dir, 'x')
  fs.mkdirSync(out)
  execFileSync('tar', ['-xzf', path.join(dir, 'latest'), '-C', out])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'package', 'server.json'), 'utf8')), { server: 'https://scorpio.example' })
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package', 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'scorpio-latest')
  assert.equal(pkg.bin['scorpio-latest'], 'bin/latest.mjs')
  assert.ok(fs.statSync(path.join(out, 'package', 'bin', 'latest.mjs')).mode & 0o100, 'executable')

  execFileSync(process.execPath, [path.join(CLI_DIR, 'tools', 'pack.mjs'), '--server', 'https://next.scorpio.example/', '--dir', dir], { stdio: 'ignore' })
  const next = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'))
  assert.notEqual(next.file, latest.file)
  assert.ok(fs.existsSync(path.join(dir, latest.file)), 'the previous package stays available after the manifest switches')
  assert.equal(next.sha256, createHash('sha256').update(fs.readFileSync(path.join(dir, next.file))).digest('hex'))
})

test('the starter asks the server which package is current and hands its arguments to npx -y <that package>', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-starter-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const server = http.createServer((req, res) => {
    if (req.url === '/dl/latest.json') return res.end(JSON.stringify({ file: 'scorpio-9.9.9-abc.tgz', version: '9.9.9' }))
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  // The starter as pack builds it, and an npx that only says what it was asked to run.
  fs.cpSync(path.join(CLI_DIR, 'tools', 'latest'), path.join(tmp, 'starter'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'starter', 'server.json'), JSON.stringify({ server: base }))
  fs.mkdirSync(path.join(tmp, 'bin'))
  fs.writeFileSync(path.join(tmp, 'bin', 'npx'), '#!/bin/sh\necho "npx $*"\n', { mode: 0o755 })
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(tmp, 'starter', 'bin', 'latest.mjs'), '--server', 'https://other.example'], { env: testEnv(tmp, { PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` }) })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ code, out }))
  })
  assert.equal(run.code, 0)
  assert.match(run.out, new RegExp(`^Scorpio 9\\.9\\.9: installing from ${base}/dl/scorpio-9\\.9\\.9-abc\\.tgz\\n`))
  assert.match(run.out, new RegExp(`npx -y ${base}/dl/scorpio-9\\.9\\.9-abc\\.tgz --server https://other\\.example\\n$`))
})

// What a deployment that knows its address serves must stay exactly what it was: installed computers and
// the install commands already handed out depend on these bytes.
test('pack with --server writes defaults.json, the starter and latest.json byte for byte as before', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-pack-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  execFileSync(process.execPath, [path.join(CLI_DIR, 'tools', 'pack.mjs'), '--server', 'https://scorpio.example/', '--dir', dir], { stdio: 'ignore' })
  const raw = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')
  const latest = JSON.parse(raw)
  assert.deepEqual(Object.keys(latest), ['file', 'version', 'sha256', 'build'])
  assert.equal(raw, JSON.stringify({ file: latest.file, version: latest.version, sha256: latest.sha256, build: latest.build }) + '\n')
  const out = path.join(dir, 'x')
  fs.mkdirSync(path.join(out, 'starter'), { recursive: true })
  execFileSync('tar', ['-xzf', path.join(dir, latest.file), '-C', out])
  execFileSync('tar', ['-xzf', path.join(dir, 'latest'), '-C', path.join(out, 'starter')])
  assert.equal(fs.readFileSync(path.join(out, 'package', 'defaults.json'), 'utf8'), '{\n  "server": "https://scorpio.example"\n}\n')
  assert.equal(fs.readFileSync(path.join(out, 'starter', 'package', 'server.json'), 'utf8'), '{"server":"https://scorpio.example"}\n')
})

test('pack without --server names no server and says so in latest.json', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-pack-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  execFileSync(process.execPath, [path.join(CLI_DIR, 'tools', 'pack.mjs'), '--dir', dir], { stdio: 'ignore' })
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'))
  assert.equal(latest.unbound, true)
  const out = path.join(dir, 'x')
  fs.mkdirSync(path.join(out, 'starter'), { recursive: true })
  execFileSync('tar', ['-xzf', path.join(dir, latest.file), '-C', out])
  execFileSync('tar', ['-xzf', path.join(dir, 'latest'), '-C', path.join(out, 'starter')])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'package', 'defaults.json'), 'utf8')), {})
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'starter', 'package', 'server.json'), 'utf8')), {})
  const bad = spawnSync(process.execPath, [path.join(CLI_DIR, 'tools', 'pack.mjs'), '--server', 'scorpio.example', '--dir', dir], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
})

test('a starter packed without a server installs from the one its --server names, and stops without one', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-starter-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const server = http.createServer((req, res) => {
    if (req.url === '/dl/latest.json') return res.end(JSON.stringify({ file: 'scorpio-9.9.9-abc.tgz', version: '9.9.9', unbound: true }))
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  fs.cpSync(path.join(CLI_DIR, 'tools', 'latest'), path.join(tmp, 'starter'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'starter', 'server.json'), '{}\n')
  fs.mkdirSync(path.join(tmp, 'bin'))
  fs.writeFileSync(path.join(tmp, 'bin', 'npx'), '#!/bin/sh\necho "npx $*"\n', { mode: 0o755 })
  const env = testEnv(tmp, { PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` })
  const starter = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(tmp, 'starter', 'bin', 'latest.mjs'), ...args], { env })
    let out = '', err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => resolve({ code, out, err }))
  })
  const run = await starter(['--server', `${base}/`])
  assert.equal(run.code, 0, run.err)
  assert.match(run.out, new RegExp(`npx -y ${base}/dl/scorpio-9\\.9\\.9-abc\\.tgz --server ${base}/\\n$`))
  const none = await starter([])
  assert.equal(none.code, 1)
  assert.equal(none.out, '')
  assert.match(none.err, /not built for one server/)
})
