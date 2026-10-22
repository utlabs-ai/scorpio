import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { agentCheck } from '../src/up/checks.mjs'
import { OPEN_FRAMES, WAVE_FRAMES, LISTEN_FRAMES, LW, pobi } from '../src/up/pobi.mjs'
import { executeSteps, UpStepError } from '../src/up/steps.mjs'
import { qrMatrix, qrLines, qrOutput } from '../src/up/qr.mjs'

const screenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-screen-'))
const previousHome = process.env.SCORPIO_HOME
process.env.SCORPIO_HOME = screenHome
const { createScreen, displayWidth, frameRow, herdrChoice, localeOf, parseChoiceKey } = await import('../src/up/screen.mjs')
test.after(() => {
  if (previousHome === undefined) delete process.env.SCORPIO_HOME
  else process.env.SCORPIO_HOME = previousHome
  fs.rmSync(screenHome, { recursive: true, force: true })
})

test('welcome frame keeps the right edge aligned in English and Chinese', () => {
  for (const [language, label, detail] of [
    ['en', 'System', 'Linux x64, glibc 2.39'],
    ['zh', '这台电脑', '还没授权，等会儿在网页上点一下'],
  ]) {
    const line = frameRow('[..]', label, detail, { language })
    assert.equal(displayWidth(line.slice(0, -1)), 78)
    assert.match(line, /\|$/m)
  }
  assert.equal(displayWidth('中文 A'), 6)
})

test('choice parser requires an explicit continue key and supports arrows', () => {
  assert.deepEqual(parseChoiceKey({ text: '1' }, { two: true }), { index: 0 })
  assert.deepEqual(parseChoiceKey({ text: '2' }, { two: true }), { index: 1 })
  assert.deepEqual(parseChoiceKey({ text: '', info: { name: 'return' } }, { two: true }), {})
  assert.deepEqual(parseChoiceKey({ text: '', info: { name: 'down' } }, { two: true }), { arrow: 1, arrowUsed: true })
  assert.deepEqual(parseChoiceKey({ text: '', info: { name: 'return' } }, { two: true, arrow: 1, arrowUsed: true }), { index: 1 })
  assert.deepEqual(parseChoiceKey({ text: 'y' }, { two: false }), { index: 0 })
  assert.deepEqual(parseChoiceKey({ text: '', info: { name: 'return' } }, { two: false }), {})
})

test('Herdr choice waits for an explicit answer and restores raw mode', async () => {
  for (const [key, expected] of [['\r', true], ['y', true], ['n', false], ['q', false], ['\x1b', false], ['\x03', false]]) {
    const input = new PassThrough()
    const modes = []
    input.setRawMode = (mode) => { input.isRaw = mode; modes.push(mode) }
    const pending = herdrChoice(input)
    setImmediate(() => input.write(key))
    assert.equal(await pending, expected, JSON.stringify(key))
    assert.deepEqual(modes, [true, false])
  }
})

test('finished non-TTY setup prints how to open the agent pane later', async () => {
  let output = ''
  const screen = createScreen({
    output: { isTTY: false, write: (value) => { output += value } },
    env: { LANG: 'zh_CN.UTF-8', TERM: 'dumb', SCORPIO_FAST: '1' },
  })
  try {
    await screen.finish({ agent: { role: 'pobi', kind: 'codex' },
      topic: { name: 'Scorpio', roomId: 'topic-id' }, workdir: '/tmp/work',
      herdrBin: 'herdr' })
    assert.match(output, /之后运行 herdr 即可打开 pobi 的窗格。/)
    assert.match(output, /完成/)
    assert.match(output, /Herdr 已启动，daemon 和 agent 都在其中运行/)
    assert.match(output, /手机扫码打开主题；pobi 加入后会向你报到/)
    assert.doesNotMatch(output, /报到.*Hello|5 秒后/)
  } finally { screen.close() }
})

test('finished setup uses the configured server for its topic link', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-link-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { testEnv } = await import('./env.mjs')
  fs.mkdirSync(path.join(home, '.scorpio'))
  fs.writeFileSync(path.join(home, '.scorpio', 'config.json'), JSON.stringify({ server: 'https://scorpio.example.com/' }))
  const script = `
    import { createScreen } from './src/up/screen.mjs'
    const screen = createScreen({ env: { LANG: 'en', TERM: 'dumb', SCORPIO_FAST: '1' } })
    try {
      await screen.finish({ agent: { role: 'pobi', kind: 'codex' }, topic: { name: 'Hello', roomId: 'topic-id' }, workdir: '/tmp/work', herdrBin: 'herdr' })
    } finally { screen.close() }
  `
  for (const [extra, expected] of [[{}, 'https://scorpio.example.com/r/topic-id'], [{ SCORPIO_SERVER: 'https://override.example.com/' }, 'https://override.example.com/r/topic-id']]) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: testEnv(home, extra), encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.ok(run.stdout.includes(expected), run.stdout)
  }
})

test('approval card labels the authorized account in both languages', () => {
  for (const [lang, expected] of [
    ['en_US.UTF-8', 'Approved. Account: kai'],
    ['zh_CN.UTF-8', '已授权，账号：kai'],
  ]) {
    let output = ''
    const screen = createScreen({
      output: { isTTY: false, write: (value) => { output += value } },
      env: { LANG: lang, TERM: 'dumb', SCORPIO_FAST: '1' },
    })
    try {
      screen.startApproval('https://example.test/device', 'ABCD-EFGH').stop('kai')
      assert.match(output, new RegExp(expected))
    } finally { screen.close() }
  }
})

test('locale takes the first nonempty override', () => {
  assert.equal(localeOf({ LC_ALL: 'C', LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(localeOf({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }), 'zh')
})

test('installed agents are selectable from --version alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-checks-'))
  const bin = path.join(home, 'bin')
  const trace = path.join(home, 'calls.txt')
  fs.mkdirSync(bin)
  for (const [name, version] of [['claude', '2.1.220 (Claude Code)'], ['codex', 'codex-cli 0.162.1']]) {
    fs.writeFileSync(path.join(bin, name),
      '#!/bin/sh\nprintf "%s %s\\n" "' + name + '" "$*" >> "$UP_CHECK_TRACE"\n' +
      'if [ "$1" = "--version" ]; then printf "%s\\n" "' + version + '"; exit 0; fi\nexit 1\n',
      { mode: 0o755 })
  }
  const names = ['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'UP_CHECK_TRACE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    process.env.PATH = bin + path.delimiter + previous.PATH
    process.env.HOME = home
    process.env.CODEX_HOME = path.join(home, 'missing-codex-config')
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'missing-claude-config')
    process.env.UP_CHECK_TRACE = trace
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    assert.deepEqual(agentCheck('claude', 'en'), {
      kind: 'claude', name: 'Claude Code', available: true, status: 'ok', label: 'Claude Code', detail: '2.1.220',
    })
    assert.deepEqual(agentCheck('codex', 'zh'), {
      kind: 'codex', name: 'Codex', available: true, status: 'ok', label: 'Codex', detail: '0.162.1',
    })
    assert.deepEqual(fs.readFileSync(trace, 'utf8').trim().split('\n'), ['claude --version', 'codex --version'])
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    assert.equal(agentCheck('codex', 'en').available, false)
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Pobi opening frames preserve the mark and total 790 ms', () => {
  const mark = pobi().map((line) => line.trimEnd())
  assert.deepEqual(mark, [
    '          (@)', '           |', '      .---------.', '     /  .-----.  \\',
    '    |  |  o o  |  |', "     \\  '-----'  /", "   ()  '-------'  ()",
  ])
  assert.equal(OPEN_FRAMES.reduce((sum, frame) => sum + frame.ms, 0), 790)
  assert.deepEqual(pobi(OPEN_FRAMES[1].sprite)[4].includes('- -'), true)
  assert.equal(WAVE_FRAMES.reduce((sum, frame) => sum + frame.ms, 0), 3710)
  assert.equal(LISTEN_FRAMES.reduce((sum, frame) => sum + frame.ms, 0), 3170)
  assert.ok(LISTEN_FRAMES.every((frame) => pobi(frame.sprite, LW).length === 7))
  assert.ok([...OPEN_FRAMES, ...WAVE_FRAMES, ...LISTEN_FRAMES].every((frame) => pobi(frame.sprite, LW)[5].includes("'-----'")))
})

test('device and topic links produce version 3 QR symbols with a plain-link fallback', () => {
  for (const url of ['https://scorpio.utlabs.ai/device?code=WDJB-MJHT', 'https://scorpio.utlabs.ai/r/R8K2QxampleTopicId0001']) {
    const matrix = qrMatrix(url)
    assert.equal(matrix.length, 29)
    assert.equal(matrix[0].length, 29)
    assert.equal(qrLines(url).length, 17)
    assert.equal(qrOutput(url, { isTTY: false }), url + '\n')
  }
})

test('no usable agent exits without writing to HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-home-'))
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const result = spawnSync(process.execPath, [path.join(cliRoot, 'bin', 'scorpio.mjs'), 'up'], {
      cwd: cliRoot,
      env: {
        HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb',
        NO_COLOR: '1', SCORPIO_FAST: '1',
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /Nothing was changed\./)
    assert.deepEqual(fs.readdirSync(home), [])
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('setup steps skip completed work and name the failed step', async () => {
  const calls = []
  const context = await executeSteps([
    { number: 1, key: 'auth', label: 'authorization', check: async () => ({ done: true, value: 'existing' }), run: async () => { throw Error('should skip') }, after: async () => calls.push('checked') },
    { number: 2, key: 'herdr', label: 'Herdr', check: async () => null, run: async () => { calls.push('install'); return 'ready' }, verify: async (_, value) => value === 'ready' },
  ], {}, (result) => calls.push(result.label))
  assert.equal(context.auth, 'existing')
  assert.equal(context.herdr, 'ready')
  assert.deepEqual(calls, ['checked', 'install', 'Herdr'])
  await assert.rejects(executeSteps([{ number: 3, key: 'daemon', label: 'daemon', check: async () => null, run: async () => { throw Error('offline') } }], {}),
    (error) => error instanceof UpStepError && error.number === 3 && error.next === 'scorpio up' && /offline/.test(error.message))
})

test('setup prints every numbered step and excludes paused input time', async () => {
  let time = 0
  let output = ''
  const screen = createScreen({
    output: { isTTY: false, write: (value) => { output += value } },
    env: { TERM: 'dumb', SCORPIO_FAST: '1' }, now: () => time,
  })
  try {
    await executeSteps([
      { number: 1, key: 'one', label: 'Waiting for approval', result: () => 'Computer authorized. Account: example',
        check: async () => ({ done: true, value: 1 }) },
      { number: 4, key: 'four', label: 'Reading topics', result: () => 'Topic selected: Scorpio', check: async () => null, run: async () => {
        time = 1_000
        screen.pauseStep()
        time = 101_000
        screen.resumeStep()
        time = 103_000
        return 4
      } },
    ], { screen })
    assert.match(output, /\[ok\] 1\/6 Computer authorized\. Account: example  1s/)
    assert.match(output, /\[ok\] 4\/6 Topic selected: Scorpio  3s/)
    assert.doesNotMatch(output, /◐|\x1b\[/)
  } finally { screen.close() }
})
