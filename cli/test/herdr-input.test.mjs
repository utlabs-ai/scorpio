import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHerdr, HERDR_BIN, herdrError } from '../src/adapters/terminal/herdr.mjs'
import { testEnv } from './env.mjs'

const execute = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check) {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (await check()) return
    assert.ok(Date.now() < deadline, 'Timed out waiting for the local input recorder')
    await sleep(50)
  }
}

test('real Herdr delivers adapter text once and unchanged', { timeout: 90_000 }, async (t) => {
  let version
  try { version = (await execute(HERDR_BIN, ['--version'])).stdout.trim() }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('Herdr is not installed'); return }
    throw error
  }
  t.diagnostic(version)
  // The recorder is a tiny C program named claude, so Herdr detects an agent in the pane; no compiler, no probe.
  try { await execute('cc', ['--version']) }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('No C compiler (cc) to build the input recorder'); return }
    throw error
  }
  // Short names leave room for Herdr's Unix socket path on macOS.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hi-'))
  const session = 'hi-' + process.pid
  const bin = path.join(root, 'bin')
  const record = path.join(root, 'input.txt')
  fs.mkdirSync(bin)
  const env = testEnv(root, { PATH: bin + path.delimiter + process.env.PATH })
  // Inherited socket and pane selectors must never retarget this probe to an existing session.
  for (const key of Object.keys(env)) if (key.startsWith('HERDR_')) delete env[key]
  env.HERDR_CONFIG_PATH = path.join(root, 'config.toml')
  fs.writeFileSync(env.HERDR_CONFIG_PATH, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n')
  let server
  t.after(async () => {
    try {
      if (server) {
        await execute(HERDR_BIN, ['session', 'stop', session, '--json'], { env, timeout: 15_000 })
        await until(() => server.exitCode !== null || server.signalCode !== null)
        t.diagnostic('Stopped the isolated Herdr session')
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  await execute('cc', [fileURLToPath(new URL('./fixtures/herdr-input.c', import.meta.url)), '-o', path.join(bin, 'claude')], { env })
  const call = async (args) => (await execute(HERDR_BIN, ['--session', session, ...args], { env, timeout: 15_000 })).stdout
  const terminal = createHerdr({ exec: call })
  server = spawn(HERDR_BIN, ['--session', session, 'server'], { env, stdio: 'ignore' })
  await until(async () => {
    assert.equal(server.exitCode, null, 'The isolated Herdr server exited during startup')
    try { await call(['pane', 'list']); return true } catch { return false }
  })
  const created = JSON.parse(await call(['workspace', 'create', '--cwd', root, '--label', 'input-recorder', '--no-focus']))
  const workspace = created.result.workspace.workspace_id
  const tab = await terminal.newTab({ label: 'x', cwd: root, workspace,
    env: { PATH: env.PATH, HERDR_INPUT_FILE: record } })
  assert.equal((await terminal.waitShell(tab.pane)).ok, true)
  await terminal.startAgent({ name: 'x', kind: 'claude', pane: tab.pane, argv: [], timeoutMs: 10_000 })
  const lines = () => fs.readFileSync(record, 'utf8').split('\n').slice(0, -1)
  const expected = []
  const texts = ['Please continue.', 'Keep "double" and \'single\' quotes, $(printf text); unchanged.']
  for (const method of ['inject', 'injectAndWatch', 'sendText', 'run']) {
    for (const text of texts) await t.test(method + ': ' + text, async () => {
      try {
        await terminal[method](tab.pane, text, 1000)
      } catch (error) {
        const code = herdrError(error).code
        // The recorder has no working state; a wait may expire after successful submission.
        if (method !== 'injectAndWatch' || !['timeout', 'agent_prompt_stalled'].includes(code)) throw error
        t.diagnostic('injectAndWatch submitted text, then returned ' + code)
      }
      if (method === 'sendText') {
        assert.deepEqual(lines(), expected, 'sendText must not submit a line on its own')
        await terminal.sendKeys(tab.pane, 'enter')
      }
      expected.push(text)
      await until(() => lines().length >= expected.length)
      assert.deepEqual(lines(), expected)
    })
  }
  assert.equal(expected.length, 8)
  assert.deepEqual(lines(), expected)
  await t.test('numbered Herdr names deliver to their own panes exactly once', async () => {
    const secondRecord = path.join(root, 'second.txt')
    const second = await terminal.newTab({ label: 'x-2', cwd: root, workspace,
      env: { PATH: env.PATH, HERDR_INPUT_FILE: secondRecord } })
    assert.equal((await terminal.waitShell(second.pane)).ok, true)
    await terminal.startAgent({ name: 'x-2', kind: 'claude', pane: second.pane, argv: [], timeoutMs: 10_000 })
    const live = await terminal.agents()
    assert.equal(live.find((agent) => agent.name === 'x').pane_id, tab.pane)
    assert.equal(live.find((agent) => agent.name === 'x-2').pane_id, second.pane)
    await terminal.inject(tab.pane, 'Only the first pane.')
    await terminal.inject(second.pane, 'Only the second pane.')
    const secondLines = () => fs.readFileSync(secondRecord, 'utf8').split('\n').slice(0, -1)
    await until(() => lines().length >= 9 && secondLines().length >= 1)
    assert.deepEqual(lines(), [...expected, 'Only the first pane.'])
    assert.deepEqual(secondLines(), ['Only the second pane.'])
    t.diagnostic('x and x-2 each recorded their own input once, with no cross-pane delivery')
  })
})
