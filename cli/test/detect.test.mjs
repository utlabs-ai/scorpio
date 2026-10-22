// Run with node --test from cli/ (no dependencies)
// Which agent CLIs are installed here: the login shell first, then the daemon's PATH,
// executable regular files only; the version from --version; failures are "unknown", never an error.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { run, findOnPath, findInLoginShell, parseVersion, detectKind, createDetector, detectedText, installedChanged } = await import('../src/adapters/cli/detect.mjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-detect-'))
const script = (name, body, mode = 0o755) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode })
  fs.chmodSync(file, mode)
  return file
}

test('PATH lookup: an executable regular file counts; a plain file, a directory and a missing name do not', () => {
  script('claude', 'echo 2.1.301')
  script('codex', 'echo x', 0o644)
  fs.mkdirSync(path.join(dir, 'gemini'))
  assert.equal(findOnPath('claude', `/nonexistent:${dir}`), path.join(dir, 'claude'))
  assert.equal(findOnPath('codex', dir), null)
  assert.equal(findOnPath('gemini', dir), null)
  assert.equal(findOnPath('nothing', dir), null)
  assert.equal(findOnPath('claude', ''), null)
})

test('login shell lookup: the last absolute path wins over startup-file noise; an alias, a timeout and a non-executable do not count', async () => {
  const claude = script('claude', 'echo 2.1.301')
  const plain = script('plain', 'echo', 0o644)
  const asked = []
  const shell = (stdout, extra = {}) => async (file, args) => { asked.push([file, ...args]); return { stdout, stderr: '', ...extra } }
  assert.equal(await findInLoginShell('claude', { shell: '/bin/zsh', runner: shell(`Welcome back\n${claude}\n`) }), claude)
  assert.deepEqual(asked[0], ['/bin/zsh', '-lc', 'command -v -- claude'])
  assert.equal(await findInLoginShell('claude', { runner: shell("alias claude='claude --foo'\n") }), null)
  assert.equal(await findInLoginShell('claude', { runner: shell(`${claude}\n`, { timedOut: true }) }), null)
  assert.equal(await findInLoginShell('claude', { runner: shell('', { error: 'ENOENT' }) }), null)
  assert.equal(await findInLoginShell('claude', { runner: shell(`${plain}\n`) }), null)
})

test('version: the number from stdout, else stderr, else the first line cut to 40; none: null', () => {
  assert.equal(parseVersion('2.1.301 (Claude Code)\n', ''), '2.1.301')
  assert.equal(parseVersion('codex-cli 0.46.0\n', ''), '0.46.0')
  assert.equal(parseVersion('', 'claude 3.0.0-beta.2\n'), '3.0.0-beta.2')
  assert.equal(parseVersion('no number here at all but a very long first line of text\nsecond', ''), 'no number here at all but a very long fi')
  assert.equal(parseVersion('\n  \n', ''), null)
  assert.equal(parseVersion('', ''), null)
})

test('one kind: found by the login shell, found on PATH instead, not found, and found but silent or too slow', async () => {
  const at = () => 5000
  const claude = script('claude-real', 'echo "2.1.301 (Claude Code)"')
  const fromShell = await detectKind('claude', { now: at, shellFind: async () => claude, pathFind: () => { throw new Error('PATH not asked') } })
  assert.deepEqual(fromShell, { kind: 'claude', installed: true, version: '2.1.301', at: 5000 })

  const codex = script('codex-real', 'echo "codex-cli 0.46.0"')
  const fromPath = await detectKind('codex', { now: at, shellFind: async () => null, pathFind: () => codex })
  assert.deepEqual(fromPath, { kind: 'codex', installed: true, version: '0.46.0', at: 5000 })

  assert.deepEqual(await detectKind('codex', { now: at, shellFind: async () => null, pathFind: () => null }),
    { kind: 'codex', installed: false, version: null, at: 5000 })
  // The login shell itself failing falls back to PATH.
  assert.equal((await detectKind('codex', { now: at, shellFind: async () => { throw new Error('boom') }, pathFind: () => codex })).installed, true)

  const silent = script('silent', 'exit 3')
  assert.deepEqual(await detectKind('claude', { now: at, shellFind: async () => silent, pathFind: () => null }),
    { kind: 'claude', installed: true, version: null, at: 5000 })
  const slow = await detectKind('claude', { now: at, shellFind: async () => claude, pathFind: () => null, runner: async () => ({ timedOut: true, stdout: '2.1.301', stderr: '' }) })
  assert.deepEqual(slow, { kind: 'claude', installed: true, version: null, at: 5000 })
})

test('run: a program that hangs is killed with its children at the limit; the output of one that answers is kept', async () => {
  const hang = script('hang', 'sleep 30 & wait')
  const started = Date.now()
  const slow = await run(hang, ['--version'], { timeoutMs: 200 })
  assert.equal(slow.timedOut, true)
  assert.ok(Date.now() - started < 5000)
  const fast = await run(script('fast', 'echo out; echo err >&2'), [], { timeoutMs: 5000 })
  assert.deepEqual([fast.stdout, fast.stderr, fast.code, fast.timedOut], ['out\n', 'err\n', 0, false])
  assert.ok((await run(path.join(dir, 'does-not-exist'), [])).error)
})

test('the card line and what counts as a change', () => {
  const claude = { kind: 'claude', installed: true, version: '2.1.301', at: 1 }
  const codexNo = { kind: 'codex', installed: false, version: null, at: 1 }
  assert.equal(detectedText([claude, codexNo]), 'Detected: Claude Code 2.1.301; Codex not installed.')
  assert.equal(detectedText([{ ...claude, version: null }, { ...codexNo, installed: true, version: '0.46.0' }]), 'Detected: Claude Code (version unknown); Codex 0.46.0.')
  assert.equal(detectedText([{ ...claude, installed: false, version: null }, codexNo]), 'Detected: no supported agent yet.')
  assert.equal(detectedText([]), '')
  assert.equal(installedChanged([claude, codexNo], [{ ...claude, version: '2.1.302', at: 9 }, codexNo]), false)
  assert.equal(installedChanged([claude, codexNo], [claude, { ...codexNo, installed: true }]), true)
})

test('detector: kinds are looked at together, one kind alone, and a failure leaves the last result', async () => {
  let n = 0
  const logs = []
  const detector = createDetector({ log: (l) => logs.push(l), detectOne: async (kind) => {
    if (kind === 'codex' && n === 2) throw new Error('boom')
    return { kind, installed: kind === 'claude', version: kind === 'claude' ? `1.0.${n}` : null, at: n }
  } })
  assert.equal(detector.ready(), false)
  assert.deepEqual((await detector.detect()).map((r) => r.kind), ['claude', 'codex'])
  n = 1
  await detector.detect(['codex'])
  assert.deepEqual([detector.get('claude').at, detector.get('codex').at], [0, 1])
  n = 2
  await detector.detect()
  assert.equal(detector.get('codex').at, 1, 'a failed look keeps what was known')
  assert.equal(detector.get('claude').version, '1.0.2')
  assert.equal(logs.length, 1)
})
