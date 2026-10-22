import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { testEnv } from './env.mjs'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installer = path.join(cliRoot, 'bin', 'install.mjs')
const daemonScript = path.join(cliRoot, 'src', 'daemon', 'run-daemon.sh')
const guardScript = path.join(cliRoot, 'src', 'daemon', 'guard.mjs')

test('launcher and daemon loop prefer private Node, then keep the old PATH behavior', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-private-node-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const privateBin = path.join(home, '.scorpio', 'node', 'bin')
  const pathBin = path.join(home, '.local', 'bin')
  fs.mkdirSync(privateBin, { recursive: true })
  fs.mkdirSync(pathBin, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(pathBin, 'node'))
  const marker = path.join(home, 'private-node-used')
  fs.writeFileSync(path.join(privateBin, 'node'), '#!/bin/sh\n[ "$1" = -p ] || printf x >> "$HOME/private-node-used"\nexec "$REAL_NODE" "$@"\n', { mode: 0o755 })
  const env = testEnv(home, { PATH: pathBin + ':/usr/bin:/bin', REAL_NODE: process.execPath, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  const installed = spawnSync(process.execPath, [installer], { env, encoding: 'utf8' })
  assert.equal(installed.status, 0, installed.stderr)
  const launcher = path.join(home, '.scorpio', 'bin', 'scorpio')
  const who = spawnSync(launcher, ['whoami'], { env, encoding: 'utf8' })
  assert.equal(who.status, 0, who.stderr)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x')
  const daemonDir = path.join(home, 'daemon-test')
  fs.mkdirSync(daemonDir)
  fs.copyFileSync(daemonScript, path.join(daemonDir, 'run-daemon.sh'))
  fs.copyFileSync(guardScript, path.join(daemonDir, 'guard.mjs'))
  fs.writeFileSync(path.join(daemonDir, 'main.mjs'), 'process.exit(3)\n')
  const loop = spawnSync('sh', [path.join(daemonDir, 'run-daemon.sh')], { env, encoding: 'utf8' })
  assert.equal(loop.status, 0, loop.stderr)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'xx')
  fs.rmSync(path.join(privateBin, 'node'))
  const fallback = spawnSync(launcher, ['whoami'], { env, encoding: 'utf8' })
  assert.equal(fallback.status, 0, fallback.stderr)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'xx')
})

test('up links the selected Codex skill on a fresh home', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-codex-skill-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const installed = spawnSync(process.execPath, [installer], {
    env: testEnv(home, { SCORPIO_AGENT: 'codex', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') }), encoding: 'utf8',
  })
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(fs.lstatSync(path.join(home, '.codex', 'skills', 'scorpio')).isSymbolicLink(), true)
})

test('daemon loop waits for main.mjs during an installer swap', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-daemon-swap-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.copyFileSync(daemonScript, path.join(dir, 'run-daemon.sh'))
  const child = spawn('sh', [path.join(dir, 'run-daemon.sh')], { env: testEnv(dir), stdio: 'ignore' })
  const closed = new Promise((resolve) => child.on('close', resolve))
  t.after(() => { if (child.exitCode === null) child.kill() })
  await new Promise((resolve) => setTimeout(resolve, 1200))
  fs.writeFileSync(path.join(dir, 'main.mjs'), 'process.exit(3)\n')
  assert.equal(await closed, 0)
})
