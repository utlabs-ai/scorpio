// First-time setup without Herdr: a plain terminal is told to wait, not to /attach; Windows
// stops before installing; the installer's last lines leave an invited agent on its path; Codex waits less.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'

const CLI_DIR = fileURLToPath(new URL('..', import.meta.url))
const tmp = (t, tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `scorpio-${tag}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const node = (args, home, env = {}) => spawnSync(process.execPath, args, { env: testEnv(home, env), encoding: 'utf8' })
// Pretend to be Windows: the platform check is the first thing either installer does.
const WIN32 = `data:text/javascript,Object.defineProperty(process,'platform',{value:'win32'})`

test('join from a plain terminal while Herdr runs: detached, told to wait, no attach code; in a pane it cannot place: attach-pending', (t) => {
  const home = tmp(t, 'reg')
  const script = `
    const { registerAfterJoin } = await import(${JSON.stringify(path.join(CLI_DIR, 'src/actions/register.mjs'))})
    const find = () => ({ reason: 'detached' })
    const plain = registerAfterJoin({ roomId: 'r1', name: 'api@kai', role: 'api', env: {}, find })
    const pane = registerAfterJoin({ roomId: 'r1', name: 'api@kai', role: 'api', env: { HERDR_PANE_ID: 'p1' }, find })
    console.log(JSON.stringify({ plain, pane }))`
  const run = node(['--input-type=module', '-e', script], home, { SCORPIO_HOME: home })
  assert.equal(run.status, 0, run.stderr)
  const { plain, pane } = JSON.parse(run.stdout.trim())
  assert.equal(plain.registered, false)
  assert.equal(plain.reason, 'detached')
  assert.equal(plain.attachCode, undefined)
  assert.match(plain.next, /not in a Herdr pane, so no daemon delivers to you: read recent history .* then run wait in the foreground\.$/)
  assert.doesNotMatch(plain.next, /attach/)
  assert.equal(pane.reason, 'attach-pending')
  assert.match(pane.attachCode, /^SCORPIO-ATTACH-/)
})

test('on Windows (not WSL) both installers stop at once and write nothing', (t) => {
  const home = tmp(t, 'win')
  const env = { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') }
  for (const bin of ['bin/install.mjs', 'tools/latest/bin/latest.mjs']) {
    const run = node(['--import', WIN32, path.join(CLI_DIR, bin)], home, env)
    assert.equal(run.status, 1, `${bin}: ${run.stderr}`)
    assert.match(run.stderr, /Scorpio runs on macOS, Linux and WSL: start your agent in a WSL terminal/)
  }
  assert.deepEqual(fs.readdirSync(home), [], 'nothing written')
})

test("the installer's last lines name the skill and help, and join only as a general how-to", (t) => {
  const home = tmp(t, 'next')
  const run = node([path.join(CLI_DIR, 'bin/install.mjs')], home, { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Next: the skill is ~\/\.scorpio\/app\/skill\/SKILL\.md; carry on with what you were following/)
  assert.doesNotMatch(run.stdout, /\/start\.md/)
  assert.match(run.stdout, /`scorpio help` lists the commands; a topic is joined with .* join topicId=<topic id> role=<your role> \(code=<passcode> for a private one\)\./)
  assert.doesNotMatch(run.stdout, /from your invitation/)
})

test("wait's default timeout: 540 seconds, 280 inside Codex", (t) => {
  const home = tmp(t, 'wait')
  const help = (extra) => node([path.join(CLI_DIR, 'bin/scorpio.mjs'), 'help'], home, { SCORPIO_HOME: home, CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', ...extra }).stdout
  assert.match(help({}), /wait topicId= \[timeout=540\]/)
  assert.match(help({ CODEX_THREAD_ID: 'th_1' }), /wait topicId= \[timeout=280\]/)
})

for (const [ownerDisplayName, shown] of [[null, 'kai'], ['Kai', 'kai (nickname: Kai)']]) {
  test(`join registration preserves owner address with nickname ${ownerDisplayName}`, (t) => {
    const home = tmp(t, 'nickname')
    const script = `
      const { registerAfterJoin } = await import(${JSON.stringify(path.join(CLI_DIR, 'src/actions/register.mjs'))})
      const rows = ['no-herdr', 'detached', 'pane'].map((reason) => registerAfterJoin({
        roomId: 'r1', name: 'api@kai', role: 'api', ownerDisplayName: ${JSON.stringify(ownerDisplayName)}, env: {},
        find: () => reason === 'pane' ? { pane: 'w:p1', via: 'explicit' } : { reason },
      }))
      console.log(JSON.stringify(rows))`
    const run = node(['--input-type=module', '-e', script], home, { SCORPIO_HOME: home })
    assert.equal(run.status, 0, run.stderr)
    const rows = JSON.parse(run.stdout.trim())
    assert.equal(rows[2].registered, true)
    for (const row of rows) assert.ok(row.next.includes(`Your owner is ${shown}; report in to @kai with send`), row.next)
  })
}
