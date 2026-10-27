import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { testEnv } from './env.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-approvals-'))
process.env.SCORPIO_HOME = home
process.env.CODEX_HOME = path.join(home, "codex")
const { createApprovals, writeApprovalSettings } = await import('../src/daemon/approvals.mjs')
const { approvalHook } = await import('../src/approval-hook.mjs')
const { parseMenu, columns, hookMatches, menuIdentity, sameMenu, standardApproval } = await import('../src/daemon/approval-menu.mjs')
const { argsFor, codexHookDefinition, fullPermission, autoPermission, permOf, dialogBlocked, unseenDialog } = await import('../src/adapters/cli/index.mjs')
const { parseSpawn, handoffPrompt } = await import('../src/daemon/commands.mjs')
const { injectWhenReady } = await import('../src/daemon/main.mjs')
const bash = (count = 3) => `Bash command\n  touch /tmp/work/result\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and always allow access to /tmp/work from this project\n${count === 4 ? '  3. Yes, and switch to auto mode · extra\n     auto mode handles these prompts for you\n  4. No' : '  3. No'}\n\nEsc to cancel · Tab to amend`
const event = { tool_name: 'Bash', tool_input: { command: 'touch /tmp/work/result' }, cwd: '/tmp/work' }
const codex = `Would you like to run the following command?\n\n $ touch /tmp/work/result\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with touch (p)\n  3. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel`
const folder = 'Folder access\n/tmp/work\n\nTrust this folder? Codex can read, edit, and run files here, subject to your permission settings.\nFolder settings can run code automatically, even without a model request. Continue only if you trust\nthese files. Your trust decision will be saved.\n\n› 1. Trust and continue\n  2. Quit\n\nenter continue · esc quit'
const hookTrust = "Hooks need review\n1 hook is new or changed.\nHooks can run outside the sandbox after you trust them.\n\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n\nenter confirm · esc skip"

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
for (const [name, screen, labels] of [
  ['Claude Bash', bash(), ['Yes', 'Yes, and always allow access to /tmp/work from this project', 'No']],
  ['Claude Edit', 'Edit /tmp/work/file\n\nAllow this edit?\n  1. Yes\n  2. Yes, allow all edits during this session\n  3. No\n\nEsc to cancel · Tab to amend', ['Yes', 'Yes, allow all edits during this session', 'No']],
  ['Claude WebFetch', "Fetch example.com\n\nAllow this request?\n  1. Yes\n  2. Yes, and don't ask again for example.com\n  3. No, and tell Claude what to do differently\n\nEsc to cancel", ['Yes', "Yes, and don't ask again for example.com", 'No, and tell Claude what to do differently']],
  ['Codex Bash', codex, ['Yes, proceed (y)', "Yes, and don't ask again for commands that start with touch (p)", 'No, and tell Codex what to do differently (esc)']],
  ['Codex folder trust', folder, ['Trust and continue', 'Quit']],
  ['Codex hook trust', hookTrust, ['Review hooks', 'Trust all and continue', "Continue without trusting (hooks won't run)"]],
]) test(`screen parser preserves ${name}`, () => {
  const menu = parseMenu(screen, 108)
  assert.deepEqual(menu.options.map((o) => o.label), labels)
  assert.ok(menu.question.length)
  assert.ok(menu.hints.length)
})
test('four-option Claude menu retains note and exact option numbering', () => {
  const menu = parseMenu(bash(4), 108)
  assert.deepEqual(menu.options[2], { n: 3, label: 'Yes, and switch to auto mode · extra', note: 'auto mode handles these prompts for you' })
  assert.equal(menu.options.at(-1).n, 4)
  assert.equal(standardApproval(menu), true)
})
test('Codex wrapped labels preserve newlines even below pane width; Claude distinguishes notes by width', () => {
  const line = "  2. Yes, and don't ask again for commands that start with `touch /tmp/work/"
  const screen = `Question?\n\n  1. Yes\n${line}\n     outside.txt\` (p)\n  3. No\n\nenter confirm`
  assert.equal(parseMenu(screen, 107, 'codex').options[1].label, "Yes, and don't ask again for commands that start with `touch /tmp/work/\noutside.txt` (p)")
  assert.equal(parseMenu(screen).options[1].label, "Yes, and don't ask again for commands that start with `touch /tmp/work/\noutside.txt` (p)")
  assert.equal(parseMenu('Q\n  1. A long sentence\n     next word\n  2. No', 23).options[0].label, 'A long sentence\nnext word')
  assert.equal(columns('目录a'), 5)
})
test('no invented options; details match only text above options', () => {
  assert.equal(parseMenu('unrecognized startup dialog'), null)
  assert.equal(hookMatches(event, bash()), true)
  assert.equal(hookMatches({ ...event, tool_input: { command: 'other' } }, bash()), false)
  assert.equal(hookMatches(event, 'Q\n  1. touch /tmp/work/result'), false)
})

function fixture({ cli = 'claude', screen = bash(), status = 'blocked', rooms = ['one', 'two'], width = 108, settleMs = 1 } = {}) {
  let clock = 1000, content = screen, state = status, live = true
  const frames = [], keys = [], texts = [], injections = [], replies = [], logs = []
  const target = { pane: 'p1', name: 'api@kai', cli, rooms }
  const terminal = { adapter: 'herdr', paneWidth: async () => width, paneStatus: async () => state, read: async () => content,
    sendKeys: async (_, key) => { keys.push(key); content = 'working'; state = 'working' },
    sendText: async (_, text) => { texts.push(text) },
    inject: async (pane, text) => { injections.push({ pane, text }) } }
  const approvals = createApprovals({ terminal, targets: async () => live ? [target] : [],
    send: (roomId, frame) => frames.push({ roomId, ...frame }), now: () => clock, sleep: async (ms) => { clock += ms },
    keyTable: async () => ({ settleMs, keys: ['esc', 'up', 'down', 'enter'].map((name) => ({ name, label: name, herdr: name })) }), log: (line) => logs.push(line) })
  return { approvals, terminal, frames, keys, texts, injections, replies, logs, target,
    now: () => clock, advance: (ms = 2000) => { clock += ms }, screen: (s) => { content = s }, status: (s) => { state = s }, gone: () => { live = false },
    request: (e = event) => approvals.request({ v: 1, cli, pane: 'p1', event: e }, (reply) => { replies.push(reply); if (reply.decision?.behavior) { content = 'working'; state = 'working' } }),
    open: async () => { await approvals.tick(); clock += 3000; await approvals.tick(); return approvals.cards.get('p1') },
    answer: (card, body) => approvals.answer('one', Object.fromEntries(Object.entries({ id: card.id, ts: clock, ...body }).filter(([, v]) => v !== undefined))),
  }
}
test('blocked waits for hook, opens one id across rooms, reconnect resends, close reaches both', async () => {
  const f = fixture()
  await f.approvals.tick(); assert.equal(f.frames.length, 0); assert.equal(f.approvals.busy('p1'), true)
  await f.request(); const card = f.approvals.cards.get('p1')
  assert.match(card.id, /^[a-zA-Z0-9]{16}$/)
  assert.equal(card.detail.tool, 'Bash'); assert.equal(card.detail.input, JSON.stringify(event.tool_input))
  assert.equal(f.frames.length, 2)
  f.approvals.resend('two'); assert.equal(f.frames.at(-1).approval.id, card.id)
  f.status('working'); await f.approvals.tick(); assert.equal(f.approvals.cards.has('p1'), true, 'menu still on screen overrides Herdr')
  f.screen('working'); await f.approvals.tick()
  assert.deepEqual(f.frames.filter((x) => x.type === 'approval_close').map((x) => x.reason), ['answered_here', 'answered_here'])
  assert.deepEqual(f.replies, [{ decision: null }])
})
test('hook precedes blocked and pairs; closing an unmatched card releases its preceding hook', async () => {
  const f = fixture({ screen: 'working', status: 'working' })
  await f.request(); assert.equal(f.frames.length, 0)
  f.screen(bash()); f.status('blocked'); await f.approvals.tick()
  assert.equal(f.approvals.cards.get('p1').detail.tool, 'Bash')
  const g = fixture(); await g.request({ ...event, tool_input: { command: 'later command' } })
  const card = g.approvals.cards.get('p1'); assert.equal(card.detail, null)
  g.screen(bash().replace('touch /tmp/work/result', 'later command').replace('Do you want to proceed?', 'Allow next command?')); await g.approvals.tick()
  assert.equal(g.frames.find((x) => x.type === 'approval_close').reason, 'changed')
  assert.equal(g.approvals.cards.get('p1').detail, null)
  assert.deepEqual(g.replies, [{ decision: null }])
})
for (const [name, n, message, decision] of [
  ['allow', 1, undefined, { behavior: 'allow' }], ['deny', 3, undefined, { behavior: 'deny' }],
  ['deny reason', 3, 'Please stop', { behavior: 'deny', message: 'Please stop' }],
]) test(`Claude standard menu uses held hook: ${name}`, async () => {
  const f = fixture(); await f.request(); const card = f.approvals.cards.get('p1')
  await f.answer(card, { n, message })
  assert.deepEqual(f.replies, [{ decision }]); assert.deepEqual(f.keys, [])
  assert.equal(f.frames.at(-1).reason, 'answered'); assert.equal(f.frames.at(-1).result, 'ok')
})
for (const [name, options] of [
  ['Claude middle', { n: 2, held: true }], ['Claude auto mode', { n: 3, held: true, four: true }],
  ['Codex yes', { cli: 'codex', n: 1 }], ['Codex always', { cli: 'codex', n: 2 }], ['Codex no with message', { cli: 'codex', n: 3, message: 'Use another command' }],
  ['no hook', { n: 1 }], ['plan confirmation', { n: 1, held: true, screen: bash().replace('1. Yes', '1. Yes, and switch mode') }],
]) test(`answer by number: ${name}`, async () => {
  const f = fixture({ cli: options.cli, screen: options.screen || (options.cli === 'codex' ? codex : bash(options.four ? 4 : 3)) })
  if (options.held || options.cli === 'codex') await f.request()
  const card = await f.open()
  await f.answer(card, options)
  assert.equal(f.keys[0], String(options.n))
  if (options.held) assert.deepEqual(f.replies, [{ decision: null }])
  if (options.message) {
    assert.deepEqual(f.injections, [{ pane: 'p1', text: options.message }])
    assert.deepEqual(f.texts, []); assert.deepEqual(f.keys, [String(options.n)])
  }
  assert.equal(f.frames.at(-1).result, 'ok')
})
test('screen-only card answers only a configured key', async () => {
  const f = fixture({ screen: 'Unknown dialog' }); const card = await f.open()
  assert.equal(card.menu, null); assert.equal(card.screen, 'Unknown dialog')
  await f.answer(card, { key: 'arbitrary' }); assert.deepEqual(f.keys, [])
  await f.answer(card, { key: 'esc' }); assert.deepEqual(f.keys, ['esc'])
  assert.ok(f.logs.includes(`approval ${card.id} answered: key esc, ok`))
})
test('Claude typed rejection reason keeps sendText and Enter', async () => {
  const f = fixture(); const card = await f.open()
  await f.answer(card, { n: 3, message: 'Please stop' })
  assert.deepEqual(f.texts, ['Please stop'])
  assert.deepEqual(f.keys, ['3', 'enter'])
  assert.deepEqual(f.injections, [])
})
test('Codex rejection injects once after the menu closes and logs no approval content', async () => {
  const f = fixture({ cli: 'codex', screen: codex }); const card = await f.open()
  f.approvals.resend('one'); await f.approvals.tick()
  const inject = f.terminal.inject
  f.terminal.inject = async (pane, text) => {
    assert.equal(await f.terminal.read(pane), 'working')
    await inject(pane, text)
  }
  await f.answer(card, { n: 3, message: 'Use another command' })
  await f.answer(card, { n: 3, message: 'Use another command' })
  assert.deepEqual(f.injections, [{ pane: 'p1', text: 'Use another command' }])
  assert.deepEqual(f.keys, ['3']); assert.deepEqual(f.texts, [])
  assert.deepEqual(f.logs, [
    `approval ${card.id} opened for api@kai (codex, menu, no hook)`,
    `approval ${card.id} answered: option 3, with a reason, ok`,
    `approval ${card.id} closed: answered`,
  ])
  for (const secret of ['touch /tmp/work/result', ...card.menu.options.map((o) => o.label), 'Use another command']) {
    assert.equal(f.logs.join('\n').includes(secret), false)
  }
})
test('Codex injection failure logs only its code and never retries the answered card', async () => {
  const f = fixture({ cli: 'codex', screen: codex }); const card = await f.open()
  let calls = 0
  f.terminal.inject = async () => { calls++; throw Object.assign(new Error('private command and reason'), { code: 'blocked' }) }
  await f.answer(card, { n: 3, message: 'Private reason' })
  await f.answer(card, { n: 3, message: 'Private reason' }); await f.approvals.tick()
  assert.equal(calls, 1); assert.equal(f.approvals.cards.size, 0)
  assert.equal(f.frames.at(-1).reason, 'answered')
  assert.deepEqual(f.keys, ['3']); assert.deepEqual(f.texts, [])
  assert.deepEqual(f.logs.filter((line) => line.startsWith('approval reason')), ['approval reason injection failed: blocked'])
  assert.equal(f.logs.join('\n').includes('private command'), false)
  assert.equal(f.logs.join('\n').includes('Private reason'), false)
})
test('stale answer expires without pressing; changed command replaces card; pane gone closes', async () => {
  const f = fixture(); const card = await f.open(); f.advance(121000)
  await f.answer(card, { n: 1, ts: 1000 }); assert.equal(f.keys.length, 0); assert.equal(f.frames.at(-1).reason, 'expired')
  const g = fixture(); await g.request(); const old = g.approvals.cards.get('p1')
  g.screen(bash().replace('touch /tmp/work/result', 'touch /tmp/work/next'))
  await g.answer(old, { n: 1 }); assert.deepEqual(g.keys, [])
  assert.equal(g.frames.filter((x) => x.type === 'approval_close').at(-1).reason, 'changed')
  assert.notEqual(g.approvals.cards.get('p1').id, old.id)
  await g.answer(old, { n: 1 }); assert.deepEqual(g.keys, [])
  g.gone(); await g.approvals.tick(); assert.equal(g.frames.at(-1).reason, 'gone')
})
test('failed press leaves failed result, duplicate answer never presses again', async () => {
  const f = fixture(); const card = await f.open(); let count = 0
  f.terminal.sendKeys = async () => { count++ }
  await f.answer(card, { n: 2 }); await f.answer(card, { n: 2 })
  assert.equal(count, 1); assert.equal(f.frames.filter((x) => x.type === 'approval_close').at(-1).result, 'failed')
  assert.notEqual(f.approvals.cards.get('p1').id, card.id)
})
test('refused card logs only id/error, keeps delivery gate and stops reconnect resend', async () => {
  const f = fixture(); const card = await f.open(); const before = f.frames.length
  f.approvals.refused({ id: card.id, error: 'limit' }); f.approvals.resend('one')
  assert.equal(f.frames.length, before); assert.equal(f.approvals.busy('p1'), true)
  assert.equal(f.logs.at(-1), `approval refused: ${card.id} limit`)
})
test('delivery gate blocks an open card or pending hook even if Herdr says done', async () => {
  const f = fixture({ status: 'done' }); let injected = 0
  f.terminal.inject = async () => { injected++ }
  await f.request(); assert.equal(await injectWhenReady(f.terminal, 'p1', 'hello', f.approvals.busy), 'blocked')
  f.advance(); await f.approvals.tick(); assert.equal(await injectWhenReady(f.terminal, 'p1', 'hello', f.approvals.busy), 'blocked')
  assert.equal(injected, 0)
})

test('default spawn preserves settings and adds stable hook; all uses old permission flags without hook', () => {
  for (const kind of ['claude', 'codex']) {
    const args = argsFor(kind, {})
    assert.equal(fullPermission(kind, args), false)
    assert.ok(args.some((a) => a.includes(kind === 'claude' ? 'claude.json' : 'approval-hook codex')))
    assert.equal(args.includes('--setting-sources'), false)
    assert.equal(args.includes('--dangerously-bypass-hook-trust'), false)
    const all = argsFor(kind, {}, 'all'); assert.equal(fullPermission(kind, all), true)
    assert.equal(all.some((a) => /approval-hook|claude.json/.test(a)), false)
  }
  const custom = ['--permission-mode', 'default', '--model', 'custom']
  assert.deepEqual(argsFor('claude', { spawn: { claude: custom } }).slice(0, custom.length), custom)
  assert.deepEqual(argsFor('claude', { spawn: { claude: ['--dangerously-skip-permissions'] } }), ['--dangerously-skip-permissions'])
  assert.equal(parseSpawn('codex api /tmp/work perm=all do work').perm, 'all')
  assert.equal(parseSpawn('codex api perm=foo').error, 'perm= only takes ask, auto or all.')
  assert.equal(parseSpawn('codex api perm=auto work').perm, 'auto')
  for (const [value, level] of [['ask', 'ask'], ['auto', 'auto'], ['all', 'all'], ['default', 'ask']]) {
    assert.equal(parseSpawn(`codex api perm=${value} work`).perm, level)
  }
  const base = { account: 'kai', by: 'kai', roomId: 'one', roomName: 'Test', seq: 1, file: '/tmp/handoff.md', daemonName: 'box@kai', kind: 'codex', name: 'api@kai', dir: '/tmp/work' }
  assert.match(handoffPrompt({ ...base, perm: 'all' }), /perm=all <what to do next>/)
  assert.match(handoffPrompt({ ...base, perm: 'auto' }), /perm=auto <what to do next>/)
  assert.match(handoffPrompt(base), /perm=ask <what to do next>/)
})
test('Codex trust definition stays byte-for-byte fixed', () => {
  assert.equal(codexHookDefinition('/tmp/home/bin/scorpio'), 'hooks.PermissionRequest=[{matcher=".*",hooks=[{type="command",command="/tmp/home/bin/scorpio approval-hook codex",timeout=10}]}]')
})
test('daemon writes only additive Claude hook with private mode', () => {
  writeApprovalSettings({ launcher: '/tmp/home/bin/scorpio', stateDir: home })
  const file = path.join(home, 'hooks', 'claude.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: "'/tmp/home/bin/scorpio' approval-hook claude", timeout: 3600 }] }] } })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

async function hookFixture(t, cli, reply, { close = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-hook-'))
  const socket = path.join(dir, 'a.sock'); let received
  const server = net.createServer((client) => {
    client.on('data', (data) => { received = JSON.parse(data); if (close) client.end(); else client.end(JSON.stringify(reply) + '\n') })
  })
  await new Promise((r) => server.listen(socket, r))
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  let output = ''; const before = Date.now()
  await approvalHook(cli, { input: Readable.from([JSON.stringify(event)]), output: { write: (s) => { output += s } }, socket, pane: 'p1' })
  assert.deepEqual(received, { v: 1, cli, pane: 'p1', event })
  return { output, elapsed: Date.now() - before }
}
for (const decision of [{ behavior: 'allow' }, { behavior: 'deny' }, { behavior: 'deny', message: 'stop' }, null]) {
  test(`Claude hook transports ${JSON.stringify(decision)}`, async (t) => {
    const { output } = await hookFixture(t, 'claude', { decision })
    assert.equal(output, decision ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) + '\n' : '')
  })
}
test('closed Claude connection prints nothing', async (t) => { assert.equal((await hookFixture(t, 'claude', null, { close: true })).output, '') })
test('Codex hook receives ack and exits silently within two seconds', async (t) => {
  const f = await hookFixture(t, 'codex', { ok: true }); assert.equal(f.output, ''); assert.ok(f.elapsed < 2000)
})
for (const cli of ['claude', 'codex']) test(`${cli} hook with no socket exits silently through real CLI`, async () => {
  const run = promisify(execFile)
  const result = await run(process.execPath, [new URL('../bin/scorpio.mjs', import.meta.url).pathname, 'approval-hook', cli], { env: testEnv(home, { HERDR_PANE_ID: 'p1' }), input: '' })
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '')
})

test('reason on Quit or a middle option is discarded while the chosen number is pressed', async () => {
  const f = fixture({ cli: 'codex', screen: folder }); const card = await f.open()
  await f.answer(card, { n: 2, message: 'must never become shell input' })
  assert.deepEqual(f.keys, ['2']); assert.deepEqual(f.texts, [])
  assert.deepEqual(f.injections, [])
  const g = fixture(); const other = await g.open()
  await g.answer(other, { n: 2, message: 'not a rejection' })
  assert.deepEqual(g.keys, ['2']); assert.deepEqual(g.texts, [])
  assert.deepEqual(g.injections, [])
})
test('socket server carries real hook requests and releases a held hook on stop', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-sock-'))
  const socket = path.join(dir, 'a.sock'), f = fixture()
  const service = createApprovals({ terminal: f.terminal, targets: async () => [f.target], socket, send: () => {} })
  await service.start()
  t.after(() => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600)
  let output = ''
  const call = approvalHook('claude', { pane: 'p1', socket, input: Readable.from([JSON.stringify(event)]), output: { write: (s) => { output += s } } })
  for (let i = 0; i < 100 && !service.cards.has('p1'); i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(service.busy('p1'), true); assert.equal(service.cards.get('p1').detail.tool, 'Bash')
  service.stop(); await call; assert.equal(output, '')
})
test('answer and observation are serialized and duplicate clicks press only once', async () => {
  const f = fixture(); const card = await f.open()
  await Promise.all([f.answer(card, { n: 2 }), f.approvals.tick(), f.answer(card, { n: 2 })])
  assert.deepEqual(f.keys, ['2'])
})
test('answer closes as soon as the changed screen is stable', async () => {
  const f = fixture({ settleMs: 3000 }); const card = await f.open()
  const started = f.now(), reads = [], read = f.terminal.read
  f.terminal.read = async (...args) => {
    if (f.keys.length) reads.push(f.now() - started)
    return read(...args)
  }
  await f.answer(card, { n: 1 })
  assert.deepEqual(f.keys, ['1'])
  assert.deepEqual(reads, [0, 200])
  assert.ok(f.now() - started <= 600)
  assert.equal(f.frames.at(-1).reason, 'answered')
  assert.equal(f.frames.at(-1).result, 'ok')
})
test('answer closes promptly after the menu disappears despite continuous status redraws', async () => {
  const f = fixture({ settleMs: 3000 }); const card = await f.open()
  const started = f.now(), screens = [], read = f.terminal.read
  f.terminal.read = async (...args) => {
    if (!f.keys.length) return read(...args)
    const screen = `${screens.length % 2 ? '✶' : '✻'} Working (${screens.length}s …)`
    screens.push(screen)
    return screen
  }
  await f.answer(card, { n: 1 })
  assert.deepEqual(f.keys, ['1'])
  assert.equal(screens.length, 2)
  assert.notEqual(screens[0], screens[1])
  assert.ok(f.now() - started <= 600)
  assert.equal(f.frames.at(-1).reason, 'answered')
  assert.equal(f.frames.at(-1).result, 'ok')
})
test('answer waits the full settle limit when the screen never changes', async () => {
  const f = fixture({ settleMs: 3000 }); const card = await f.open()
  f.terminal.sendKeys = async (_, key) => { f.keys.push(key) }
  const started = f.now()
  await f.answer(card, { n: 1 })
  assert.equal(f.now() - started, 3000)
  assert.deepEqual(f.keys, ['1'])
  const closed = f.frames.find((frame) => frame.type === 'approval_close')
  assert.equal(closed.reason, 'answered'); assert.equal(closed.result, 'failed')
  assert.notEqual(f.approvals.cards.get('p1').id, card.id)
})
test('slow Claude hook keeps the decided card until its menu leaves', async () => {
  const f = fixture({ rooms: ['one'], settleMs: 3000 })
  await f.approvals.request({ v: 1, cli: 'claude', pane: 'p1', event }, (reply) => { f.replies.push(reply) })
  const card = f.approvals.cards.get('p1'), started = f.now()
  assert.equal(card.detail.tool, 'Bash'); assert.ok(card.request.reply)
  await f.answer(card, { n: 1 })
  assert.equal(f.now() - started, 3000)
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
  assert.deepEqual(f.keys, [])
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_close').length, 0)
  assert.equal(f.approvals.cards.get('p1').id, card.id)
  assert.equal(f.logs.some((line) => line.includes('failed')), false)
  assert.ok(f.logs.includes(`approval ${card.id} answered: option 1, sent to claude; waiting for the menu to close`))
  for (let i = 0; i < 2; i++) { f.advance(); await f.approvals.tick() }
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 1)
  await f.answer(card, { n: 1 })
  assert.deepEqual(f.keys, [])
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
  f.screen('working'); f.status('working'); await f.approvals.tick()
  const closed = f.frames.filter((frame) => frame.type === 'approval_close')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].reason, 'answered'); assert.equal(closed[0].result, 'ok')
  assert.equal(f.approvals.cards.has('p1'), false)
})
test('slow Claude hook closes answered ok before the next menu gets its own hook', async () => {
  const f = fixture({ rooms: ['one'] })
  await f.approvals.request({ v: 1, cli: 'claude', pane: 'p1', event }, (reply) => { f.replies.push(reply) })
  const card = f.approvals.cards.get('p1')
  await f.answer(card, { n: 1 })
  f.advance()
  const next = { ...event, tool_input: { command: 'touch /tmp/work/other' } }
  f.screen(bash().replace('touch /tmp/work/result', next.tool_input.command))
  await f.approvals.request({ v: 1, cli: 'claude', pane: 'p1', event: next }, (reply) => { f.replies.push(reply) })
  await f.approvals.tick()
  const closed = f.frames.filter((frame) => frame.type === 'approval_close')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].id, card.id)
  assert.equal(closed[0].reason, 'answered'); assert.equal(closed[0].result, 'ok')
  const replacement = f.approvals.cards.get('p1')
  assert.notEqual(replacement.id, card.id)
  assert.equal(replacement.detail.tool, 'Bash')
  assert.equal(replacement.detail.input, JSON.stringify(next.tool_input))
  assert.ok(replacement.request.reply)
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
  assert.deepEqual(f.keys, [])
})
test('slow Claude hook closes answered ok when the same command requests approval again', async () => {
  const f = fixture({ rooms: ['one'] })
  const request = () => f.approvals.request({ v: 1, cli: 'claude', pane: 'p1', event }, (reply) => { f.replies.push(reply) })
  await request()
  const card = f.approvals.cards.get('p1')
  await f.answer(card, { n: 1 })
  assert.equal(card.decided, true)
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
  f.advance()
  await request()
  await f.approvals.tick()
  const closed = f.frames.filter((frame) => frame.type === 'approval_close')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].id, card.id)
  assert.equal(closed[0].reason, 'answered'); assert.equal(closed[0].result, 'ok')
  const replacement = f.approvals.cards.get('p1')
  assert.notEqual(replacement.id, card.id)
  assert.equal(replacement.detail.tool, 'Bash')
  assert.equal(replacement.detail.input, JSON.stringify(event.tool_input))
  assert.ok(replacement.request.reply)
  assert.deepEqual(f.keys, [])
  await f.answer(replacement, { n: 1 })
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }, { decision: { behavior: 'allow' } }])
  assert.deepEqual(f.keys, [])
})
test('slow Claude hook keeps its decided card while a parallel hook is already waiting', async () => {
  const read = { tool_name: 'Read', tool_input: { file_path: '/tmp/work/outside/f.txt' } }
  const next = { tool_name: 'Bash', tool_input: { command: 'ls -la /tmp/work/outside' } }
  const readScreen = '$ ls -la /tmp/work/outside\nRead file\n  /tmp/work/outside/f.txt\n\nAllow this read?\n❯ 1. Yes\n  2. Yes, allow all reads during this session\n  3. No\n\nEsc to cancel'
  const bashScreen = bash().replace('Bash command', 'Bash command · 2 of 2').replace('touch /tmp/work/result', next.tool_input.command)
  const f = fixture({ rooms: ['one'], screen: readScreen })
  const request = (event) => f.approvals.request({ v: 1, cli: 'claude', pane: 'p1', event }, (reply) => { f.replies.push(reply) })
  await request(read)
  const card = f.approvals.cards.get('p1')
  assert.equal(card.detail.tool, 'Read')
  f.advance(350)
  await request(next)
  f.advance(1)
  await f.answer(card, { n: 1 })
  assert.equal(card.decided, true)
  for (let i = 0; i < 2; i++) { f.advance(); await f.approvals.tick() }
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_close').length, 0)
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 1)
  assert.equal(f.approvals.cards.get('p1').id, card.id)
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
  f.screen(bashScreen)
  await f.approvals.tick()
  const closed = f.frames.filter((frame) => frame.type === 'approval_close')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].id, card.id)
  assert.equal(closed[0].reason, 'answered'); assert.equal(closed[0].result, 'ok')
  const replacement = f.approvals.cards.get('p1')
  assert.notEqual(replacement.id, card.id)
  assert.equal(replacement.detail.tool, 'Bash')
  assert.equal(replacement.detail.input, JSON.stringify(next.tool_input))
  assert.ok(replacement.request.reply)
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
  assert.deepEqual(f.keys, [])
})
test('closed Claude hook still fails and reopens an unchanged menu', async () => {
  const f = fixture({ rooms: ['one'] })
  await f.approvals.request({ v: 1, cli: 'claude', pane: 'p1', event }, () => false)
  const card = f.approvals.cards.get('p1')
  await f.answer(card, { n: 1 })
  const closed = f.frames.find((frame) => frame.type === 'approval_close')
  assert.equal(closed.id, card.id)
  assert.equal(closed.reason, 'answered'); assert.equal(closed.result, 'failed')
  assert.notEqual(f.approvals.cards.get('p1').id, card.id)
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 2)
  assert.deepEqual(f.keys, [])
})
for (const disconnected of [true, false]) test(`real Claude hook socket ${disconnected ? 'closed before answer fails and reopens' : 'left open keeps the decided card'}`, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-slow-hook-'))
  const socket = path.join(dir, 'a.sock'), f = fixture({ rooms: ['one'] })
  const service = createApprovals({ terminal: f.terminal, targets: async () => [f.target], socket,
    send: (roomId, frame) => f.frames.push({ roomId, ...frame }), now: f.now,
    sleep: async (ms) => { f.advance(ms) }, keyTable: async () => ({ settleMs: 1, keys: [] }),
    log: (line) => f.logs.push(line) })
  await service.start()
  const client = net.createConnection(socket)
  t.after(() => { client.destroy(); service.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  let output = ''
  client.on('data', (data) => { output += data })
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject) })
  client.write(JSON.stringify({ v: 1, cli: 'claude', pane: 'p1', event }) + '\n')
  for (let i = 0; i < 100 && !service.cards.has('p1'); i++) await new Promise((r) => setTimeout(r, 5))
  const card = service.cards.get('p1')
  assert.ok(card); assert.equal(card.detail.tool, 'Bash')
  if (disconnected) {
    const closed = new Promise((resolve) => client.once('close', resolve))
    client.end(); await closed
  }
  await service.answer('one', { id: card.id, ts: f.now(), n: 1 })
  assert.deepEqual(f.keys, [])
  const closed = f.frames.filter((frame) => frame.type === 'approval_close')
  if (disconnected) {
    assert.equal(closed.length, 1)
    assert.equal(closed[0].reason, 'answered'); assert.equal(closed[0].result, 'failed')
    assert.notEqual(service.cards.get('p1').id, card.id)
    assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 2)
  } else {
    const ended = new Promise((resolve) => client.once('end', resolve))
    await ended
    assert.deepEqual(JSON.parse(output), { decision: { behavior: 'allow' } })
    assert.equal(closed.length, 0)
    assert.equal(service.cards.get('p1').id, card.id)
    assert.equal(f.logs.some((line) => line.includes('failed')), false)
    await service.tick(); await service.tick()
    assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 1)
    f.screen('working'); f.status('working'); await service.tick()
    const result = f.frames.find((frame) => frame.type === 'approval_close')
    assert.equal(result.reason, 'answered'); assert.equal(result.result, 'ok')
  }
})
test('Codex cursor rejection confirms promptly and injects the reason once', async () => {
  const screen = codex.replace('1. ', '').replace('2. ', '').replace('3. ', '')
  const f = fixture({ cli: 'codex', screen, settleMs: 3000 }); const card = await f.open()
  const started = f.now(); let selected = 1, entered
  f.terminal.sendKeys = async (_, key) => {
    f.keys.push(key)
    if (key === 'down') {
      selected++
      f.screen(screen.replace('› Yes', '  Yes').replace(selected === 2 ? "  Yes, and don't" : '  No,', selected === 2 ? "› Yes, and don't" : '› No,'))
    }
    if (key === 'enter') { entered = f.now() - started; f.screen('working'); f.status('working') }
  }
  await f.answer(card, { n: 3, message: 'Use another command' })
  await f.answer(card, { n: 3, message: 'Use another command' })
  assert.deepEqual(f.keys, ['down', 'down', 'enter'])
  assert.ok(entered <= 600)
  assert.deepEqual(f.injections, [{ pane: 'p1', text: 'Use another command' }])
  assert.equal(f.frames.at(-1).result, 'ok')
})

test('Codex path split from a captured native menu stays on the same button', () => {
  const screen = "Would you like to run the following command?\n\n  $ touch /tmp/work/codex-trust/outside.txt\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with `touch /tmp/work/codex-trust/\n     outside.txt` (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel"
  const menu = parseMenu(screen, 107, 'codex')
  assert.equal(menu.options[1].label, "Yes, and don't ask again for commands that start with `touch /tmp/work/codex-trust/\noutside.txt` (p)")
  assert.equal(menu.options[1].note, undefined)
  assert.equal(menu.question[0], 'Would you like to run the following command?')
})
test('terminal pane width uses its layout rectangle minus the reserved column', async () => {
  const { createHerdr } = await import('../src/adapters/terminal/herdr.mjs')
  const calls = []
  const terminal = createHerdr({ exec: async (args) => { calls.push(args); return JSON.stringify({ result: { layout: { panes: [{ pane_id: 'p1', rect: { width: 108 } }] } } }) } })
  assert.equal(await terminal.paneWidth('p1'), 107)
  assert.deepEqual(calls, [['pane', 'layout', '--pane', 'p1']])
  assert.equal(await terminal.paneWidth('p2'), null)
})
test('Codex hook timeout and missing pane both leave the native menu untouched', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-timeout-')), socket = path.join(dir, 'a.sock')
  let client
  const server = net.createServer((c) => { client = c; c.on('data', () => {}) })
  await new Promise((r) => server.listen(socket, r))
  t.after(() => { client?.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  let output = ''; const start = Date.now()
  await approvalHook('codex', { pane: 'p1', socket, input: Readable.from([JSON.stringify(event)]), output: { write: (s) => { output += s } } })
  assert.equal(output, ''); assert.ok(Date.now() - start < 2500)
  await approvalHook('claude', { pane: '', socket, input: Readable.from([]), output: { write: () => assert.fail('must be silent') } })
})

test('terminal error reports failed and creates a fresh card without retrying the press', async () => {
  const f = fixture(); const card = await f.open(); let attempts = 0
  f.terminal.sendKeys = async () => { attempts++; throw Object.assign(new Error('unavailable'), { code: 'unavailable' }) }
  await f.answer(card, { n: 2 })
  assert.equal(attempts, 1)
  assert.equal(f.frames.filter((x) => x.type === 'approval_close').at(-1).result, 'failed')
  assert.notEqual(f.approvals.cards.get('p1').id, card.id)
})

test('permission detection reads permission flags rather than unrelated argument values', () => {
  assert.equal(fullPermission('codex', ['--model', 'danger-full-access']), false)
  assert.equal(fullPermission('codex', ['--sandbox', 'danger-full-access']), false)
  assert.equal(fullPermission('codex', ['--sandbox=danger-full-access']), false)
  assert.equal(fullPermission('claude', ['--permission-mode', 'bypassPermissions']), true)
})

for (const path of ['observation', 'answer']) test(`working numbered output does not open another card during ${path}`, async () => {
  const f = fixture({ rooms: ['one'] }); const card = await f.open()
  f.status('working'); f.screen('Progress report\n\n  1. Parsed input\n  2. Wrote output')
  if (path === 'observation') await f.approvals.tick()
  else await f.answer(card, { n: 1 })
  assert.equal(f.approvals.cards.size, 0)
  assert.equal(f.frames.filter((x) => x.type === 'approval_open').length, 1)
  assert.deepEqual(f.keys, [])
})
test('unparsed blocked screen updates keep one card id until the pane resumes', async () => {
  const f = fixture({ rooms: ['one'], screen: 'Waiting · 1s' }); const card = await f.open()
  for (const screen of ['Waiting · 2s', 'Waiting · 3s']) { f.screen(screen); await f.approvals.tick() }
  const updates = f.frames.filter((x) => x.type === 'approval_open')
  assert.equal(new Set(updates.map((x) => x.approval.id)).size, 1)
  assert.equal(f.frames.some((x) => x.type === 'approval_close'), false)
  assert.equal(updates.at(-1).approval.screen, 'Waiting · 3s')
  assert.equal(f.approvals.cards.get('p1').id, card.id)
  f.status('working'); await f.approvals.tick()
  assert.equal(f.approvals.cards.size, 0)
  assert.equal(f.frames.at(-1).reason, 'answered_here')
})
test('Codex sandbox access alone retains hooks; every never approval form suppresses them', () => {
  const sandbox = ['--sandbox', 'danger-full-access']
  assert.equal(fullPermission('codex', sandbox), false)
  assert.ok(argsFor('codex', { spawn: { codex: sandbox } }).some((arg) => arg.includes('approval-hook codex')))
  for (const args of [['--dangerously-bypass-approvals-and-sandbox'], ['--yolo'], ['-a', 'never'], ['--ask-for-approval', 'never'], ['--ask-for-approval=never']]) {
    assert.equal(fullPermission('codex', args), true)
    assert.deepEqual(argsFor('codex', { spawn: { codex: args } }), args)
  }
})

test('wrapped command pairs with its hook and leaves no idle card or gate', async () => {
  const command = 'touch /tmp/work/very-long-directory/result'
  const screen = bash().replace('touch /tmp/work/result', 'touch /tmp/work/very-long-\n    directory/result')
  const f = fixture({ screen, rooms: ['one'] })
  await f.request({ ...event, tool_input: { command } })
  const card = f.approvals.cards.get('p1')
  assert.equal(card.detail?.input, JSON.stringify({ command }))
  await f.answer(card, { n: 1 })
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
  f.advance(6000); await f.approvals.tick()
  assert.equal(f.approvals.busy('p1'), false)
  assert.equal(f.frames.filter((x) => x.type === 'approval_open').length, 1)
})
test('unpaired hook expires after two seconds without a menu or card', async () => {
  const f = fixture({ screen: 'Idle prompt', status: 'done' })
  await f.request()
  f.advance(1999); await f.approvals.tick()
  assert.deepEqual(f.replies, [])
  f.advance(1)
  assert.equal(f.approvals.busy('p1'), false, 'expired hook does not gate before the next observation')
  await f.approvals.tick()
  assert.deepEqual(f.replies, [{ decision: null }])
  assert.equal(f.frames.length, 0)
})
test('closing a card releases every earlier hook on its pane', async () => {
  const f = fixture({ screen: 'working', status: 'working' })
  await f.request({ ...event, tool_input: { command: 'unmatched command' } })
  await f.request()
  f.screen(bash()); f.status('blocked'); await f.approvals.tick()
  const card = f.approvals.cards.get('p1')
  f.screen('Idle prompt'); f.status('done'); await f.approvals.tick()
  assert.equal(f.approvals.cards.has('p1'), false)
  assert.deepEqual(f.replies, [{ decision: null }, { decision: null }])
  assert.equal(f.approvals.busy('p1'), false)
  assert.ok(card)
})
test('same options with a new command finish ok and open a new card immediately', async () => {
  const f = fixture({ screen: bash().replace('touch /tmp/work/result', 'touch a.txt'), rooms: ['one'] })
  const card = await f.open()
  f.terminal.sendKeys = async () => f.screen(bash().replace('touch /tmp/work/result', 'touch b.txt'))
  await f.answer(card, { n: 1 })
  assert.equal(f.frames.find((x) => x.type === 'approval_close').result, 'ok')
  assert.notEqual(f.approvals.cards.get('p1')?.id, card.id)
  assert.equal(f.frames.filter((x) => x.type === 'approval_open').length, 2)
})
test('idle screen closes answered_here even while terminal status lags blocked', async () => {
  const f = fixture({ rooms: ['one'] }); const card = await f.open()
  f.screen('Idle prompt'); await f.approvals.tick()
  assert.equal(f.frames.at(-1).reason, 'answered_here')
  assert.equal(f.approvals.cards.has('p1'), false)
  assert.ok(card)
})
test('screen-only card requires three continuous blocked seconds without menu or hook', async () => {
  const f = fixture({ screen: 'Between menus', rooms: ['one'] })
  await f.approvals.tick(); f.advance(2000); await f.approvals.tick()
  assert.equal(f.frames.length, 0)
  f.status('working'); await f.approvals.tick()
  f.status('blocked'); await f.approvals.tick(); f.advance(2999); await f.approvals.tick()
  assert.equal(f.frames.length, 0)
  f.advance(1); await f.approvals.tick()
  assert.equal(f.approvals.cards.get('p1').menu, null)
})

test('menu identity ignores whitespace and older history but retains the command block', () => {
  const identity = (screen) => menuIdentity(screen, parseMenu(screen, 108))
  const context = Array.from({ length: 7 }, (_, i) => `Context ${i}`).join('\n')
  const screen = `Old history\n${context}\n${bash()}`
  assert.equal(identity(screen), identity(screen.replace('Old history', 'New history')))
  assert.equal(identity(bash()), identity(bash().replace('touch /tmp/work/result', 'touch /tmp/work/\n    result')))
  assert.notEqual(identity(screen), identity(screen.replace('touch /tmp/work/result', 'touch /tmp/work/other')))
})
test('closing the current menu preserves a later hook for the next menu', async () => {
  const f = fixture({ rooms: ['one'] }); const card = await f.open()
  f.advance(1)
  const next = { ...event, tool_input: { command: 'touch b.txt' } }
  await f.request(next)
  f.screen(bash().replace('touch /tmp/work/result', 'touch b.txt'))
  await f.approvals.tick()
  assert.equal(f.frames.find((x) => x.type === 'approval_close').reason, 'changed')
  assert.notEqual(f.approvals.cards.get('p1').id, card.id)
  assert.equal(f.approvals.cards.get('p1').detail.input, JSON.stringify(next.tool_input))
  assert.deepEqual(f.replies, [])
  await f.answer(f.approvals.cards.get('p1'), { n: 1 })
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
})

for (const timing of ['replacement', 'unchanged', 'delayed observation']) test(`parallel Read and Bash hooks retain the second decision: ${timing}`, async () => {
  const read = { tool_name: 'Read', tool_input: { file_path: '/tmp/work/outside/f.txt' } }
  const next = { tool_name: 'Bash', tool_input: { command: 'ls -la /tmp/work/outside' } }
  const readScreen = '$ ls -la /tmp/work/outside\nRead file\n  /tmp/work/outside/f.txt\n\nAllow this read?\n❯ 1. Yes\n  2. Yes, allow all reads during this session\n  3. No\n\nEsc to cancel'
  const bashScreen = bash().replace('Bash command', 'Bash command · 2 of 2').replace('touch /tmp/work/result', next.tool_input.command)
  const delayed = timing === 'delayed observation'
  const f = fixture({ rooms: ['one'], screen: delayed ? 'working' : readScreen, status: delayed ? 'working' : 'blocked' })
  await f.request(read)
  f.advance(100)
  await f.request(next)
  if (delayed) { f.advance(100); f.screen(readScreen); f.status('blocked'); await f.approvals.tick() }
  let card = f.approvals.cards.get('p1')
  assert.equal(card.detail?.tool, 'Read')
  assert.equal(card.detail.input, JSON.stringify(read.tool_input))
  if (timing === 'replacement') {
    f.advance(100)
    f.screen(readScreen.replace('Read file', 'Read file · confirmation'))
    await f.approvals.tick()
    const replacement = f.approvals.cards.get('p1')
    assert.notEqual(replacement.id, card.id)
    assert.equal(replacement.request, card.request)
    assert.equal(replacement.detail?.tool, 'Read')
    card = replacement
  }
  assert.deepEqual(f.replies, [])
  await f.answer(card, { n: 1 })
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
  f.screen(bashScreen); f.status('blocked'); await f.approvals.tick()
  const second = f.approvals.cards.get('p1')
  assert.equal(second.detail?.tool, 'Bash')
  assert.equal(second.detail.input, JSON.stringify(next.tool_input))
  assert.ok(second.request?.reply)
  await f.answer(second, { n: 1 })
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }, { decision: { behavior: 'allow' } }])
  assert.deepEqual(f.keys, [])
})

for (const route of ['idle', 'observation', 'answer', 'stale answer']) test(`idle question with numbered choices never opens an approval during ${route}`, async () => {
  const f = fixture({ rooms: ['one'] })
  const output = 'Which approach?\n\n  1. First approach\n  2. Second approach'
  if (route === 'idle') {
    f.status('done'); f.screen(output)
    await f.approvals.tick(); f.advance(6000); await f.approvals.tick()
  } else {
    const card = await f.open()
    if (route === 'answer') {
      f.terminal.sendKeys = async () => { f.status('done'); f.screen(output) }
      await f.answer(card, { n: 1 })
    } else {
      f.status('done'); f.screen(output)
      if (route === 'observation') await f.approvals.tick()
      else await f.answer(card, { n: 1 })
      assert.equal(f.frames.at(-1).reason, 'answered_here')
    }
    assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 1)
  }
  assert.equal(f.approvals.cards.size, 0)
  assert.equal(f.approvals.busy('p1'), false)
})

const stagingScreen = (prefix) => {
  const dir = new URL('./fixtures/approval-staging/', import.meta.url)
  return fs.readFileSync(new URL(fs.readdirSync(dir).find((name) => name.startsWith(prefix)), dir), 'utf8')
}
for (const prefix of ['163123-f91a8d', '163250-8f67d5', '163324-310316', '163905-89f3fb']) {
  test(`staging wrapped command pairs with hook and retains detail: ${prefix}`, async () => {
    const screen = stagingScreen(prefix)
    const command = screen.split('\n').filter((line) => /^ │ /.test(line)).map((line) => line.slice(3).trim()).join(' ')
    assert.ok(command)
    const f = fixture({ screen })
    await f.request({ tool_name: 'Bash', tool_input: { command } })
    assert.equal(f.approvals.cards.get('p1').detail.input, JSON.stringify({ command }))
    await f.answer(f.approvals.cards.get('p1'), { n: 1 })
    assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
    assert.equal(f.approvals.busy('p1'), false)
  })
}
const trustNo = () => stagingScreen('164302-5bee72')
const trustYes = () => stagingScreen('164350-b5dfd3')
test('staging unnumbered trust menus preserve two labels and identity across cursor movement', () => {
  for (const screen of [trustNo(), trustYes()]) {
    const menu = parseMenu(screen)
    assert.deepEqual(menu.options, [{ n: 1, label: 'No, exit' }, { n: 2, label: 'Yes, I trust this folder' }])
    assert.match(menu.question[0], /^Quick safety check:/)
    assert.deepEqual(menu.hints, ['Enter to confirm · Esc to cancel'])
  }
  assert.equal(menuIdentity(trustNo(), parseMenu(trustNo())), menuIdentity(trustYes(), parseMenu(trustYes())))
  assert.equal(parseMenu('❯ Write a report\n  about the project'), null)
})
for (const moves of [true, false]) test(`trust answer checks cursor before Enter: movement ${moves}`, async () => {
  const f = fixture({ screen: trustNo() })
  f.terminal.sendKeys = async (_, key) => {
    f.keys.push(key)
    if (key === 'down' && moves) f.screen(trustYes())
    if (key === 'enter') { f.screen('working'); f.status('working') }
  }
  const card = await f.open()
  assert.ok(card.menu)
  await f.answer(card, { n: 2 })
  assert.deepEqual(f.keys, moves ? ['down', 'enter'] : ['down'])
  assert.equal(f.frames.find((frame) => frame.type === 'approval_close').result, moves ? 'ok' : 'failed')
  if (moves) assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 2)
})
for (const n of [1, 2]) test(`trust answer from second option selects ${n}`, async () => {
  const f = fixture({ screen: trustYes() })
  f.terminal.sendKeys = async (_, key) => {
    f.keys.push(key)
    if (key === 'up') f.screen(trustNo())
    if (key === 'enter') { f.screen('working'); f.status('working') }
  }
  await f.answer(await f.open(), { n })
  assert.deepEqual(f.keys, n === 1 ? ['up', 'enter'] : ['enter'])
  assert.equal(f.frames.find((frame) => frame.type === 'approval_close').result, 'ok')
})
test('trust answer never confirms a changed menu after moving', async () => {
  const f = fixture({ screen: trustNo() })
  f.terminal.sendKeys = async (_, key) => { f.keys.push(key); f.screen(trustYes().replace('Yes, I trust this folder', 'Yes, trust another folder')) }
  await f.answer(await f.open(), { n: 2 })
  assert.deepEqual(f.keys, ['down'])
  assert.equal(f.frames.find((frame) => frame.type === 'approval_close').result, 'failed')
})


test('blinking status outside the menu rule keeps the same card and held detail', async () => {
  const first = stagingScreen('174830-'), second = stagingScreen('174832-')
  const f = fixture({ screen: first, rooms: ['one'] })
  await f.request({ tool_name: 'Read', tool_input: { file_path: '/tmp/work/.scorpio-staging/spawns/example-topic/t5.md' } })
  const card = f.approvals.cards.get('p1')
  assert.ok(card.detail)
  f.screen(second); await f.approvals.tick()
  assert.equal(f.approvals.cards.get('p1').id, card.id)
  assert.equal(f.frames.length, 1)
  assert.deepEqual(f.replies, [])
})

test('menu identity ignores status glyphs without a top rule', () => {
  const identity = (s) => menuIdentity(s, parseMenu(s))
  for (const glyph of ['•', '·', '■', '●', '◿', '⠋', '✻', '✶', '✳', '✢', '✽']) {
    assert.equal(identity(glyph + ' Reading\n' + bash()), identity('Reading\n' + bash()))
  }
})

const readCounterScreen = (counter = '') => `─────────────────────────────────────────
 Read file${counter ? `                                  ${counter}` : ''}
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Read(/tmp/work/outside/f.txt)
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from /tmp/work/outside during this session
   3. No

 Esc to cancel · Tab to amend`
test('menu identity ignores the first request counter but retains later counters', () => {
  const first = readCounterScreen()
  const identity = (screen) => menuIdentity(screen, parseMenu(screen, 108))
  const card = { cli: 'claude', width: 108, identity: identity(first) }
  for (const counter of ['1 of 2', '1 of 3']) {
    assert.equal(identity(first), identity(readCounterScreen(counter)))
    assert.equal(sameMenu(card, readCounterScreen(counter)), true)
  }
  assert.notEqual(identity(readCounterScreen('1 of 2')), identity(readCounterScreen('2 of 2')))
  assert.notEqual(identity(readCounterScreen('1 of 3')), identity(readCounterScreen('3 of 3')))
})
test('adding a first request counter and another hook keeps the Read card and detail', async () => {
  const f = fixture({ screen: readCounterScreen(), rooms: ['one'] })
  const read = { tool_name: 'Read', tool_input: { file_path: '/tmp/work/outside/f.txt' }, cwd: '/tmp/work' }
  await f.request(read)
  const card = f.approvals.cards.get('p1')
  assert.equal(card.detail.tool, 'Read')
  assert.equal(card.detail.input, JSON.stringify(read.tool_input))
  f.advance(300)
  f.screen(readCounterScreen('1 of 2'))
  await f.request({ ...event, tool_input: { command: 'ls /tmp/work' } })
  await f.approvals.tick()
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_close').length, 0)
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 1)
  assert.equal(f.approvals.cards.get('p1').id, card.id)
  assert.deepEqual(f.approvals.cards.get('p1').detail, card.detail)
  assert.deepEqual(f.replies, [])
})

for (const answer of [false, true]) test(`changed menu transfers its matching hook and detail (${answer ? 'answer' : 'poll'})`, async () => {
  const f = fixture({ rooms: ['one'] })
  await f.request(); const old = f.approvals.cards.get('p1')
  f.screen(bash().replace('Do you want to proceed?', 'Allow this command?'))
  if (answer) await f.answer(old, { n: 1 })
  else await f.approvals.tick()
  const next = f.approvals.cards.get('p1')
  assert.notEqual(next.id, old.id)
  assert.equal(next.request, old.request)
  assert.deepEqual(next.detail, old.detail)
  assert.deepEqual(f.replies, [])
  await f.answer(next, { n: 1 })
  assert.deepEqual(f.replies, [{ decision: { behavior: 'allow' } }])
})

for (const [label, menu, count] of [['hooks', hookTrust, 3], ['folder', folder, 2]]) {
  const screen = menu + '\n'.repeat(60)
  test(`idle Codex ${label} trust opens without a hook and accepts a web answer`, async () => {
    const f = fixture({ cli: 'codex', status: 'idle', screen })
    await f.approvals.tick()
    assert.equal(f.frames.length, 0)
    f.advance(1999); await f.approvals.tick(); assert.equal(f.frames.length, 0)
    f.advance(1); await f.approvals.tick()
    const card = f.approvals.cards.get('p1')
    assert.equal(card.menu.options.length, count)
    assert.equal(card.detail, null)
    assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 2, 'one card shared by two rooms')
    f.terminal.sendKeys = async (_, key) => {
      f.keys.push(key)
      if (key === '2') f.screen(screen.replace('› 1.', '  1.').replace('  2.', '› 2.'))
      if (key === 'enter') f.screen('› Ask anything')
    }
    await f.answer(card, { n: 2 })
    assert.deepEqual(f.keys, ['2', 'enter'])
    assert.equal(f.frames.at(-1).reason, 'answered')
    assert.equal(f.frames.at(-1).result, 'ok')
    assert.equal(f.approvals.cards.size, 0)
  })
  test(`idle Codex ${label} trust closes when answered at the terminal and reopens after failed presses`, async () => {
    const f = fixture({ cli: 'codex', status: 'idle', screen })
    const card = await f.open()
    f.terminal.sendKeys = async () => {}
    await f.answer(card, { n: 2 })
    assert.equal(f.frames.find((frame) => frame.type === 'approval_close').result, 'failed')
    assert.ok(f.approvals.cards.get('p1'))
    f.terminal.sendKeys = async () => { throw new Error('press failed') }
    await f.answer(f.approvals.cards.get('p1'), { n: 2 })
    assert.ok(f.approvals.cards.get('p1'), 'error path preserves an idle dialog')
    f.screen('› Ask anything'); await f.approvals.tick()
    assert.equal(f.frames.at(-1).reason, 'answered_here')
    assert.equal(f.approvals.cards.size, 0)
  })
}
test('unseen dialog detection is narrow, recent and subordinate to working status', async () => {
  for (const screen of ['› 1. foo', 'Hooks need review', 'Trust all and continue', 'Trust this folder?', 'Trust and continue', hookTrust + '\nordinary line'.repeat(30)]) {
    assert.equal(unseenDialog(screen), false)
    const f = fixture({ cli: 'codex', status: 'idle', screen })
    await f.open(); assert.equal(f.approvals.cards.size, 0)
  }
  assert.equal(dialogBlocked('working', hookTrust), false)
  const f = fixture({ cli: 'codex', status: 'working', screen: hookTrust })
  await f.open(); assert.equal(f.approvals.cards.size, 0)
})

// Captured menu layouts with neutral names; blank lines match terminal block spacing.
const capturedCodex = [
  "• Previous output with several words\n  and a result\n• Another result\n  continued output\n• Running scorpio roleCard topicId=T0 role=worker\n    + Show details\n\n\nWould you like to run the following command?\n\nEnvironment: local\nReason: 允许在沙箱外更新 worker 的 Scorpio 职责卡吗？\n\n$ scorpio roleCard topicId=T0 role=worker roleCard='worker 是 api@kai\n的冒烟测试 Agent；仅按其逐步指令执行文件或无害命令操作，每步一个动作并用一行报告结果。所有 Scorpio\n命令使用提权执行，报到后等待 daemon 消息。'\n\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with `scorpio roleCard\n     'topicId=T0' 'role=worker' 'roleCard=worker 是 api@kai 的冒烟测试 Agent；\n     仅按其逐步指令执行文件或无害命令操作，每步一个动作并用一行报告结果。所有 Scorpio 命令使用提权执行，报\n     到后等待 daemon 消息。'` (p)\n  3. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel",
  "• Previous output with several\n  words and a result\n• Another\n  result continued output\n• Running scorpio roleCard\n  topicId=T0 role=worker\n    + Show details\n\n\nWould you like to run the following command?\n\nEnvironment: local\nReason: 允许在沙箱外更新 worker 的 Scorpio 职责卡吗？\n\n$ scorpio roleCard topicId=T0 role=worker roleCard='worker 是 api@kai\n的冒烟测试 Agent；仅按其逐步指令执行文件或无害命令操作，每步一个动作并用一行报告结果。所有 Scorpio\n命令使用提权执行，报到后等待 daemon 消息。'\n\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with `scorpio roleCard\n     'topicId=T0' 'role=worker' 'roleCard=worker 是 api@kai 的冒烟测试 Agent；仅\n     按其逐步指令执行文件或无害命令操作，每步一个动作并用一行报告结果。所有 Scorpio 命令使用提权执行，报到后\n     等待 daemon 消息。'` (p)\n  3. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel",
  "• Running scorpio send\n    + Show details\n\n\nWould you like to run the following command?\n\nEnvironment: local\nReason: 允许在沙箱外向 api 回复 reason received 吗？\n\n$ scorpio send topicId=T0 role=worker replyTo=140 text='@api@kai reason\nreceived'\n\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with `scorpio send 'topicId=T0'\n     'role=worker' 'replyTo=140' 'text=@api@kai reason received'` (p)\n  3. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel",
  "  note.txt in your working folder containing the single line: line one\n  +--------------------------------------+\n\n  Mark them read first: scorpio mark topicId=T0 role=worker upTo=146\n  Then do the work (if any).\n\n\n• 我会先标记消息，再用 apply_patch 创建 apv-note.txt，内容为单行 line one。\n\n✔ You approved codex to run scorpio mark topicId=T0 role=worker upTo=146 this time\n\n• Ran scorpio mark topicId=T0 role=worker upTo=146\n  └ {\"topicId\":\"T0\",\"name\":\"worker@kai\",\"cursor\":146}\n\n• Added apv-note.txt (+1 -0)\n    1 +line one\n    + Show details\n\n\n  Would you like to make the following edits?\n\n  Description: Apply proposed file edits\n  Destination: /work/apv-note.txt\n\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for these files (a)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel"
]

test('Codex command questions retain the title, environment and questioned reason', () => {
  const menu = parseMenu(capturedCodex[2], 108, 'codex')
  assert.equal(menu.question[0], 'Would you like to run the following command?')
  assert.equal(menu.question.filter(Boolean)[1], 'Environment: local')
  assert.ok(menu.question.some((line) => /^Reason:.*？$/.test(line)))
  assert.ok(menu.question.some((line) => line.startsWith('$ scorpio send ')))
  assert.equal(menu.question[1], '')
})
test('Codex patch and hook questions start at the menu title', () => {
  assert.equal(parseMenu(capturedCodex[3], 108, 'codex').question[0], 'Would you like to make the following edits?')
  assert.equal(parseMenu('• Previous work?\n\n' + hookTrust, 108, 'codex').question[0], 'Hooks need review')
})
test('Codex role card rewrap keeps identity, sameMenu and the open card', async () => {
  const [first, second] = capturedCodex
  const menu = parseMenu(first, 108, 'codex')
  const identity = menuIdentity(first, menu)
  assert.equal(identity, menuIdentity(second, parseMenu(second, 108, 'codex')))
  assert.equal(sameMenu({ cli: 'codex', width: 108, identity }, second), true)
  const f = fixture({ cli: 'codex', screen: first, rooms: ['one'] })
  const card = await f.open()
  f.screen(second); await f.approvals.tick()
  assert.equal(f.approvals.cards.get('p1').id, card.id)
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 1)
  assert.equal(f.frames.filter((frame) => frame.type === 'approval_close').length, 0)
})
for (const options of ["› 1. Yes, proceed (y)\n  2. No (esc)", '› 1. Yes\n  2. No']) {
  test(`Codex identity retains different commands with ${options.split('\n')[0]}`, () => {
    const identity = (command) => {
      const screen = `• Previous work\n\nWould you like to run the following command?\n\nEnvironment: local\nReason: Run it？\n\n$ ${command}\n\n${options}\n\nenter confirm`
      return menuIdentity(screen, parseMenu(screen, 108, 'codex'))
    }
    assert.notEqual(identity('touch a.txt'), identity('touch b.txt'))
    assert.notEqual(identity("cat <<'EOF'\na\nEOF"), identity("cat <<'EOF'\nb\nEOF"))
  })
}
for (const boundary of ['•', '✔', '✗', '■', '›', '└', '───', '━━━']) {
  test(`Codex question search stops at transcript boundary ${boundary}`, () => {
    const screen = `Earlier question?\n  ${boundary}${/[─━]/.test(boundary) ? '' : ' Previous work'}\n\n${hookTrust}`
    assert.equal(parseMenu(screen, 108, 'codex').question[0], 'Hooks need review')
  })
}
test('Codex cursor menu uses the same question boundary and no transcript context', () => {
  const screen = '• Previous question?\n\nHooks need review\n\n1 hook is new or changed.\n\n› Review hooks\n  Trust all and continue\n\nEnter to confirm · Esc to cancel'
  const menu = parseMenu(screen, 108, 'codex')
  assert.equal(menu.question[0], 'Hooks need review')
  assert.equal(JSON.parse(menuIdentity(screen, menu)).context, '')
})

test('Codex question searches the captured block without a transcript boundary', () => {
  const screen = 'Top of captured block\n\nQuestion?\n\n› 1. Yes\n  2. No\n\nenter confirm'
  assert.equal(parseMenu(screen, 108, 'codex').question[0], 'Question?')
})

test('Codex hook trust skips leading blank rows without a transcript boundary', () => {
  assert.equal(parseMenu('\n\n' + hookTrust, 108, 'codex').question[0], 'Hooks need review')
})

for (const [name, change] of [
  ['unchanged cursor', (screen) => screen],
  ['changed label', (screen) => screen.replace('› 1.', '  1.').replace('  2. Trust all and continue', '› 2. Trust selected hooks')],
  ['changed question', (screen) => screen.replace('› 1.', '  1.').replace('  2.', '› 2.').replace('1 hook is new or changed.', '2 hooks are new or changed.')],
]) test(`Codex trust never confirms after ${name}`, async () => {
  const screen = hookTrust + '\n'.repeat(60)
  const f = fixture({ cli: 'codex', status: 'idle', screen, rooms: ['one'] })
  f.terminal.sendKeys = async (_, key) => { f.keys.push(key); f.screen(change(screen)) }
  const card = await f.open()
  await f.answer(card, { n: 2 })
  assert.deepEqual(f.keys, ['2'])
  assert.equal(f.frames.find((frame) => frame.type === 'approval_close').result, 'failed')
  if (name === 'unchanged cursor') {
    assert.notEqual(f.approvals.cards.get('p1').id, card.id)
    assert.equal(f.frames.filter((frame) => frame.type === 'approval_open').length, 2)
  }
})
test('Codex command number never confirms an identical next menu', async () => {
  const f = fixture({ cli: 'codex', screen: codex, rooms: ['one'] })
  f.terminal.sendKeys = async (_, key) => { f.keys.push(key); f.screen(codex) }
  await f.answer(await f.open(), { n: 2 })
  assert.deepEqual(f.keys, ['2'])
  assert.equal(f.frames.find((frame) => frame.type === 'approval_close').result, 'failed')
})

test('Codex only adds permission to ask when the selected user config has no policy', async () => {
  const { approvalSettings } = await import('../src/adapters/cli/codex-settings.mjs')
  const dir = process.env.CODEX_HOME
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'config.toml')
  const cases = [
    ['', true],
    ['sandbox_mode = "workspace-write"', true],
    ['approval_policy = { granular = { network = false } }', false],
    ['[approval_policy.granular]\nnetwork = false', false],
    ['profile = "work"\n[profiles.work]\napproval_policy = { granular = { network = false } }', false],
    ['profile = "work"\n[profiles.work.approval_policy.granular]\nnetwork = false', false],
    ['profile = "work"\n[profiles.other.approval_policy.granular]\nnetwork = false', true],
    ['# approval_policy = "never"\n[approval_policy_extra]\nnetwork = false', true],
    ['approval_policy = "never"\nsandbox_mode = { mode = "danger-full-access" }', false],
    ['approval_policy = "never"', false],
    ["approval_policy = 'on-request' # user choice", false],
    ['profile = "work"\n[profiles.work]\napproval_policy = "untrusted"', false],
    ['profile = "work"\n[profiles.other]\napproval_policy = "never"', true],
    ['[projects."/tmp/work"]\napproval_policy = "never"', true],
    ['approval_policy = "never"\nnotes = "unicode \\U00000041"\n[projects."/tmp/work.v1"]\ntrust_level = "trusted"', false],
    ['profile = "work.v1"\n[profiles."work.v1"]\napproval_policy = "on-request"', false],
    ['approval_policy = """never"""', false],
    ['profile = "work"\napproval_policy = "on-request"\n[profiles."work"]\napproval_policy = "never"\nsandbox_mode = "danger-full-access"', false],
  ]
  try {
    for (const [source, added] of cases) {
      fs.writeFileSync(file, source)
      const args = argsFor('codex', {})
      assert.equal(args.includes('--ask-for-approval'), added, source)
      if (added) assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'on-request')
      assert.equal(args.includes('--sandbox'), false)
      assert.equal(fs.readFileSync(file, 'utf8'), source, 'settings stay read-only')
      assert.deepEqual(argsFor('claude', {}).slice(0, 4), ['--model', 'claude-opus-5-5', '--effort', 'medium'])
    }
    assert.deepEqual(approvalSettings(), { policy: 'never', sandbox: 'danger-full-access' })
    fs.rmSync(file)
    assert.ok(argsFor('codex', {}).includes('on-request'), 'missing config')
    const custom = ['-a', 'untrusted']
    assert.deepEqual(argsFor('codex', { spawn: { codex: custom } }).slice(0, 2), custom)
    assert.equal(argsFor('codex', { spawn: { codex: custom } }).includes('--ask-for-approval'), false)
    assert.equal(argsFor('codex', {}, 'all').includes('on-request'), false)
    assert.equal(argsFor('codex', {}, 'auto').includes('--ask-for-approval'), false)
  } finally { fs.rmSync(file, { force: true }) }
})


test('automatic permission flags are recognized and full permission takes precedence', () => {
  for (const [kind, forms, full] of [
    ['claude', [['--permission-mode', 'auto'], ['--permission-mode=auto']], '--dangerously-skip-permissions'],
    ['codex', [['--approve-for-me'], ['--not-so-yolo']], '--yolo'],
  ]) {
    assert.equal(autoPermission(kind, []), false)
    assert.equal(permOf(kind, []), 'ask')
    for (const args of forms) {
      assert.equal(autoPermission(kind, args), true)
      assert.equal(permOf(kind, args), 'auto')
      assert.equal(permOf(kind, [...args, full]), 'all')
    }
  }
  assert.equal(autoPermission('claude', ['--model', 'auto']), false)
  assert.equal(autoPermission('codex', ['--permission-mode', 'auto']), false)
})

test('auto spawn retains the Claude hook and omits the Codex hook and asking policy', () => {
  const claude = argsFor('claude', {}, 'auto')
  assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'auto')
  assert.equal(claude[claude.indexOf('--settings') + 1].endsWith(path.join('hooks', 'claude.json')), true)
  const codex = argsFor('codex', {}, 'auto')
  assert.ok(codex.includes('--approve-for-me'))
  assert.equal(codex.some((arg) => arg.includes('hooks.PermissionRequest')), false)
  assert.equal(codex.includes('--ask-for-approval'), false)
  for (const flag of ['--approve-for-me', '--not-so-yolo']) {
    assert.deepEqual(argsFor('codex', { spawn: { codex: [flag] } }), [flag])
  }
  for (const custom of [['--permission-mode', 'auto'], ['--permission-mode=auto']]) {
    const args = argsFor('claude', { spawn: { claude: custom } })
    assert.deepEqual(args.slice(0, custom.length), custom)
    assert.ok(args.includes('--settings'))
  }
})

test('unsafe rejection reasons never press, type, inject, or decide a hook', async () => {
  for (const cli of ['claude', 'codex']) for (const message of ['!touch file', '  !touch file', 'a\nb', 'a\tb', 'a\x1bb', 'a\x9bb']) {
    const f = fixture({ cli })
    const card = await f.open()
    await f.answer(card, { n: card.menu.options.at(-1).n, message })
    assert.deepEqual(f.keys, [])
    assert.deepEqual(f.texts, [])
    assert.deepEqual(f.injections, [])
    assert.deepEqual(f.replies, [])
    assert.ok(f.logs.some((line) => /reason refused/.test(line)))
    assert.equal(f.frames.find((frame) => frame.type === 'approval_close').result, 'failed')
    assert.notEqual(f.approvals.cards.get('p1').id, card.id)
  }
})
