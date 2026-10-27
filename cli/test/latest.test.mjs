// dl/latest, the install command that never changes. npx keeps a tarball by its URL, so that URL holds a
// small starter (tools/latest) that installs whatever latest.json names each time it runs.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
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

test('starter installs only a downloaded package with the manifest hash', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-starter-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const bytes = Buffer.from('test archive')
  const good = { file: 'scorpio-9.9.9-abc.tgz', version: '9.9.9', sha256: createHash('sha256').update(bytes).digest('hex') }
  let manifest = good, redirect = false
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    if (req.url === '/dl/latest.json') return res.end(JSON.stringify(manifest))
    if (req.url === '/dl/' + good.file) {
      if (redirect) return res.writeHead(302, { location: '/unexpected' }).end()
      return res.end(bytes)
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  fs.cpSync(path.join(CLI_DIR, 'tools', 'latest'), path.join(tmp, 'starter'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'starter', 'server.json'), JSON.stringify({ server: base }))
  fs.mkdirSync(path.join(tmp, 'bin'))
  fs.writeFileSync(path.join(tmp, 'bin', 'npx'), '#!/bin/sh\necho "npx $*"\nfile=${2#--package=file:}\ncat "$file"\n', { mode: 0o755 })
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(tmp, 'starter', 'bin', 'latest.mjs'), '--server', 'https://other.example'], { env: testEnv(tmp, { PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}` }) })
    let out = '', err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => resolve({ code, out, err }))
  })
  const installed = await run()
  assert.equal(installed.code, 0, installed.err)
  assert.match(installed.out, /npx -y --package=file:.*scorpio-9\.9\.9-abc\.tgz scorpio --server https:\/\/other\.example/)
  assert.ok(installed.out.endsWith('test archive'))
  for (const bad of [{ ...good, file: '../outside.tgz' }, { ...good, sha256: undefined }, { ...good, sha256: '0'.repeat(64) }]) {
    manifest = bad
    const refused = await run()
    assert.equal(refused.code, 1)
    assert.equal(refused.out.includes('npx -y'), false)
  }
  manifest = good; redirect = true
  const refused = await run()
  assert.equal(refused.code, 1)
  assert.equal(refused.out.includes('npx -y'), false)
  assert.equal(requests.includes('/unexpected'), false)
})
