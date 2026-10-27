import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-dashboard-'))
process.env.SCORPIO_HOME = home
test.after(() => fs.rmSync(home, { recursive: true, force: true }))
const { createDashboardTerminal, createExitConfirmation, terminalFrame } = await import('../src/daemon/dashboard-terminal.mjs')
const { createPobiAnimator, dashboardLog, pobiMode, pobiSprite, renderDashboard, renderLogPage, statusText, widthOf } = await import('../src/daemon/dashboard.mjs')
const { dashboardState } = await import('../src/daemon/dashboard-state.mjs')
const { createLinks } = await import('../src/daemon/links.mjs')

const sample = {
  width: 80, height: 24, language: 'zh', utf8: true, color: false, version: '0.13.2', now: new Date('2026-10-17T14:02:11Z').getTime(),
  seat: 'box-daemon@kai', connection: { status: 'connected', since: new Date('2026-10-17T12:00:00Z').getTime(), latencyMs: 42 },
  computer: { name: 'box', hostname: 'box-01.example.com', note: 'Kai 的工作机' },
  clis: null, stats: { today: { total: 128, rooms: { r: { total: 128, agents: { 'pm@kai': 96 } } } }, total: 1240 },
  topics: [{ id: 'r', name: 'Scorpio', agents: [{ name: 'pm@kai', status: 'working', minutes: 4, pane: 'wC:pCX' }] }],
  logs: [{ ts: '2026-10-17T14:01:50Z', text: 'delivered to pm@kai in r (pane wC:pCX, 1 up to #5323)' }],
}

test('dashboard renders 80 and 60 columns without overflow', () => {
  for (const width of [80, 60]) {
    const lines = renderDashboard({ ...sample, width })
    assert.ok(lines.every((line) => widthOf(line) <= width), lines.join('\n'))
    assert.ok(lines.some((line) => line.includes('本机参与的主题 · 1')))
    assert.ok(lines.some((line) => line.includes('日志 · 最近')))
    assert.ok(lines.some((line) => line.includes('送达 pm · 1 条 · 至 #5323')))
    assert.equal(lines.some((line) => line.includes('(@)')), width === 80)
  }
})

test('no detection data is labeled 尚未检测, and the log page keeps its back hint', () => {
  assert.ok(renderDashboard({ ...sample, clis: null }).some((line) => line.includes('已检测  尚未检测')))
  const rows = renderLogPage({ file: '/a/very/long/path/to/daemon.log', rows: ['line'], width: 30, language: 'en' })
  assert.ok(rows[0].endsWith('l/q back'))
  assert.ok(rows.every((row) => widthOf(row) <= 30))
})

test('the log page writes no tabs, so it covers the dashboard and its rows fit the width', () => {
  // A file line is ts, level and text joined by tabs; a tab moves the cursor without erasing what is under it.
  const row = `2026-10-20T10:15:00+08:00\tinfo\t${'delivered to pm@kai in abc, 1 up to #9001 '.repeat(3)}`
  const lines = renderLogPage({ file: '/home/kai/.scorpio/state/daemon.log', rows: [row, row], width: 80, height: 24 })
  assert.ok(lines.every((line) => !line.includes('\t') && widthOf(line) <= 80))
  assert.ok(lines[1].startsWith('2026-10-20T10:15:00+08:00  info  delivered'))
})

test('dashboard falls back to ASCII framing and NO_COLOR produces no escape codes', () => {
  const lines = renderDashboard({ ...sample, utf8: false, color: false })
  assert.ok(lines[0].startsWith('+-'))
  assert.ok(lines.every((line) => !line.includes('\x1b[')))
})

test('Pobi mode and frames show a lamp and closed eyes for disconnected and idle', () => {
  assert.equal(pobiMode({ connected: false }), 'disconnected')
  assert.equal(pobiMode({ agents: [{ status: 'blocked' }] }), 'blocked')
  assert.equal(pobiMode({ agents: [{ status: 'working' }] }), 'working')
  assert.equal(pobiMode({ agents: [] }), 'idle')
  assert.ok(pobiSprite('blocked')[0].includes('(!)'))
  assert.ok(pobiSprite('idle')[4].includes('- -'))
  assert.ok(pobiSprite('disconnected', 0)[0].includes('( )'))
  assert.ok(pobiSprite('blocked', 0, 0)[4].includes('o o'))
  let time = 0
  const animator = createPobiAnimator(() => time)
  assert.equal(animator.current('working').phase, 0)
  time = 500
  assert.equal(animator.current('blocked').phase, 0)
  animator.note('delivery')
  time = 700
  assert.equal(animator.current('blocked').event.elapsed, 200)
  assert.equal(statusText({ status: 'idle', minutes: 58, idleIn: 2 }, 'zh'), '空闲 · 58 分 · 2 分后交接')
})

test('exit requires two Ctrl-C presses or y inside three seconds', () => {
  let time = 0
  const exit = createExitConfirmation({ now: () => time })
  assert.equal(exit.key('ctrl-c'), 'confirm')
  assert.equal(exit.key('ctrl-c'), 'stop')
  const other = createExitConfirmation({ now: () => time })
  assert.equal(other.key('ctrl-c'), 'confirm')
  time = 3001
  assert.equal(other.pending(), false)
  assert.equal(other.key('ctrl-c'), 'confirm')
  assert.equal(other.key('x'), 'cancel')
  assert.equal(other.key('ctrl-c'), 'confirm')
  assert.equal(other.key('y'), 'stop')
})

test('dashboard log uses the approved event wording', () => {
  assert.equal(dashboardLog({ text: 'connection lost: h|r' }, 'zh').text, '连接断开 · 重新连接中')
  assert.equal(dashboardLog({ text: 'connection restored: h|r after 6 s' }, 'en').text, 'Reconnected · down 6 s')
  assert.equal(dashboardLog({ text: 'updating 0.13.2 → 0.13.3' }, 'zh'), null)
  assert.equal(dashboardLog({ text: 'updated to 0.13.3' }, 'zh').text, '已更新至 0.13.3 · 下次启动生效')
  assert.equal(dashboardLog({ text: 'web@kai needs confirmation' }, 'zh').text, 'web 等待确认 · 查看 /read web · 按键 /keys web …')
  assert.equal(dashboardLog({ text: 'web@kai needs confirmation' }, 'en').text, 'web needs confirmation · /read web to view · /keys web to answer')
  assert.equal(dashboardLog({ text: 'delivered to pm@kai in r (pane w:p, 1 up to #2)' }, 'en').text, 'Delivered to pm · 1 message · up to #2')
  assert.equal(dashboardLog({ text: 'heartbeat' }, 'zh'), null)
})

test('copy and rows use the visible counts, preserve the note, and align update detail', () => {
  const zh = renderDashboard({ ...sample, height: 26 })
  const computer = zh.find((line) => line.includes('电脑'))
  assert.ok(computer.includes('Kai 的工作机'), computer)
  assert.ok(!computer.includes('box-01.example.com'), computer)
  assert.ok(zh.some((line) => line.includes('日志 · 最近 1 行')))
  assert.ok(zh.some((line) => line.includes('今日 128 条 · 累计 1,240 条')))
  const seat = zh.find((line) => line.includes('box-daemon@kai'))
  const update = zh.find((line) => line.includes('上次检测'))
  assert.equal(widthOf(seat.slice(0, seat.indexOf('box-daemon@kai'))), widthOf(update.slice(0, update.indexOf('上次检测'))))
  const en = renderDashboard({ ...sample, language: 'en', stats: { ...sample.stats, today: { ...sample.stats.today, total: 1 } } })
  assert.ok(en.some((line) => line.includes('1 message today · 1,240 total')))
  const checked = renderDashboard({ ...sample, language: 'en', update: { at: sample.now, state: 'current' }, detectedAt: sample.now })
  assert.ok(checked.some((line) => line.includes('Last detected')))
  assert.ok(checked.some((line) => line.includes('Update check') && line.includes('up to date')))
  assert.ok(checked.every((line) => widthOf(line) <= 80))
})

test('terminal redraw overwrites rows without clearing the entire screen', () => {
  const frame = terminalFrame(['abc', 'd'])
  assert.equal(frame, '\x1b[Habc\x1b[K\r\nd\x1b[K\x1b[J')
  assert.ok(!frame.includes('\x1b[2J'))
})

test('dashboard agent minutes follow status changes and host latency expires', () => {
  const now = new Date('2026-10-17T14:00:00Z').getTime()
  const link = { host: true, isOpen: true, openedAt: now - 120_000, latencyMs: 42, latencyAt: now - 61_000, failures: 0 }
  const args = {
    now, seat: { name: 'box-daemon@kai', joined: () => ['r'] }, rooms: { get: () => ({ roomName: 'Scorpio' }) },
    roster: [{ roomId: 'r', name: 'pm@kai', pane: 'w:p1' }], ops: [],
    links: { all: () => [link] }, panes: new Map([['w:p1', { agent_status: 'idle' }]]),
    idle: new Map([['r|pm@kai', { since: now - 30 * 60_000 }]]), idleMinutes: 60,
    statusSince: new Map([['r|pm@kai', { status: 'idle', since: now - 58 * 60_000 }]]),
    clis: null, detectedAt: null, update: null,
    stats: { snapshot: () => ({ today: { total: 0, rooms: {} }, total: 0 }) },
    pobiAnimator: createPobiAnimator(() => now),
  }
  const view = dashboardState(args)
  assert.equal(view.topics[0].agents[0].minutes, 58)
  assert.equal(view.topics[0].agents[0].idleIn, 30)
  assert.equal(view.connection.latencyMs, undefined)
  link.latencyAt = now - 10_000
  assert.equal(dashboardState(args).connection.latencyMs, 42)
})

test('host connection sends a ping immediately after opening', () => {
  class Socket {
    constructor() { this.handlers = {}; this.sent = []; Socket.last = this }
    addEventListener(name, handler) { this.handlers[name] = handler }
    send(value) { this.sent.push(value) }
    close() {}
    emit(name, value = {}) { this.handlers[name](value) }
  }
  const links = createLinks({ api: { wsUrl: () => 'ws://local', token: () => 'x', userAgent: 'test' }, onFrame: () => {}, WebSocketImpl: Socket })
  links.sync([{ key: 'h|r', roomId: 'r', role: 'daemon', host: true, carry: [] }])
  Socket.last.emit('open')
  assert.ok(Socket.last.sent.includes('ping'))
  Socket.last.emit('message', { data: 'pong' })
  assert.ok(links.get('h|r').latencyAt != null)
  links.closeAll()
})

test('confirmed stop logs its final text and uses the supplied exit path', () => {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => {}
  input.resume = () => {}
  const output = { isTTY: true, columns: 80, rows: 24, text: '', write(chunk) { this.text += chunk } }
  const logged = []
  const log = (line) => logged.push(line)
  log.recent = () => []
  log.all = () => []
  log.file = '/tmp/daemon.log'
  let stops = 0
  const dashboard = createDashboardTerminal({ input, output, env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }, state: () => ({ topics: [] }), log, onStop: () => { stops += 1 } })
  input.emit('keypress', '', { ctrl: true, name: 'c' })
  assert.equal(stops, 0)
  input.emit('keypress', '', { ctrl: true, name: 'c' })
  assert.equal(stops, 1)
  assert.deepEqual(logged, ['Scorpio daemon stopped. Agents on this computer keep running but no longer receive messages.'])
  assert.ok(!output.text.includes('Scorpio daemon stopped.'))
  dashboard.close()
})

test('the computer header follows the host join answer, with the local hostname and fallback before joining', () => {
  const args = {
    seat: { name: 'box-daemon@kai', joined: () => [] }, rooms: new Map(), roster: [],
    links: { all: () => [] }, panes: new Map(), idle: new Map(), statusSince: new Map(),
    stats: { snapshot: () => ({}) }, pobiAnimator: createPobiAnimator(),
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ device_name: 'box', device_note: 'old note' }))
  assert.equal(dashboardState(args).computer.name, 'box')
  args.seat.state = { device: { name: 'computer-1', note: 'Work computer' } }
  assert.deepEqual(dashboardState(args).computer, { name: 'computer-1', note: 'Work computer', hostname: os.hostname() })
  args.seat.state.device.note = null
  assert.equal(dashboardState(args).computer.note, null)
})

test('an offline dashboard without agent panes shows the full approval link in both languages and removes it on recovery', () => {
  const url = 'https://scorpio.example.com/activate?code=BCDF-GHJK'
  fs.writeFileSync(path.join(home, 'device.json'), JSON.stringify({ verification_uri_complete: url }))
  let offline = true
  const args = {
    seat: { name: 'box-daemon@kai', joined: () => [] }, rooms: new Map(), roster: [],
    links: { all: () => [] }, panes: new Map(), idle: new Map(), statusSince: new Map(),
    stats: { snapshot: () => ({}) }, pobiAnimator: createPobiAnimator(), logout: { offline: () => offline },
  }
  assert.equal(dashboardState(args).logout.url, url)
  for (const language of ['zh', 'en']) {
    for (const width of [60, 80, 100]) {
      const lines = renderDashboard({ ...dashboardState(args), language, width })
      assert.ok(lines.some((row) => row.includes(language === 'zh' ? '已掉线 · 打开网页重新授权：' : 'Logged out · approve on the web: ')))
      assert.ok(lines.every((row) => widthOf(row) <= width))
      assert.ok(lines.map((row) => row.slice(2, -1).trim()).join('').includes(url))
    }
  }
  offline = false
  assert.equal(dashboardState(args).logout, null)
  assert.ok(!renderDashboard(dashboardState(args)).join('').includes('Logged out'))
})

test('dashboard strips controls from topic names and server approval links', () => {
  const lines = renderDashboard({ ...sample, topics: [{ id: 'r', name: 'bad\x1b\x07\x9bname' }], logout: { url: 'https://example.com/\x1b\x9bcode' } })
  assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(lines.join('')), false)
})
