// Run with node --test from cli/ (no dependencies)
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { testEnv } from './env.mjs'
import { hideKeys } from '../src/daemon/screens.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-test-'))
process.env.SCORPIO_HOME = home
process.env.CODEX_HOME = path.join(home, "codex")

test('daemon tabs use the exact home-specific label for creation and idle reuse', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-daemon-label-'))
  const probe = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { pathToFileURL } from 'node:url'
    const root = process.argv[1]
    const staging = process.argv[2] === 'staging'
    process.env.HOME = root
    if (staging) {
      process.env.SCORPIO_HOME = path.join(root, '.scorpio-example')
      process.env.SCORPIO_SERVER = 'https://scorpio.example.com'
    } else {
      delete process.env.SCORPIO_HOME
      delete process.env.SCORPIO_SERVER
    }
    const home = staging ? process.env.SCORPIO_HOME : path.join(root, '.scorpio')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'token'), 'test')
    const { startDaemon } = await import(pathToFileURL(path.resolve('src/daemon/start.mjs')))
    const labels = ['Scorpio daemon', 'Scorpio daemon · scorpio.example.com']
    const tabs = labels.map((label, i) => ({ label, tab_id: 't' + i }))
    const panes = labels.map((_, i) => ({ pane_id: 'p' + i, tab_id: 't' + i }))
    const terminal = (available) => {
      const seen = {}
      return { seen, tabs: async () => available, panes: async () => panes,
        processInfo: async () => ({ foreground_processes: [{ argv: ['zsh'] }] }),
        workspaces: async () => [],
        newTab: async ({ label }) => { seen.label = label; return { pane: 'new' } },
        run: async (pane) => { seen.pane = pane; throw new Error('stop before polling') } }
    }
    const own = terminal(tabs)
    await startDaemon({ terminal: own })
    const other = terminal(tabs.filter((tab) => tab.label !== labels[staging ? 1 : 0]))
    await startDaemon({ terminal: other })
    const missing = terminal([])
    missing.newTab = async ({ label }) => { missing.seen.label = label; return {} }
    const error = await startDaemon({ terminal: missing })
    const failed = terminal([])
    failed.newTab = async () => { throw new Error('unavailable') }
    const failure = await startDaemon({ terminal: failed })
    console.log(JSON.stringify({ own: own.seen, other: other.seen, error, missing: missing.seen, failure }))
  `
  try {
    for (const mode of ['default', 'staging']) {
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe, root, mode], { cwd: process.cwd(), env: testEnv(root), encoding: 'utf8' }))
      const label = mode === 'default' ? 'Scorpio daemon' : 'Scorpio daemon · scorpio.example.com'
      assert.deepEqual(result.own, { pane: mode === 'default' ? 'p0' : 'p1' })
      assert.deepEqual(result.other, { label, pane: 'new' })
      assert.equal(result.missing.label, label)
      assert.equal(result.error.error, 'no_tab')
      assert.ok(result.error.next.includes('"' + label + '"'))
      assert.equal(result.failure.error, 'no_tab')
      assert.ok(result.failure.next.includes('"' + label + '"'))
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the daemon tab carries the staging update interval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-tab-env-'))
  const probe = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { pathToFileURL } from 'node:url'
    const root = process.argv[1]
    process.env.HOME = root
    process.env.SCORPIO_HOME = path.join(root, '.scorpio-staging')
    process.env.SCORPIO_UPDATE_CHECK_MS = '60000'
    fs.mkdirSync(process.env.SCORPIO_HOME, { recursive: true })
    fs.writeFileSync(path.join(process.env.SCORPIO_HOME, 'token'), 'test')
    const { startDaemon } = await import(pathToFileURL(path.resolve('src/daemon/start.mjs')))
    const seen = {}
    await startDaemon({ terminal: { tabs: async () => [], panes: async () => [], workspaces: async () => [],
      newTab: async ({ env }) => { seen.env = env; return { pane: 'new' } },
      run: async (pane, command) => { seen.command = command; throw new Error('stop before polling') } } })
    console.log(JSON.stringify(seen))
  `
  try {
    const seen = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe, root], { cwd: process.cwd(), env: testEnv(root), encoding: 'utf8' }))
    assert.equal(seen.env.SCORPIO_UPDATE_CHECK_MS, '60000')
    assert.match(seen.command, /SCORPIO_UPDATE_CHECK_MS='60000'/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const { namedRoom, renderDelivery, renderKeepalive, reminderDue, rosterChanges, rosterOf, wakeMessages, typeable, FRAME } = await import('../src/render/forward.mjs')
const { parseCommand, daemonsNamed, judge, senderOf, machineName, parseSpawn, spawnDirArg, parseTargets, freeName, seatRole, spawnLine, spawnPrompt, spawnCard, handoffPrompt, takeoverText, agoText, SPACE_FULL_LINE, COMMANDS, parseIdle, idleNotice, HELP_SHORT, HELP_FULL, parseRead, parseKeys, parseText } = await import('../src/daemon/commands.mjs')
const { agentEnv, plan, deliveryMessages, composeDelivery, injectWhenReady, humanSpokeWithin, restartDue, restartNote, RESTART_NOTE_MS, notMember, newer, idleClock, keepaliveFor, createPacer, topicLeft, updateIntervals, KEEPALIVE_MS, IDLE_GAP_MS, TICK_MS, MIN_ROUND_MS } = await import('../src/daemon/main.mjs')
const { idleHandoffMinutes, setIdleHandoffMinutes, spawnRecordPath, readJson, writeJson, CONFIG_FILE, REMOVED_FILE, ROLLBACK_FILE } = await import('../src/daemon/paths.mjs')
const { createHealth } = await import('../src/daemon/health.mjs')
const { clearRemoved, wasRemoved } = await import('../src/daemon/removed.mjs')
const { register, unregister, markLeft, entries, leftEntries, prune } = await import('../src/daemon/registry.mjs')
const { modelText, argsFor, withModel, modelOf, stoppedOnNetworkError, runsCli } = await import('../src/adapters/cli/index.mjs')
const { createHerdr, findOwnPane, shellIdle, herdrError, SHELL_READY_SECONDS, tail } = await import('../src/adapters/terminal/herdr.mjs')
const { createPending } = await import('../src/actions/attach.mjs')
const { takeLock } = await import('../src/daemon/pid.mjs')
const { createSeat, HANDOFF_MS, OWNED_ROOMS_MS, NUDGE_MAX, SPAWN_JOIN_MS, SPAWN_STALL_MS, STALL_CARD_MS, KEY_GAP_MS, DETECT_EVERY_MS, DETECT_REPORT_MS } = await import('../src/daemon/seat.mjs')
const { createApprovals } = await import('../src/daemon/approvals.mjs')
const { screenTail } = await import('../src/daemon/approval-menu.mjs')
const { DEFAULT_KEYS, createKeys, keyTable, findKey, keysFor } = await import('../src/daemon/keys.mjs')
const { DEFAULT_SPAWN, SPAWN_REFRESH_MS, SPAWN_RETRY_MS, createSpawnOptions } = await import('../src/daemon/spawn-config.mjs')
const { spawnPermission, carryPermissions, permissionNotice, SETTING_UNREADABLE } = await import('../src/daemon/spawn-permission.mjs')
const { createApi } = await import('../src/daemon/api.mjs')
const { createLinks, OPEN_MS } = await import('../src/daemon/links.mjs')
const { codexWindows, usageLine, formatIn } = await import('../src/adapters/cli/usage.mjs')
const { createDetector } = await import('../src/adapters/cli/detect.mjs')
const { buildId } = await import('../src/build-id.mjs')
const { selfUpdate } = await import('../src/daemon/update.mjs')

const ROOM = 'AbCdEf0123456789_-ghIJ'
test('staging update interval override applies to the first and later checks', () => {
  assert.deepEqual(updateIntervals({}), { first: 5 * 60_000, every: 60 * 60_000 })
  assert.deepEqual(updateIntervals({ SCORPIO_UPDATE_CHECK_MS: '60000' }), { first: 60_000, every: 60_000 })
})
const room = {
  roomId: ROOM, roomName: 'Login rework', topic: 'Ship the new login', owner: 'kai',
  members: [
    { name: 'kai', kind: 'human', status: 'active' },
    { name: 'api@kai', kind: 'agent', roleCard: 'api: backend endpoints', status: 'active' },
    { name: 'lead@kai', kind: 'agent', roleCard: 'lead: plans', status: 'active' },
    { name: 'daemon.box@kai', kind: 'host', roleCard: '…', status: 'active' },
    { name: 'old@kai', kind: 'agent', roleCard: 'gone', status: 'left' },
  ],
}
const msg = (seq, extra = {}) => ({ seq, from: 'kai', fromKind: 'human', text: `hello ${seq}`, reply: null, broadcast: false, ts: 1000 + seq, ...extra })

test('human nicknames appear consistently without changing addresses or agent names', () => {
  for (const [displayName, shown] of [[undefined, 'kai'], ['kai', 'kai'], ['Kai', 'kai (nickname: Kai)'], ['Kai|A\nB\x03', 'kai (nickname: Kai A B)']]) {
    const named = { ...room, members: room.members.map((m) => ({ ...m, displayName: m.name === 'kai' ? displayName : 'Ignored' })) }
    const text = renderDelivery({ room: named, messages: [msg(701)], name: 'api@kai', remind: 'x', terminal: true })
    assert.ok(text.includes(`#701 from ${shown} (human):`))
    assert.ok(text.includes(`created by ${shown}.`))
    assert.ok(text.includes(`| ${shown} | person, creator, your owner | — |`))
    assert.ok(text.includes('| lead@kai | agent |'))
    const changed = renderDelivery({ room: named, messages: [msg(702)], name: 'api@kai', changes: [{ type: 'card', name: 'api@kai', kind: 'agent', by: 'kai', card: 'New card' }] })
    assert.ok(changed.includes(`changed by ${shown} (person, your owner)`))
  }
  const left = { ...room, members: [{ name: 'kai', kind: 'human', displayName: 'Kai', status: 'left' }] }
  assert.ok(renderDelivery({ room: left, messages: [msg(1)], name: 'api@kai' }).includes('from kai (nickname: Kai) (human)'))
  assert.ok(renderDelivery({ room: { ...room, members: [] }, messages: [msg(1)], name: 'api@kai' }).includes('from kai (human)'))
})

test('wait shape: header, frames, mark line, again', () => {
  const text = renderDelivery({ room, messages: [msg(701, { broadcast: true }), msg(702, { from: 'lead@kai', fromKind: 'agent', reply: { seq: 699 } })], name: 'api@kai', again: `scorpio wait topicId=${ROOM}` })
  assert.match(text, /^Scorpio topic "Login rework" \(AbCdEf0123456789_-ghIJ\): 2 new messages for you\.\n\n#701 from kai \(human\), broadcast:\n/)
  assert.ok(text.includes(`${FRAME}\n│ hello 701\n${FRAME}\nThis is a broadcast`))
  assert.ok(text.includes('#702 from lead@kai (agent), reply to #699:'))
  assert.ok(text.endsWith(`Mark them read first: scorpio mark topicId=${ROOM} upTo=702\nThen do the work (if any), and run wait again: scorpio wait topicId=${ROOM}`))
})

test('terminal: control characters are never typed; role= goes into the commands', () => {
  const text = renderDelivery({ room, messages: [msg(5, { text: 'stop\x03now\r' }), msg(6, { from: 'daemon.box@kai', fromKind: 'host' })], name: 'api@kai', terminal: true, role: 'api' })
  assert.ok(typeable(text))
  assert.ok(text.includes(`Read it with: scorpio message topicId=${ROOM} role=api seq=5`))
  assert.ok(text.includes('#6 from daemon.box@kai (command seat)'))
  assert.ok(text.endsWith(`scorpio mark topicId=${ROOM} role=api upTo=6\nThen do the work (if any).`))
  // wait passes everything through
  assert.ok(renderDelivery({ room, messages: [msg(5, { text: 'a\x03b' })], name: 'api@kai' }).includes('a\x03b'))
})

test('scheduled delivery identifies its creator and due delay before attachments', () => {
  const scheduled = msg(812, { from: 'scheduled', fromKind: 'scheduled', text: '@api@kai do it',
    ts: 2_000_000, scheduled: { id: 'S1', by: 'kai', at: 1_000_000 }, files: [{ id: 'f1', name: 'data.txt', size: 5 }] })
  const text = renderDelivery({ room, messages: [scheduled], name: 'api@kai', terminal: true, role: 'api' })
  assert.match(text, /#812 from scheduled \(scheduled message\):/)
  assert.match(text, new RegExp(`Set by kai · Scheduled S1 · scorpio schedule topicId=${ROOM} role=api show=S1 · due 16 min ago\\nAttached:`))
  const veryLate = renderDelivery({ room, messages: [{ ...scheduled, ts: 1_000_000 + 130 * 60_000 }], name: 'api@kai' })
  assert.match(veryLate, /due 2 h ago/)
})

test('scheduled command takes the creator identity and still rejects another account', () => {
  const base = { from: 'scheduled', fromKind: 'scheduled', text: '@daemon.box@kai /spawn claude qa do it', ts: 1_000_000 }
  assert.deepEqual(senderOf({ ...base, scheduled: { by: 'lead@kai' } }), { from: 'lead@kai', fromKind: 'agent' })
  assert.equal(judge({ message: { ...base, scheduled: { by: 'lead@kai' } }, account: 'kai', seatName: 'daemon.box@kai', now: 1_000_001 }).act, 'run')
  assert.equal(judge({ message: { ...base, scheduled: { by: 'lead@zoe' } }, account: 'kai', seatName: 'daemon.box@kai', now: 1_000_001 }).act, 'refuse')
  assert.equal(judge({ message: { ...base, scheduled: { by: 'kai' } }, account: 'kai', seatName: 'daemon.box@kai', now: 1_000_001 }).act, 'run')
})

test('reminder: first time, then changes, then again after 20', () => {
  const roster = rosterOf(room)
  const first = reminderDue(undefined, { session: 1, roster })
  assert.equal(first.remind, 'the first message from this topic in your session')
  const text = renderDelivery({ room, messages: [msg(1)], name: 'api@kai', remind: first.remind })
  assert.ok(text.includes('Topic reminder (the first message from this topic in your session)'))
  assert.ok(text.includes('| api@kai (you) | agent | api: backend endpoints |'))
  assert.ok(text.includes('| kai | person, creator, your owner | — |'))
  assert.ok(text.includes('| daemon.box@kai | command seat | … |'))
  assert.ok(!text.includes('old@kai'))
  const room2 = { ...room, topic: 'Ship it today', members: [...room.members.slice(0, 2), { name: 'qa@kai', kind: 'agent', roleCard: 'qa', status: 'active' }] }
  const second = reminderDue(first.next, { session: 1, roster: rosterOf(room2) })
  assert.equal(second.remind, null)
  assert.deepEqual(second.changes.map((c) => c.type).sort(), ['join', 'leave', 'leave', 'topic'])
  const t2 = renderDelivery({ room: room2, messages: [msg(2)], name: 'api@kai', changes: second.changes })
  assert.ok(t2.includes('Topic changes:\n- The description changed to:'))
  assert.ok(t2.includes('- qa@kai (agent) joined; its role card (its own words):'))
  let rec = second.next
  for (let i = 0; i < 18; i += 1) rec = reminderDue(rec, { session: 1, roster: rosterOf(room2) }).next
  assert.equal(reminderDue(rec, { session: 1, roster: rosterOf(room2) }).remind, '20 deliveries since the last reminder')
  assert.equal(reminderDue(first.next, { session: 2, roster }).remind, 'the first message from this topic in your session')
})

test('a topic not read yet is unknown, not cleared: no change lines, and the kept roster stays the last real reading', () => {
  const read = reminderDue(undefined, { session: 1, roster: rosterOf(room) }).next
  // A restart or a failed read: the daemon's room has no description, members or name yet.
  const unread = reminderDue(read, { session: 1, roster: rosterOf({ roomId: ROOM }) })
  assert.equal(unread.remind, null)
  assert.deepEqual(unread.changes, [])
  assert.deepEqual(unread.next.roster, read.roster)
  // Description known, members not: no one is reported as leaving.
  assert.deepEqual(rosterChanges(read.roster, rosterOf({ ...room, members: undefined })), [])
  // The next real reading is compared with the last real one.
  const back = reminderDue(unread.next, { session: 1, roster: rosterOf({ ...room, topic: 'Ship it today' }) })
  assert.deepEqual(back.changes, [{ type: 'topic', text: 'Ship it today' }])
  // '' from the server is a real clearing.
  const cleared = reminderDue(read, { session: 1, roster: rosterOf({ ...room, topic: '' }) })
  assert.deepEqual(cleared.changes, [{ type: 'topic', text: '' }])
  assert.ok(renderDelivery({ room: { ...room, topic: '' }, messages: [msg(3)], name: 'api@kai', changes: cleared.changes }).includes('- The description was cleared'))
})

test('the first delivery after a restart, before the topic is read: no topic changes, and the last name, not the ID', () => {
  const entry = { name: 'api@kai', role: 'api', ts: 1 }
  const before = composeDelivery({ entry, room, messages: [msg(1)], reminded: undefined, pokedSeq: undefined, maxBytes: 100_000 })
  const d = composeDelivery({ entry, room: { roomId: ROOM }, messages: [msg(2)], reminded: before.next, pokedSeq: 1, maxBytes: 100_000 })
  assert.ok(!d.text.includes('Topic changes'), d.text)
  assert.ok(d.text.startsWith(`Scorpio topic "Login rework" (${ROOM}): 1 new message for you.`), d.text)
  assert.deepEqual(d.next.roster, before.next.roster)
  assert.ok(renderKeepalive(namedRoom({ roomId: ROOM }, before.next)).startsWith(`Scorpio topic "Login rework" (${ROOM}): no new messages.`))
})

test('a reminder due before the topic is read waits, and the first delivery after the read carries it', () => {
  const entry = { name: 'api@kai', role: 'api', ts: 1 }
  const early = composeDelivery({ entry, room: { roomId: ROOM }, messages: [msg(1)], reminded: undefined, pokedSeq: undefined, maxBytes: 100_000 })
  assert.equal(early.remind, null)
  assert.ok(!early.text.includes('Topic reminder') && !early.text.includes('no description'), early.text)
  const later = composeDelivery({ entry, room, messages: [msg(2)], reminded: early.next, pokedSeq: 1, maxBytes: 100_000 })
  assert.equal(later.remind, 'the first message from this topic in your session')
  assert.ok(later.text.includes('Topic reminder (the first message from this topic in your session)'))
  // Due after 20 deliveries, the same: it waits for the read and keeps its reason.
  let rec = later.next
  for (let i = 0; i < 19; i += 1) rec = reminderDue(rec, { session: 1, roster: rosterOf(room) }).next
  const held = reminderDue(rec, { session: 1, roster: rosterOf({ roomId: ROOM }) })
  assert.equal(held.remind, null)
  assert.equal(reminderDue(held.next, { session: 1, roster: rosterOf(room) }).remind, '20 deliveries since the last reminder')
})

test('agents get SCORPIO_HOME only for a home other than ~/.scorpio; SCORPIO_SERVER whenever it is set', () => {
  const home = path.join(os.homedir(), '.scorpio')
  assert.deepEqual(agentEnv({}), {})
  assert.deepEqual(agentEnv({ SCORPIO_HOME: home }), {})
  assert.deepEqual(agentEnv({ SCORPIO_HOME: `${home}/` }), {})
  assert.deepEqual(agentEnv({ SCORPIO_HOME: `${home}-staging` }), { SCORPIO_HOME: `${home}-staging` })
  assert.deepEqual(agentEnv({ SCORPIO_HOME: home, SCORPIO_SERVER: 'http://localhost:8787' }), { SCORPIO_SERVER: 'http://localhost:8787' })
})

test('attachments: one line per file under the frame, with its name and size; a deleted one says so', () => {
  const files = [
    { id: 'f1', name: 'a.png', size: 170916 },
    { id: 'f2', name: 'Q3\nreport.pdf', size: 2_400_000 },
    { id: 'f3', name: 'notes.txt', size: 12, deleted: 1791257766469 },
    { id: 'f4' },
  ]
  const text = renderDelivery({ room, messages: [msg(7, { files })], name: 'api@kai' })
  assert.ok(text.includes([
    `│ hello 7`, FRAME,
    `Attached: a.png (167 KB) · scorpio file topicId=${ROOM} id=f1`,
    `Attached: Q3 report.pdf (2.3 MB) · scorpio file topicId=${ROOM} id=f2`,
    `Attached: notes.txt (12 B), deleted`,
    `Attached: scorpio file topicId=${ROOM} id=f4`,
  ].join('\n')), text)
})

test('an attachment with its own page: the page after the command, "(shown there)" when it can be read there', () => {
  const files = [
    { id: 'f5', name: 'notes.md', size: 12_288, link: 'https://scorpio.utlabs.ai/v/f5', view: true },
    { id: 'f6', name: 'shot.png', size: 2048, link: 'https://scorpio.utlabs.ai/v/f6', view: false },
    { id: 'f7', name: 'gone.txt', size: 3, link: 'https://scorpio.utlabs.ai/v/f7', deleted: 1791257766469 },
    { id: 'f8', name: 'odd.txt', size: 3, link: 'javascript:alert(1)' },
  ]
  const text = renderDelivery({ room, messages: [msg(8, { files })], name: 'api@kai', role: 'api', terminal: true })
  assert.ok(text.includes([
    `Attached: notes.md (12 KB) · scorpio file topicId=${ROOM} role=api id=f5 · page: https://scorpio.utlabs.ai/v/f5 (shown there)`,
    `Attached: shot.png (2 KB) · scorpio file topicId=${ROOM} role=api id=f6 · page: https://scorpio.utlabs.ai/v/f6`,
    `Attached: gone.txt (3 B), deleted`,
    `Attached: odd.txt (3 B) · scorpio file topicId=${ROOM} role=api id=f8`,
  ].join('\n')), text)
})

test('TODO: the reminder lists what is under your name; /handoff asks to close delivered items and set the rest back to todo, posts the takeover unpinned', () => {
  const items = [
    { id: 'T3', title: 'Refresh-token endpoint', status: 'doing', assignee: 'api@kai', createdBy: 'api@kai', blockedBy: [], blocked: false },
    { id: 'T5', title: 'Error\nmessages', status: 'doing', assignee: 'api@kai', createdBy: 'kai', blockedBy: [], blocked: false },
    { id: 'T7', title: 'Rate limit copy', status: 'todo', assignee: 'api@kai', createdBy: 'kai', blockedBy: ['T2', 'T3'], blocked: true },
    { id: 'T9', title: 'Docs', status: 'todo', assignee: 'api@kai', createdBy: 'api@kai', blockedBy: [], blocked: false },
    { id: 'T8', title: 'Not mine', status: 'doing', assignee: 'lead@kai', createdBy: 'kai', blockedBy: [], blocked: false },
  ]
  const text = renderDelivery({ room: { ...room, items }, messages: [msg(1)], name: 'api@kai', remind: 'x' })
  assert.ok(text.includes('In progress under your name: T3 Refresh-token endpoint; T5 Error messages\nAssigned to you, not started: T7 Rate limit copy (by kai; waits for T3 to be delivered); T9 Docs'), text)
  assert.ok(!text.includes('Not mine'))
  const h = handoffPrompt({ account: 'kai', roomId: ROOM, roomName: 'x', seq: 7, targets: 'api', file: '/f.md', daemonName: 'daemon@kai', kind: 'claude', name: 'api@kai', dir: '/w', items: items.slice(0, 2) })
  assert.ok(h.includes(`0. Your tasks: T3 Refresh-token endpoint (doing); T5 Error messages (doing). Close each one whose result is delivered (already live, sent, or written where it was asked for): scorpio task topicId=${ROOM} role=api done=<id>. Set every other one to todo: scorpio task topicId=${ROOM} role=api edit=<id> status=todo (add to=<name> when someone else goes on with it; your takeover keeps your name).`), h)
  const h2 = handoffPrompt({ account: 'kai', roomId: ROOM, roomName: 'x', seq: 7, targets: 'api', file: '/f.md', daemonName: 'daemon@kai', kind: 'claude', name: 'api@kai', dir: '/w', items: items.slice(2, 4) })
  assert.ok(h2.includes('0. Your tasks: T7 Rate limit copy; T9 Docs. Close each one'), 'a todo item is listed without (doing)')
  assert.ok(h.includes('5. Post the takeover command: a line that explains'))
  assert.ok(h.includes('Never push to a branch that deploys, releases or publishes on push'), 'no push-triggered release')
  assert.ok(!/\bpin\b/.test(h), 'nothing pinned any more')
})

test('a person replying to a message carrying their item: the message author closes it, even when another agent created the item', () => {
  const items = [
    { id: 'T6', title: 'Passcode\nwording', status: 'todo', assignee: 'kai', createdBy: 'lead@kai', reply: { seq: 12, from: 'kai', ts: 1, closer: 'api@kai' } },
    { id: 'T4', title: 'Logo', status: 'todo', assignee: 'kai', createdBy: 'lead@kai', reply: { seq: 11, from: 'kai', ts: 1, closer: 'lead@kai' } },
    { id: 'T2', title: 'Old', status: 'done', assignee: 'kai', createdBy: 'api@kai', reply: { seq: 9, from: 'kai', ts: 1 } },
    { id: 'T1', title: 'Not answered', status: 'todo', assignee: 'kai', createdBy: 'api@kai', reply: null },
  ]
  const reply = (seq, t) => msg(seq, { reply: { seq: 10 }, todo: [{ id: t.id, title: t.title, assignee: 'kai', status: t.status, round: 1, rel: 'reply', closer: t.reply?.closer }, { id: 'T1', title: 'x', status: 'todo', rel: 'source' }] })
  const text = renderDelivery({ room: { ...room, items }, messages: [reply(12, items[0]), reply(13, items[1]), reply(14, items[2])], name: 'api@kai', role: 'api', terminal: true, remind: 'x' })
  assert.ok(text.includes(`hello 12\n${FRAME}\nRelated tasks: T6 Passcode wording (yours).`), text)
  assert.ok(text.includes(`hello 13\n${FRAME}\nRelated tasks: T4 Logo (lead@kai closes it).`), text)
  assert.ok(text.includes(`hello 14\n${FRAME}\nRelated tasks: T2 Old (done already).`), text)
  assert.ok(!text.includes('Related tasks: T1'))
  assert.ok(text.includes("\nReplies waiting for you: T6 Passcode wording (under kai's name; kai replied in #12 — close it, or update it to your next message)\n"), text)
  const creatorText = renderDelivery({ room: { ...room, items }, messages: [reply(12, items[0])], name: 'lead@kai' })
  assert.ok(creatorText.includes('Related tasks: T6 Passcode wording (api@kai closes it).'), creatorText)
  assert.ok(!creatorText.includes('Replies waiting for you: T6'), creatorText)
  // Items not known (wait before the room's TODO came): the carried reply names its closer.
  assert.match(renderDelivery({ room, messages: [reply(12, items[0])], name: 'api@kai' }), /Related tasks: T6 Passcode wording \(yours\)\./)
})

test('reply tasks share one line, with the same closer and done rules', () => {
  const long = 'a'.repeat(41)
  const tasks = [
    { id: 'T6', title: long, status: 'todo', rel: 'reply', closer: 'api@kai' },
    { id: 'T7', title: 'Second', status: 'todo', rel: 'reply', closer: 'api@kai' },
  ]
  const message = msg(12, { todo: tasks })
  const line = renderDelivery({ room, messages: [message], name: 'api@kai' }).split('\n').find((s) => s.startsWith('Related tasks:'))
  assert.equal(line, `Related tasks: T6 ${'a'.repeat(40)}… (yours), T7 Second (yours).`)
  assert.equal(line.split('Related tasks:').length, 2)
  const mixed = renderDelivery({ room, messages: [{ ...message, todo: [tasks[0], { ...tasks[1], closer: 'lead@kai' }] }], name: 'api@kai' })
  assert.match(mixed, /T6 a+… \(yours\), T7 Second \(lead@kai closes it\)\./)
  const done = renderDelivery({ room, messages: [{ ...message, todo: tasks.map((t) => ({ ...t, status: 'done' })) }], name: 'api@kai' })
  assert.match(done, /Related tasks: T6 a+… \(done already\), T7 Second \(done already\)\./)
  assert.ok(!done.includes('For yours:'))
})

test('keep-alive text', () => {
  assert.equal(renderKeepalive(room), 'Scorpio topic "Login rework" (AbCdEf0123456789_-ghIJ): no new messages. Nothing new to do; carry on with what you were doing. No reply needed.')
})

test('wakeMessages merges, flags broadcasts, sorts', () => {
  assert.deepEqual(wakeMessages({ mentions: [msg(3)], broadcasts: [msg(2)] }).map((m) => [m.seq, m.broadcast]), [[2, true], [3, false]])
})

test('parseCommand: only prose @names before it; fenced examples do not run', () => {
  assert.deepEqual(parseCommand('@daemon.box@kai /spawn claude api /w do it'), { name: 'spawn', rest: 'claude api /w do it' })
  assert.equal(parseCommand('```\n@daemon.box@kai /bye api\n```'), null)
  assert.equal(parseCommand('@kai takeover command for api; copy:\n```\n@daemon.box@kai /spawn claude api /w\n```'), null)
  assert.equal(parseCommand('please /bye api'), null)
})

test('judge', () => {
  const base = { account: 'kai', seatName: 'daemon.box@kai', now: 10 * 60_000 + 5000 }
  const m = (from, fromKind, text, ts = 10 * 60_000) => ({ seq: 9, from, fromKind, text, ts })
  assert.equal(judge({ ...base, message: m('kai', 'human', '@daemon.box@kai /bye api') }).act, 'run')
  assert.equal(judge({ ...base, message: m('lead@kai', 'agent', '@daemon.box@kai /handoff api') }).act, 'run')
  assert.equal(judge({ ...base, message: m('lead@kai', 'agent', '@daemon.box@kai thanks') }).act, 'ignore')
  assert.equal(judge({ ...base, message: m('daemon.mac@kai', 'host', '@daemon.box@kai /bye api') }).act, 'ignore')
  assert.equal(judge({ ...base, message: m('zoe', 'human', '@daemon.box@kai /bye api') }).act, 'refuse')
  assert.equal(judge({ ...base, message: m('kai', 'human', '@daemon.box@kai hi') }).act, 'help')
  assert.equal(judge({ ...base, message: m('kai', 'human', '@daemon.box@kai /frob') }).act, 'help')
  assert.equal(judge({ ...base, message: m('kai', 'human', '@daemon.box@kai /bye api', 0) }).act, 'stale')
  assert.equal(judge({ ...base, message: m('kai', 'human', '@daemon.box@kai /help', 0) }).act, 'run')
  assert.equal(judge({ ...base, message: { ...m('kai', 'human', '@daemon.box@kai @daemon.mac@kai /spawn claude /w'), mentions: ['daemon.box@kai', 'daemon.mac@kai'] } }).act, 'refuse')
  assert.equal(judge({ ...base, message: { ...m('kai', 'human', '@daemon@kai @daemon-2@kai /spawn claude /w'), mentions: ['daemon@kai', 'daemon-2@kai'] } }).act, 'refuse')
  const codeMention = { ...m('kai', 'human', '@daemon@kai /spawn claude api /w `@daemon-2@kai`'), mentions: ['daemon@kai'] }
  assert.deepEqual(daemonsNamed(codeMention), ['daemon@kai'])
  assert.equal(judge({ ...base, message: codeMention }).act, 'run')
  assert.equal(judge({ ...base, message: m('daemon-2@kai', 'agent', '@daemon.box@kai /bye api') }).act, 'run', 'fromKind identifies an old agent seat')
})

test('machine names normalize and truncate; a legacy agent ending in -daemon is not a host when members are known', () => {
  assert.equal(machineName('My__Very_Long.Host.local'), 'my--very-long')
  assert.equal(machineName('abcdefghijklmnopqrstuvwxyz.local'), 'abcdefghijklmnopqrstuvwx')
  const members = [{ name: 'pane-daemon@kai', kind: 'agent' }, { name: 'box-daemon@kai', kind: 'host' }]
  assert.deepEqual(daemonsNamed({ mentions: members.map((m) => m.name) }, members), ['box-daemon@kai'])
})

test('parseSpawn', () => {
  assert.deepEqual(parseSpawn('claude api /srv/app read the handover'), { kind: 'claude', name: 'api', dir: '/srv/app', model: null, effort: null, prompt: 'read the handover' })
  assert.deepEqual(parseSpawn('codex ～/w，压一遍'), { kind: 'codex', name: null, dir: '~/w', model: null, effort: null, prompt: '压一遍' })
  assert.deepEqual(parseSpawn('claude api /srv effort=max model=claude-fable-5-1 go on'), { kind: 'claude', name: 'api', dir: '/srv', model: 'claude-fable-5-1', effort: 'max', prompt: 'go on' })
  assert.deepEqual(parseSpawn('claude api cwd="/srv/My Project" model=claude-fable-5-1 go on'), { kind: 'claude', name: 'api', dir: '/srv/My Project', model: 'claude-fable-5-1', effort: null, prompt: 'go on' })
  assert.deepEqual(parseSpawn('codex qa effort=xhigh model=gpt-6-sol go on'), { kind: 'codex', name: 'qa', needDir: true, model: 'gpt-6-sol', effort: 'xhigh', prompt: 'go on' })
  assert.equal(spawnDirArg('/srv/My Project'), 'cwd="/srv/My Project"')
  assert.match(parseSpawn('claude api /srv model= go').error, /model= needs a value/)
  assert.equal(parseSpawn('claude api do it').needDir, true)
  assert.match(parseSpawn('gpt api /w').error, /starts with claude or codex/)
  assert.match(parseSpawn('claude API /w').error, /Can't use the name "API"/)
  assert.equal(freeName('claude', ['claude-1@kai', 'kai']), 'claude-2')
  assert.deepEqual(parseTargets('@api lead@kai, api', 'kai'), { all: false, names: ['api@kai', 'lead@kai'] })
  assert.equal(parseTargets('all', 'kai').all, true)
  assert.equal(seatRole('Kais-MacBook-Pro.local'), 'daemon.kais-macbook-pro')
})

test('spawnLine is one typeable line; handoff prompt keeps the explanation line', () => {
  const line = spawnLine({ by: 'kai', roomName: 'A\nB', name: 'api@kai', file: '/h/.scorpio/spawns/R/api.md', prompt: 'do\nthis', handoff: { file: '/h.md' } })
  assert.equal(line, 'kai brought you into the Scorpio topic "A B" as api@kai. Their instruction: "do this". First read all of /h/.scorpio/spawns/R/api.md: how to join, and which handoff to read next (it says where things stood; their instruction says what to do now).')
  assert.ok(!/[\n\t]/.test(line))
  assert.ok(typeable(line))
  assert.equal(spawnLine({ by: 'kai', roomName: 'x', name: 'api@kai', file: '/f', prompt: 'start' }), 'kai brought you into the Scorpio topic "x" as api@kai. Their instruction: "start". First read all of /f: how to join.')
  assert.equal(spawnLine({ by: 'kai', roomName: 'x', name: 'api@kai', file: '/f' }), 'kai brought you into the Scorpio topic "x" as api@kai, with no instruction this time. Read all of /f and do what it says.')
  assert.equal(spawnLine({ by: 'kai', roomName: 'x', name: 'api@kai', file: '/f', prompt: 'x'.repeat(601) }), `kai brought you into the Scorpio topic "x" as api@kai. Their instruction begins: "${'x'.repeat(600)}…" (all of it is in the file). First read all of /f: how to join.`)
  assert.match(spawnPrompt({ account: 'kai', roomId: ROOM, roomName: 'x', seq: 7, name: 'api@kai', pane: 'w:p9', cli: 'scorpio' }), /join topicId=AbCdEf0123456789_-ghIJ role=api resume=true pane=w:p9/)
  const h = handoffPrompt({ account: 'kai', roomId: ROOM, roomName: 'x', seq: 7, targets: 'api', file: '/f.md', daemonName: 'daemon.box@kai', kind: 'claude', name: 'api@kai', dir: '/w' })
  assert.ok(h.includes('@kai takeover command for api; to take over, copy the line below and send it:'))
  assert.ok(h.includes('@daemon.box@kai /spawn claude api /w perm=ask <what to do next>'))
  const h2 = handoffPrompt({ account: 'kai', roomId: ROOM, roomName: 'x', seq: 7, targets: 'api', file: '/f.md', daemonName: 'daemon.box@kai', kind: 'claude', name: 'api@kai', dir: '/w', model: 'claude-opus-5-5', effort: 'xhigh' })
  assert.ok(h2.includes('/spawn claude api /w model=claude-opus-5-5 effort=xhigh perm=ask <what to do next>'))
  for (const heading of ['## Where things stand', '## Next', '## Lessons and gotchas', '## Your work']) assert.ok(h.includes(heading))
  assert.ok(h.includes('Never push to a branch that deploys, releases or publishes on push'))
  assert.ok(!h.includes('Read /f.md'))
  assert.equal(parseCommand(h.split('\n').slice(4, 8).map((l) => l.trim()).join('\n')), null)
})

test('spawnPrompt: a new name joins with the generic role card, a takeover without one', () => {
  const base = { account: 'kai', by: 'lead@kai', roomId: ROOM, roomName: 'x', seq: 7, name: 'api@kai', pane: 'w:p9', cli: 'scorpio' }
  assert.ok(spawnPrompt(base).includes(`join topicId=AbCdEf0123456789_-ghIJ role=api resume=true pane=w:p9 roleCard='api: started by lead@kai with /spawn; takes work from lead@kai'`))
  const kept = spawnPrompt({ ...base, keepCard: true })
  assert.match(kept, /^ {3}scorpio join topicId=AbCdEf0123456789_-ghIJ role=api resume=true pane=w:p9$/m)
  assert.ok(!/join .*roleCard=/.test(kept))
  assert.ok(kept.includes("api@kai's open tasks and role card are yours now"))
  assert.equal(spawnCard('api', 'kai'), 'api: started by kai with /spawn; takes work from kai')
})

test('spawnPrompt full text: takeover with and without a handoff, handoff=skip, new name, no instruction', () => {
  const base = { account: 'kai', roomId: ROOM, roomName: 'x', seq: 7, name: 'api@kai', pane: 'w:p9', prompt: 'Do new work.' }
  const intro = '# You are api@kai in the Scorpio topic "x"\n\nkai (person) sent /spawn (#7) in the Scorpio topic "x" (topic AbCdEf0123456789_-ghIJ) to bring you in. You report to kai and take your work from kai.'
  const instruction = "## kai's instruction: what you are here to do\n\nDo new work.\n\nThis is the latest word from kai, so it decides what you do now. The handoff below is what the previous session knew, and kai may have moved on since: where its plans or next steps differ, follow the instruction. Rules are different: the ones on your role card and in your handoff (each with the message that set it) still hold unless the instruction names the rule and lifts it. If part of the instruction seems to break one, ask kai about that part (a task, as at the end of this file), leave that part until they answer, and go on with the rest."
  const join = '1. Join (run it as is; no passcode needed; if it fails, stop and leave the error on screen: the daemon shows it to kai; do not retry under another name):'
  const keptJoin = '   scorpio join topicId=AbCdEf0123456789_-ghIJ role=api resume=true pane=w:p9\n   Its answer has the topic\'s description, your role card and your tasks. If your work is now different, rewrite the card (scorpio roleCard), keeping the rules on it.'
  const newJoin = "   scorpio join topicId=AbCdEf0123456789_-ghIJ role=api resume=true pane=w:p9 roleCard='api: started by kai with /spawn; takes work from kai'\n   Its answer has the topic's description, your role card and your tasks. Then rewrite the card in your own words (scorpio roleCard), as the skill says."
  const ending = "Nobody sits at your terminal. When a person has to decide something, give them a task with the question (scorpio send topicId=AbCdEf0123456789_-ghIJ role=api text='@kai …' add='<what to decide>' to=kai) and leave that decision until they answer; never ask in the terminal. Messages for you appear in this session by themselves (this computer's Scorpio daemon types them in), so do not run `scorpio wait`. Everything else: the scorpio skill."
  const steps = (joinLine, next, report, act) => `## Steps\n\n${join}\n${joinLine}\n${next ? `${next}\n` : ''}${next ? '3' : '2'}. Report in: scorpio send topicId=AbCdEf0123456789_-ghIJ role=api replyTo=7 text='@kai …': ${report}\n${next ? '4' : '3'}. ${act}`
  const seat = '## You are taking over\n\nThe same name in a topic is the same seat, so api@kai\'s open tasks and role card are yours now.'
  const cloud = { source: 'cloud', file: '/c.md', ago: '3 h ago', computer: 'box' }
  const doIt = 'Do the instruction; you need not wait for a reply to your report.'
  const wait = 'Wait for kai; their messages appear here by themselves.'
  const reportWithHandoff = 'in a line or two, what you take the instruction to mean, what you do first, and anything in the handoff that disagrees with the instruction.'
  const reportInstruction = 'in a line or two, what you take the instruction to mean and what you do first.'
  const noInstruction = "## kai's instruction: none this time\n\nRead your handoff, report in with what it says comes next, and wait for kai to say what to do (their messages appear here by themselves)."
  const noInstructionNoHandoff = "## kai's instruction: none this time\n\nReport in with where your tasks and the topic's recent messages say it stopped, and wait for kai to say what to do (their messages appear here by themselves)."
  const cloudSeat = `${seat} The daemon told the topic: "taking over api: its tasks, role card and handoff (from the cloud, stored 3 h ago on box) go with it." Its handoff: /c.md (stored 3 h ago).`
  const noneSeat = `${seat} The daemon told the topic: "taking over api: its tasks and role card go with it; it left no handoff, in the cloud or on this computer." Your tasks and the topic's recent messages show where it stopped.`
  assert.equal(spawnPrompt({ ...base, keepCard: true, handoff: cloud }), [intro, instruction, `${cloudSeat} Read it before you report in: it tells you where things stood; the instruction above tells you what to do now.`, steps(keptJoin, '2. Read the handoff above.', reportWithHandoff, doIt), ending].join('\n\n'))
  const instructionNoHandoff = "## kai's instruction: what you are here to do\n\nDo new work.\n\nThis is the latest word from kai, so it decides what you do now. Rules are different: the ones on your role card (each with the message that set it) still hold unless the instruction names the rule and lifts it. If part of the instruction seems to break one, ask kai about that part (a task, as at the end of this file), leave that part until they answer, and go on with the rest."
  assert.equal(spawnPrompt({ ...base, keepCard: true, handoff: { source: 'none' } }), [intro, instructionNoHandoff, noneSeat, steps(keptJoin, '2. Read the last messages in the topic and your tasks.', reportInstruction, doIt), ending].join('\n\n'))
  assert.equal(spawnPrompt({ ...base, keepCard: true }), spawnPrompt({ ...base, keepCard: true, handoff: { source: 'none' } }), 'no source said: none')
  assert.equal(spawnPrompt(base), [intro, instruction, steps(newJoin, null, reportInstruction, doIt), ending].join('\n\n'))
  assert.equal(spawnPrompt({ ...base, prompt: null, keepCard: true, handoff: cloud }), [intro, noInstruction, `${cloudSeat} Read it before you report in: it tells you where things stood; kai will tell you what to do now.`, steps(keptJoin, '2. Read the handoff above.', 'in a line or two, what the handoff says comes next.', wait), ending].join('\n\n'))
  assert.equal(spawnPrompt({ ...base, prompt: null, keepCard: true, handoff: { source: 'none' } }), [intro, noInstructionNoHandoff, noneSeat, steps(keptJoin, '2. Read the last messages in the topic and your tasks.', 'in a line or two, where your tasks and the recent messages say it stopped.', wait), ending].join('\n\n'))
  assert.equal(spawnPrompt({ ...base, prompt: null }), [intro, "## kai's instruction: none this time\n\nReport in and wait for kai.", steps(newJoin, null, 'say you have joined and are waiting for their instruction.', wait), ending].join('\n\n'))

  // handoff=skip: not a word about a handoff anywhere, with or without an instruction.
  const skipped = spawnPrompt({ ...base, keepCard: true, handoff: { source: 'skipped' } })
  assert.equal(skipped, [intro, instructionNoHandoff, `${seat} Your tasks and the topic's recent messages show where it stopped.`, steps(keptJoin, '2. Read the last messages in the topic and your tasks.', reportInstruction, doIt), ending].join('\n\n'))
  assert.ok(!/hand ?(off|over)/i.test(skipped), skipped)
  assert.ok(!/hand ?(off|over)/i.test(spawnPrompt({ ...base, prompt: null, keepCard: true, handoff: { source: 'skipped' } })))
})

test('the six sources of a takeover\'s handoff, and the words for each', () => {
  const at = { ago: '3 h ago' }
  assert.equal(takeoverText('arch', { source: 'cloud', ...at, computer: 'box' }), 'taking over arch: its tasks, role card and handoff (from the cloud, stored 3 h ago on box) go with it')
  assert.equal(takeoverText('arch', { source: 'cloud', ...at, computer: null }), 'taking over arch: its tasks, role card and handoff (from the cloud, stored 3 h ago) go with it')
  assert.equal(takeoverText('arch', { source: 'local', ...at }), "taking over arch: its tasks, role card and handoff (this computer's copy, written 3 h ago) go with it")
  assert.equal(takeoverText('arch', { source: 'local_cloud_failed', ...at, reason: 'network' }), "taking over arch: its tasks and role card go with it. The cloud handoff could not be fetched (network), so it gets this computer's copy (written 3 h ago)")
  assert.equal(takeoverText('arch', { source: 'none_cloud_failed', reason: 'timeout' }), "taking over arch: its tasks and role card go with it. The cloud handoff could not be fetched (timeout) and there is none on this computer, so it starts without one; the topic's messages show where it stopped")
  assert.equal(takeoverText('arch', { source: 'none' }), 'taking over arch: its tasks and role card go with it; it left no handoff, in the cloud or on this computer')
  assert.equal(takeoverText('arch', { source: 'skipped' }), 'taking over arch: its tasks and role card go with it; handoff=skip, so its handoff was not read')
  assert.ok(!takeoverText('arch', { source: 'local', ...at }).includes('not uploaded'), 'neutral: keeping handoffs local is a setting, not a failure')
  // Relative times only, no clock or zone: under an hour N min, under two days N h, then N d.
  const M = 60_000, H = 60 * M
  assert.deepEqual([0, 30_000, 59 * M, 60 * M, 47 * H + 59 * M, 48 * H, 30 * 24 * H, -5_000].map(agoText),
    ['1 min ago', '1 min ago', '59 min ago', '1 h ago', '47 h ago', '2 d ago', '30 d ago', '1 min ago'])
})

test('findOwnPane uses spawn mapping, live Herdr context, then an exact process ancestor', () => {
  const panes = [{ pane_id: 'w:p1', tab_id: 'w:t1', workspace_id: 'w', agent: 'codex' }, { pane_id: 'w:p2', tab_id: 'w:t2', workspace_id: 'w', agent: 'codex' }]
  const exec = (bin, args) => {
    if (args[1] === 'list') return JSON.stringify({ result: { panes } })
    if (args[1] === 'current') return JSON.stringify({ result: { pane: panes[0] } })
    if (args[1] === 'process-info') return JSON.stringify({ result: { process_info: { shell_pid: args.at(-1) === 'w:p2' ? 700 : 400, foreground_processes: [] } } })
    if (bin === 'ps') return args.at(-1) === '900' ? '700' : '1'
    throw Error('unexpected command')
  }
  const opts = { pid: 900, bin: 'herdr', exec, env: {} }
  assert.deepEqual(findOwnPane({ ...opts, spawnPane: 'w:p2' }), { pane: 'w:p2', via: 'spawn' })
  assert.deepEqual(findOwnPane({ ...opts, spawnPane: 'w:p2', explicitPane: 'w:p1' }), { reason: 'pane-mismatch' })
  assert.deepEqual(findOwnPane({ ...opts, explicitPane: 'w:p1' }), { pane: 'w:p1', via: 'explicit' })
  assert.deepEqual(findOwnPane({ ...opts, env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p1', HERDR_TAB_ID: 'w:t1', HERDR_WORKSPACE_ID: 'w' } }), { pane: 'w:p1', via: 'environment' })
  assert.deepEqual(findOwnPane(opts), { pane: 'w:p2', via: 'ancestry' })
  const remote = { ...opts, pid: 901, env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p1', HERDR_TAB_ID: 'w:t1', HERDR_WORKSPACE_ID: 'w', TMUX: '/tmp/tmux' } }
  assert.deepEqual(findOwnPane(remote), { reason: 'detached' })
  assert.deepEqual(findOwnPane({ ...remote, env: { ...remote.env, TMUX: '', HERDR_TAB_ID: 'old' } }), { reason: 'detached' })
})

test('plan and resend window', () => {
  const now = 1_000_000
  assert.equal(plan({ messages: [msg(5)], now }).act, 'message')
  assert.equal(plan({ messages: [msg(5)], pokedSeq: 5, pokedTs: now - 1000, now }).act, 'none')
  assert.equal(plan({ messages: [msg(5)], pokedSeq: 5, pokedTs: now - 6 * 60_000, now }).act, 'message')
  assert.equal(plan({ messages: [], quietSince: now - 51 * 60_000, kind: 'claude', now }).act, 'keepalive')
  assert.equal(plan({ messages: [], quietSince: now - 51 * 60_000, kind: 'codex', now }).act, 'skip')
  assert.equal(plan({ messages: [], quietSince: now - 51 * 60_000, kind: 'claude', status: 'working', now }).act, 'skip')
  assert.equal(plan({ messages: [], quietSince: now - 10 * 60_000, kind: 'claude', now }).act, 'none')
  assert.deepEqual(deliveryMessages([msg(4), msg(5)], 4, now - 1000, now).map((m) => m.seq), [5])
  assert.deepEqual(deliveryMessages([msg(4), msg(5)], 4, now - 6 * 60_000, now).map((m) => m.seq), [4, 5])
  // resent once at most: after a resend up to 5, only newer ones go
  assert.deepEqual(deliveryMessages([msg(4), msg(5), msg(6)], 5, now - 6 * 60_000, now, 5 * 60_000, 5).map((m) => m.seq), [6])
  assert.equal(plan({ messages: [msg(4), msg(5)], pokedSeq: 5, pokedTs: now - 6 * 60_000, resentSeq: 5, now }).act, 'none')
  assert.equal(humanSpokeWithin([msg(3, { ts: 50 }), msg(4, { fromKind: 'agent', ts: 200 })], 100), false)
  assert.equal(humanSpokeWithin([msg(3, { ts: 150 })], 100), true)
  assert.equal(humanSpokeWithin([msg(3, { fromKind: 'agent', ts: 150 })], 100), null)
})

test('composeDelivery cuts to fit; a resend carries no reminder and does not count', () => {
  const entry = { name: 'api@kai', role: 'api', ts: 1 }
  const big = [msg(1, { text: 'x'.repeat(3000) }), msg(2, { text: 'y'.repeat(3000) }), msg(3, { text: 'z'.repeat(3000) })]
  const d = composeDelivery({ entry, room, messages: big, reminded: undefined, pokedSeq: undefined, maxBytes: 8500 })
  assert.equal(d.upTo, 2)
  assert.ok(d.text.includes('upTo=2'))
  assert.ok(d.remind)
  const again = composeDelivery({ entry, room, messages: big.slice(0, 1), reminded: d.next, pokedSeq: 2, maxBytes: 100_000 })
  assert.equal(again.remind, null)
  assert.deepEqual(again.changes, [])
  assert.deepEqual(again.next, d.next)
  assert.equal(again.text, `Still unmarked: #1. After reading, scorpio mark topicId=${ROOM} role=api upTo=1`)
  const mixed = composeDelivery({ entry, room, messages: big.slice(0, 2), reminded: d.next, pokedSeq: 1, maxBytes: 100_000 })
  assert.match(mixed.text, new RegExp(`^Still unmarked: #1\\. After reading, scorpio mark topicId=${ROOM} role=api upTo=1\\n\\nScorpio topic`))
  assert.ok(!mixed.text.includes('x'.repeat(3000)))
  assert.ok(mixed.text.includes('y'.repeat(3000)), 'a newer message is still delivered in full')
  assert.equal(mixed.upTo, 2)
})

test('restart waits for a settled change and an idle seat; versions', () => {
  assert.deepEqual(restartDue({ started: 'a', pending: null, current: 'a', idle: true }), { exit: false, pending: null })
  assert.deepEqual(restartDue({ started: 'a', pending: null, current: 'b', idle: true }), { exit: false, pending: 'b' })
  assert.deepEqual(restartDue({ started: 'a', pending: 'b', current: 'b', idle: false }), { exit: false, pending: 'b' })
  assert.deepEqual(restartDue({ started: 'a', pending: 'b', current: 'b', idle: true }), { exit: true, pending: 'b' })
  // New code waiting long for an idle moment says what holds it, once an hour.
  const since = 1_000_000
  assert.equal(restartNote({ waitingSince: null, notedAt: null, now: since + 99 * RESTART_NOTE_MS, holders: [] }), null)
  assert.equal(restartNote({ waitingSince: since, notedAt: null, now: since + RESTART_NOTE_MS - 1, holders: ['x'] }), null)
  assert.match(restartNote({ waitingSince: since, notedAt: null, now: since + RESTART_NOTE_MS, holders: ['1 CLI request(s) through the relay', '/spawn qa joining'] }),
    /^New code is on disk since \d\d:\d\d; the daemon restarts on it once nothing is half done\. Waiting for: 1 CLI request\(s\) through the relay; \/spawn qa joining\.$/)
  const noted = since + RESTART_NOTE_MS
  assert.equal(restartNote({ waitingSince: since, notedAt: noted, now: noted + 59 * 60_000, holders: ['x'] }), null)
  assert.ok(restartNote({ waitingSince: since, notedAt: noted, now: noted + 60 * 60_000, holders: ['x'] }))
  assert.equal(newer('0.3.0', '0.2.9'), true)
  assert.equal(newer('0.2.0', '0.2.0'), false)
})

test('pace: a round every 5 s; a kick wakes it, never sooner than 1 s after the last round started; a kick mid-round counts', async () => {
  let t = 0
  const timers = new Map()
  let id = 0
  const pacer = createPacer({
    now: () => t,
    setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, at: t + ms }); return id },
    clearTimer: (x) => timers.delete(x),
  })
  // Runs the timers due by `to`, in order; resolves what was woken.
  const run = async (to) => {
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); t = due[1].at; due[1].fn()
      await Promise.resolve()
    }
    t = to
    await new Promise((r) => setImmediate(r))
  }
  const napOf = () => { let woke = null; pacer.nap().then(() => { woke = t }); return () => woke }

  pacer.round()
  let woke = napOf()
  await run(TICK_MS - 1)
  assert.equal(woke(), null)
  await run(TICK_MS)
  assert.equal(woke(), TICK_MS, 'no kick: the full nap')

  pacer.round() // t = 5000
  woke = napOf()
  await run(5200)
  pacer.kick()
  await run(5200)
  assert.equal(woke(), null, 'kicked 200 ms after the round started: not yet')
  await run(5000 + MIN_ROUND_MS)
  assert.equal(woke(), 5000 + MIN_ROUND_MS, 'woken 1 s after the round started')
  assert.equal(timers.size, 0, 'the 5 s timer is gone with it')

  pacer.round() // t = 6000
  woke = napOf()
  await run(9000)
  pacer.kick(); pacer.kick(); pacer.kick()
  await run(9000)
  assert.equal(woke(), 9000, 'kicked 3 s into the nap: at once')

  pacer.round() // t = 9000
  pacer.kick() // something pushed while the round runs
  woke = napOf()
  await run(9000 + MIN_ROUND_MS)
  assert.equal(woke(), 9000 + MIN_ROUND_MS, 'a kick during the round shortens the nap after it')

  // A kick after every round (what the seat's finished job once did) is at most one round a second.
  let rounds = 0
  const start = t
  for (; t < start + 10_000;) { pacer.round(); rounds += 1; const w = napOf(); await Promise.resolve(); pacer.kick(); while (w() === null) await run(Math.min(...[...timers.values()].map((x) => x.at))) }
  assert.ok(rounds <= 10, `${rounds} rounds in 10 s`)
})

test('registry: register, pane-guarded unregister, prune', () => {
  register({ roomId: ROOM, name: 'api@kai', role: 'api', pane: 'w:p1' })
  register({ roomId: ROOM, name: 'qa@kai', role: 'qa', pane: 'w:p2' })
  assert.equal(entries().length, 2)
  assert.equal(unregister({ roomId: ROOM, name: 'api@kai', pane: 'w:p9' }), false)
  assert.deepEqual(prune(['w:p1']).map((d) => d.name), ['qa@kai'])
  assert.equal(markLeft({ roomId: ROOM, name: 'api@kai' }), true)
  assert.deepEqual(entries(), [])
  assert.equal(leftEntries()[0]?.pane, 'w:p1')
  assert.equal(unregister({ roomId: ROOM, name: 'api@kai' }), true)
  assert.deepEqual(leftEntries(), [])
})

test('CLI adapters: model and effort in the arguments', () => {
  assert.equal(modelText('claude', argsFor('claude', {})), 'claude-opus-5-5, effort medium')
  assert.equal(modelText('codex', argsFor('codex', {})), 'gpt-6.1-sol, reasoning medium')
  assert.deepEqual(argsFor('claude', { spawn: { claude: ['--model', 'x'] } }), ['--model', 'x', '--settings', path.join(home, 'state', 'hooks', 'claude.json')])
  assert.deepEqual(withModel('claude', ['--model', 'a', '--effort', 'high'], { effort: 'max' }), ['--model', 'a', '--effort', 'max'])
  assert.deepEqual(withModel('codex', ['-m', 'a', '-c', 'model_reasoning_effort=high'], { model: 'b', effort: 'low' }), ['-m', 'b', '-c', 'model_reasoning_effort=low'])
  assert.deepEqual(modelOf('claude', ['--dangerously-skip-permissions', '--model', 'claude-opus-5-5', '--effort', 'xhigh', 'hi']), { model: 'claude-opus-5-5', effort: 'xhigh' })
})

// Claude Code in a narrow herdr pane after its ten retries failed (read off a real pane).
const BOX = '────────────────────────────\n❯\n────────────────────────────\n  Model: Opus 5.5 | ⎇ dae…\n  Session: 23.0% | Reset:…\n  ⏵⏵ bypass permissions on'
const DROPPED = `  Ran 3 shell commands\n\n● API Error:\n  Connection dropped\n  (ECONNRESET)\n\n✻ Cooked for 17m 49s · done\n  12:05 PM\n\n${BOX}`

test('stopped on a network API error: the last block above the input box only', () => {
  assert.equal(stoppedOnNetworkError('claude', DROPPED), true)
  // On its first prompt, the error under the prompt.
  assert.equal(stoppedOnNetworkError('claude', `❯ kai (person) brought you into the\n  Scorpio topic "Login rework" as api@kai.\n  ⎿  API Error: Connection error.\n\n${BOX}`), true)
  assert.equal(stoppedOnNetworkError('claude', `❯ read the file\n  ⎿  API Error: Request timed out.\n\n${BOX}`), true)
  // Still retrying, or told to carry on and working again: the error is not the last block.
  assert.equal(stoppedOnNetworkError('claude', `❯ read the file\n\n✻ Connect · Retrying in 0s ·\nio…    attempt 3/10\n\n${BOX}`), false)
  assert.equal(stoppedOnNetworkError('claude', `${DROPPED.replace(BOX, '')}❯ Your last API request failed on\n  this computer's network\n\n✻ Thinking…\n\n${BOX}`), false)
  // Went on after an error; the status line's [API Error] is not the conversation.
  assert.equal(stoppedOnNetworkError('claude', `${DROPPED.replace(BOX, '')}● Joined the room.\n\n${BOX.replace('Reset:…', '[API Error]')}`), false)
  // Errors that carrying on would not fix.
  assert.equal(stoppedOnNetworkError('claude', `● API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}\n\n${BOX}`), false)
  assert.equal(stoppedOnNetworkError('claude', `● API Error: Claude's usage limit reached\n\n${BOX}`), false)
  // Not Claude Code, or no input box on screen.
  assert.equal(stoppedOnNetworkError('codex', DROPPED), false)
  assert.equal(stoppedOnNetworkError('claude', '● API Error: Connection dropped (ECONNRESET)'), false)
  assert.equal(stoppedOnNetworkError('claude', ''), false)
})

test('herdr helpers', () => {
  assert.equal(shellIdle({ foreground_processes: [{ argv: ['-zsh'] }] }), true)
  assert.equal(shellIdle({ foreground_processes: [{ argv: ['node', 'x'] }] }), false)
  assert.equal(herdrError({ message: 'Command failed: herdr agent start\n{"error":{"code":"agent_pane_busy","message":"busy"}}' }).code, 'agent_pane_busy')
})

test('delivery checks this pane again before typing; blocked or unavailable never injects', async () => {
  const calls = []
  let status = 'blocked', screen = '> '
  const terminal = {
    paneStatus: async () => { calls.push('status'); if (status === 'error') throw new Error('Herdr unavailable'); return status },
    read: async () => { calls.push('read'); return screen },
    inject: async () => { calls.push('inject') },
  }
  for (const [value, result] of [['blocked', 'blocked'], [null, 'unavailable'], ['unknown', 'unavailable'], ['error', 'unavailable']]) {
    status = value; calls.length = 0
    assert.equal(await injectWhenReady(terminal, 'w:p1', 'hello'), result)
    assert.deepEqual(calls, ['status'])
  }
  for (const value of ['idle', 'done', 'working']) {
    status = value; calls.length = 0
    assert.equal(await injectWhenReady(terminal, 'w:p1', 'hello'), 'sent')
    assert.deepEqual(calls, ['status', 'read', 'inject'])
  }
  screen = 'Update available! Run: claude update\n❯ Update now\n  Skip until next version'
  calls.length = 0
  assert.equal(await injectWhenReady(terminal, 'w:p1', 'hello'), 'dialog')
  assert.deepEqual(calls, ['status', 'read'], 'the update prompt on screen still stops typing')
  // Other trust wording still relies on herdr; only the known Codex dialogs supplement its status.
  screen = 'Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit'
  calls.length = 0
  assert.equal(await injectWhenReady(terminal, 'w:p1', 'hello'), 'sent')
})

test('Herdr pane status is fetched for this pane each time; errors and missing agents are unavailable', async () => {
  const calls = []
  let agentStatus = 'idle', missing = false, fail = false
  const terminal = createHerdr({ exec: async (args) => {
    calls.push(args)
    if (fail) throw new Error('Herdr unavailable')
    return JSON.stringify({ result: { pane: missing ? null : { pane_id: 'w:p1', agent: 'claude', agent_status: agentStatus } } })
  } })
  assert.equal(await terminal.paneStatus('w:p1'), 'idle')
  agentStatus = 'blocked'
  assert.equal(await terminal.paneStatus('w:p1'), 'blocked')
  missing = true
  assert.equal(await terminal.paneStatus('w:p1'), null)
  fail = true
  assert.equal(await terminal.paneStatus('w:p1'), null)
  assert.deepEqual(calls, Array.from({ length: 4 }, () => ['pane', 'get', 'w:p1']))
})

test('spawn waits beyond 30 seconds for a real shell prompt, but still times out or cancels', async () => {
  function terminal(readyAfter) {
    let elapsed = 0, polls = 0
    const herdr = createHerdr({
      clock: () => elapsed,
      sleep: async (ms) => { elapsed += ms },
      exec: async (args) => {
        if (args[1] === 'process-info') {
          polls++
          return JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: polls > readyAfter ? ['-zsh'] : ['node', 'startup'] }] } } })
        }
        if (args[1] === 'read') return polls > readyAfter ? '➜  ~' : ''
        throw new Error(`unexpected herdr call: ${args.join(' ')}`)
      },
    })
    return { herdr, elapsed: () => elapsed }
  }

  const slow = terminal(35)
  assert.deepEqual(await slow.herdr.waitShell('w:p1'), { ok: true })
  assert.equal(slow.elapsed(), 35_000)

  const stuck = terminal(Infinity)
  assert.deepEqual(await stuck.herdr.waitShell('w:p2'), { ok: false })
  assert.equal(stuck.elapsed(), SHELL_READY_SECONDS * 1000)

  const cancelled = terminal(Infinity)
  assert.deepEqual(await cancelled.herdr.waitShell('w:p3', () => cancelled.elapsed() >= 2_000), { ok: false, cancelled: true })
})

test('device id: made once, kept, other config kept', async () => {
  const { deviceId } = await import('../src/daemon/paths.mjs')
  const file = path.join(home, 'cfg', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ server: 'https://x' }))
  const id = deviceId(file)
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(deviceId(file), id)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).server, 'https://x')
})

test('one daemon per computer', () => {
  const file = path.join(home, 'lock', 'daemon.pid')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '999999') // a dead pid
  assert.equal(takeLock(file), null)
  assert.equal(Number(fs.readFileSync(file, 'utf8')), process.pid)
})

// ------------------------------------------------------------------ the seat, with a fake server and terminal

function fakeMachine(seatOpts = {}) {
  const said = [], sent = [], left = [], closed = [], typed = [], joins = [], marks = [], listed = [], events = [], fetched = [], cloud = {}
  const room = { total: 0, cursor: 0 }
  const memberList = [{ name: 'kai', kind: 'human', status: 'active' }, { name: 'daemon.box@kai', kind: 'host', status: 'active' }, { name: 'api@kai', kind: 'agent', status: 'active' }]
  const inbox = []
  const panes = [{ pane_id: 'w:p1', tab_id: 'w:t1', agent: 'claude', agent_status: 'idle', cwd: '/work' }]
  let clock = 1_000_000
  const api = {
    join: async (roomId, body) => { joins.push(body); return { name: `${body.role}@kai`, kind: 'host', roomName: 'Login rework', topic: 't', owner: 'kai' } },
    rooms: async () => { listed.push(clock); return [{ roomId: ROOM, status: 'active' }] },
    listen: async () => ({ mentions: inbox.splice(0, 100), broadcasts: [], total: room.total, cursor: room.cursor }),
    mark: async (roomId, role, upTo) => { marks.push(upTo); room.cursor = Math.max(room.cursor, upTo); return {} },
    members: async () => ({ members: memberList }),
    spawnPerm: async () => ({ perm: 'ask' }),
    send: async (roomId, role, text, replyTo, screen) => {
      if (screen) {
        assert.doesNotMatch(text, /Screen:|```/)
        assert.deepEqual(hideKeys(screen.text), { text: screen.text, hidden: 0 })
        assert.match(text, /\n\w[\w-]* · its screen is with its owner, as a card only they can see(?:; waiting for them)?\.$/)
      }
      said.push(text); sent.push({ roomId, role, text, replyTo, ...(screen ? { screen } : {}) }); return { seq: 100 + said.length }
    },
    leave: async (roomId, role) => { left.push(role); events.push(`left:${role}`); const m = memberList.find((x) => x.name === `${role}@kai`); if (m) m.status = 'left'; return {} },
    // The cloud's handoffs: name → {body, updatedAt, computer} or an error code to throw; none: handoff_not_found.
    handoff: async (roomId, role, name, opts) => {
      fetched.push({ roomId, role, name, opts })
      const h = cloud[name]
      if (typeof h === 'function') return h()
      if (typeof h === 'string') throw Object.assign(new Error(h), { code: h })
      if (!h) throw Object.assign(new Error('handoff_not_found'), { code: 'handoff_not_found' })
      return { roomId, name, size: Buffer.byteLength(h.body), writtenAt: null, computer: null, ...h }
    },
  }
  const tabs = [], pressed = []
  const screen = { text: '> ' }
  // Foreground processes per pane (herdr process-info); none known: null, as herdr answers for a closed pane.
  const fg = {}
  const terminal = {
    panes: async () => panes, agents: async () => [], read: async (pane) => screen.byPane?.[pane] ?? screen.text,
    processInfo: async (pane) => fg[pane] ?? null, paneStatus: async (pane) => panes.find((p) => p.pane_id === pane)?.agent_status ?? null,
    injectAndWatch: async (pane, text) => { typed.push([pane, text]) },
    closePane: async (pane) => { closed.push(pane); return true },
    sendKeys: async (pane, ...keys) => { pressed.push([pane, ...keys]); events.push(`keys:${keys.join(' ')}@${clock}`) },
    sendText: async (pane, text) => { pressed.push([pane, `text:${text}`]); events.push(`text@${clock}`) },
    newTab: async (o) => { tabs.push(o); events.push(`tab:${o.label}`); return { tab: 'w:t9', pane: 'w:p9' } }, waitShell: async () => ({ ok: true }), startAgent: async () => {},
  }
  const roomData = { roomId: ROOM, roomName: 'Login rework', topic: 't', owner: 'kai', members: memberList }
  const rooms = { get: () => roomData, update: () => roomData }
  const unregistered = [], ran = []
  terminal.run = async (pane, cmd) => { ran.push([pane, cmd]) }
  const slept = []
  const seat = createSeat({ api, terminal, rooms, hostname: 'box', stateFile: path.join(home, `seat-${Math.random()}.json`), now: () => clock,
    sleep: async (ms) => { slept.push(ms); events.push(`sleep:${ms}`) }, keyTable: async () => DEFAULT_KEYS, ...seatOpts })
  let nextSeq = 50
  const ask = (text, from = 'kai', fromKind = 'human') => inbox.push({ seq: nextSeq++, from, fromKind, text, ts: clock })
  const tick = async (entries = [{ roomId: ROOM, name: 'api@kai', role: 'api', pane: 'w:p1' }]) => {
    await seat.tick({ entries, panes, unregister: (e) => unregistered.push(e.name) })
    await seat.settle()
  }
  return { seat, terminal, api, said, sent, left, closed, typed, tabs, ask, tick, unregistered, ran, panes, events, advance: (ms) => { clock += ms }, now: () => clock, memberList, roomData, joins, screen, marks, listed, room, inbox, pressed, fg, slept, cloud, fetched }
}

test('a removed computer stops retrying its topic and resumes after explicit rejoin', async () => {
  fs.rmSync(REMOVED_FILE, { force: true })
  const logs = [], m = fakeMachine({ log: (line) => logs.push(line) })
  let attempts = 0
  m.api.join = async () => { attempts++; throw Object.assign(new Error('removed'), { code: 'computer_removed' }) }
  await m.tick([]); await m.tick([])
  assert.equal(attempts, 1)
  assert.equal(wasRemoved(ROOM), true)
  m.advance(2 * OWNED_ROOMS_MS)
  await m.tick([]); await m.tick([])
  assert.equal(attempts, 1, 'no retry after the server refused this computer')
  assert.equal(logs.filter((line) => line.includes('not retrying')).length, 1)
  clearRemoved(ROOM)
  m.api.join = async (_roomId, body) => { attempts++; return { name: `${body.role}@kai`, kind: 'host', roomName: 'Login rework', topic: 't', owner: 'kai' } }
  await m.tick([])
  assert.equal(attempts, 2, 'the running daemon sees the explicit local unblock')
  fs.rmSync(REMOVED_FILE, { force: true })
})

test('host join sends machine and uses the server device in its role card', async () => {
  const stateFile = path.join(home, `seat-device-${Math.random()}.json`)
  const m = fakeMachine({ stateFile })
  m.api.join = async (_roomId, body) => {
    m.joins.push(body)
    return { name: 'box-2-daemon@kai', kind: 'host', roomName: 'Login rework', topic: 't', owner: 'kai',
      device: { name: 'box-2', hostname: 'box.local', note: 'Desk' } }
  }
  await m.tick()
  assert.equal(m.joins.length, 2)
  assert.deepEqual(m.joins[0].perms, ['ask', 'auto', 'all'])
  assert.equal(m.joins[0].machine, 'box')
  assert.match(m.joins[1].roleCard, /This computer: box-2 — Desk\./)
  assert.equal(m.seat.role, 'box-2-daemon')
  const restarted = fakeMachine({ stateFile })
  restarted.api.join = async (_roomId, body) => {
    restarted.joins.push(body)
    return { name: 'box-2-daemon@kai', kind: 'host', roomName: 'Login rework', topic: 't', owner: 'kai',
      device: { name: 'box-2', hostname: 'box.local', note: 'Desk' } }
  }
  await restarted.tick()
  assert.equal(restarted.joins.length, 1, 'restarting does not briefly write the old machine card')
  assert.match(restarted.joins[0].roleCard, /This computer: box-2 — Desk\./)
})

test('after a new token, the daemon seat joins its topics again before delivery resumes', async () => {
  const m = fakeMachine()
  await m.tick()
  assert.equal(m.joins.length, 1)
  assert.deepEqual(m.seat.joined(), [ROOM])
  m.seat.reconnect()
  assert.deepEqual(m.seat.joined(), [])
  await m.tick()
  assert.equal(m.joins.length, 2)
  assert.deepEqual(m.seat.joined(), [ROOM])
})

test('host join reports the last rollback', async () => {
  writeJson(ROLLBACK_FILE, { bad: { version: '2.0.0', build: 'bad-hash' }, good: { version: '1.0.0', build: 'good-hash' }, at: 123, reason: 'signin' })
  try {
    const m = fakeMachine()
    await m.tick()
    assert.deepEqual(m.joins[0].rollback, { bad: { version: '2.0.0', build: 'bad-hash' }, at: 123 })
  } finally { fs.rmSync(ROLLBACK_FILE, { force: true }) }
})

test('health writes changed checks immediately but throttles aliveAt to 30 seconds', () => {
  const file = path.join(home, `health-${Math.random()}.json`)
  let clock = 1_000
  const health = createHealth({ file, build: 'build-a', pid: 123, now: () => clock })
  clock = 5_000
  health.herdr(true)
  health.round()
  assert.equal(readJson(file).checks.herdr, true)
  assert.equal(readJson(file).aliveAt, 1_000)
  clock = 30_999
  health.round()
  assert.equal(readJson(file).aliveAt, 1_000)
  clock = 31_000
  health.round()
  assert.equal(readJson(file).aliveAt, 31_000)
})

test('seat: /bye stops delivery, leaves for it, closes its pane', async () => {
  const m = fakeMachine()
  m.ask('@daemon.box@kai /bye api')
  await m.tick()
  assert.deepEqual(m.unregistered, ['api@kai'])
  assert.deepEqual(m.left, ['api'])
  assert.deepEqual(m.closed, ['w:p1'])
  assert.match(m.said.at(-1), /^@kai ✓ api · left the topic · pane closed$/)
})

test('seat: /handoff types the instructions, closes the pane after it leaves, reports', async () => {
  const m = fakeMachine()
  m.ask('@daemon.box@kai /handoff api', 'lead@kai', 'agent')
  await m.tick()
  assert.equal(m.typed.length, 1)
  assert.ok(m.typed[0][1].includes('sent /handoff api (#50)'))
  assert.match(m.said.at(-1), /^@lead@kai Got it; asked api to write a handoff\.$/)
  await m.tick()
  assert.deepEqual(m.closed, [])
  assert.equal(m.seat.idle(), false)
  assert.deepEqual(m.seat.busyWhy(), ['a handoff waiting for api to leave'])
  m.memberList.find((x) => x.name === 'api@kai').status = 'left'
  await m.tick()
  assert.deepEqual(m.closed, ['w:p1'])
  assert.match(m.said.at(-1), /^@lead@kai ✓ api · left the topic · pane closed$/)
  assert.equal(m.seat.idle(), true)
  assert.deepEqual(m.seat.busyWhy(), [])
})

test('seat: scheduled /handoff names and answers the creator', async () => {
  const m = fakeMachine()
  m.inbox.push({ seq: 50, from: 'scheduled', fromKind: 'scheduled', scheduled: { id: 'S7', by: 'lead@kai', at: 1_000_000 },
    text: '@daemon.box@kai /handoff api', mentions: ['daemon.box@kai'], ts: 1_000_000 })
  await m.tick()
  assert.match(m.typed[0][1], /lead@kai \(agent\) sent \/handoff api \(#50\)/)
  assert.match(m.said.at(-1), /^@lead@kai Got it; asked api to write a handoff\.$/)
})

test('seat: /handoff keeps watching past ten minutes, closes on leave, or reports after two hours', async () => {
  const m = fakeMachine()
  m.ask('@daemon.box@kai /handoff api')
  await m.tick()
  m.advance(13 * 60_000)
  await m.tick()
  assert.deepEqual(m.closed, [])
  assert.equal(m.said.some((s) => s.includes('did not leave')), false)
  const lateLeave = fakeMachine()
  lateLeave.ask('@daemon.box@kai /handoff api')
  await lateLeave.tick()
  lateLeave.advance(13 * 60_000)
  lateLeave.memberList.find((x) => x.name === 'api@kai').status = 'left'
  await lateLeave.tick()
  assert.deepEqual(lateLeave.closed, ['w:p1'])
  m.advance(HANDOFF_MS + 1000)
  await m.tick()
  assert.deepEqual(m.closed, [])
  assert.match(m.said.at(-1), /did not leave within 2 hours/)
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(m.screen.text, 8)))
})

test('seat: /bye closes a pane left behind after its agent left the room', async () => {
  register({ roomId: ROOM, name: 'api@kai', role: 'api', pane: 'w:p1' })
  markLeft({ roomId: ROOM, name: 'api@kai' })
  assert.equal(entries().length, 0)
  const m = fakeMachine()
  m.memberList.find((x) => x.name === 'api@kai').status = 'left'
  m.ask('@daemon.box@kai /bye api')
  await m.tick([])
  assert.deepEqual(m.closed, ['w:p1'])
  assert.match(m.said.at(-1), /✓ api · left the topic · pane closed/)
  unregister({ roomId: ROOM, name: 'api@kai' })
})

test('an agent that left by itself: not_member on its listen marks it left (not removed), so /bye still closes its pane', async () => {
  register({ roomId: ROOM, name: 'api@kai', role: 'api', pane: 'w:p1' })
  const logged = []
  // The seat read the leave before the CLI marked it: the daemon's round gets not_member first.
  notMember({ roomId: ROOM, name: 'api@kai', role: 'api', pane: 'w:p1' }, { markLeft, log: (t) => logged.push(t) })
  assert.equal(entries().some((e) => e.name === 'api@kai'), false, 'no more delivery')
  assert.equal(leftEntries().find((e) => e.name === 'api@kai')?.pane, 'w:p1', 'its pane kept for /bye')
  assert.match(logged[0], /marked left/)
  markLeft({ roomId: ROOM, name: 'api@kai' }) // the CLI's own mark, a moment later: still there
  const m = fakeMachine()
  m.memberList.find((x) => x.name === 'api@kai').status = 'left'
  m.ask('@daemon.box@kai /bye api')
  await m.tick([])
  assert.deepEqual(m.closed, ['w:p1'])
  assert.match(m.said.at(-1), /✓ api · left the topic · pane closed/)
  unregister({ roomId: ROOM, name: 'api@kai' })
})

test('seat: /spawn without a directory uses this topic workspace; another account is refused', async () => {
  const m = fakeMachine()
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  m.ask('@daemon.box@kai /spawn claude qa model=claude-opus-5-5 effort=xhigh do things')
  m.ask('@daemon.box@kai /bye api', 'zoe', 'human')
  await m.tick()
  for (let i = 0; i < 20 && !m.said.some((s) => s.includes('Started qa')); i++) await new Promise((r) => setImmediate(r))
  const workspace = path.join(home, 'topics', ROOM, 'workspace')
  assert.equal(m.tabs[0].cwd, workspace)
  assert.ok(fs.statSync(workspace).isDirectory())
  assert.ok(m.said.some((s) => s.includes('Started qa') && s.includes(` in ${workspace},`)), m.said.join('\n'))
  assert.ok(m.said.some((s) => /^@kai Started qa /.test(s)), 'a person who starts an agent gets the reply')
  assert.ok(m.said.some((s) => /^@zoe This daemon only takes commands from kai/.test(s)))
  assert.equal(readJson(spawnRecordPath(ROOM, 'qa@kai')).explicitDir, false)
})

test('seat: /spawn still-starting errors log info without the first prompt and a working pane starts normally', async () => {
  for (const code of ['timeout', 'agent_not_ready']) {
    const info = [], errors = []
    const log = Object.assign((line) => info.push(line), { error: (line) => errors.push(line) })
    const m = fakeMachine({ log })
    const prompt = 'private-first-prompt-marker'
    m.terminal.startAgent = async () => {
      const error = new Error(`Command failed: herdr agent start -- ${prompt}`)
      error.code = 1
      error.stderr = JSON.stringify({ error: { code, message: `timed out waiting for agent startup: ${prompt}` } })
      throw error
    }
    const panes = m.terminal.panes
    m.terminal.panes = async () => {
      await new Promise((resolve) => setImmediate(resolve))
      m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
      return panes()
    }
    m.ask(`@daemon.box@kai /spawn claude qa ${prompt}`)
    await m.tick()
    for (let i = 0; i < 20 && !m.said.some((s) => s.includes('Started qa')); i++) await new Promise((r) => setImmediate(r))
    assert.ok(m.said.some((s) => s.includes('Started qa')), m.said.join('\n'))
    assert.deepEqual(errors, [])
    assert.ok(info.includes(`agent start qa (try 1): herdr returned ${code} while the CLI works on its first prompt`))
    assert.equal([...info, ...errors].some((line) => line.includes(prompt)), false)
  }
})

test('seat: /spawn an unknown start failure keeps an error with its code and no herdr message', async () => {
  const info = [], errors = []
  const log = Object.assign((line) => info.push(line), { error: (line) => errors.push(line) })
  const m = fakeMachine({ log })
  const prompt = 'private-first-prompt-marker'
  m.terminal.startAgent = async () => {
    const error = new Error(`Command failed: herdr agent start -- ${prompt}`)
    error.code = 1
    error.stderr = JSON.stringify({ error: { code: 'bad_kind', message: prompt } })
    throw error
  }
  m.ask(`@daemon.box@kai /spawn claude qa ${prompt}`)
  await m.tick()
  for (let i = 0; i < 20 && !m.said.some((s) => s.includes('did not start; herdr says: bad_kind')); i++) await new Promise((r) => setImmediate(r))
  assert.ok(m.said.some((s) => s.includes('did not start; herdr says: bad_kind')), m.said.join('\n'))
  assert.equal(m.said.some((s) => s.includes('Started qa')), false)
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(m.screen.text)))
  assert.deepEqual(errors, ['agent start qa (try 1): herdr agent start exit 1 (bad_kind)'])
  assert.equal([...info, ...errors].some((line) => line.includes(prompt)), false)
})

test('spawn options: configured defaults reach /spawn, and both kinds appear on the card and installed kinds have options in /help', async () => {
  const options = structuredClone(DEFAULT_SPAWN)
  options.claude.models.push({ id: 'claude-sonnet-5', about: { en: 'For routine work.' } })
  options.claude.default.model = 'claude-sonnet-5'
  options.claude.default.effort = 'medium'
  const { detector } = fakeDetector({ claude: '2.1.301', codex: null })
  const m = fakeMachine({ detector, spawnOptions: { get: () => options, refresh: async () => false } })
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  await m.tick()
  assert.match(m.joins[0].roleCard, /Spawn options: claude · codex \(model=, effort=; see \/help\)\./)
  assert.ok(!m.joins[0].roleCard.includes('codex models'))
  m.ask('@daemon.box@kai /help')
  await m.tick()
  assert.match(m.said.at(-1), /claude models: claude-opus-5-5; claude-sonnet-5 \(default\) — For routine work\./)
  assert.match(m.said.at(-1), /claude effort: low; medium \(default\); high; xhigh; max; ultracode/)
  m.ask('@daemon.box@kai /spawn claude qa do things')
  await m.tick()
  const record = readJson(spawnRecordPath(ROOM, 'qa@kai'))
  assert.deepEqual({ model: record.model, effort: record.effort }, { model: 'claude-sonnet-5', effort: 'medium' })
})

test('spawn options: the daemon reuses its saved copy when the server is unavailable', async () => {
  const file = path.join(home, `spawn-options-${Math.random()}.json`)
  const options = structuredClone(DEFAULT_SPAWN)
  options.codex.default.effort = 'high'
  let time = 0
  let reads = 0
  const first = createSpawnOptions({ fetch: async () => { reads++; return options }, file, now: () => time })
  assert.equal(await first.refresh(), true)
  assert.deepEqual(readJson(file), options)
  time = SPAWN_REFRESH_MS - 1
  await first.refresh()
  assert.equal(reads, 1)
  time = SPAWN_REFRESH_MS
  await first.refresh()
  assert.equal(reads, 2)
  const offline = createSpawnOptions({ fetch: async () => { throw new Error('offline') }, file, now: () => time })
  assert.equal(await offline.refresh(), false)
  assert.deepEqual(offline.get(), options)
  const invalid = createSpawnOptions({ fetch: async () => ({}), file, now: () => time })
  assert.equal(await invalid.refresh(), false)
  assert.deepEqual(invalid.get(), options)
})

test('spawn options: a failed fetch retries after one hour, then returns to the 24-hour interval', async () => {
  const file = path.join(home, `spawn-retry-${Math.random()}.json`)
  const next = structuredClone(DEFAULT_SPAWN)
  next.claude.default.effort = 'high'
  let time = 0, reads = 0, online = false
  const options = createSpawnOptions({ file, now: () => time, fetch: async () => {
    reads++
    if (!online) throw new Error('offline')
    return next
  } })
  assert.equal(await options.refresh(), false)
  assert.deepEqual(options.get(), DEFAULT_SPAWN)
  time = SPAWN_RETRY_MS - 1
  await options.refresh()
  assert.equal(reads, 1)
  online = true
  time = SPAWN_RETRY_MS
  assert.equal(await options.refresh(), true)
  assert.equal(reads, 2)
  assert.deepEqual(options.get(), next)
  time += SPAWN_REFRESH_MS - 1
  await options.refresh()
  assert.equal(reads, 2)
})

test('seat: an agent sender is not woken by a successful /spawn reply', async () => {
  const m = fakeMachine({ isDir: () => true })
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  m.ask('@daemon.box@kai /spawn claude qa /work do things', 'api@kai', 'agent')
  await m.tick()
  await until(() => m.said.some((s) => s.includes('Started qa')))
  assert.match(m.said.at(-1), /^@qa@kai Started qa /)
})

test('seat: scheduled takeover replies to creator, carries its handoff path and labels first prompt', async () => {
  const m = fakeMachine({ isDir: () => true })
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  m.memberList.push({ name: 'schedqa@kai', kind: 'agent', status: 'left', roleCard: 'schedqa: reviews' })
  m.cloud['schedqa@kai'] = { body: '## Handoff\nKeep reviewing.', updatedAt: 900_000, computer: 'box' }
  m.inbox.push({ seq: 50, from: 'scheduled', fromKind: 'scheduled', scheduled: { id: 'S3', by: 'lead@kai', at: 1_000_000 },
    text: '@daemon.box@kai /spawn claude schedqa /work model=claude-opus-5-5 Review again @schedqa@kai',
    mentions: ['daemon.box@kai', 'schedqa@kai'], ts: 1_000_000 })
  await m.tick()
  for (let i = 0; i < 20 && !m.said.some((s) => s.includes('Started schedqa')); i++) await new Promise((r) => setImmediate(r))
  assert.ok(m.said.some((s) => /^@schedqa@kai Started schedqa /.test(s)), m.said.join('\n'))
  const prompt = fs.readFileSync(path.join(home, 'spawns', ROOM, 'schedqa.md'), 'utf8')
  assert.equal(fs.statSync(path.join(home, 'spawns', ROOM, 'schedqa.md')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(home, 'spawns', ROOM)).mode & 0o777, 0o700)
  assert.match(prompt, /Set by lead@kai · Scheduled S3/)
  assert.match(prompt, /handoff/)
  assert.ok(m.fetched.some((f) => f.name === 'schedqa@kai'), 'normal takeover fetches its handoff')

  const self = fakeMachine({ isDir: () => true })
  self.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  self.memberList.push({ name: 'schedself@kai', kind: 'agent', status: 'left' })
  self.inbox.push({ seq: 50, from: 'scheduled', fromKind: 'scheduled', scheduled: { id: 'S4', by: 'schedself@kai', at: 1_000_000 },
    text: '@daemon.box@kai /spawn claude schedself /work Do it @schedself@kai', mentions: ['daemon.box@kai', 'schedself@kai'], ts: 1_000_000 })
  await self.tick()
  for (let i = 0; i < 20 && !self.said.some((s) => s.includes('Started schedself')); i++) await new Promise((r) => setImmediate(r))
  assert.ok(self.said.some((s) => /^@schedself@kai Started schedself /.test(s)), self.said.join('\n'))
})

test('seat: a dead local name leaves before takeover; live local and remote names are refused', async () => {
  const dead = fakeMachine({ isDir: () => true })
  dead.panes.splice(0, 1)
  dead.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  dead.ask('@daemon.box@kai /spawn claude api /work do it')
  await dead.tick()
  for (let i = 0; i < 20 && !dead.said.some((s) => s.includes('Started api')); i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(dead.events.slice(0, 2), ['left:api', 'tab:api'])
  assert.equal(dead.said.at(-1), "@kai Started api (claude: claude-opus-5-5, effort medium) in /work, taking over api: its tasks and role card go with it; it left no handoff, in the cloud or on this computer. api's old process on this computer was gone, so the daemon took it out of the topic first. It is working on its first prompt; waiting for it to join. perm: ask me in Scorpio (your setting).")
  assert.ok(!fs.readFileSync(path.join(home, 'spawns', ROOM, 'api.md'), 'utf8').includes('roleCard='))

  const live = fakeMachine({ isDir: () => true })
  live.ask('@daemon.box@kai /spawn claude api /work do it')
  await live.tick()
  assert.match(live.said.at(-1), /api is running on this computer \(pane w:p1\)\. To replace it, first \/handoff api \(it writes a handoff\) or \/bye api \(no handoff\)\./)
  assert.deepEqual(live.tabs, [])

  const remote = fakeMachine({ isDir: () => true })
  remote.ask('@daemon.box@kai /spawn claude api /work do it')
  await remote.tick([{ roomId: ROOM, name: 'other@kai', role: 'other', pane: 'w:p1' }])
  assert.match(remote.said.at(-1), /api is in this topic on another computer, or is a person here\. To take that seat over, use the daemon of the computer it runs on; otherwise pick another name\./)
  assert.deepEqual(remote.tabs, [])
})

test('seat: another topic can use the same seat name with a numbered Herdr label', async () => {
  for (const count of [1, 2]) {
    const m = fakeMachine({ isDir: () => true })
    const live = Array.from({ length: count }, (_, i) => ({ name: i ? 'supervisor-2' : 'supervisor', pane_id: `w:p${i + 2}` }))
    m.terminal.agents = async () => live
    const starts = []
    m.terminal.startAgent = async (args) => { starts.push(args) }
    m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working' })
    m.ask('@daemon.box@kai /spawn claude supervisor /work do it')
    await m.tick()
    await until(() => m.said.some((s) => s.includes('Started supervisor')))
    assert.equal(starts.length, 1)
    assert.equal(starts[0].name, `supervisor-${count + 1}`)
    assert.equal(m.tabs[0].label, starts[0].name)
    assert.equal(m.seat.ops[0].name, 'supervisor@kai')
    assert.equal(m.seat.ops[0].herdrName, starts[0].name)
    const prompt = fs.readFileSync(path.join(home, 'spawns', ROOM, 'supervisor.md'), 'utf8')
    assert.match(prompt, /role=supervisor resume=true pane=w:p9/)
    assert.match(prompt, /You are supervisor@kai/)
  }
})

test('seat: a left seat with an open pane is refused even under a numbered Herdr label', async (t) => {
  register({ roomId: ROOM, name: 'supervisor@kai', pane: 'w:p2' })
  markLeft({ roomId: ROOM, name: 'supervisor@kai' })
  t.after(() => unregister({ roomId: ROOM, name: 'supervisor@kai' }))
  const m = fakeMachine({ isDir: () => true })
  m.memberList.push({ name: 'supervisor@kai', kind: 'agent', status: 'left' })
  m.panes.push({ pane_id: 'w:p2', tab_id: 'w:t2', agent: 'claude' })
  m.terminal.agents = async () => [{ name: 'supervisor-2', pane_id: 'w:p2' }]
  m.ask('@daemon.box@kai /spawn claude supervisor /work do it')
  await m.tick()
  assert.equal(m.said.at(-1), '@kai supervisor left this topic, but its pane w:p2 is still open. /bye supervisor closes it; then /spawn again.')
  assert.deepEqual(m.tabs, [])
  assert.deepEqual(m.closed, [])
})

test('seat: a left seat whose pane is gone keeps its handoff and card across a Herdr collision', async (t) => {
  register({ roomId: ROOM, name: 'supervisor@kai', pane: 'w:p2' })
  markLeft({ roomId: ROOM, name: 'supervisor@kai' })
  t.after(() => unregister({ roomId: ROOM, name: 'supervisor@kai' }))
  const m = fakeMachine({ isDir: () => true })
  m.memberList.push({ name: 'supervisor@kai', kind: 'agent', status: 'left', roleCard: 'supervisor: coordinates' })
  m.cloud['supervisor@kai'] = { body: '## Handoff\nContinue the review.', updatedAt: 900_000, computer: 'box' }
  m.terminal.agents = async () => [{ name: 'supervisor', pane_id: 'w:p3' }]
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working' })
  m.ask('@daemon.box@kai /spawn claude supervisor /work go on')
  await m.tick()
  await until(() => m.said.some((s) => s.includes('Started supervisor')))
  assert.equal(m.tabs[0].label, 'supervisor-2')
  assert.match(m.said.at(-1), /taking over supervisor: its tasks, role card and handoff/)
  const prompt = fs.readFileSync(path.join(home, 'spawns', ROOM, 'supervisor.md'), 'utf8')
  assert.match(prompt, /role=supervisor resume=true pane=w:p9/)
  assert.doesNotMatch(prompt, /roleCard=/)
  assert.match(fs.readFileSync(m.seat.ops[0].handoff.file, 'utf8'), /Continue the review\./)
  assert.equal(m.memberList.at(-1).roleCard, 'supervisor: coordinates')
})

test('seat: pending names reserve Herdr labels across topics and survive a daemon restart', async () => {
  const other = 'OtherTopic12345678901'
  const stateFile = path.join(home, 'seat-cross-topic.json')
  const m = fakeMachine({ isDir: () => true, stateFile })
  m.api.rooms = async () => [{ roomId: ROOM }, { roomId: other }]
  const queues = new Map([ROOM, other].map((roomId) => [roomId, [{ seq: 50, from: 'kai', fromKind: 'human',
    text: '@daemon.box@kai /spawn claude supervisor /work do it', ts: 1_000_000 }]]))
  m.api.listen = async (roomId) => ({ mentions: queues.get(roomId).splice(0), total: 50 })
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  m.terminal.waitShell = async () => { await waiting; return { ok: true } }
  m.terminal.newTab = async (options) => {
    m.tabs.push(options)
    const n = m.tabs.length + 8
    m.panes.push({ pane_id: `w:p${n}`, tab_id: `w:t${n}`, agent: 'claude', agent_status: 'working' })
    return { tab: `w:t${n}`, pane: `w:p${n}` }
  }
  // Owned topics are discovered in the background; the following round joins the second topic.
  await m.tick()
  await m.tick()
  assert.deepEqual(m.tabs.map((tab) => tab.label), ['supervisor', 'supervisor-2'])
  assert.deepEqual(m.seat.ops.map((op) => [op.roomId, op.name, op.herdrName]), [
    [ROOM, 'supervisor@kai', 'supervisor'], [other, 'supervisor@kai', 'supervisor-2'],
  ])
  const restarted = fakeMachine({ stateFile })
  assert.deepEqual(restarted.seat.ops.map((op) => [op.herdrName, op.stage]), [['supervisor', 'failed'], ['supervisor-2', 'failed']])
  // A second request for the same topic remains a refusal, without opening another tab.
  queues.get(other).push({ seq: 51, from: 'kai', fromKind: 'human', text: '@daemon.box@kai /spawn claude supervisor /work again', ts: 1_000_001 })
  await m.tick()
  assert.match(m.said.at(-1), /supervisor is starting on this computer\. To start over, \/bye supervisor first\./)
  assert.equal(m.tabs.length, 2)
  release()
  await until(() => m.seat.ops.every((op) => op.stage === 'joining'))
  assert.equal(m.seat.ops.every((op) => op.stage === 'joining'), true)
})

test('seat: a Herdr name claimed during startup retries with the next label', async () => {
  for (const first of [1, 2]) {
    const stateFile = path.join(home, 'seat-name-race.json')
    fs.rmSync(stateFile, { force: true })
    const m = fakeMachine({ isDir: () => true, stateFile })
    const live = first === 1 ? [] : [{ name: 'supervisor', pane_id: 'w:p3' }]
    const starts = [], labels = []
    const initial = first === 1 ? 'supervisor' : 'supervisor-2'
    const next = `supervisor-${first + 1}`
    m.terminal.agents = async () => live
    m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9' })
    m.terminal.renameTab = async (tab, label) => { labels.push([tab, label]) }
    m.terminal.startAgent = async ({ name }) => {
      starts.push(name)
      if (name === initial) {
        live.splice(0)
        live.push({ name, pane_id: 'w:p2' })
        throw new Error('Herdr name already taken')
      }
      Object.assign(m.panes.at(-1), { agent: 'claude', agent_status: 'working' })
    }
    m.ask('@daemon.box@kai /spawn claude supervisor /work do it')
    await m.tick()
    await until(() => m.said.some((s) => s.includes('Started supervisor')))
    assert.deepEqual(starts, [initial, next])
    assert.deepEqual(labels, [['w:t9', next]])
    assert.equal(readJson(stateFile).spawns[0].herdrName, next)
    assert.match(m.said.at(-1), /Started supervisor /)
  }
})

test('seat: a spawn cancelled while checking a Herdr name race never starts again', async () => {
  const m = fakeMachine({ isDir: () => true })
  let answer, reads = 0, starts = 0
  m.terminal.agents = async () => {
    if (++reads === 1) return []
    return new Promise((resolve) => { answer = resolve })
  }
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9' })
  m.terminal.startAgent = async () => { starts++; throw new Error('Herdr name already taken') }
  m.ask('@daemon.box@kai /spawn claude supervisor /work do it')
  await m.tick()
  await until(() => answer)
  assert.equal(typeof answer, 'function')
  m.ask('@daemon.box@kai /bye supervisor')
  await m.tick()
  answer([{ name: 'supervisor', pane_id: 'w:p2' }])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(starts, 1)
  assert.deepEqual(m.closed, ['w:p9'])
  assert.equal(m.seat.ops.length, 0)
})

test('seat: nameless spawn skips left names; last directory is suggested but never applied', async () => {
  const m = fakeMachine({ isDir: () => true })
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  m.memberList.push({ name: 'claude-1@kai', kind: 'agent', status: 'left' })
  m.ask('@daemon.box@kai /spawn claude /work go')
  await m.tick()
  for (let i = 0; i < 20 && !m.said.some((s) => s.includes('Started claude-2')); i++) await new Promise((r) => setImmediate(r))
  assert.match(m.said.at(-1), /Started claude-2 .* in \/work, a new name in this topic\./)
  assert.deepEqual(readJson(spawnRecordPath(ROOM, 'claude-2@kai')), { kind: 'claude', dir: '/work', explicitDir: true, model: 'claude-opus-5-5', effort: 'medium', pane: 'w:p9', perm: 'ask', permFrom: 'setting', permParent: null, at: 1_000_000 })

  writeJson(spawnRecordPath(ROOM, 'web@kai'), { kind: 'codex', dir: '/last', model: 'gpt-6-sol', effort: 'high', at: 1 })
  m.ask('@daemon.box@kai /spawn claude web do new work')
  await m.tick()
  assert.ok(m.said.at(-1).includes('Not started: web last worked in /last. Copy the command with that directory, or name another one:\n```\n@daemon.box@kai /spawn codex web /last model=gpt-6-sol effort=high do new work\n```'), m.said.at(-1))
  assert.deepEqual(m.tabs.map((t) => t.label), ['claude-2'])
})

test('seat: cwd with spaces is used, and a named takeover repeats an explicit directory', async () => {
  const dir = path.join(home, 'Project with spaces')
  fs.mkdirSync(dir, { recursive: true })
  const first = fakeMachine()
  first.ask(`@daemon.box@kai /spawn codex qa cwd="${dir}" model=gpt-6-sol effort=xhigh do work`)
  await first.tick()
  for (let i = 0; i < 20 && !first.said.some((s) => s.includes('Started qa')); i++) await new Promise((r) => setImmediate(r))
  assert.equal(first.tabs[0].cwd, dir)
  assert.equal(readJson(spawnRecordPath(ROOM, 'qa@kai')).explicitDir, true)

  const takeover = fakeMachine()
  takeover.ask('@daemon.box@kai /spawn codex qa do more')
  await takeover.tick()
  assert.deepEqual(takeover.tabs, [])
  assert.ok(takeover.said.at(-1).includes(`@daemon.box@kai /spawn codex qa cwd="${dir}" model=gpt-6-sol effort=xhigh do more`))
})

test('seat: a missing directory with no other agent directory suggests the topic workspace', async () => {
  const m = fakeMachine({ isDir: () => false })
  m.panes.length = 0
  m.ask('@daemon.box@kai /spawn claude qa /missing do things')
  await m.tick()
  assert.ok(m.said.at(-1).includes("Without a directory it starts in this topic's workspace:\n```\n@daemon.box@kai /spawn claude qa do things\n```"))
  assert.deepEqual(m.tabs, [])
})

// ------------------------------------------------------------------ taking over: where the handoff comes from

const AT = new Date(2026, 9, 16, 14, 20) // 10-16 14:20 local
const writeLocal = (role, at = AT, body = `# ${role}'s local handoff`) => {
  const file = path.join(home, 'topics', ROOM, 'handoffs', `${role}.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  fs.utimesSync(file, at, at)
  return file
}
const until = async (check, ms = 2_000) => { for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise((r) => setTimeout(r, 2)) }

/** A /spawn of a seat that left the topic; resolves once the seat said Started (or gave up). */
async function takeover(role, { prompt = 'go on', skip = false, cloud, setup = () => {}, seatOpts = {} } = {}) {
  const m = fakeMachine({ isDir: () => true, ...seatOpts })
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  m.memberList.push({ name: `${role}@kai`, kind: 'agent', status: 'left' })
  m.advance(AT.getTime() + 3 * 3_600_000 - 1_000_000) // the seat's clock: 3 h after AT
  if (cloud !== undefined) m.cloud[`${role}@kai`] = cloud
  setup(m)
  m.ask(`@daemon.box@kai /spawn claude ${role} /work${skip ? ' handoff=skip' : ''} ${prompt}`)
  await m.tick()
  await until(() => m.said.some((x) => x.includes(`Started ${role}`)))
  const line = m.said.find((x) => x.includes(`Started ${role}`)) || m.said.at(-1)
  const spawnFile = path.join(home, 'spawns', ROOM, `${role}.md`)
  return { m, line, prompt: fs.existsSync(spawnFile) ? fs.readFileSync(spawnFile, 'utf8') : null, typedLine: m.ran.at(-1)?.[1] }
}
const started = (role, source) => `@kai Started ${role} (claude: claude-opus-5-5, effort medium) in /work, ${source}. It is working on its first prompt; waiting for it to join. perm: ask me in Scorpio (your setting).`

test('takeover sources: cloud only; written to files/handoff-<name>.md 0600, never the fallback directory', async () => {
  const updatedAt = AT.getTime()
  const { m, line, prompt } = await takeover('src1', { cloud: { body: '# from the cloud', updatedAt, computer: 'box' } })
  assert.equal(line, started('src1', `taking over src1: its tasks, role card and handoff (from the cloud, stored 3 h ago on box) go with it`))
  const copy = path.join(home, 'topics', ROOM, 'files', 'handoff-src1@kai.md')
  assert.equal(fs.readFileSync(copy, 'utf8'), '# from the cloud')
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600)
  assert.ok(!fs.existsSync(path.join(home, 'topics', ROOM, 'handoffs', 'src1.md')), 'nothing in the fallback directory')
  assert.ok(prompt.includes(`The daemon told the topic: "taking over src1: its tasks, role card and handoff (from the cloud, stored 3 h ago on box) go with it." Its handoff: ${copy} (stored 3 h ago). Read it before you report in`), prompt)
  assert.deepEqual(m.fetched.map((f) => [f.role, f.name, f.opts.budgetMs]), [['daemon.box', 'src1@kai', 20_000]], 'as the seat, bounded to 20 s')
})

test('takeover sources: local only (cloud has none), neutral words; the file used where it is and kept', async () => {
  const file = writeLocal('src2')
  const { line, prompt } = await takeover('src2')
  assert.equal(line, started('src2', `taking over src2: its tasks, role card and handoff (this computer's copy, written 3 h ago) go with it`))
  assert.ok(prompt.includes(`Its handoff: ${file} (written 3 h ago).`), prompt)
  assert.ok(fs.existsSync(file), 'nothing deleted by /spawn')
  assert.ok(!fs.existsSync(path.join(home, 'topics', ROOM, 'files', 'handoff-src2@kai.md')))
})

test('takeover sources: both; the local copy wins only when its mtime is later than the cloud updatedAt', async () => {
  const newer = writeLocal('src3', new Date(AT.getTime() + 60_000))
  const a = await takeover('src3', { cloud: { body: 'cloud', updatedAt: AT.getTime(), computer: 'box' } })
  assert.match(a.line, /taking over src3: its tasks, role card and handoff \(this computer's copy, written 2 h ago\) /)
  assert.ok(a.prompt.includes(`Its handoff: ${newer} `))
  assert.ok(!fs.existsSync(path.join(home, 'topics', ROOM, 'files', 'handoff-src3@kai.md')))

  writeLocal('src4', AT)
  const b = await takeover('src4', { cloud: { body: 'cloud', updatedAt: AT.getTime(), computer: 'box' } })
  assert.match(b.line, /taking over src4: its tasks, role card and handoff \(from the cloud, stored 3 h ago on box\) go with it/, 'equal: the cloud')
  writeLocal('src5', new Date(AT.getTime() - 60_000))
  const c = await takeover('src5', { cloud: { body: 'cloud', updatedAt: AT.getTime(), computer: null } })
  assert.match(c.line, /taking over src5: its tasks, role card and handoff \(from the cloud, stored 3 h ago\) go with it\./, 'older local: the cloud; no computer: none named')
  assert.ok(fs.existsSync(path.join(home, 'topics', ROOM, 'handoffs', 'src5.md')), 'the older local copy is not deleted')
})

test('takeover sources: cloud failed, with and without a local copy; a server without the route; none', async () => {
  const file = writeLocal('src6')
  const a = await takeover('src6', { cloud: 'network' })
  assert.equal(a.line, started('src6', `taking over src6: its tasks and role card go with it. The cloud handoff could not be fetched (network), so it gets this computer's copy (written 3 h ago)`))
  assert.ok(a.prompt.includes(`Its handoff: ${file} `))

  const b = await takeover('src7', { cloud: 'server_error' })
  assert.equal(b.line, started('src7', "taking over src7: its tasks and role card go with it. The cloud handoff could not be fetched (server_error) and there is none on this computer, so it starts without one; the topic's messages show where it stopped"))
  assert.ok(b.prompt.includes("Your tasks and the topic's recent messages show where it stopped."))
  assert.ok(b.prompt.includes('2. Read the last messages in the topic and your tasks.'))

  // An older server answers the unknown route with a plain 404 (api.mjs: not_found) or a JSON bad_request: failed, never "none".
  const c = await takeover('src8', { cloud: 'not_found' })
  assert.match(c.line, /could not be fetched \(not_found\) and there is none on this computer/)
  const d = await takeover('src9', { cloud: 'unauthorized' })
  assert.match(d.line, /could not be fetched \(unauthorized\)/)

  const e = await takeover('src10')
  assert.equal(e.line, started('src10', 'taking over src10: its tasks and role card go with it; it left no handoff, in the cloud or on this computer'))
})

test('takeover sources: the cloud fetch is bounded (timeout), and a slow answer after that is ignored', async () => {
  let answer
  const file = writeLocal('slow1')
  const a = await takeover('slow1', { cloud: () => new Promise((r) => { answer = r }), seatOpts: { handoffFetchMs: 30 } })
  assert.equal(a.line, started('slow1', `taking over slow1: its tasks and role card go with it. The cloud handoff could not be fetched (timeout), so it gets this computer's copy (written 3 h ago)`))
  answer({ body: 'late', updatedAt: Date.now() })
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(a.prompt.includes(`Its handoff: ${file} `))
  assert.ok(!fs.existsSync(path.join(home, 'topics', ROOM, 'files', 'handoff-slow1@kai.md')))
  const b = await takeover('slow2', { cloud: () => new Promise(() => {}), seatOpts: { handoffFetchMs: 30 } })
  assert.match(b.line, /could not be fetched \(timeout\) and there is none on this computer/)
})

test('takeover with handoff=skip: nothing fetched or read, the prompt says nothing about a handoff, also with a local copy', async () => {
  const file = writeLocal('skip1')
  const { m, line, prompt, typedLine } = await takeover('skip1', { skip: true, cloud: { body: 'cloud', updatedAt: AT.getTime() } })
  assert.equal(line, started('skip1', 'taking over skip1: its tasks and role card go with it; handoff=skip, so its handoff was not read'))
  assert.deepEqual(m.fetched, [])
  assert.ok(!/hand ?(off|over)/i.test(prompt), prompt)
  assert.ok(!/hand ?(off|over)/i.test(typedLine || ''), typedLine)
  assert.ok(prompt.includes("## kai's instruction: what you are here to do\n\ngo on\n"))
  assert.ok(fs.existsSync(file), 'the local copy is left alone')

  // On a new name handoff=skip means nothing: a new seat has no handoff.
  const n = fakeMachine({ isDir: () => true })
  n.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  n.ask('@daemon.box@kai /spawn claude fresh1 /work handoff=skip start')
  await n.tick()
  await until(() => n.said.some((x) => x.includes('Started fresh1')))
  assert.match(n.said.at(-1), /Started fresh1 .* in \/work, a new name in this topic\./)
  assert.deepEqual(n.fetched, [])
  assert.deepEqual(parseSpawn('claude api handoff=skip go'), { kind: 'claude', name: 'api', needDir: true, model: null, effort: null, skipHandoff: true, prompt: 'go' })
  assert.deepEqual(parseSpawn('claude api /w model=m1 handoff=skip effort=high go'), { kind: 'claude', name: 'api', dir: '/w', model: 'm1', effort: 'high', skipHandoff: true, prompt: 'go' })
  assert.match(parseSpawn('claude api handoff=no go').error, /handoff= only takes skip/)
})

test('takeover fetch: a second /spawn meanwhile is "starting", deliveries go on, /bye ends it, a restart leaves it failed', async () => {
  const stateFile = path.join(home, 'seat-fetch.json')
  let answer
  const m = fakeMachine({ isDir: () => true, stateFile })
  m.memberList.push({ name: 'wait1@kai', kind: 'agent', status: 'left' })
  m.cloud['wait1@kai'] = () => new Promise((r) => { answer = r })
  m.ask('@daemon.box@kai /spawn claude wait1 /work go on')
  await m.tick()
  await until(() => m.fetched.length === 1)
  assert.equal(m.seat.ops.find((op) => op.name === 'wait1@kai').stage, 'starting')
  assert.ok(m.seat.busyWhy().length, 'a daemon update waits for it')
  m.ask('@daemon.box@kai /spawn claude wait1 /work again')
  m.ask('@daemon.box@kai /help')
  await m.tick()
  assert.ok(m.said.some((x) => /^@kai wait1 is starting on this computer\. To start over, \/bye wait1 first\.$/.test(x)), m.said.join('\n'))
  assert.ok(m.said.some((x) => x.startsWith('@kai Commands:')), 'other commands are answered while it fetches')

  // The daemon restarts meanwhile: the saved operation was starting, so it is failed.
  const again = createSeat({ api: m.api, terminal: { panes: async () => [] }, rooms: { get: () => null }, hostname: 'box', stateFile })
  assert.equal(again.ops.find((op) => op.name === 'wait1@kai').stage, 'failed')

  m.ask('@daemon.box@kai /bye wait1')
  await m.tick()
  answer({ body: 'late', updatedAt: Date.now() })
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(!m.said.some((x) => x.includes('Started wait1')), 'SAID:' + m.said.join('\n'))
  assert.ok(!fs.existsSync(path.join(home, 'spawns', ROOM, 'wait1.md')), 'no first prompt written for a /bye-d one')
  assert.ok(!fs.existsSync(path.join(home, 'topics', ROOM, 'files', 'handoff-wait1@kai.md')))
  assert.equal(m.seat.ops.some((op) => op.name === 'wait1@kai'), false)
})

test('seat: /attach binds only the joining agent when exactly one pane shows its one-time code', async () => {
  const m = fakeMachine()
  m.panes.push({ pane_id: 'w:p2', tab_id: 'w:t2', agent: 'codex', agent_status: 'working', cwd: '/work' })
  const { code } = createPending({ roomId: ROOM, name: 'qa@kai', role: 'qa', now: 1_000_000 })
  m.screen.byPane = { 'w:p1': 'another agent', 'w:p2': `join result ${code}` }
  m.ask(`@daemon.box@kai /attach ${code}`, 'qa@kai', 'agent')
  await m.tick()
  assert.equal(entries().find((e) => e.name === 'qa@kai')?.pane, 'w:p2')
  assert.match(m.said.at(-1), /Registered you on pane w:p2/)
  unregister({ roomId: ROOM, name: 'qa@kai' })

  const next = createPending({ roomId: ROOM, name: 'qa@kai', role: 'qa', now: 1_000_000 }).code
  m.screen.byPane = { 'w:p1': next, 'w:p2': next }
  m.ask(`@daemon.box@kai /attach ${next}`, 'qa@kai', 'agent')
  await m.tick()
  assert.equal(entries().some((e) => e.name === 'qa@kai'), false)
  assert.match(m.said.at(-1), /appeared in 2 agent panes/)
})

test('seat: spawned agents find this SCORPIO_HOME launcher before the private Node and inherited PATH', async (t) => {
  const nodeBin = path.join(home, 'node', 'bin')
  fs.mkdirSync(nodeBin, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'))
  t.after(() => fs.rmSync(path.join(home, 'node'), { recursive: true, force: true }))
  const m = fakeMachine({ isDir: () => true, spawnEnv: { SCORPIO_HOME: home, PATH: '/usr/bin:/bin' } })
  m.ask('@daemon.box@kai /spawn claude qa /work do things')
  await m.tick()
  assert.deepEqual(m.tabs[0].env.PATH.split(path.delimiter).slice(0, 2), [path.join(home, 'bin'), nodeBin])
  assert.equal(m.tabs[0].env.SCORPIO_HOME, home)
})

test('seat: a /spawn-ed agent stopped on a network API error before joining is told to carry on, once per stop, up to 5 times', async () => {
  const m = fakeMachine({ isDir: () => true })
  const pane = { pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' }
  m.panes.push(pane)
  m.ask('@daemon.box@kai /spawn claude qa /work do things')
  await m.tick()
  for (let i = 0; i < 20 && !m.said.some((t) => t.includes('Started qa')); i += 1) await new Promise((r) => setImmediate(r))
  assert.match(m.said.at(-1), /^@kai Started qa \(claude: /)
  assert.equal(m.tabs[0].env.PATH.split(path.delimiter)[0], path.join(home, 'bin'))
  const nudges = () => m.typed.filter(([p]) => p === 'w:p9').map(([, t]) => t)
  // Working (retrying), or idle with something else last: left alone.
  m.screen.text = DROPPED
  await m.tick()
  pane.agent_status = 'done'; m.screen.text = `● Read the file.\n\n${BOX}`
  m.advance(20_000); await m.tick()
  assert.deepEqual(nudges(), [])
  // Stopped on the error: told once; the same stop is not told again.
  m.screen.text = DROPPED
  m.advance(20_000); await m.tick()
  assert.equal(nudges().length, 1)
  assert.ok(nudges()[0].includes('Carry on where you left off'))
  assert.ok(nudges()[0].includes(path.join('spawns', ROOM, 'qa.md')))
  m.advance(20_000); await m.tick()
  assert.equal(nudges().length, 1)
  // It worked a while and stopped again: told again, up to NUDGE_MAX in all.
  for (let n = 2; n <= NUDGE_MAX; n += 1) {
    pane.agent_status = 'working'; m.advance(60_000); await m.tick()
    pane.agent_status = 'done'; m.advance(20_000); await m.tick()
    assert.equal(nudges().length, n)
  }
  // Once more: not typed, said once in the room.
  pane.agent_status = 'working'; m.advance(60_000); await m.tick()
  pane.agent_status = 'done'; m.advance(20_000); await m.tick()
  m.advance(60_000); await m.tick()
  assert.equal(nudges().length, NUDGE_MAX)
  assert.equal(m.said.filter((t) => t.includes('not nudging it any more')).length, 1)
  assert.match(m.said.find((t) => t.includes('not nudging it any more')), /^@kai qa stopped on an API connection error again after 5 nudges to carry on; not nudging it any more\. Its pane is still open \(\/bye qa closes it\)\.\nqa · its screen is with its owner, as a card only they can see; waiting for them\.$/)
  assert.deepEqual(m.sent.find((message) => message.text.includes('not nudging it any more')).screen, hideKeys(tail(m.screen.text)))
  // Joined after all: no longer watched.
  m.memberList.push({ name: 'qa@kai', kind: 'agent', status: 'active' })
  await m.tick()
  assert.equal(m.seat.ops.length, 0)
})

test('seat: /spawn of a name the topic has (left) keeps its card, whatever it says; only a new name gets the generic card', async () => {
  const spawnFile = (role) => fs.readFileSync(path.join(home, 'spawns', ROOM, `${role}.md`), 'utf8')
  const started = async (m, role) => {
    for (let i = 0; i < 20 && !m.said.some((t) => t.includes(`Started ${role}`)); i += 1) await new Promise((r) => setImmediate(r))
    assert.ok(m.said.some((t) => t.includes(`Started ${role}`)), m.said.join('\n'))
  }
  const m = fakeMachine({ isDir: () => true })
  m.panes.push({ pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' })
  m.memberList.push(
    { name: 'web@kai', kind: 'agent', status: 'left', roleCard: 'web: the pages; takes work from lead@kai' },
    { name: 'ops@kai', kind: 'agent', status: 'left', roleCard: 'ops: started by kai with /spawn; takes work from kai' },
    { name: 'doc@kai', kind: 'agent', status: 'left', roleCard: '' },
  )
  m.ask('@daemon.box@kai /spawn claude web /work Read the handover', 'lead@kai', 'agent')
  m.ask('@daemon.box@kai /spawn claude ops /work go on', 'lead@kai', 'agent')
  m.ask('@daemon.box@kai /spawn claude doc /work write it', 'lead@kai', 'agent')
  m.ask('@daemon.box@kai /spawn claude qa /work test it', 'lead@kai', 'agent')
  await m.tick()
  for (const role of ['web', 'ops', 'doc', 'qa']) await started(m, role)
  const web = spawnFile('web')
  assert.match(web, /^ {3}scorpio join topicId=AbCdEf0123456789_-ghIJ role=web resume=true pane=w:p9$/m)
  assert.ok(!/join .*roleCard=/.test(web))
  for (const role of ['ops', 'doc']) assert.match(spawnFile(role), new RegExp(`^ {3}scorpio join topicId=AbCdEf0123456789_-ghIJ role=${role} resume=true pane=w:p9$`, 'm'), `${role}: no roleCard`)
  assert.ok(spawnFile('qa').includes(`role=qa resume=true pane=w:p9 roleCard='qa: started by lead@kai with /spawn; takes work from lead@kai'`))
})

test('/usage: one line per CLI, Claude from its quota API and Codex from its app-server, no tab opened', async () => {
  const resetsAt = new Date(1_000_000 + 5 * 3_600_000).toISOString()
  const m = fakeMachine({
    which: () => true,
    claudeLimits: async () => ({ result: { limits: [{ kind: 'session', percent: 12, resets_at: resetsAt }, { kind: 'weekly_all', percent: 30, resets_at: null }] } }),
    codexLimits: async () => ({ error: 'authentication required' }),
  })
  m.ask('@daemon.box@kai /usage')
  await m.tick()
  assert.equal(m.said.at(-1), '@kai box:\nClaude Code: 5h 12% used (resets in 5h 0m) · week 30% used\nCodex: could not read the quota (not logged in)')
  assert.deepEqual(m.tabs, [])

  const n = fakeMachine({ which: (bin) => bin === 'claude', claudeLimits: async () => ({ reason: "Claude's login has expired; a Claude session started on this computer renews it" }) })
  n.ask('@daemon.box@kai /usage')
  await n.tick()
  assert.match(n.said.at(-1), /Claude Code: could not read the quota \(Claude's login has expired; .*\)\nCodex: not installed$/)
})

test('/usage: the line in the room', () => {
  const now = Date.UTC(2026, 9, 4, 12, 0)
  assert.deepEqual(codexWindows({ rateLimits: { primary: { windowDurationMins: 300, usedPercent: 4, resetsAt: now / 1000 + 600 } } }).map((x) => [x.label, x.pct]), [['5h', 4]])
  const w = [{ label: '5h', pct: 4, resetsAt: now + 600_000 }, { label: 'week', pct: 18, resetsAt: now + 50 * 3_600_000 }, { label: 'week Fable', pct: 13, resetsAt: now + 50 * 3_600_000 }]
  assert.equal(usageLine('Claude Code', { windows: w }, now), 'Claude Code: 5h 4% used (resets in 10m) · week 18% used (resets in 2d 2h) · week Fable 13% used')
  assert.equal(usageLine('Codex', { missing: true }, now), 'Codex: not installed')
  assert.equal(formatIn(90 * 60_000), '1h 30m')
})

test('seat: /reborn is gone: an unknown command, the short help, nothing typed or run', async () => {
  const m = fakeMachine()
  m.ask('@daemon.box@kai /reborn api')
  await m.tick()
  assert.equal(m.said.at(-1), `@kai Unknown command /reborn.\n${HELP_SHORT}`)
  assert.ok(!HELP_SHORT.includes('reborn'))
  assert.deepEqual(m.typed, [])
  assert.deepEqual(m.ran, [])
  assert.deepEqual(m.unregistered, [])
  assert.deepEqual(m.closed, [])
  assert.equal(m.seat.ops.length, 0)
})

// ------------------------------------------------------------------ idle handoff

test('idle clock: idle and done count; working, blocked, unknown, deliveries and gaps start it again', () => {
  const MIN = 60_000
  let c = idleClock(null, { status: 'idle', now: 0 })
  assert.deepEqual(c, { since: 0, seen: 0 })
  for (let t = 1; t <= 30; t += 1) c = idleClock(c, { status: t % 2 ? 'done' : 'idle', now: t * MIN })
  assert.deepEqual(c, { since: 0, seen: 30 * MIN })
  assert.equal(idleClock(c, { status: 'working', now: 31 * MIN }), null)
  assert.equal(idleClock(c, { status: 'blocked', now: 31 * MIN }), null, 'stuck at a dialog is not idle')
  assert.equal(idleClock(c, { status: 'unknown', now: 31 * MIN }), null)
  assert.equal(idleClock(c, { status: undefined, now: 31 * MIN }), null)
  assert.equal(idleClock(c, { status: 'idle', busy: true, now: 31 * MIN }), null, 'something delivered or waiting')
  // the turn a keep-alive starts is not work; real work after it is
  assert.deepEqual(idleClock(c, { status: 'working', now: 31 * MIN, keptAliveAt: 30 * MIN }), { since: 0, seen: 31 * MIN })
  assert.equal(idleClock(c, { status: 'working', now: 34 * MIN, keptAliveAt: 30 * MIN }), null)
  // not watched for a while (asleep, daemon down): nobody knows what happened, so it starts again
  assert.deepEqual(idleClock(c, { status: 'idle', now: 30 * MIN + IDLE_GAP_MS + 1 }), { since: 30 * MIN + IDLE_GAP_MS + 1, seen: 30 * MIN + IDLE_GAP_MS + 1 })
})

test('keep-alives stop when the agent is handed off within the hour; go on with a longer one or none', () => {
  assert.equal(keepaliveFor(60), 0)
  assert.equal(keepaliveFor(30), 0)
  assert.equal(keepaliveFor(0), KEEPALIVE_MS)
  assert.equal(keepaliveFor(120), KEEPALIVE_MS)
  assert.equal(keepaliveFor(60, { handsOff: false }), KEEPALIVE_MS, 'an agent idle handoff does not take keeps them')
  assert.equal(plan({ messages: [], quietSince: 1_000_000 - 51 * 60_000, kind: 'claude', now: 1_000_000, keepaliveMs: keepaliveFor(60) }).act, 'none')
})

test('idle handoff setting: config.json, default 60, 0 is off, the rest of the file kept', () => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ server: 'https://s.example', device_id: 'dev-123456' }))
  assert.equal(idleHandoffMinutes(), 60)
  setIdleHandoffMinutes(0)
  assert.equal(idleHandoffMinutes(), 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), { server: 'https://s.example', device_id: 'dev-123456', idle_handoff_minutes: 0 })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ idle_handoff_minutes: 'soon' }))
  assert.equal(idleHandoffMinutes(), 60, 'not a number: the default')
  assert.throws(() => setIdleHandoffMinutes(-1))
  fs.rmSync(CONFIG_FILE)
  assert.deepEqual(parseIdle(''), { show: true })
  assert.deepEqual(parseIdle('off'), { minutes: 0 })
  assert.deepEqual(parseIdle(' 120 '), { minutes: 120 })
  assert.deepEqual(parseIdle('90 分钟'), { minutes: 90 })
  assert.ok(parseIdle('soon').error)
  assert.match(idleNotice({ minutes: 60, role: 'api' }), /^api has been idle for 60 minutes, so it is handed off now\./)
  const h = handoffPrompt({ account: 'kai', roomId: ROOM, roomName: 'x', seq: 9, targets: 'api', file: '/f.md', daemonName: 'daemon.box@kai', kind: 'claude', name: 'api@kai', idleMinutes: 60 })
  assert.match(h, /^You have been idle for 60 minutes, so this computer's Scorpio daemon hands you off .* as if kai had sent \/handoff api \(idle handoff, #9 says so in the topic\)/)
  assert.ok(h.includes("replyTo=9 text='@kai handoff written: <link>'"))
})

test('handoff instructions (the skill\'s Handing off): write, store with scorpio handoff, tell the owner with the link, takeover, leave', () => {
  const file = path.join(home, 'topics', ROOM, 'handoffs', 'api.md')
  const h = handoffPrompt({ account: 'kai', roomId: ROOM, roomName: 'x', seq: 7, targets: 'api', file, daemonName: 'daemon@kai', kind: 'claude', name: 'api@kai', dir: '/w' })
  const steps = h.split('\n\n')
  assert.match(steps[0], /: hand off, then leave\. Whoever takes over gets the topic, your role card and your tasks from Scorpio, and everything else only from this handoff\./)
  assert.ok(steps[2].startsWith(`2. Write the handoff to ${file}, short, facts only, under four headings`))
  assert.ok(steps[2].endsWith('\n   Never put tokens, keys or passwords in a handoff: everyone who can read the topic can read it. Local paths and directory names are fine.'), steps[2])
  assert.equal(steps[3], `3. Store it: scorpio handoff topicId=${ROOM} role=api file=${file}\n   stored "cloud": its link goes in step 4 (the file is gone from this computer; that is right). stored "local" (this account keeps handoffs on agents' computers): nothing to say about it. handoff_too_large: shorten it and run the same command again. handoff_space_full: go on, and add its line to step 5. Any other error: do what its next says, then go on and say nothing about it (the file stays; the next /spawn says where the handoff came from).`)
  assert.equal(steps[4], `4. Tell kai: scorpio send topicId=${ROOM} role=api replyTo=7 text='@kai handoff written: <link>' (the link from step 3); without a link: text='@kai handoff written.'`)
  assert.ok(steps[5].startsWith('5. Post the takeover command'))
  assert.ok(steps[5].includes('The same name gets your tasks, card and this handoff by itself'))
  assert.ok(steps[5].endsWith(`Only after handoff_space_full in step 3, the explanation line ends with: ${SPACE_FULL_LINE}`), 'the space-full line only after handoff_space_full')
  assert.equal(SPACE_FULL_LINE, 'Cloud handoffs for this account in this topic are full (2.5 MB), so this handoff was not uploaded. Delete handoffs of seats you no longer need from their member cards; the next handoff will then upload.')
  assert.equal(steps[6], `6. Leave: scorpio leave topicId=${ROOM} role=api (this terminal is closed afterwards).`)
  assert.equal(h.split(SPACE_FULL_LINE).length, 2, 'said once')
  assert.ok(!/only on this computer/i.test(h), 'neutral: no warning that the handoff stays on this computer')
  assert.ok(!/handover/i.test(h))
  assert.equal(parseCommand(steps[5].split('\n').slice(1, 5).map((l) => l.trim()).join('\n')), null, 'the takeover example is not run as a command')
  for (const c of COMMANDS) assert.ok(!/handover/i.test(c.help), c.name)
  assert.ok(HELP_FULL.includes('`/spawn claude|codex [name] [<dir>|cwd="…"] [model=…] [effort=…] [handoff=skip] [perm=ask|auto|all] [prompt]`'))
})

const API = { roomId: ROOM, name: 'api@kai', role: 'api', pane: 'w:p1' }

test('idle handoff: said in the room first, handed over like /handoff, nothing more once it left', async () => {
  const m = fakeMachine()
  await m.tick()
  assert.equal(await m.seat.idleHandoff({ entry: API, minutes: 60, panes: m.panes }), 'started')
  assert.equal(m.said.length, 1)
  assert.match(m.said[0], /^@kai api has been idle for 60 minutes, so it is handed off now\. \(This computer's setting: @ me with \/idle 120 to change the time, \/idle off to turn it off\.\)$/)
  assert.equal(m.typed.length, 1)
  assert.match(m.typed[0][1], /^You have been idle for 60 minutes/)
  assert.ok(m.typed[0][1].includes('#101 says so in the topic'), 'the notice is the message it answers')
  assert.equal(await m.seat.idleHandoff({ entry: API, minutes: 60, panes: m.panes }), 'a command is already handling it')
  assert.equal(m.seat.idle(), false, 'no restart while it hands over')
  m.memberList.find((x) => x.name === 'api@kai').status = 'left'
  await m.tick()
  assert.deepEqual(m.closed, ['w:p1'])
  assert.deepEqual(m.unregistered, ['api@kai'])
  assert.equal(m.said.length, 1, 'its own handover messages say the rest')
})

test('idle handoff: one that does not leave is reported; a dialog on screen stops it before anything is said', async () => {
  const m = fakeMachine()
  await m.tick()
  m.screen.text = 'Update available! Run: claude update\n❯ Update now\n  Skip until next version'
  assert.equal(await m.seat.idleHandoff({ entry: API, minutes: 60, panes: m.panes }), 'a dialog is open')
  assert.deepEqual([m.said, m.typed], [[], []])
  m.screen.text = '> '
  assert.equal(await m.seat.idleHandoff({ entry: API, minutes: 60, panes: m.panes }), 'started')
  m.advance(HANDOFF_MS + 1000)
  await m.tick()
  assert.match(m.said.at(-1), /^@kai ⏳ api · did not leave within 2 hours; pane left open/)
  assert.deepEqual(m.closed, [])
})

test('/idle shows and changes the setting; the seat tells the server on its next join', async () => {
  let minutes = 60
  const idleSetting = { minutes: () => minutes, set: (n) => { minutes = n; return n }, report: () => [{ name: 'api@kai', idleMinutes: 12 }], keepalives: () => minutes === 0 || minutes > 60 }
  const m = fakeMachine({ idleSetting })
  await m.tick()
  assert.equal(m.joins.at(-1).idleHandoffMinutes, 60)
  const joined = m.joins.length
  m.ask('@daemon.box@kai /idle')
  await m.tick()
  assert.match(m.said.at(-1), /^@kai box: idle handoff after 60 minutes\. .* no keep-alives .* Now: api idle 12 min\. \/idle 120 changes it, \/idle off turns it off/)
  assert.equal(m.joins.length, joined, 'unchanged: no new join')
  m.ask('@daemon.box@kai /idle 120')
  await m.tick()
  assert.equal(minutes, 120)
  assert.match(m.said.at(-1), /^@kai box: idle handoff after 120 minutes \(was 60 minutes\)\. .*keep-alives go on until then/)
  await m.tick()
  assert.equal(m.joins.at(-1).idleHandoffMinutes, 120, 'joined again to report it')
  m.ask('@daemon.box@kai /idle off')
  await m.tick()
  assert.equal(minutes, 0)
  assert.match(m.said.at(-1), /^@kai box: idle handoff is off \(was 120 minutes\); agents here stay until \/handoff\. \/idle 60 turns it on\.$/)
  m.ask('@daemon.box@kai /idle soon')
  await m.tick()
  assert.match(m.said.at(-1), /takes a number of minutes .* Usage: \/idle \[minutes\|off\]/)
})

// ------------------------------------------------------------------ the daemon's own traffic

test('seat cursor: read up to the room\'s last message, not only the last command; a full listen is read again', async () => {
  const m = fakeMachine()
  m.room.total = 40
  await m.tick()
  assert.deepEqual(m.marks, [40], 'no command: still read up to the end')
  await m.tick()
  assert.deepEqual(m.marks, [40], 'nothing new: no mark')
  m.room.total = 60
  m.ask('@daemon.box@kai /help')
  await m.tick()
  assert.equal(m.marks.at(-1), 60)
  // 150 waking messages: a listen returns 100, so the cursor stops at the 100th and the rest is read next round.
  for (let i = 0; i < 150; i += 1) m.inbox.push({ seq: 200 + i, from: 'kai', fromKind: 'human', text: '@daemon.box@kai hi', ts: 0 })
  m.room.total = 400
  await m.tick()
  assert.equal(m.marks.at(-1), 299)
  assert.equal(m.seat.more(), true, 'more to read: the loop comes back soon')
  await m.tick()
  assert.equal(m.marks.at(-1), 400)
  assert.equal(m.seat.more(), false)
})

test('rooms of the account: listed every 5 minutes, at once after rooms_changed', async () => {
  const m = fakeMachine()
  await m.tick()
  await new Promise((r) => setImmediate(r))
  const first = m.listed.length
  assert.ok(first >= 1)
  m.advance(60_000)
  await m.tick()
  assert.equal(m.listed.length, first, 'not every 15 s any more')
  m.seat.roomsChanged()
  await m.tick()
  assert.equal(m.listed.length, first + 1)
  m.advance(OWNED_ROOMS_MS)
  await m.tick()
  assert.equal(m.listed.length, first + 2)
})

test('links: a handshake that never ends is given up after 45 s and tried again; a late close of the old socket leaves the new one alone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const sockets = []
  class FakeWS {
    constructor() { this.l = {}; this.closed = 0; sockets.push(this) }
    addEventListener(type, fn) { this.l[type] = fn }
    send() {}
    close() { this.closed += 1 }
    fire(type, ev = {}) { this.l[type]?.(ev) }
  }
  const frames = []
  const links = createLinks({ api: { wsUrl: () => 'ws://x', token: () => 't', userAgent: 'u' }, onFrame: (link, f) => frames.push(f), WebSocketImpl: FakeWS })
  links.sync([{ key: 'h|R', roomId: 'R', role: 'daemon', host: true }])
  assert.equal(sockets.length, 1)
  t.mock.timers.tick(OPEN_MS - 1)
  assert.deepEqual(frames, [])
  t.mock.timers.tick(1)
  assert.deepEqual(frames, [{ type: 'closed', reason: 'not connected within 45 s' }])
  assert.equal(sockets[0].closed, 1)
  t.mock.timers.tick(1000) // first retry after a second
  assert.equal(sockets.length, 2)
  sockets[1].fire('open')
  assert.equal(links.get('h|R').isOpen, true)
  sockets[0].fire('close', { code: 1006 }) // the abandoned one closes at last
  sockets[0].fire('open')
  assert.equal(links.get('h|R').isOpen, true)
  assert.deepEqual(frames.map((f) => f.type), ['closed', 'open'])
  t.mock.timers.tick(OPEN_MS) // open: no handshake timeout any more
  assert.equal(sockets.length, 2)
  links.closeAll()
})

test('links: a WebSocket that cannot even be made says why, once per reason, and keeps trying', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let made = 0
  class Throws { constructor() { made += 1; throw new TypeError('WebSocket is not a constructor') } }
  const frames = []
  const links = createLinks({ api: { wsUrl: () => 'ws://x', token: () => 't', userAgent: 'u' }, onFrame: (link, f) => frames.push(f), WebSocketImpl: Throws })
  links.sync([{ key: 'h|R', roomId: 'R', role: 'daemon', host: true }])
  t.mock.timers.tick(1000); t.mock.timers.tick(2000); t.mock.timers.tick(4000)
  assert.equal(made, 4)
  assert.deepEqual(frames, [{ type: 'closed', reason: 'could not start: WebSocket is not a constructor' }, { type: 'failing' }])
  links.closeAll()
})

test('newer Node: private Scorpio Node first, then SCORPIO_NODE and nvm; only 22 or newer', async () => {
  const { newerNode } = await import('../src/daemon/node.mjs')
  const versions = { '/n/22/node': 'v22.23.2\n', '/h/.nvm/versions/node/v24.1.0/bin/node': 'v24.1.0\n', '/h/.nvm/versions/node/v22.4.0/bin/node': 'v22.4.0\n', '/h/.nvm/versions/node/v20.20.0/bin/node': 'v20.20.0\n', '/opt/homebrew/bin/node': 'v23.0.0\n', '/usr/local/bin/node': 'v18.0.0\n' }
  const io = (extra = {}) => ({ home: '/h', exists: (p) => p in versions, list: (d) => (d === '/h/.nvm/versions/node' ? ['v20.20.0', 'v22.4.0', 'v24.1.0'] : []), versionOf: (p) => versions[p], ...extra })
  assert.equal(newerNode({ ...io(), env: { SCORPIO_NODE: '/n/22/node' }, exists: (p) => p === '/h/.scorpio/node/bin/node' || p in versions,
    versionOf: (p) => p === '/h/.scorpio/node/bin/node' ? 'v22.23.3' : versions[p] }), '/h/.scorpio/node/bin/node')
  assert.equal(newerNode({ ...io(), env: { SCORPIO_NODE: '/n/22/node' } }), '/n/22/node')
  assert.equal(newerNode({ ...io(), env: {} }), '/h/.nvm/versions/node/v24.1.0/bin/node')
  assert.equal(newerNode({ ...io({ list: () => ['v20.20.0'] }), env: {} }), '/opt/homebrew/bin/node')
  assert.equal(newerNode({ ...io({ list: () => [], exists: (p) => p === '/usr/local/bin/node' }), env: {} }), null)
  assert.equal(newerNode({ ...io(), env: { SCORPIO_NODE: '/usr/local/bin/node', NVM_DIR: '/elsewhere' } }), '/opt/homebrew/bin/node')
})

test('removed: this computer\'s entries in that topic go and the seat forgets it, so it does not come back', () => {
  const dropped = [], said = []
  const names = { R1: ['api@kai', 'ui@kai'], R2: [] }
  const deps = { leftTopic: (r, why) => { dropped.push([r, why]); return names[r] }, log: (l) => said.push(l) }
  topicLeft('R1', { type: 'removed', account: 'kai', by: 'kai' }, deps)
  assert.deepEqual(dropped, [['R1', 'was left by this account']])
  assert.match(said[0], /^kai left R1; api@kai, ui@kai no longer delivered to$/)
  // Asked to leave by the topic's creator.
  topicLeft('R2', { type: 'removed', account: 'kai', by: 'mei' }, deps)
  assert.deepEqual(dropped.at(-1), ['R2', "was left at mei's request"])
  assert.equal(said.at(-1), 'kai left R2')
})

// ------------------------------------------------------------------ /read, /keys, /text

test('/read, /keys, /text: parsing; /keys and /text are stale after 2 minutes, /read never', () => {
  assert.deepEqual(parseRead('qa', 'kai'), { name: 'qa@kai', lines: 30 })
  assert.deepEqual(parseRead('@qa@kai 12', 'kai'), { name: 'qa@kai', lines: 12 })
  assert.deepEqual(parseRead('qa 500', 'kai'), { name: 'qa@kai', lines: 100 })
  assert.match(parseRead('', 'kai').error, /Name an agent/)
  assert.match(parseRead('qa many', 'kai').error, /"many" is not a number of lines/)
  const find = (w) => findKey(DEFAULT_KEYS.keys, w)
  assert.deepEqual(parseKeys('qa down Enter ↑, esc', 'kai', find).keys.map((k) => k.name), ['down', 'enter', 'up', 'esc'])
  assert.deepEqual(parseKeys('qa left', 'kai', find), { error: '"left" is not a key here', unknown: 'left' })
  assert.match(parseKeys('qa', 'kai', find).error, /at least one key/)
  assert.deepEqual(parseText('qa  go on, please  ', 'kai'), { name: 'qa@kai', text: 'go on, please  ' })
  assert.deepEqual(parseText('qa yes\n', 'kai'), { name: 'qa@kai', text: 'yes' })
  assert.match(parseText('qa one\ntwo', 'kai').error, /one line/)
  assert.match(parseText('qa a\tb', 'kai').error, /one line/)
  assert.match(parseText('qa   ', 'kai').error, /Give the text/)
  const at = (text, age) => judge({ message: { seq: 1, from: 'kai', fromKind: 'human', text, ts: 0 }, account: 'kai', seatName: 'daemon@kai', now: age })
  assert.equal(at('@daemon@kai /keys qa enter', 119_000).act, 'run')
  assert.equal(at('@daemon@kai /keys qa enter', 121_000).act, 'stale')
  assert.equal(at('@daemon@kai /text qa yes', 121_000).act, 'stale')
  assert.equal(at('@daemon@kai /read qa', 24 * 3600_000).act, 'run')
  for (const c of ['/read <name> [lines]', '/keys <name> <key>…', '/text <name> <text>']) {
    assert.ok(HELP_SHORT.includes(c), c)
    assert.ok(HELP_FULL.includes(`\`${c}\``), c)
  }
})

test('runsCli: the CLI in front of the pane, not the shell it exited to', () => {
  const info = (...procs) => ({ foreground_processes: procs })
  assert.equal(runsCli(info({ name: 'claude', argv: ['claude', '--dangerously-skip-permissions', 'reply ok'] }), 'claude'), true)
  assert.equal(runsCli(info({ name: 'node', argv: ['node', '/usr/lib/node_modules/@openai/codex/bin/codex'] }), 'codex'), true)
  assert.equal(runsCli(info({ name: 'bash', argv: ['/bin/bash'] }), 'claude'), false)
  assert.equal(runsCli(info({ name: 'codex', argv: ['codex'] }), 'claude'), false)
  assert.equal(runsCli(null, 'claude'), false)
})

test('key table: the server\'s when it is one, else the default; asked at most once a minute; each adapter its own column', async () => {
  assert.equal(keyTable({ keys: [], settleMs: 3000 }), null)
  assert.equal(keyTable({ keys: [{ name: 'up' }], settleMs: 3000 }), null)
  assert.equal(keyTable({ keys: [{ name: 'up', label: '↑', herdr: 'up' }], settleMs: 0 }), null)
  assert.equal(keyTable({ keys: [{ name: 'up', label: '↑', herdr: 'up' }] }), null)
  const custom = { keys: [{ name: 'tab', label: 'Tab', herdr: 'tab' }, { name: 'f1', label: 'F1', tmux: 'F1' }], settleMs: 1500 }
  assert.deepEqual(keyTable(custom), custom)
  assert.deepEqual(keysFor(custom, 'herdr').map((k) => k.name), ['tab'])
  assert.deepEqual(keysFor(DEFAULT_KEYS, 'herdr').map((k) => k.herdr), ['up', 'down', 'enter', 'esc'])
  let clock = 0, asked = 0, answer = custom
  const get = createKeys({ fetch: async () => { asked += 1; if (answer instanceof Error) throw answer; return answer }, now: () => clock })
  assert.deepEqual(await get(), custom)
  clock = 59_000; await get()
  assert.equal(asked, 1, 'cached for a minute')
  clock = 61_000; answer = Object.assign(new Error('offline'), { code: 'network' })
  assert.deepEqual(await get(), DEFAULT_KEYS, 'not reachable: the default')
  clock = 122_000; answer = { keys: 'nope' }
  assert.deepEqual(await get(), DEFAULT_KEYS, 'not a table: the default')
  assert.equal(asked, 3)
})

const QA_PANE = { pane_id: 'w:p9', tab_id: 'w:t9', agent: 'claude', agent_status: 'working', cwd: '/work' }
const CLAUDE_FG = { foreground_processes: [{ name: 'claude', argv: ['claude', '--dangerously-skip-permissions'], pid: 7 }] }
const BASH_FG = { foreground_processes: [{ name: 'bash', argv: ['/bin/bash'], pid: 6 }] }

/** A /spawn qa that stopped at a dialog while starting (herdr: blocked), not joined yet. */
async function spawnedAtDialog(seatOpts = {}, { kind = 'claude', dir = '/work', from = 'kai', fromKind = 'human', perm = '' } = {}) {
  const m = fakeMachine({ isDir: () => true, ...seatOpts })
  const pane = { ...QA_PANE, agent: kind, agent_status: 'blocked' }
  m.panes.push(pane)
  m.screen.byPane = { 'w:p9': ' Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel' }
  m.ask(`@daemon.box@kai /spawn ${kind} qa ${dir} ${perm} do things`, from, fromKind)
  await m.tick()
  for (let i = 0; i < 20 && !m.said.some((t) => /has not joined yet|Started qa /.test(t)); i += 1) await new Promise((r) => setImmediate(r))
  return { m, pane }
}

test('/spawn: joining screen is sampled every 5s, resets on change, and reports once at 30s', async () => {
  const m = fakeMachine({ isDir: () => true })
  const pane = { ...QA_PANE }
  m.panes.push(pane)
  m.ask('@daemon.box@kai /spawn claude qa /work go', 'api@kai', 'agent')
  await m.tick()
  pane.agent_status = 'idle'
  m.screen.text = 'Trust this folder?'
  await m.tick()
  const notices = () => m.said.filter((t) => t.includes('has not joined yet'))
  for (let i = 0; i < 5; i++) { m.advance(5000); await m.tick() }
  assert.equal(notices().length, 0)
  m.screen.text += ' '
  m.advance(5000); await m.tick()
  for (let i = 0; i < 5; i++) { m.advance(5000); await m.tick() }
  assert.equal(notices().length, 0, 'raw text change restarts the clock')
  m.advance(5000); await m.tick()
  assert.equal(notices().length, 1)
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(m.screen.text)))
  assert.match(notices()[0], /^@api@kai qa has not joined yet\. Its screen has not changed for 30s; the daemon does not answer it\.\nqa · its screen is with its owner, as a card only they can see; waiting for them\.$/)
  assert.doesNotMatch(notices()[0], /\/(read|keys|text|bye)/)
  m.screen.text = 'Another question'
  m.advance(5000); await m.tick()
  m.advance(30000); await m.tick()
  assert.equal(notices().length, 1, 'only once per spawn, even after screen changes')
  m.advance(SPAWN_JOIN_MS); await m.tick()
  assert.match(m.said.at(-1), /^@api@kai qa has not joined after 10 minutes; its pane is still open \(\/bye qa closes it\)\.\nqa · its screen is with its owner, as a card only they can see; waiting for them\.$/)
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(m.screen.text)))
  m.memberList.push({ name: 'qa@kai', kind: 'agent', status: 'active' })
  await m.tick()
  assert.equal(m.seat.ops.length, 0)
})

test('/spawn: startup trust unrecognized by Herdr reports after 30 seconds without pressing anything', async () => {
  let m
  m = fakeMachine({ isDir: () => true, sleep: async (ms) => { m.advance(ms) } })
  m.panes.push({ ...QA_PANE, agent_status: 'idle' })
  m.screen.text = 'Do you trust this directory?'
  m.ask('@daemon.box@kai /spawn claude qa /work go')
  await m.tick()
  for (let i = 0; i < 20 && !m.said.some((t) => t.includes('has not joined yet')); i += 1) await new Promise((r) => setImmediate(r))
  assert.match(m.said.at(-1), /screen has not changed for 30s; the daemon does not answer it\.\nqa · its screen is with its owner, as a card only they can see; waiting for them\.$/)
  assert.equal(m.seat.ops[0].stage, 'joining')
  assert.deepEqual(m.pressed, [])
})

test('/spawn: update prompt and Codex blocked dialog use the same early notice', async () => {
  const { m } = await spawnedAtDialog({}, { kind: 'codex' })
  assert.match(m.said.at(-1), /screen has not changed for 0s; the daemon does not answer it\.\nqa · its screen is with its owner, as a card only they can see; waiting for them\.$/)
  const u = fakeMachine({ isDir: () => true })
  u.panes.push({ ...QA_PANE, agent_status: 'idle' })
  u.screen.text = 'Update available! Run: claude update\n❯ Update now\n  Skip until next version'
  u.ask('@daemon.box@kai /spawn claude qa /work go')
  await u.tick()
  assert.match(u.said.at(-1), /screen has not changed for 0s; the daemon does not answer it\.\nqa · its screen is with its owner, as a card only they can see; waiting for them\.$/)
})

test('/spawn: working or changing screens do not stall; join ends screen sampling', async () => {
  const m = fakeMachine({ isDir: () => true })
  const pane = { ...QA_PANE }
  m.panes.push(pane)
  m.ask('@daemon.box@kai /spawn claude qa /work go')
  await m.tick()
  for (let i = 0; i < 8; i++) { m.advance(5000); await m.tick() }
  assert.equal(m.said.filter((t) => t.includes('has not joined yet')).length, 0)
  pane.agent_status = 'idle'
  for (let i = 0; i < 8; i++) { m.screen.text = `Reading ${i}`; m.advance(5000); await m.tick() }
  assert.equal(m.said.filter((t) => t.includes('has not joined yet')).length, 0)
  let reads = 0
  m.terminal.read = async () => { reads++; return m.screen.text }
  m.advance(4999); await m.tick()
  assert.equal(reads, 0, 'no extra read inside the 5s screen interval')
  m.memberList.push({ name: 'qa@kai', kind: 'agent', status: 'active' })
  m.advance(5000); await m.tick()
  assert.equal(reads, 0, 'no screen read after join')
  assert.equal(m.seat.ops.length, 0)
})

test('/spawn: a dialog while starting is not answered; it reports only the fact and screen', async () => {
  const { m } = await spawnedAtDialog()
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(await m.terminal.read('w:p9'))))
  assert.deepEqual(m.pressed, [], 'no key pressed by the daemon')
  assert.match(m.said.at(-1), /^@kai qa has not joined yet\. Its screen has not changed for 0s; the daemon does not answer it\.\nqa · its screen is with its owner, as a card only they can see; waiting for them\.$/)
  assert.doesNotMatch(m.said.at(-1), /\/(read|keys|text|bye)/)
  assert.equal(m.seat.ops[0].stage, 'joining')
})

test('/spawn: a dialog still wakes the agent that sent the command', async () => {
  const { m } = await spawnedAtDialog({}, { from: 'api@kai', fromKind: 'agent' })
  assert.match(m.said.at(-1), /^@api@kai qa has not joined yet\./)
})

test('/keys: presses table keys in order 200 ms apart, then shows the screen after settleMs; a not-joined spawn gets 10 more minutes', async () => {
  const { m, pane } = await spawnedAtDialog()
  m.fg['w:p9'] = CLAUDE_FG
  m.events.length = 0
  m.ask('@daemon.box@kai /keys qa down Enter', 'lead@kai', 'agent')
  await m.tick()
  assert.deepEqual(m.pressed, [['w:p9', 'down'], ['w:p9', 'enter']])
  assert.deepEqual(m.events.filter((e) => /^(keys|sleep)/.test(e)).map((e) => e.replace(/@\d+$/, '')), ['keys:down', `sleep:${KEY_GAP_MS}`, 'keys:enter', 'sleep:3000'])
  assert.match(m.said.at(-1), /^@lead@kai qa · pressed ↓ Enter\.\nqa · its screen is with its owner, as a card only they can see\.$/)
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(await m.terminal.read('w:p9'), 20)))
  assert.equal(m.seat.ops[0].stage, 'joining')
  pane.agent_status = 'working'
  m.advance(SPAWN_JOIN_MS - 1000); await m.tick()
  assert.ok(!m.said.at(-1).includes('has not joined'))
  m.advance(2000); await m.tick()
  assert.match(m.said.at(-1), /^@kai qa has not joined after 10 minutes; its pane is still open \(\/bye qa closes it\)\.\nqa · its screen is with its owner, as a card only they can see; waiting for them\.$/)
  // It joins: no longer a /spawn record.
  m.memberList.push({ name: 'qa@kai', kind: 'agent', status: 'active' })
  await m.tick()
  assert.equal(m.seat.ops.length, 0)
})

test('/keys and /text send nothing when the CLI is no longer in front (back at the shell): the reason and the screen', async () => {
  const { m } = await spawnedAtDialog()
  m.fg['w:p9'] = BASH_FG
  m.ask('@daemon.box@kai /keys qa enter')
  m.ask('@daemon.box@kai /text qa yes')
  await m.tick()
  assert.deepEqual(m.pressed, [])
  assert.match(m.said.at(-2), /^@kai ✗ qa · Claude Code is no longer in front of its pane \(bash is\), so nothing was pressed\.\nqa · its screen is with its owner, as a card only they can see\.$/)
  assert.match(m.said.at(-1), /^@kai ✗ qa · Claude Code is no longer in front of its pane \(bash is\), so nothing was typed\.\nqa · its screen is with its owner, as a card only they can see\.$/)
  assert.deepEqual(m.sent.at(-2).screen, hideKeys(tail(await m.terminal.read('w:p9'))))
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(await m.terminal.read('w:p9'))))
  m.fg['w:p9'] = null
  m.ask('@daemon.box@kai /keys qa enter')
  await m.tick()
  assert.match(m.said.at(-1), /\(herdr cannot say what is\), so nothing was pressed/)
  assert.deepEqual(m.pressed, [])
})

test('/text types one line without Enter, then shows the screen; /keys to one pane run in the order they came', async () => {
  const { m } = await spawnedAtDialog()
  m.fg['w:p9'] = CLAUDE_FG
  m.ask('@daemon.box@kai /text qa go on')
  await m.tick()
  assert.deepEqual(m.pressed, [['w:p9', 'text:go on']])
  assert.match(m.said.at(-1), /^@kai qa · typed the text, Enter not pressed\.\nqa · its screen is with its owner, as a card only they can see\.$/)
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(await m.terminal.read('w:p9'), 20)))
  m.ask('@daemon.box@kai /text qa line one\nline two')
  await m.tick()
  assert.match(m.said.at(-1), /^@kai The text must be one line.*Usage: \/text <name> <text>$/)
  m.pressed.length = 0; m.events.length = 0
  m.ask('@daemon.box@kai /keys qa down')
  m.ask('@daemon.box@kai /keys qa enter')
  await m.tick()
  assert.deepEqual(m.events.filter((e) => /^(keys|sleep)/.test(e)).map((e) => e.replace(/@\d+$/, '')), ['keys:down', 'sleep:3000', 'keys:enter', 'sleep:3000'])
})

test('/keys: an unknown key lists the keys; the server\'s table decides, in its herdr column, with its settleMs', async () => {
  const { m } = await spawnedAtDialog({ keyTable: async () => ({ keys: [{ name: 'tab', label: 'Tab', herdr: 'tab' }, { name: 'f1', label: 'F1', tmux: 'F1' }], settleMs: 1500 }) })
  m.fg['w:p9'] = CLAUDE_FG
  m.ask('@daemon.box@kai /keys qa f1')
  await m.tick()
  assert.equal(m.said.at(-1), '@kai "f1" is not a key here. Usage: /keys <name> <key>…; keys: tab (Tab).')
  m.ask('@daemon.box@kai /keys qa tab')
  await m.tick()
  assert.deepEqual(m.pressed, [['w:p9', 'tab']])
  assert.match(m.said.at(-1), /^@kai qa · pressed Tab\.\nqa · its screen is with its owner, as a card only they can see\.$/)
})

test('/read: a joined agent this daemon started, found in the registry; others are refused with the reason', async () => {
  const m = fakeMachine()
  m.panes.push({ ...QA_PANE })
  m.memberList.push({ name: 'qa@kai', kind: 'agent', status: 'active' }, { name: 'web@kai', kind: 'agent', status: 'active' })
  writeJson(spawnRecordPath(ROOM, 'qa@kai'), { kind: 'claude', dir: '/work', pane: 'w:p9', at: 1 })
  writeJson(spawnRecordPath(ROOM, 'web@kai'), { kind: 'claude', dir: '/work', pane: 'w:p7', at: 1 })
  m.screen.byPane = { 'w:p9': Array.from({ length: 140 }, (_, i) => `line ${i + 1}`).join('\n') }
  const entries = [{ roomId: ROOM, name: 'api@kai', role: 'api', pane: 'w:p1' }, { roomId: ROOM, name: 'qa@kai', role: 'qa', pane: 'w:p9' }, { roomId: ROOM, name: 'web@kai', role: 'web', pane: 'w:p7' }]
  m.ask('@daemon.box@kai /read qa')
  await m.tick(entries)
  assert.match(m.said.at(-1), /^@kai qa · last 30 lines:\nqa · its screen is with its owner, as a card only they can see\.$/)
  assert.equal(m.sent.at(-1).screen.text, Array.from({ length: 30 }, (_, i) => `line ${i + 111}`).join('\n'))
  m.ask('@daemon.box@kai /read qa 500')
  await m.tick(entries)
  assert.match(m.said.at(-1), /^@kai qa · last 100 lines:/)
  assert.equal(m.sent.at(-1).screen.text.split('\n').length, 100)
  assert.ok(m.sent.at(-1).screen.text.startsWith('line 41\n'))
  m.ask('@daemon.box@kai /read api')
  await m.tick(entries)
  assert.equal(m.said.at(-1), '@kai ✗ api · not started by this daemon (/spawn), so /read does not reach its pane')
  m.ask('@daemon.box@kai /read web')
  await m.tick(entries)
  assert.equal(m.said.at(-1), '@kai ✗ web · its pane is closed')
  m.ask('@daemon.box@kai /read nobody')
  await m.tick(entries)
  assert.equal(m.said.at(-1), '@kai ✗ nobody · not in this topic. Agents this daemon started here: qa, web. Usage: /read <name> [lines]')
  // Another account's pane is never read; an agent of the account may.
  m.ask('@daemon.box@kai /read qa', 'zoe', 'human')
  m.ask('@daemon.box@kai /read qa 2', 'lead@kai', 'agent')
  await m.tick(entries)
  assert.match(m.said.at(-2), /^@zoe This daemon only takes commands from kai/)
  assert.match(m.said.at(-1), /^@lead@kai qa · last 2 lines:/)
})

test('/keys older than 2 minutes is not run; /read is', async () => {
  const { m } = await spawnedAtDialog()
  m.fg['w:p9'] = CLAUDE_FG
  m.ask('@daemon.box@kai /keys qa enter')
  m.ask('@daemon.box@kai /read qa 5')
  m.advance(3 * 60_000)
  await m.tick()
  assert.deepEqual(m.pressed, [])
  assert.ok(m.said.some((t) => /^@kai This one is 3 minutes old, so it was not run/.test(t)))
  assert.match(m.said.at(-1), /^@kai qa · last 5 lines:/)
})

test('a pane herdr reports blocked gets no typed text: /handoff says it is stuck on a dialog; /help lists the keys; the seat card the commands', async () => {
  const m = fakeMachine()
  m.panes[0].agent_status = 'blocked'
  m.ask('@daemon.box@kai /handoff api')
  await m.tick()
  assert.deepEqual(m.typed, [])
  assert.match(m.said.at(-1), /^@kai ✗ api · stuck on a dialog; the handoff instructions were not typed in, nothing done/)
  m.ask('@daemon.box@kai /help')
  await m.tick()
  assert.ok(m.said.at(-1).includes('- `/keys <name> <key>…`: press these keys'))
  assert.ok(m.said.at(-1).endsWith('\nKeys for /keys: up (↑), down (↓), enter (Enter), esc (Esc).'))
  assert.match(m.joins[0].roleCard, /\(\/attach \/spawn \/handoff \/bye \/idle \/read \/keys \/text \/usage \/help\)/)
})

// ------------------------------------------------------------------ detecting the agent CLIs

/** A detector whose answers the test sets: world.claude / world.codex = the version, or null for not installed. */
function fakeDetector(world, at = new Date(2026, 9, 17, 12, 0).getTime()) {
  const looked = []
  const detector = createDetector({ detectOne: async (kind) => { looked.push(kind); return { kind, installed: world[kind] != null, version: world[kind] || null, at } } })
  return { detector, looked }
}

test('detection: the first join already carries the CLIs and an Agent CLIs line without hostnames or versions on the card', async () => {
  const { detector } = fakeDetector({ claude: '2.1.301', codex: null })
  const m = fakeMachine({ detector })
  await m.tick()
  assert.equal(m.joins.length, 1)
  assert.match(m.joins[0].roleCard, /\. Agent CLIs: Claude Code; Codex not installed\. Spawn options: claude · codex \(model=, effort=; see \/help\)\. Takes only commands/)
  assert.doesNotMatch(m.joins[0].roleCard, /2\.1\.301|host |box\.local/)
  assert.deepEqual(m.joins[0].clis.map((c) => [c.kind, c.installed, c.version]), [['claude', true, '2.1.301'], ['codex', false, null]])
  const none = fakeMachine({ detector: fakeDetector({ claude: null, codex: null }).detector })
  await none.tick()
  assert.match(none.joins[0].roleCard, /Agent CLIs: none yet\. Spawn options: claude · codex/)
  const older = fakeMachine()
  await older.tick()
  assert.ok(!('clis' in older.joins[0]) && !older.joins[0].roleCard.includes('Detected'), 'no detector: the join is as before')
})

test('detection: a CLI installed or removed re-joins at once; a new version waits until the report is a day old', async () => {
  const world = { claude: '2.1.301', codex: null }
  const { detector } = fakeDetector(world)
  const m = fakeMachine({ detector })
  await m.tick()
  assert.equal(m.joins.length, 1)
  await m.tick()
  assert.equal(m.joins.length, 1, 'nothing changed: no join')
  // An hourly version change waits for the daily computer report.
  world.claude = '2.1.302'
  m.advance(DETECT_EVERY_MS); await m.tick(); await m.tick()
  assert.equal(m.joins.length, 1)
  // Codex installed: told at once, with the version that is known now.
  world.codex = '0.46.0'
  m.advance(DETECT_EVERY_MS); await m.tick(); await m.tick()
  assert.equal(m.joins.length, 2)
  assert.match(m.joins[1].roleCard, /Agent CLIs: Claude Code; Codex\./)
  // Only a version again, then a day since the last report: the next look reports it.
  world.claude = '2.1.303'
  m.advance(DETECT_EVERY_MS); await m.tick(); await m.tick()
  assert.equal(m.joins.length, 2)
  m.advance(DETECT_REPORT_MS); await m.tick(); await m.tick()
  assert.equal(m.joins.length, 3)
  assert.equal(m.joins[2].clis[0].version, '2.1.303')
  assert.doesNotMatch(m.joins[2].roleCard, /2\.1\.303|host |box\.local/)
  // Removed.
  world.codex = null
  m.advance(DETECT_EVERY_MS); await m.tick(); await m.tick()
  assert.equal(m.joins.length, 4)
  assert.match(m.joins[3].roleCard, /Codex not installed/)
})

test('detection: /spawn of a CLI that is not installed says so at once, in English, and opens nothing', async () => {
  const logs = []
  const { detector, looked } = fakeDetector({ claude: '2.1.301', codex: null })
  const m = fakeMachine({ detector, log: (l) => logs.push(l), isDir: () => true })
  await m.tick()
  looked.length = 0
  m.ask('@daemon.box@kai /spawn codex qa /work go')
  await m.tick()
  assert.equal(m.said.at(-1), '@kai ✗ No Codex on this computer (detected 12:00).')
  assert.deepEqual(looked, ['codex'], 'only the kind asked for is looked at again')
  assert.deepEqual(m.tabs, [])
  assert.ok(logs.includes('/spawn refused: Codex not installed'))
  // Installed since the last look: the look before the refusal finds it, the agent starts, and the card is told.
  const world = { claude: '2.1.301', codex: null }
  const later = fakeMachine({ detector: fakeDetector(world).detector, isDir: () => true })
  await later.tick()
  world.codex = '0.46.0'
  later.ask('@daemon.box@kai /spawn codex qa /work go')
  await later.tick()
  assert.equal(later.tabs.length, 1)
  assert.ok(!later.said.some((t) => t.includes('✗ No Codex')))
  await later.tick()
  assert.equal(later.joins.length, 2)
  assert.match(later.joins[1].roleCard, /Agent CLIs: Claude Code; Codex\./)
})

test('detection: /spawn of an installed CLI, or with no detection, starts as before; /usage looks again', async () => {
  const { detector, looked } = fakeDetector({ claude: '2.1.301', codex: null })
  const m = fakeMachine({ detector, isDir: () => true })
  await m.tick()
  m.ask('@daemon.box@kai /spawn claude qa /work go')
  await m.tick()
  assert.equal(m.tabs.length, 1)
  const plain = fakeMachine({ isDir: () => true })
  plain.ask('@daemon.box@kai /spawn codex qa /work go')
  await plain.tick()
  assert.equal(plain.tabs.length, 1, 'a daemon that did not detect rules nothing out')
  const u = fakeMachine({ detector, which: () => false })
  await u.tick()
  looked.length = 0
  u.ask('@daemon.box@kai /usage')
  await u.tick()
  assert.deepEqual(looked.sort(), ['claude', 'codex'])
})

test('detection: the seat hands the dashboard its last detection, and detect() looks again (the u key)', async () => {
  const world = { claude: '2.1.301', codex: null }
  const { detector, looked } = fakeDetector(world)
  const m = fakeMachine({ detector })
  assert.equal(m.seat.clis(), null, 'before the first look')
  await m.tick()
  assert.deepEqual(m.seat.clis().map((c) => [c.kind, c.installed, c.version]), [['claude', true, '2.1.301'], ['codex', false, null]])
  world.codex = '0.46.0'
  looked.length = 0
  await m.seat.detect()
  assert.deepEqual(looked.sort(), ['claude', 'codex'])
  assert.equal(m.seat.clis()[1].version, '0.46.0')
  assert.equal(await createSeat({ api: m.api, terminal: { panes: async () => [] }, rooms: { get: () => null }, hostname: 'box', stateFile: path.join(home, `seat-${Math.random()}.json`) }).detect(), undefined, 'no detector: nothing to do')
})

const CLI_ROOT = fileURLToPath(new URL('..', import.meta.url))
const UPDATE_VERSION = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8')).version
const execFileP = promisify(execFile)
function treeContents(root) {
  const rows = []
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { rows.push([name, 'dir']); visit(path.join(dir, entry.name), name) }
      else if (entry.isFile()) rows.push([name, createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex')])
      else if (entry.isSymbolicLink()) rows.push([name, fs.readlinkSync(path.join(dir, entry.name))])
    }
  }
  visit(root)
  return rows.sort(([a], [b]) => a.localeCompare(b))
}

async function updateFixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-update-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const installHome = path.join(temp, '.scorpio-staging')
  fs.mkdirSync(installHome)
  fs.writeFileSync(path.join(installHome, 'token'), 'test-token\n')
  const state = { manifest: null, archive: null, downloadStatus: 200, selftestStatus: 200, whoamiBody: '{"account":"test"}', downloads: 0 }
  const server = http.createServer((req, res) => {
    if (req.url === '/dl/latest.json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state.manifest))
    if (req.url === '/dl/scorpio.tgz') { state.downloads += 1; return res.writeHead(state.downloadStatus).end(state.downloadStatus === 200 ? state.archive : '') }
    if (req.url === '/api/v1/whoami') return res.writeHead(state.selftestStatus, { 'Content-Type': 'application/json' }).end(state.selftestStatus === 200 ? state.whoamiBody : '{"error":"unavailable"}')
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const childEnv = testEnv(temp, { SCORPIO_HOME: installHome, SCORPIO_SERVER: url, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', CLAUDE_CONFIG_DIR: path.join(temp, '.claude'), CODEX_HOME: path.join(temp, '.codex') })
  let serial = 0
  function packageAt(change = () => {}) {
    const dir = path.join(temp, `package-${++serial}`)
    const pkg = path.join(dir, 'package')
    const manifest = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'))
    fs.mkdirSync(pkg, { recursive: true })
    for (const name of [...manifest.files, 'package.json']) {
      const src = path.join(CLI_ROOT, name)
      if (fs.existsSync(src)) fs.cpSync(src, path.join(pkg, name), { recursive: true })
    }
    fs.writeFileSync(path.join(pkg, 'defaults.json'), JSON.stringify({ server: url }) + '\n')
    change(pkg)
    return { dir, pkg, build: buildId(pkg) }
  }
  const old = packageAt((pkg) => fs.appendFileSync(path.join(pkg, 'README.md'), 'old-build'))
  const installed = spawnSync(process.execPath, [path.join(old.pkg, 'bin', 'install.mjs')], { env: childEnv, encoding: 'utf8' })
  assert.equal(installed.status, 0, installed.stderr)
  function publish(change) {
    const candidate = packageAt(change)
    const file = path.join(candidate.dir, 'scorpio.tgz')
    const packed = spawnSync('tar', ['-czf', file, '-C', candidate.dir, 'package'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    state.archive = fs.readFileSync(file)
    state.manifest = { file: 'scorpio.tgz', version: UPDATE_VERSION, build: candidate.build, sha256: createHash('sha256').update(state.archive).digest('hex') }
    return candidate
  }
  const run = (whoami = async () => ({ account: 'test' }), options = {}) => selfUpdate({
    home: installHome, serverUrl: url, currentVersion: '0.0.0', newer, whoami, childEnv, ...options,
  })
  return { temp, installHome, childEnv, url, state, old, publish, run }
}

test('selftest loads source modules, checks the installer, calls whoami, and writes no local files', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  const before = treeContents(f.installHome)
  const result = await execFileP(process.execPath, [path.join(candidate.pkg, 'bin', 'scorpio.mjs'), 'selftest'], { env: f.childEnv, timeout: 10_000 })
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, version: UPDATE_VERSION })
  f.state.whoamiBody = '{}'
  await assert.rejects(execFileP(process.execPath, [path.join(candidate.pkg, 'bin', 'scorpio.mjs'), 'selftest'], { env: f.childEnv, timeout: 10_000 }), (error) => {
    assert.deepEqual(JSON.parse(error.stdout), { ok: false, version: UPDATE_VERSION, reason: 'whoami returned no account' })
    return true
  })
  assert.deepEqual(treeContents(f.installHome), before)
})

test('same-version update keeps the same build without downloading', async (t) => {
  const f = await updateFixture(t)
  f.publish()
  f.state.manifest.build = f.old.build
  const checks = []
  await f.run(undefined, { currentVersion: UPDATE_VERSION, currentBuild: f.old.build, checked: (result) => checks.push(result) })
  assert.equal(f.state.downloads, 0)
  assert.equal(checks.at(-1).state, 'current')
})

test('same-version update installs a different build and retains the previous build', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  const checks = []
  await f.run(undefined, { currentVersion: UPDATE_VERSION, currentBuild: f.old.build, checked: (result) => checks.push(result) })
  assert.equal(f.state.downloads, 1)
  assert.equal(checks.at(-1).state, 'new')
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), candidate.build)
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app.prev', '.build'), 'utf8').trim(), f.old.build)
})

test('same-version update rejects builds recorded in skip.json or rollback.json', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  const checks = []
  const options = { currentVersion: UPDATE_VERSION, currentBuild: f.old.build, checked: (result) => checks.push(result) }
  fs.mkdirSync(path.join(f.installHome, 'state'), { recursive: true })
  fs.writeFileSync(path.join(f.installHome, 'state', 'skip.json'), JSON.stringify({ build: candidate.build }))
  await f.run(undefined, options)
  assert.equal(checks.at(-1).state, 'failed')
  fs.rmSync(path.join(f.installHome, 'state', 'skip.json'))
  fs.writeFileSync(path.join(f.installHome, 'state', 'rollback.json'), JSON.stringify({ bad: { build: candidate.build } }))
  await f.run(undefined, options)
  assert.equal(checks.at(-1).state, 'failed')
  assert.equal(f.state.downloads, 0)
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), f.old.build)
})

test('update never downloads an older version even with a different build', async (t) => {
  const f = await updateFixture(t)
  f.publish()
  const checks = []
  await f.run(undefined, { currentVersion: '999.0.0', currentBuild: f.old.build, checked: (result) => checks.push(result) })
  assert.equal(f.state.downloads, 0)
  assert.equal(checks.at(-1).state, 'current')
})

test('update precheck rejects a module that throws on import, without replacing app', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish((pkg) => fs.appendFileSync(path.join(pkg, 'src', 'build-id.mjs'), '\nthrow new Error("broken module")\n'))
  await f.run()
  assert.equal(readJson(path.join(f.installHome, 'state', 'skip.json')).build, candidate.build)
  assert.equal(readJson(path.join(f.installHome, 'state', 'skip.json')).reason, 'selftest')
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), f.old.build)
  assert.equal(fs.existsSync(path.join(f.installHome, 'update', candidate.build)), false)
})

test('update precheck rejects new-code whoami failure when the old code can reach it', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  f.state.selftestStatus = 503
  await f.run()
  assert.equal(readJson(path.join(f.installHome, 'state', 'skip.json')).build, candidate.build)
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), f.old.build)
})

test('update precheck leaves no verdict when old whoami also fails, then retries', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  f.state.selftestStatus = 503
  await f.run(async () => { throw new Error('network down') })
  assert.equal(fs.existsSync(path.join(f.installHome, 'state', 'skip.json')), false)
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), f.old.build)
  f.state.selftestStatus = 200
  await f.run()
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), candidate.build)
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app.prev', '.build'), 'utf8').trim(), f.old.build)
  assert.equal(fs.existsSync(path.join(f.temp, '.scorpio')), false)
})

test('update precheck retries a tarball with the wrong sha256 without skipping the build', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  f.state.manifest.sha256 = '0'.repeat(64)
  await f.run()
  assert.equal(fs.existsSync(path.join(f.installHome, 'state', 'skip.json')), false)
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), f.old.build)
  f.state.manifest.sha256 = createHash('sha256').update(f.state.archive).digest('hex')
  await f.run()
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), candidate.build)
})

test('update precheck retries a failed download without skipping the build', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  f.state.downloadStatus = 503
  await f.run()
  assert.equal(fs.existsSync(path.join(f.installHome, 'state', 'skip.json')), false)
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), f.old.build)
  f.state.downloadStatus = 200
  await f.run()
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), candidate.build)
})

test('update precheck retries unpack and package-build failures without skipping', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  const archive = f.state.archive
  f.state.archive = Buffer.from('incomplete tarball')
  f.state.manifest.sha256 = createHash('sha256').update(f.state.archive).digest('hex')
  await f.run()
  assert.equal(fs.existsSync(path.join(f.installHome, 'state', 'skip.json')), false)
  f.state.archive = archive
  f.state.manifest.sha256 = createHash('sha256').update(archive).digest('hex')
  f.state.manifest.build = '0'.repeat(64)
  await f.run()
  assert.equal(fs.existsSync(path.join(f.installHome, 'state', 'skip.json')), false)
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), f.old.build)
  f.state.manifest.build = candidate.build
  await f.run()
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), candidate.build)
})

test('update precheck treats an installer runtime failure as a bad build before swapping', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish((pkg) => {
    const file = path.join(pkg, 'bin', 'install.mjs')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\nthrow new Error("broken installer")\n'))
  })
  await f.run()
  assert.equal(readJson(path.join(f.installHome, 'state', 'skip.json')).build, candidate.build)
  assert.equal(readJson(path.join(f.installHome, 'state', 'skip.json')).reason, 'install')
  assert.equal(fs.readFileSync(path.join(f.installHome, 'app', '.build'), 'utf8').trim(), f.old.build)
})

test('update precheck skips the exact build in skip.json or rollback.json', async (t) => {
  const f = await updateFixture(t)
  const candidate = f.publish()
  fs.mkdirSync(path.join(f.installHome, 'state'), { recursive: true })
  fs.writeFileSync(path.join(f.installHome, 'state', 'skip.json'), JSON.stringify({ build: candidate.build, version: UPDATE_VERSION }))
  await f.run()
  assert.equal(f.state.downloads, 0)
  fs.rmSync(path.join(f.installHome, 'state', 'skip.json'))
  fs.writeFileSync(path.join(f.installHome, 'state', 'rollback.json'), JSON.stringify({ bad: { version: UPDATE_VERSION, build: candidate.build } }))
  await f.run()
  assert.equal(f.state.downloads, 0)
})


test('spawn guidance keeps the three approved lines and the new notice references', () => {
  const skill = fs.readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8')
  for (const line of [
    'One `/read` to judge is enough; do not keep checking its screen while it works.',
    'Right: the daemon says a helper has not joined yet; you `/read` it once, see it reading files and thinking, and go back to your own work until its report-in comes. Models work in minutes, not seconds.',
    "Wrong: you notice the daemon can `/text`, so instead of writing in the topic you type into an agent's pane and press Enter to talk to it.",
  ]) assert.ok(skill.includes(line), line)
  for (const file of ['daemon.md', 'troubleshooting.md']) {
    const text = fs.readFileSync(new URL(`../skill/references/${file}`, import.meta.url), 'utf8')
    assert.ok(text.includes('has not joined yet. Its screen has not changed for <n>s; the daemon does not answer it.'))
    assert.ok(text.includes('has not joined after 10 minutes; its pane is still open'))
    assert.ok(!text.includes('has not joined after 3 minutes'))
    assert.ok(text.includes('/read') && text.includes('/keys') && text.includes('/text'))
  }
})

test('/handoff with an approval card omits the screen; a dialog without a card keeps it', async () => {
  for (const shown of [true, false]) {
    const m = fakeMachine({ approvalBusy: () => true, approvalShown: () => shown })
    m.screen.text = 'Bash command: cat /work/private-approval-command.txt\n1. Yes\n2. No'
    m.panes[0].agent_status = 'blocked'
    m.ask('@daemon.box@kai /handoff api')
    await m.tick()
    const line = m.said.find((text) => text.includes('the handoff instructions were not typed in'))
    assert.ok(line)
    assert.deepEqual(m.typed, [])
    if (shown) {
      assert.equal(line, "@kai ✗ api · waiting for its owner to answer an approval card in Scorpio; the handoff instructions were not typed in, nothing done.")
      assert.doesNotMatch(line, /Screen:|private-approval-command/)
    } else {
      assert.match(line, /stuck on a dialog/)
      assert.deepEqual(m.sent.find((message) => message.text === line).screen, hideKeys(tail(m.screen.text, 8)))
    }
  }
})

test('idle handoff with a newly opened approval card omits the screen; a dialog without a card keeps it', async () => {
  for (const shown of [true, false]) {
    let busy = false
    const m = fakeMachine({ approvalBusy: () => busy, approvalShown: () => shown && busy })
    await m.tick()
    const send = m.api.send
    m.api.send = async (...args) => {
      const result = await send(...args)
      busy = shown
      m.panes[0].agent_status = 'blocked'
      m.screen.text = 'Bash command: cat /work/private-approval-command.txt\n1. Yes\n2. No'
      return result
    }
    assert.equal(await m.seat.idleHandoff({ entry: API, minutes: 60, panes: m.panes }), 'a dialog is open')
    const line = m.said.find((text) => text.includes('the handoff instructions were not typed in'))
    assert.ok(line)
    assert.deepEqual(m.typed, [])
    if (shown) {
      assert.equal(line, "@kai ✗ api · waiting for its owner to answer an approval card in Scorpio; the handoff instructions were not typed in, nothing done.")
      assert.doesNotMatch(line, /Screen:|private-approval-command/)
    } else {
      assert.match(line, /a dialog opened just now/)
      assert.deepEqual(m.sent.find((message) => message.text === line).screen, hideKeys(tail(m.screen.text, 8)))
    }
  }
})

test('approval gate pauses handoff clock and suppresses spawn stall until refused', async () => {
  let blocked = false
  const m = fakeMachine({ approvalBusy: () => blocked, approvalShown: () => blocked })
  m.ask('@daemon.box@kai /handoff api'); await m.tick()
  blocked = true
  m.advance(HANDOFF_MS + 1000); await m.tick()
  assert.equal(m.seat.ops.some((op) => op.type === 'handoff'), true)
  assert.equal(m.said.some((line) => line.includes('did not leave within 2 hours')), false)
  blocked = false; m.advance(1000); await m.tick()
  assert.equal(m.seat.ops.some((op) => op.type === 'handoff'), true)
  m.advance(HANDOFF_MS + 1000); await m.tick()
  assert.match(m.said.at(-1), /did not leave within 2 hours/)
  assert.deepEqual(m.sent.at(-1).screen, hideKeys(tail(m.screen.text, 8)))
  const n = fakeMachine({ approvalBusy: () => true, approvalShown: () => true })
  n.panes.push({ pane_id: 'w:p9', agent: 'codex', agent_status: 'blocked' })
  n.ask('@daemon.box@kai /spawn codex gated-helper work'); await n.tick()
  assert.equal(n.said.some((line) => line.includes('has not joined yet')), false)
  n.advance(SPAWN_JOIN_MS + 1000); await n.tick()
  assert.equal(n.said.some((line) => line.includes('has not joined after')), false)
})

test('approval routing uses spawn room before join, else all registry rooms, and forgets a left agent', async () => {
  const m = fakeMachine()
  register({ roomId: ROOM, name: 'api@kai', role: 'api', pane: 'w:p1' })
  register({ roomId: 'OtherTopic0123456789012', name: 'api@kai', role: 'api', pane: 'w:p1' })
  fs.rmSync(spawnRecordPath(ROOM, 'api@kai'), { force: true })
  assert.equal(m.seat.approvalTargets(m.panes)[0].rooms.length, 2)
  writeJson(spawnRecordPath(ROOM, 'api@kai'), { kind: 'claude', pane: 'w:p1' })
  assert.deepEqual(m.seat.approvalTargets(m.panes)[0].rooms, [ROOM])
  unregister({ roomId: ROOM, name: 'api@kai' }); unregister({ roomId: 'OtherTopic0123456789012', name: 'api@kai' })
  m.panes.push({ pane_id: 'w:p9', agent: 'codex', agent_status: 'working' })
  m.ask('@daemon.box@kai /spawn codex before-join work'); await m.tick()
  assert.ok(m.seat.approvalTargets(m.panes).some((t) => t.name === 'before-join@kai' && t.rooms[0] === ROOM))
})

test('handoff takes permission from the actual CLI argv, including a Node launcher', async () => {
  for (const all of [false, true]) {
    const m = fakeMachine()
    m.fg['w:p1'] = { foreground_processes: [{ name: 'node', argv: ['node', '/tmp/bin/claude', '--model', 'custom', ...(all ? ['--dangerously-skip-permissions'] : [])] }] }
    m.ask('@daemon.box@kai /handoff api'); await m.tick()
    const text = m.typed.at(-1)[1]
    assert.equal(text.includes('perm=all <what to do next>'), all)
    assert.ok(text.includes('model=custom'))
  }
})

test('spawn relay suppresses early blocked screen and a card suppresses the later notice', async () => {
  let shown = false
  const { m } = await spawnedAtDialog({ approvalsRunning: () => true, approvalShown: () => shown })
  assert.equal(m.sent.some((message) => message.screen), false)
  assert.equal(m.said.filter((text) => text.includes('Started qa ')).length, 1)
  assert.equal(m.seat.ops[0].stage, 'joining')
  shown = true
  m.advance(3000); await m.tick()
  m.advance(30000); await m.tick()
  assert.equal(m.sent.some((message) => message.screen), false)
  shown = false
  m.advance(30000); await m.tick()
  assert.equal(m.said.filter((text) => text.includes('has not joined yet')).length, 1)
})

/** A /spawn qa that started working and has not joined, with the approval relay watching the seat's targets. */
async function relayedSpawn(kind = 'claude') {
  let approvals = null
  const m = fakeMachine({ isDir: () => true, approvalsRunning: () => true, approvalBusy: (p) => approvals.busy(p), approvalShown: (p) => approvals.shown(p) })
  const pane = { ...QA_PANE, agent: kind }
  m.panes.push(pane)
  const frames = []
  approvals = createApprovals({ terminal: m.terminal, targets: async () => m.seat.approvalTargets(m.panes), send: (_roomId, frame) => frames.push(frame), now: m.now, sleep: async () => {} })
  m.ask(`@daemon.box@kai /spawn ${kind} qa /work go`, 'api@kai', 'agent')
  await m.tick()
  assert.equal(m.seat.ops[0].stage, 'joining')
  const round = async (ms = 5000) => { m.advance(ms); await m.tick(); await approvals.tick() }
  return { m, pane, approvals, frames, round, notices: () => m.said.filter((t) => t.includes('has not joined yet')) }
}

const stillScreens = [
  ['no menu', 'Loading configuration\n\nOne moment', null],
  ['a menu', "Hooks need review\n\n1 hook is new or changed.\n\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n\nenter confirm · esc skip",
    ['Review hooks', 'Trust all and continue', "Continue without trusting (hooks won't run)"]],
]
for (const [label, screen, options] of stillScreens) {
  test(`/spawn stopped before joining with ${label} on a still screen gets a card at 30 s and no notice; a change closes it`, async () => {
    const { m, pane, approvals, frames, round, notices } = await relayedSpawn('codex')
    pane.agent_status = 'idle'
    m.screen.text = screen
    await round() // the first idle read: the still screen's clock starts
    for (let i = 0; i < 5; i++) await round()
    assert.equal(approvals.cards.size, 0, 'not before 30 s')
    await round()
    await round(3000)
    const card = approvals.cards.get('w:p9')
    assert.ok(card, 'a card once the screen stood still for 30 s')
    assert.equal(frames.filter((f) => f.type === 'approval_open').length, 1)
    if (options) assert.deepEqual(card.menu.options.map((o) => o.label), options)
    else { assert.equal(card.menu, null); assert.equal(card.screen, screenTail(screen)) }
    for (let i = 0; i < 6; i++) await round()
    assert.deepEqual(notices(), [], 'no screen in the room while the card is shown')
    assert.equal(m.sent.some((message) => message.screen), false)
    m.screen.text = 'Working on it'
    await round(1000)
    assert.equal(approvals.cards.size, 0)
    assert.equal(frames.at(-1).type, 'approval_close')
    assert.deepEqual(m.pressed, [])
  })
}

test('/spawn stopped before joining: a refused card leaves the notice, which waits for the card first', async () => {
  const { m, pane, approvals, round, notices } = await relayedSpawn()
  pane.agent_status = 'idle'
  m.screen.text = 'Loading configuration'
  for (let i = 0; i < 7; i++) await round()
  await round(3000)
  const card = approvals.cards.get('w:p9')
  assert.ok(card)
  assert.deepEqual(notices(), [])
  approvals.refused({ id: card.id, error: 'not_allowed' })
  await round()
  assert.deepEqual(notices(), [], 'the notice waits STALL_CARD_MS for a card')
  for (let i = 0; i < 2; i++) await round()
  assert.equal(notices().length, 1)
  assert.ok(STALL_CARD_MS > 0 && SPAWN_STALL_MS === 30_000)
})

test('/spawn that works before 30 s or joins gets no stall card', async () => {
  const { m, pane, approvals, frames, round } = await relayedSpawn()
  pane.agent_status = 'idle'
  m.screen.text = 'Thinking'
  await round(0)
  for (let i = 0; i < 5; i++) await round()
  pane.agent_status = 'working'
  for (let i = 0; i < 6; i++) await round()
  assert.equal(frames.length, 0)
  pane.agent_status = 'idle'
  for (let i = 0; i < 5; i++) await round()
  register({ roomId: ROOM, name: 'qa@kai', role: 'qa', pane: 'w:p9' })
  try {
    for (let i = 0; i < 4; i++) await round()
    assert.equal(approvals.cards.size, 0, 'joined: the stall no longer counts')
    assert.equal(frames.length, 0)
  } finally { unregister({ roomId: ROOM, name: 'qa@kai' }) }
})

test('custom spawn arguments report when requested permission was not applied', async () => {
  const before = readJson(CONFIG_FILE)
  try {
    for (const perm of ['all', 'auto']) for (const kind of ['claude', 'codex']) {
      writeJson(CONFIG_FILE, { spawn: { [kind]: ['--model', 'custom'] } })
      const m = fakeMachine()
      m.panes.push({ pane_id: 'w:p9', agent: kind, agent_status: 'working' })
      m.ask(`@daemon.box@kai /spawn ${kind} custom-${kind} perm=${perm} work`)
      await m.tick()
      assert.equal(readJson(spawnRecordPath(ROOM, `custom-${kind}@kai`)).perm, 'ask')
      assert.ok(m.said.find((text) => text.includes('Started '))?.endsWith(`perm=${perm} was not applied: this computer's ${CONFIG_FILE.startsWith(os.homedir() + path.sep) ? '~' + CONFIG_FILE.slice(os.homedir().length) : CONFIG_FILE} spawn.${kind} sets the arguments.`))
    }
  } finally {
    if (before) writeJson(CONFIG_FILE, before)
    else fs.rmSync(CONFIG_FILE, { force: true })
  }
})


test('blocked spawn with relay sends Started and the custom permission notice without a screen', async () => {
  const before = readJson(CONFIG_FILE)
  try {
    writeJson(CONFIG_FILE, { spawn: { claude: ['--model', 'custom'] } })
    const { m } = await spawnedAtDialog({ approvalsRunning: () => true }, { perm: 'perm=all' })
    const started = m.said.filter((text) => text.includes('Started qa '))
    assert.equal(started.length, 1)
    assert.ok(started[0].includes('perm=all was not applied:'))
    assert.ok(started[0].includes(CONFIG_FILE))
    assert.equal(m.sent.some((message) => message.screen), false)
    assert.equal(m.seat.ops[0].stage, 'joining')
  } finally {
    if (before) writeJson(CONFIG_FILE, before)
    else fs.rmSync(CONFIG_FILE, { force: true })
  }
})

const codexTrustScreens = [
  "Hooks need review\n\n1 hook is new or changed.\n\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n\nenter confirm · esc skip",
  'Trust this folder?\n\n› 1. Trust and continue\n  2. Quit\n\nenter continue · esc quit',
].map((screen) => screen + '\n'.repeat(60))

for (const [i, screen] of codexTrustScreens.entries()) {
  test(`Codex trust screen ${i}: idle quoted text allows delivery and handoff`, async () => {
    const m = fakeMachine()
    m.screen.text = screen
    m.terminal.read = async (_, lines) => screen.split('\n').slice(-lines).join('\n')
    const injected = []
    m.terminal.inject = async (pane, text) => injected.push([pane, text])
    assert.equal(await injectWhenReady(m.terminal, 'w:p1', 'hello'), 'sent')
    assert.deepEqual(injected, [['w:p1', 'hello']])
    m.ask('@daemon.box@kai /handoff api'); await m.tick()
    assert.equal(m.typed.length, 1)
    const idle = fakeMachine()
    idle.screen.text = screen
    await idle.tick()
    assert.equal(await idle.seat.idleHandoff({ entry: API, minutes: 60, panes: idle.panes }), 'started')
    assert.equal(idle.typed.length, 1)
  })
  for (const relay of [false, true]) test(`Codex trust screen ${i}: idle spawn with relay ${relay} does not infer a dialog`, async () => {
    const m = fakeMachine({ isDir: () => true, approvalsRunning: () => relay })
    m.panes.push({ ...QA_PANE, agent: 'codex', agent_status: 'idle' })
    m.terminal.read = async (_, lines) => screen.split('\n').slice(-lines).join('\n')
    m.ask('@daemon.box@kai /spawn codex qa /work go')
    await m.tick()
    assert.equal(m.seat.ops[0].stage, 'starting')
    assert.equal(m.sent.some((message) => message.screen), false)
    m.panes.find((pane) => pane.pane_id === m.seat.ops[0].pane).agent_status = 'working'
    await until(() => m.said.some((text) => text.includes('Started qa ')))
    assert.equal(m.seat.ops[0].stage, 'joining')
    assert.deepEqual(m.pressed, [])
    assert.equal(m.said.filter((text) => text.includes('Started qa ')).length, 1)
    assert.equal(m.sent.some((message) => message.screen), false)
  })
}

test('Started explains added Codex asking policy and preserves an explicit never policy', async () => {
  const dir = process.env.CODEX_HOME
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'config.toml')
  try {
    for (const [source, expected] of [
      ['', 'Added --ask-for-approval on-request, since your Codex settings set no approval policy: it asks you in Scorpio before it runs a command outside its sandbox; nothing is allowed by itself.'],
      ['approval_policy = "never"', `Your Codex settings (approval_policy = "never" with a sandbox) keep it from asking to leave the sandbox, so it cannot reach the topic. Use perm=all for this session or change approval_policy in ${file}.`],
      ['approval_policy = "never"\nsandbox_mode = "danger-full-access"', ''],
    ]) {
      fs.writeFileSync(file, source)
      const m = fakeMachine({ isDir: () => true })
      m.panes.push({ pane_id: 'w:p9', agent: 'codex', agent_status: 'working' })
      m.ask('@daemon.box@kai /spawn codex qa /work go')
      await m.tick()
      await until(() => m.said.some((text) => text.includes('Started qa ')))
      const line = m.said.find((text) => text.includes('Started qa '))
      assert.ok(line, m.said.join('\n'))
      if (expected) assert.ok(line.endsWith(expected), line)
      else assert.ok(line.endsWith('perm: ask me in Scorpio (your setting).'), line)
      assert.equal(readJson(spawnRecordPath(ROOM, 'qa@kai')).perm, 'ask')
    }
  } finally { fs.rmSync(file, { force: true }) }
})


for (const [kind, note] of [
  ['claude', "perm=auto: Claude Code's auto mode decides what runs. What it blocks does not come to you as a card; your own ask rules still do."],
  ['codex', "perm=auto: Codex's auto-review decides what runs, without the approval hook. What it blocks does not come to you as a card."],
]) test(`person can spawn ${kind} auto with the recorded permission and exact Started notice`, async () => {
  const m = fakeMachine()
  m.panes.push({ pane_id: 'w:p9', agent: kind, agent_status: 'working' })
  m.ask(`@daemon.box@kai /spawn ${kind} auto-${kind} perm=auto work`)
  await m.tick()
  assert.equal(m.tabs.length, 1)
  assert.equal(readJson(spawnRecordPath(ROOM, `auto-${kind}@kai`)).perm, 'auto')
  assert.equal(m.seat.ops[0].perm, 'auto')
  const started = m.said.find((text) => text.includes('Started '))
  assert.ok(started?.endsWith(note), m.said.join('\n'))
  assert.doesNotMatch(started, /Added --ask-for-approval|Your Codex settings/)
})

test('handoff carries auto permission from the running CLI, including aliases and Node launchers', async () => {
  for (const [kind, args] of [
    ['codex', ['--approve-for-me']], ['codex', ['--not-so-yolo']],
    ['claude', ['--permission-mode', 'auto']], ['claude', ['--permission-mode=auto']],
  ]) {
    const m = fakeMachine()
    m.panes.find((p) => p.pane_id === 'w:p1').agent = kind
    m.fg['w:p1'] = { foreground_processes: [{ name: 'node', argv: ['node', `/tmp/bin/${kind}`, ...args] }] }
    m.ask('@daemon.box@kai /handoff api')
    await m.tick()
    assert.ok(m.typed.at(-1)[1].includes('perm=auto <what to do next>'))
  }
})

test('permission selection orders levels and records the four sources', () => {
  assert.deepEqual(spawnPermission({ setting: 'all' }), { level: 'all', from: 'setting', parent: null })
  assert.deepEqual(spawnPermission({ requested: 'ask' }), { level: 'ask', from: 'spawn', parent: null })
  assert.deepEqual(spawnPermission({ sender: { name: 'api@kai', level: 'all' } }), { level: 'all', from: 'parent', parent: 'api@kai' })
  for (const requested of [null, 'auto']) assert.deepEqual(spawnPermission({ requested, previous: 'auto' }), { level: 'auto', from: 'takeover', parent: null })
  assert.deepEqual(spawnPermission({ requested: 'ask', sender: { name: 'api@kai', level: null } }), { needsSetting: true })
  assert.deepEqual(spawnPermission({ previous: 'all', sender: { name: 'api@kai', level: 'ask' } }), { error: '✗ perm=all: api@kai runs with perm=ask, so it cannot start an agent with more.' })
  for (const [perm, permFrom, permParent, text] of [
    ['all', 'setting', null, 'perm: allow everything (your setting).'],
    ['ask', 'spawn', null, 'perm: ask me in Scorpio (chosen in this /spawn).'],
    ['all', 'parent', 'api@kai', 'perm: allow everything (same as api@kai).'],
    ['auto', 'takeover', null, 'perm: approve for me (takeover, kept).'],
  ]) assert.equal(permissionNotice({ perm, permFrom, permParent }), text)
})

test('account permission reads use the token endpoint without a cache', async () => {
  const calls = []
  const client = createApi({ server: 'https://scorpio.example.com', token: () => 'test-token', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ perm: calls.length === 1 ? 'all' : 'ask' }))
  } })
  assert.deepEqual(await client.spawnPerm(), { perm: 'all' })
  assert.deepEqual(await client.spawnPerm(), { perm: 'ask' })
  assert.equal(calls.length, 2)
  for (const { url, options } of calls) {
    assert.equal(url, 'https://scorpio.example.com/api/v1/account/spawn-perm')
    assert.equal(options.method, 'GET')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
  }
})

test('human spawns use each current setting and explicit requests skip that read', async () => {
  const m = fakeMachine()
  m.panes.push({ pane_id: 'w:p9', agent: 'claude', agent_status: 'working' })
  let reads = 0
  m.api.spawnPerm = async () => ({ perm: ['all', 'ask'][reads++] })
  for (const level of ['all', 'ask']) {
    m.ask(`@daemon.box@kai /spawn claude setting-${level} work`)
    await m.tick()
    const record = readJson(spawnRecordPath(ROOM, `setting-${level}@kai`))
    assert.deepEqual([record.perm, record.permFrom, record.permParent], [level, 'setting', null])
    assert.equal(m.said.at(-1), `@kai Started setting-${level} (claude: claude-opus-5-5, effort medium) in ${m.tabs.at(-1).cwd}, a new name in this topic. It is working on its first prompt; waiting for it to join. perm: ${level === 'all' ? 'allow everything' : 'ask me in Scorpio'} (your setting).`)
  }
  m.ask('@daemon.box@kai /spawn claude chosen-ask perm=ask work')
  await m.tick()
  assert.equal(reads, 2)
  assert.equal(m.said.at(-1), `@kai Started chosen-ask (claude: claude-opus-5-5, effort medium) in ${m.tabs.at(-1).cwd}, a new name in this topic. It is working on its first prompt; waiting for it to join. perm: ask me in Scorpio (chosen in this /spawn).`)
})

test('ask setting retains the Codex hook and asking policy', async () => {
  const m = fakeMachine()
  let argv
  m.terminal.startAgent = async (spec) => { argv = spec.argv }
  m.panes.push({ pane_id: 'w:p9', agent: 'codex', agent_status: 'working' })
  m.ask('@daemon.box@kai /spawn codex setting-codex work')
  await m.tick()
  assert.equal(readJson(spawnRecordPath(ROOM, 'setting-codex@kai')).perm, 'ask')
  assert.ok(argv.some((arg) => arg.includes('hooks.PermissionRequest')))
  assert.equal(argv[argv.indexOf('--ask-for-approval') + 1], 'on-request')
  assert.ok(m.said.at(-1).endsWith('perm: ask me in Scorpio (your setting). Added --ask-for-approval on-request, since your Codex settings set no approval policy: it asks you in Scorpio before it runs a command outside its sandbox; nothing is allowed by itself.'))
})

test('unreadable settings start nothing; explicit human requests need no setting', async () => {
  for (const response of [null, { perm: 'unknown' }]) {
    const m = fakeMachine()
    m.api.spawnPerm = async () => { if (!response) throw new Error('offline'); return response }
    m.ask('@daemon.box@kai /spawn claude failed work')
    await m.tick()
    assert.equal(m.tabs.length, 0)
    assert.equal(m.said.at(-1), '@kai ✗ Could not read your permission setting; nothing was started. Send it again, or add perm=ask / auto / all.')
  }
  const m = fakeMachine()
  m.api.spawnPerm = async () => { throw new Error('offline') }
  m.ask('@daemon.box@kai /spawn claude failed-worker perm=ask work', 'api@kai', 'agent')
  await m.tick()
  assert.equal(m.tabs.length, 0)
  assert.equal(m.said.at(-1), `@api@kai ${SETTING_UNREADABLE}`)
  m.ask('@daemon.box@kai /spawn claude explicit perm=ask work')
  await m.tick()
  assert.equal(m.tabs.length, 1)
})

test('remote helpers inherit Member.perm, may lower it, and cannot raise it', async () => {
  fs.rmSync(spawnRecordPath(ROOM, 'pm@kai'), { force: true })
  for (const [parentLevel, requested, expected] of [
    ['all', '', 'all'], ['all', 'perm=ask', 'ask'], ['ask', 'perm=all', null],
    ['ask', 'perm=auto', null], ['auto', '', 'auto'], ['auto', 'perm=all', null], [null, '', 'auto'],
  ]) {
    const m = fakeMachine()
    m.memberList.push({ name: 'pm@kai', kind: 'agent', status: 'active', perm: parentLevel ? { level: parentLevel, from: 'spawn', parent: null } : null })
    m.panes.push({ pane_id: 'w:p9', agent: 'claude', agent_status: 'working' })
    let reads = 0
    m.api.spawnPerm = async () => { reads++; return { perm: 'auto' } }
    m.ask(`@daemon.box@kai /spawn claude remote-worker ${requested} work`, 'pm@kai', 'agent')
    await m.tick()
    assert.equal(reads, parentLevel ? 0 : 1)
    assert.equal(m.tabs.length, expected ? 1 : 0)
    if (!expected) {
      assert.equal(m.said.at(-1), `@pm@kai ✗ perm=${requested.slice(5)}: pm@kai runs with perm=${parentLevel}, so it cannot start an agent with more.`)
      continue
    }
    const record = readJson(spawnRecordPath(ROOM, 'remote-worker@kai'))
    assert.deepEqual([record.perm, record.permFrom, record.permParent], [expected, requested ? 'spawn' : parentLevel ? 'parent' : 'setting', !requested && parentLevel ? 'pm@kai' : null])
    if (expected === 'all') assert.equal(m.said.at(-1), `@remote-worker@kai Started remote-worker (claude: claude-opus-5-5, effort medium) in ${m.tabs.at(-1).cwd}, a new name in this topic. It is working on its first prompt; waiting for it to join. perm: allow everything (same as pm@kai).`)
  }
})

test('helpers of an agent with null Member.perm use the setting and name it in Started', async () => {
  const m = fakeMachine()
  m.memberList.push({ name: 'pm@kai', kind: 'agent', status: 'active', perm: null })
  m.panes.push({ pane_id: 'w:p9', agent: 'claude', agent_status: 'working' })
  m.api.spawnPerm = async () => ({ perm: 'all' })
  m.ask('@daemon.box@kai /spawn claude setting-helper work', 'pm@kai', 'agent')
  await m.tick()
  assert.equal(m.tabs.length, 1)
  const record = readJson(spawnRecordPath(ROOM, 'setting-helper@kai'))
  assert.deepEqual([record.perm, record.permFrom, record.permParent], ['all', 'setting', null])
  assert.equal(m.said.at(-1), `@setting-helper@kai Started setting-helper (claude: claude-opus-5-5, effort medium) in ${m.tabs.at(-1).cwd}, a new name in this topic. It is working on its first prompt; waiting for it to join. perm: allow everything (your setting).`)
})

test('spawn reads current member permissions when the cached room still has null', async () => {
  const m = fakeMachine()
  m.memberList.push({ name: 'pm@kai', kind: 'agent', status: 'active', perm: { level: 'ask', from: 'spawn', parent: null } })
  m.roomData.members = structuredClone(m.memberList)
  m.roomData.members.find((member) => member.name === 'pm@kai').perm = null
  m.panes.push({ pane_id: 'w:p9', agent: 'claude', agent_status: 'working' })
  let settingReads = 0
  m.api.spawnPerm = async () => { settingReads++; return { perm: 'all' } }
  m.ask('@daemon.box@kai /spawn claude fresh-permission work', 'pm@kai', 'agent')
  await m.tick()
  assert.equal(m.tabs.length, 1)
  const record = readJson(spawnRecordPath(ROOM, 'fresh-permission@kai'))
  assert.deepEqual([record.perm, record.permFrom, record.permParent], ['ask', 'parent', 'pm@kai'])
  assert.equal(settingReads, 0)
})

test('local missing or stale spawn panes use the setting, not a stale Member.perm', async () => {
  for (const pane of [null, 'old-pane', 'w:p1']) {
    const m = fakeMachine()
    m.memberList.find((member) => member.name === 'api@kai').perm = { level: 'all', from: 'spawn', parent: null }
    if (pane) writeJson(spawnRecordPath(ROOM, 'api@kai'), { pane, perm: 'ask' })
    else fs.rmSync(spawnRecordPath(ROOM, 'api@kai'), { force: true })
    m.panes.push({ pane_id: 'w:p9', agent: 'claude', agent_status: 'working' })
    let reads = 0
    m.api.spawnPerm = async () => { reads++; return { perm: 'ask' } }
    m.ask('@daemon.box@kai /spawn claude local-worker work', 'api@kai', 'agent')
    await m.tick()
    assert.equal(m.tabs.length, 1)
    assert.equal(reads, pane === 'w:p1' ? 0 : 1)
    assert.equal(readJson(spawnRecordPath(ROOM, 'local-worker@kai')).perm, pane === 'w:p1' ? 'all' : 'ask')
  }
  fs.rmSync(spawnRecordPath(ROOM, 'api@kai'), { force: true })
})

test('takeovers keep the member level, including explicit matching requests and sender ceilings', async () => {
  for (const [requested, agent] of [['', false], ['perm=auto', false], ['', true], ['perm=auto', true]]) {
    const m = fakeMachine()
    m.memberList.push({ name: 'kept@kai', kind: 'agent', status: 'left', perm: { level: 'auto', from: 'setting', parent: null } })
    m.memberList.push({ name: 'pm@kai', kind: 'agent', status: 'active', perm: { level: 'all', from: 'setting', parent: null } })
    m.panes.push({ pane_id: 'w:p9', agent: 'claude', agent_status: 'working' })
    m.api.spawnPerm = async () => { throw new Error('known levels must not read settings') }
    m.ask(`@daemon.box@kai /spawn claude kept ${requested} work`, agent ? 'pm@kai' : 'kai', agent ? 'agent' : 'human')
    await m.tick()
    await until(() => m.said.some((line) => line.includes('Started kept ')))
    const record = readJson(spawnRecordPath(ROOM, 'kept@kai'))
    assert.deepEqual([record.perm, record.permFrom], ['auto', 'takeover'])
    assert.equal(m.said.at(-1), `@${agent ? 'kept@kai' : 'kai'} Started kept (claude: claude-opus-5-5, effort medium) in ${m.tabs.at(-1).cwd}, taking over kept: its tasks and role card go with it; it left no handoff, in the cloud or on this computer. It is working on its first prompt; waiting for it to join. perm: approve for me (takeover, kept). perm=auto: Claude Code's auto mode decides what runs. What it blocks does not come to you as a card; your own ask rules still do.`)
  }
  const m = fakeMachine()
  m.memberList.push({ name: 'kept@kai', kind: 'agent', status: 'left', perm: { level: 'all', from: 'spawn', parent: null } })
  m.memberList.push({ name: 'pm@kai', kind: 'agent', status: 'active', perm: { level: 'ask', from: 'setting', parent: null } })
  m.ask('@daemon.box@kai /spawn claude kept work', 'pm@kai', 'agent')
  await m.tick()
  assert.equal(m.tabs.length, 0)
  assert.equal(m.said.at(-1), '@pm@kai ✗ perm=all: pm@kai runs with perm=ask, so it cannot start an agent with more.')
})

test('carry only describes current spawn panes and normalizes older records', () => {
  const carried = [{ name: 'api@kai', pane: 'p1' }, { name: 'qa@kai', pane: 'p2' }, { name: 'manual@kai', pane: 'p3' }, { name: 'old@kai', pane: 'p4' }]
  const records = {
    'api@kai': { pane: 'p1', perm: 'all', permFrom: 'parent', permParent: 'pm@kai' },
    'qa@kai': { pane: 'p2', perm: 'default' }, 'old@kai': { pane: 'previous-pane', perm: 'all' },
  }
  assert.deepEqual(carryPermissions(carried, (e) => records[e.name]), {
    'api@kai': { level: 'all', from: 'parent', parent: 'pm@kai' }, 'qa@kai': { level: 'ask', from: 'spawn', parent: null },
  })
})

test('host carry sends permissions on opening and when only permissions change', () => {
  class Socket {
    constructor() { this.handlers = {}; this.sent = []; Socket.last = this }
    addEventListener(name, fn) { this.handlers[name] = fn }
    send(value) { this.sent.push(value) }
    close() {}
  }
  const links = createLinks({ api: { wsUrl: () => 'ws://example.com', token: () => 'test', userAgent: 'test' }, onFrame: () => {}, WebSocketImpl: Socket })
  try {
    const spec = { key: 'host', roomId: 'one', role: 'daemon', host: true, carry: ['api@kai', 'manual@kai'], perm: { 'api@kai': { level: 'auto', from: 'spawn', parent: null } } }
    links.sync([spec]); Socket.last.handlers.open()
    const frames = () => Socket.last.sent.filter((value) => value !== 'ping').map((value) => JSON.parse(value))
    assert.deepEqual(frames(), [{ type: 'carry', names: ['api@kai', 'manual@kai'], perm: spec.perm }])
    links.sync([spec]); assert.equal(frames().length, 1)
    links.sync([{ ...spec, perm: {} }])
    assert.deepEqual(frames().at(-1), { type: 'carry', names: ['api@kai', 'manual@kai'], perm: {} })
    assert.equal(frames().length, 2)
  } finally { links.closeAll() }
})


test('/spawn shell not ready sends a masked screen without starting a CLI', async () => {
  const m = fakeMachine({ isDir: () => true })
  m.panes.push({ ...QA_PANE })
  m.screen.text = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n') + '\nsk-' + 'a'.repeat(16)
  m.terminal.waitShell = async () => ({ ok: false })
  m.terminal.startAgent = async () => assert.fail('shell not ready')
  m.ask('@daemon.box@kai /spawn claude qa /work work')
  await m.tick()
  for (let i = 0; i < 20 && !m.sent.some((message) => message.screen); i++) await new Promise((r) => setImmediate(r))
  const report = m.sent.find((message) => message.screen)
  assert.ok(report, m.said.join('\n'))
  assert.match(report.text, /shell was not ready/)
  assert.deepEqual(report.screen, hideKeys(tail(m.screen.text)))
  assert.equal(report.screen.hidden, 1)
  assert.match(report.text, /; waiting for them\.$/)
})

test('/read empty stays unchanged, while read, keys and text mask every screen', async () => {
  const { m } = await spawnedAtDialog()
  m.screen.byPane = {}
  m.fg['w:p9'] = CLAUDE_FG
  m.screen.text = ''
  m.ask('@daemon.box@kai /read qa')
  await m.tick()
  assert.equal(m.said.at(-1), '@kai qa · its screen is empty')
  assert.equal(m.sent.at(-1).screen, undefined)
  m.screen.text = 'screen marker\nsk-' + 'a'.repeat(16) + '\n' + 'b'.repeat(20) + '\n next prompt'
  for (const command of ['/read qa', '/keys qa enter', '/text qa yes']) {
    m.ask('@daemon.box@kai ' + command)
    await m.tick()
    assert.deepEqual(m.sent.at(-1).screen, hideKeys(m.screen.text))
    assert.equal(m.sent.at(-1).screen.hidden, 1)
    assert.doesNotMatch(m.said.at(-1), /screen marker|sk-|waiting for them/)
  }
})

test('multi-agent dialogs and handoff timeouts keep each screen with its report', async () => {
  for (const blocked of [true, false]) {
    const m = fakeMachine()
    m.panes.push({ ...QA_PANE, agent_status: blocked ? 'blocked' : 'idle' })
    m.panes[0].agent_status = blocked ? 'blocked' : 'idle'
    m.memberList.push({ name: 'qa@kai', kind: 'agent', status: 'active' })
    const screens = { 'w:p1': 'API screen\n' + 'a\n'.repeat(20) + 'sk-' + 'a'.repeat(16), 'w:p9': 'QA screen\n' + 'b\n'.repeat(20) + 'ghp_' + 'b'.repeat(20) }
    m.screen.byPane = screens
    const entries = [API, { roomId: ROOM, name: 'qa@kai', role: 'qa', pane: 'w:p9' }]
    m.ask('@daemon.box@kai /handoff api qa')
    await m.tick(entries)
    if (!blocked) { m.advance(HANDOFF_MS + 1000); await m.tick(entries) }
    const reports = m.sent.filter((message) => message.screen)
    assert.equal(reports.length, 2)
    for (const [i, pane] of ['w:p1', 'w:p9'].entries()) {
      assert.deepEqual(reports[i].screen, hideKeys(tail(screens[pane], 8)))
      assert.match(reports[i].text, new RegExp(`\\n${i ? 'qa' : 'api'} · its screen`))
      assert.match(reports[i].text, /; waiting for them\.$/)
    }
  }
})
