import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'
import { exposeLauncher } from '../src/install-path.mjs'
import { checkToken, onServerChange } from '../src/install-token.mjs'
import { buildId } from '../src/build-id.mjs'

const install = fileURLToPath(new URL('../bin/install.mjs', import.meta.url))
const CLI_DIR = fileURLToPath(new URL('..', import.meta.url))

function packageCopy(dir, suffix = '') {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'))
  fs.mkdirSync(dir, { recursive: true })
  for (const name of [...pkg.files, 'package.json']) {
    const source = path.join(CLI_DIR, name)
    if (fs.existsSync(source)) fs.cpSync(source, path.join(dir, name), { recursive: true })
  }
  if (suffix) fs.appendFileSync(path.join(dir, 'README.md'), suffix)
  return path.join(dir, 'bin', 'install.mjs')
}

test('install keeps one previous different build, and a same-build install leaves it there', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-prev-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = testEnv(home, { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  const a = packageCopy(path.join(home, 'a'))
  const b = packageCopy(path.join(home, 'b'), 'build-b')
  const c = packageCopy(path.join(home, 'c'), 'build-c')
  const app = path.join(home, '.scorpio', 'app')
  const previous = path.join(home, '.scorpio', 'app.prev')
  const installed = (script, args = []) => {
    const run = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
  }
  installed(a)
  const first = fs.readFileSync(path.join(app, '.build'), 'utf8').trim()
  assert.equal(fs.existsSync(previous), false)
  installed(b)
  const second = fs.readFileSync(path.join(app, '.build'), 'utf8').trim()
  assert.notEqual(second, first)
  assert.equal(fs.readFileSync(path.join(previous, '.build'), 'utf8').trim(), first)
  installed(c)
  const third = fs.readFileSync(path.join(app, '.build'), 'utf8').trim()
  assert.notEqual(third, second)
  assert.equal(fs.readFileSync(path.join(previous, '.build'), 'utf8').trim(), second)
  installed(c)
  assert.equal(fs.readFileSync(path.join(previous, '.build'), 'utf8').trim(), second)
})

test('installer refuses locally skipped or rolled-back builds unless forced', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-bad-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = testEnv(home, { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  const a = packageCopy(path.join(home, 'a'))
  const b = packageCopy(path.join(home, 'b'), 'bad-build')
  const dir = path.join(home, '.scorpio')
  const first = spawnSync(process.execPath, [a], { env, encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  const original = fs.readFileSync(path.join(dir, 'app', '.build'), 'utf8').trim()
  const bad = buildId(path.dirname(path.dirname(b)))
  fs.mkdirSync(path.join(dir, 'state'))
  fs.writeFileSync(path.join(dir, 'state', 'rollback.json'), JSON.stringify({ bad: { version: '0.15.12', build: bad } }))
  const refused = spawnSync(process.execPath, [b], { env, encoding: 'utf8' })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /rolled back/)
  assert.equal(fs.readFileSync(path.join(dir, 'app', '.build'), 'utf8').trim(), original)
  fs.rmSync(path.join(dir, 'state', 'rollback.json'))
  fs.writeFileSync(path.join(dir, 'state', 'skip.json'), JSON.stringify({ version: '0.15.12', build: bad }))
  const skipped = spawnSync(process.execPath, [b], { env, encoding: 'utf8' })
  assert.notEqual(skipped.status, 0)
  const forced = spawnSync(process.execPath, [b, '--force'], { env, encoding: 'utf8' })
  assert.equal(forced.status, 0, forced.stderr)
  assert.equal(fs.readFileSync(path.join(dir, 'app', '.build'), 'utf8').trim(), bad)
  assert.equal(fs.readFileSync(path.join(dir, 'app.prev', '.build'), 'utf8').trim(), original)
})

test('a staging home keeps its previous build and skip decision separate from the default home', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-homes-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const a = packageCopy(path.join(home, 'a'))
  const b = packageCopy(path.join(home, 'b'), 'staging-build')
  const defaultDir = path.join(home, '.scorpio')
  const stagingDir = path.join(home, '.scorpio-staging')
  const env = testEnv(home, { SCORPIO_HOME: '', PATH: '/usr/bin:/bin', SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  const installAt = (script, dir) => spawnSync(process.execPath, [script], { env: { ...env, SCORPIO_HOME: dir }, encoding: 'utf8' })
  const first = installAt(a, '')
  assert.equal(first.status, 0, first.stderr)
  const initial = fs.readFileSync(path.join(defaultDir, 'app', '.build'), 'utf8').trim()
  const bad = buildId(path.dirname(path.dirname(b)))
  fs.mkdirSync(path.join(defaultDir, 'state'))
  fs.writeFileSync(path.join(defaultDir, 'state', 'skip.json'), JSON.stringify({ build: bad, version: '0.15.12' }))
  const stageFirst = installAt(a, stagingDir)
  assert.equal(stageFirst.status, 0, stageFirst.stderr)
  const stageNext = installAt(b, stagingDir)
  assert.equal(stageNext.status, 0, stageNext.stderr)
  assert.equal(fs.readFileSync(path.join(stagingDir, 'app.prev', '.build'), 'utf8').trim(), initial)
  assert.equal(fs.readFileSync(path.join(stagingDir, 'app', '.build'), 'utf8').trim(), bad)
  assert.equal(fs.readFileSync(path.join(defaultDir, 'app', '.build'), 'utf8').trim(), initial)
  assert.equal(fs.existsSync(path.join(defaultDir, 'app.prev')), false)
  fs.mkdirSync(path.join(stagingDir, 'state'))
  fs.writeFileSync(path.join(stagingDir, 'state', 'skip.json'), JSON.stringify({ build: bad, version: '0.15.12' }))
  assert.notEqual(installAt(b, stagingDir).status, 0)
})

test('packed manifest and installed package share a content build id; one changed byte changes it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-build-id-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const output = path.join(home, 'dl')
  const packed = spawnSync(process.execPath, [path.join(CLI_DIR, 'tools', 'pack.mjs'), '--server', 'https://scorpio.example', '--dir', output], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'latest.json'), 'utf8'))
  const extracted = path.join(home, 'extracted')
  fs.mkdirSync(extracted)
  const unpack = spawnSync('tar', ['-xzf', path.join(output, manifest.file), '-C', extracted], { encoding: 'utf8' })
  assert.equal(unpack.status, 0, unpack.stderr)
  const pkgDir = path.join(extracted, 'package')
  assert.equal(buildId(pkgDir), manifest.build)
  const env = testEnv(home, { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  const installed = spawnSync(process.execPath, [path.join(pkgDir, 'bin', 'install.mjs')], { env, encoding: 'utf8' })
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(fs.readFileSync(path.join(home, '.scorpio', 'app', '.build'), 'utf8').trim(), manifest.build)
  fs.appendFileSync(path.join(pkgDir, 'README.md'), 'x')
  assert.notEqual(buildId(pkgDir), manifest.build)
})

test('install twice links one command that runs whoami in a fresh shell', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const bin = path.join(home, '.local', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  const env = testEnv(home, { PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/zsh', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  for (let i = 0; i < 2; i += 1) {
    const run = spawnSync(process.execPath, [install], { env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /Command: scorpio \(linked at/)
  }
  const link = path.join(bin, 'scorpio')
  assert.equal(fs.readlinkSync(link), path.join(home, '.scorpio', 'bin', 'scorpio'))
  const shell = spawnSync('/bin/sh', ['-c', 'scorpio whoami'], { env, encoding: 'utf8' })
  assert.equal(shell.status, 0, shell.stderr)
  const result = JSON.parse(shell.stdout)
  assert.equal(result.account, null)
  assert.match(result.next, /No token on this computer/)
})

test('a non-default SCORPIO_HOME installs and runs separately without changing the default home or agent links', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const defaultDir = path.join(home, '.scorpio')
  const stagingDir = path.join(home, ".scorpio staging's")
  const bin = path.join(home, '.local', 'bin')
  fs.mkdirSync(path.join(defaultDir, 'app'), { recursive: true })
  fs.writeFileSync(path.join(defaultDir, 'app', 'production'), 'production app')
  fs.writeFileSync(path.join(defaultDir, 'config.json'), '{"server":"https://production.example"}\n')
  fs.writeFileSync(path.join(defaultDir, 'token'), 'production token\n')
  fs.mkdirSync(path.join(defaultDir, 'state'))
  fs.writeFileSync(path.join(defaultDir, 'state', 'health'), 'production health')
  for (const agent of ['.claude', '.codex']) {
    const skills = path.join(home, agent, 'skills')
    fs.mkdirSync(skills, { recursive: true })
    fs.symlinkSync(path.join(defaultDir, 'skill'), path.join(skills, 'scorpio'))
  }
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  const env = testEnv(home, { SCORPIO_HOME: stagingDir, SCORPIO_AGENT: 'codex', PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/zsh', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  const run = spawnSync(process.execPath, [install, '--server', 'https://staging.example'], { env, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(fs.readFileSync(path.join(stagingDir, 'config.json'), 'utf8').includes('https://staging.example'), true)
  assert.ok(fs.existsSync(path.join(stagingDir, 'app', 'bin', 'scorpio.mjs')))
  assert.equal(fs.readFileSync(path.join(defaultDir, 'app', 'production'), 'utf8'), 'production app')
  assert.equal(fs.readFileSync(path.join(defaultDir, 'config.json'), 'utf8'), '{"server":"https://production.example"}\n')
  assert.equal(fs.readFileSync(path.join(defaultDir, 'token'), 'utf8'), 'production token\n')
  assert.equal(fs.readFileSync(path.join(defaultDir, 'state', 'health'), 'utf8'), 'production health')
  assert.deepEqual(fs.readdirSync(defaultDir).sort(), ['app', 'config.json', 'state', 'token'])
  assert.equal(fs.existsSync(path.join(bin, 'scorpio')), false)
  assert.equal(fs.existsSync(path.join(home, '.zshrc')), false)
  for (const agent of ['.claude', '.codex']) assert.equal(fs.readlinkSync(path.join(home, agent, 'skills', 'scorpio')), path.join(defaultDir, 'skill'))
  const launcher = path.join(stagingDir, 'bin', 'scorpio')
  const result = spawnSync(launcher, ['whoami'], { env: { ...env, SCORPIO_HOME: '' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).account, null)
})

test('launcher uses its own home by default and another install when SCORPIO_HOME is given', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-launcher-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dirs = [path.join(home, "default home's"), path.join(home, "other home's")]
  const env = testEnv(home, { PATH: '/usr/bin:/bin', SHELL: '/bin/sh' })
  for (const dir of dirs) {
    const installed = spawnSync(process.execPath, [install], { env: { ...env, SCORPIO_HOME: dir }, encoding: 'utf8' })
    assert.equal(installed.status, 0, installed.stderr)
    fs.mkdirSync(path.join(dir, 'node', 'bin'), { recursive: true })
    fs.symlinkSync(process.execPath, path.join(dir, 'node', 'bin', 'node'))
    fs.writeFileSync(path.join(dir, 'app', 'bin', 'scorpio.mjs'),
      'console.log(JSON.stringify({ home: process.env.SCORPIO_HOME, app: import.meta.url, args: process.argv.slice(2) }))\n')
  }
  const launcher = path.join(dirs[0], 'bin', 'scorpio')
  const withoutHome = { ...env }
  delete withoutHome.SCORPIO_HOME
  for (const [childEnv, expected] of [[withoutHome, dirs[0]], [{ ...env, SCORPIO_HOME: '' }, dirs[0]], [{ ...env, SCORPIO_HOME: dirs[1] }, dirs[1]]]) {
    const run = spawnSync(launcher, ['one argument', 'two'], { env: childEnv, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout)
    assert.equal(result.home, expected)
    assert.equal(fs.realpathSync(fileURLToPath(result.app)), fs.realpathSync(path.join(expected, 'app', 'bin', 'scorpio.mjs')))
    assert.deepEqual(result.args, ['one argument', 'two'])
  }
})

test('without a writable PATH directory, fallback adds one shell startup line', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const args = { home, launcher: path.join(home, '.scorpio', 'bin', 'scorpio'), pathEnv: '/usr/bin:/bin', platform: 'darwin', shell: '/bin/zsh' }
  assert.deepEqual(exposeLauncher(args), { mode: 'rc', path: path.join(home, '.zshrc') })
  exposeLauncher(args)
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8').split('export PATH="$HOME/.scorpio/bin:$PATH"').length - 1, 1)
})

test('an existing earlier scorpio command is not replaced or shadowed by a later link', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const earlier = path.join(home, 'earlier'), local = path.join(home, '.local', 'bin')
  fs.mkdirSync(earlier)
  fs.mkdirSync(local, { recursive: true })
  fs.writeFileSync(path.join(earlier, 'scorpio'), 'another command')
  const result = exposeLauncher({ home, launcher: path.join(home, '.scorpio', 'bin', 'scorpio'), pathEnv: `${earlier}:${local}`, platform: 'darwin', shell: '/bin/zsh' })
  assert.equal(result.mode, 'rc')
  assert.equal(fs.existsSync(path.join(local, 'scorpio')), false)
})

// Another --server than config.json. The token is shown only to the package's own server (defaults.json)
// and kept if it accepts it; any other address never sees it and it goes, as before.
const runInstall = (installer, env, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [installer, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })
  child.on('close', (status) => resolve({ status, stdout, stderr }))
})

// fake: 200 or 401 (a server that answers), or 'unreachable'. packagedIsFake: whether the package was built for it.
async function serverChange(t, fake, { packagedIsFake = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, '.scorpio')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: 'https://old.example', device_id: 'dev-1' }))
  fs.writeFileSync(path.join(dir, 'token'), 'tok-123\n')
  fs.writeFileSync(path.join(dir, 'device.json'), '{}')
  const asked = []
  let to
  if (fake === 'unreachable') {
    const probe = http.createServer()
    await new Promise((r) => probe.listen(0, '127.0.0.1', r))
    to = `http://127.0.0.1:${probe.address().port}`
    await new Promise((r) => probe.close(r)) // nothing listens there any more
  } else {
    const server = http.createServer((req, res) => {
      asked.push({ url: req.url, auth: req.headers.authorization, cli: req.headers['x-scorpio-cli'] })
      res.writeHead(fake, { 'Content-Type': 'application/json' }).end(fake === 200 ? '{"account":"kai"}' : '{"error":"unauthorized"}')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    t.after(() => server.close())
    to = `http://127.0.0.1:${server.address().port}`
  }
  // The package as pack.mjs builds it: the server it is for baked into defaults.json.
  const pkgDir = path.join(home, 'pkg')
  for (const f of ['bin', 'src', 'package.json']) fs.cpSync(path.join(CLI_DIR, f), path.join(pkgDir, f), { recursive: true })
  const packaged = packagedIsFake ? to : 'https://scorpio.example'
  fs.writeFileSync(path.join(pkgDir, 'defaults.json'), JSON.stringify({ server: packaged }))
  const env = testEnv(home, { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  const run = await runInstall(path.join(pkgDir, 'bin', 'install.mjs'), env, ['--server', to])
  assert.equal(run.status, 0, run.stderr)
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  assert.equal(config.server, to)
  assert.equal(config.device_id, 'dev-1')
  assert.equal(fs.existsSync(path.join(dir, 'device.json')), false) // a pending code of the old server
  const token = fs.existsSync(path.join(dir, 'token')) ? fs.readFileSync(path.join(dir, 'token'), 'utf8').trim() : null
  return { run, token, asked, to }
}

test("the package's own server accepts the token (200 on whoami): the token is kept, only the address changes", async (t) => {
  const { run, token, asked, to } = await serverChange(t, 200)
  assert.equal(token, 'tok-123')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].url, '/api/v1/whoami')
  assert.equal(asked[0].auth, 'Bearer tok-123')
  assert.match(asked[0].cli, /^\d+\.\d+\.\d+/)
  assert.ok(run.stdout.includes(`Server changed from https://old.example to ${to}: it accepts this computer's token, so the token is kept.`), run.stdout)
})

test("the package's own server refuses the token (401): the token is removed and the person approves again", async (t) => {
  const { run, token, asked } = await serverChange(t, 401)
  assert.equal(token, null)
  assert.equal(asked.length, 1)
  assert.match(run.stdout, /it refused this computer's token \(401\), so the token was removed and the next join asks your person to approve this computer again\./)
})

test("the package's own server cannot be reached: the token is kept and the output says it was not checked", async (t) => {
  const { run, token } = await serverChange(t, 'unreachable')
  assert.equal(token, 'tok-123')
  assert.match(run.stdout, /could not check this computer's token there \(ECONNREFUSED\), so it is kept\. If that server refuses it, the next scorpio command removes it/)
})

test('a new address that is not the package\'s server is never sent the token: it is removed, as before', async (t) => {
  const { run, token, asked, to } = await serverChange(t, 200, { packagedIsFake: false })
  assert.equal(asked.length, 0) // no request at all, so no Authorization header reached it
  assert.equal(token, null)
  assert.ok(run.stdout.includes(`Server changed from https://old.example to ${to}: removed this computer's token without sending it there (only https://scorpio.example, the server this package is built for, is asked whether it still takes it)`), run.stdout)
})

test('checkToken: a network failure is tried again; another status is no verdict on the token', async () => {
  const calls = []
  const flaky = async (url) => { calls.push(url); if (calls.length < 3) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); return { status: 200 } }
  assert.deepEqual(await checkToken({ server: 'https://s', token: 't', fetchImpl: flaky, sleep: async () => {} }), { verdict: 'ok' })
  assert.equal(calls.length, 3)
  const down = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }) }
  assert.deepEqual(await checkToken({ server: 'https://s', token: 't', fetchImpl: down, sleep: async () => {} }), { verdict: 'unknown', reason: 'ECONNRESET' })
  assert.deepEqual(await checkToken({ server: 'https://s', token: 't', fetchImpl: async () => ({ status: 502 }), sleep: async () => {} }), { verdict: 'unknown', reason: 'HTTP 502' })
})

test('onServerChange: no token yet changes only the address; another server than the trusted one is never asked', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-install-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let asked = 0
  const check = async () => { asked += 1; return { verdict: 'ok' } }
  assert.equal(await onServerChange({ dir, from: 'https://a', to: 'https://b', trusted: 'https://b', version: '1', check }), 'Server changed from https://a to https://b.')
  fs.writeFileSync(path.join(dir, 'token'), 'tok\n')
  assert.match(await onServerChange({ dir, from: 'https://a', to: 'https://evil', trusted: 'https://b', version: '1', check }), /removed this computer's token without sending it there/)
  assert.equal(asked, 0)
  assert.equal(fs.existsSync(path.join(dir, 'token')), false)
})
