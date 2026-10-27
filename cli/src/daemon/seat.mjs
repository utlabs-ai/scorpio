// The daemon's seat in each room: daemon.<computer>@<account> (kind host; "command seat" on the page).
// It takes room commands that its own account's people and agents @ it with (commands.mjs), does them
// on this computer through the terminal adapter, and answers the sender in the room. It also hands off
// agents the main loop found idle for too long (idleHandoff), saying so in the room first.
//
// Long commands (/handoff waiting for the agent to leave, /spawn waiting for it to join) become
// pending operations that each tick moves along, so the main loop keeps delivering messages meanwhile.
// Side effects come in through createSeat's arguments.

import { codexApprovalNote } from '../adapters/cli/codex-settings.mjs'
import fs from 'node:fs'
import os from 'node:os'
import { wasRemoved, markRemoved } from './removed.mjs'
import path from 'node:path'
import {
  COMMANDS, HELP_FULL, HELP_SHORT, daemonsNamed, judge, machineName, senderOf, parseSpawn, parseTargets, freeName, seatRole, spawnPrompt, spawnLine, handoffPrompt, takeoverText, agoText, usage,
  parseIdle, idleNotice, minutesText, nudgePrompt, spawnDirArg, parseRead, parseKeys, parseText, targetOf,
} from './commands.mjs'
import { approvalTargets } from './approvals.mjs'
import { createKeys, findKey, keyList, keysFor } from './keys.mjs'
import { createSpawnOptions, spawnHelpOptions } from './spawn-config.mjs'
import { PERMS, SETTING_UNREADABLE, permissionLevel, permissionNotice, spawnPermission } from './spawn-permission.mjs'
import { deviceId, handoffCopyPath, handoffPath, spawnPath, spawnRecordPath, CONFIG_FILE, SEAT_FILE, ROLLBACK_FILE, readJson, writeJson } from './paths.mjs'
import { argsFor, autoPermission, fullPermission, permOf, CLIS, KINDS, modelOf, modelText, NEVER_ANSWER, dialogBlocked, runsCli, stoppedOnNetworkError, withModel } from '../adapters/cli/index.mjs'
import { claudeWindows, codexWindows, readClaudeRateLimits, readCodexRateLimits, usageLine } from '../adapters/cli/usage.mjs'
import { agentClisText, detectedText, installedChanged } from '../adapters/cli/detect.mjs'
import { HOME } from './paths.mjs'
import { herdrExit } from './log.mjs'
import { herdrError, SHELL_READY_SECONDS, tail } from '../adapters/terminal/herdr.mjs'
import { consumePending, matchingPanes } from '../actions/attach.mjs'
import { dropRoom, entries as rosterEntries, leftEntries, register as registerLocal } from './registry.mjs'
import { workspaceFor, ensureDir, topicFilesDir } from '../workspace.mjs'

const MIN = 60_000
export const SPAWN_JOIN_MS = 10 * MIN
export const SPAWN_STALL_MS = 30_000
const SPAWN_SCREEN_MS = 5_000
export const HANDOFF_MS = 2 * 60 * MIN
// A takeover's look for its handoff in the cloud, tries included: past it, failed (timeout).
export const HANDOFF_FETCH_MS = 20_000
const JOIN_RETRY_MS = 5 * MIN
// Detection of the agent CLIs on this computer: every hour; the seat tells its rooms again when a CLI
// became installed or not at once, otherwise (a new version, or just to say it is current) at most once a day.
export const DETECT_EVERY_MS = 60 * MIN
export const DETECT_REPORT_MS = 24 * 60 * MIN
// A /spawn-ed agent that stopped at its prompt on a network API error before joining is told to carry on
// (a computer whose TLS handshake to the API takes 5–11 s, cut off at about 11, loses every retry of a
// bad minute): once per stop, at least a minute apart, NUDGE_MAX times in all. Its screen is read only
// while it is not working, and at most every NUDGE_LOOK_MS.
export const NUDGE_MAX = 5
const NUDGE_GAP_MS = MIN
const NUDGE_LOOK_MS = 15_000
// How often to look for rooms this account created (GET /rooms). In a new room people wait for the seat
// before they can /spawn, so the server says rooms_changed on the seat's connections and the seat looks
// at once; the poll is the backstop (polling every 15 s was most of a user's server cost). A seat in
// no room yet has no connection to hear it on, so it looks more often.
export const OWNED_ROOMS_MS = 5 * MIN
export const OWNED_ROOMS_ALONE_MS = 30_000
const LISTEN_MAX = 100 // the server's cap on the waking messages one listen returns
// agent start answers these while the CLI is still coming up: not detected yet, or stopped at a startup dialog.
const STILL_STARTING = new Set(['timeout', 'agent_not_ready'])
// /keys presses one key at a time, this far apart: a CLI redraws between keys.
export const KEY_GAP_MS = 200

const shortOf = (name) => String(name).split('@')[0]
const fence = (text) => `\`\`\`\n${text}\n\`\`\``

/**
 * This account's person left the topic (status left) and nobody of the account is still in it but daemon seats.
 * Not a topic its agents only handed over in (the person is in, or never joined): there the seat waits for the
 * takeover line.
 */
export function strandedSeat(members, account) {
  const list = members || []
  const person = list.find((m) => m.name === account && m.kind === 'human')
  return person?.status === 'left' && !list.some((m) => m.owner === account && m.kind !== 'host' && m.status === 'active')
}

export function createSeat({
  api, terminal, rooms, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  hostname = os.hostname(), stateFile = SEAT_FILE, spawnEnv = {},
  isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } },
  which = (bin) => onPath(bin), codexLimits = readCodexRateLimits, claudeLimits = readClaudeRateLimits,
  // This computer's idle handoff (main.mjs): minutes() (0 = off), set(n) → the new value, report(roomId) →
  // [{name, idleMinutes}] (null: not idle now), keepalives() → whether idle agents still get them.
  idleSetting = { minutes: () => 0, set: (n) => n, report: () => [], keepalives: () => true },
  // The key table for /keys (keys.mjs): asked of the server at most once a minute.
  keyTable = null,
  spawnOptions = null,
  handoffFetchMs = HANDOFF_FETCH_MS,
  // Which agent CLIs are installed here (detect.mjs createDetector); null: not detected (tests, an older main.mjs).
  detector = null,
  approvalBusy = () => false,
  approvalShown = approvalBusy,
  approvalsRunning = () => false,
} = {}) {
  const logError = log.error || log
  const keyTableNow = keyTable || createKeys({ fetch: () => api.keys(), now, log })
  const optionTable = spawnOptions || createSpawnOptions({ fetch: () => api.spawnOptions(), now, log, file: path.join(path.dirname(stateFile), 'spawn-config.json') })
  const spawnArgs = (kind, spec) => withModel(kind, argsFor(kind, undefined, spec.perm), {
    model: spec.model || optionTable.get()[kind].default.model,
    effort: spec.effort || optionTable.get()[kind].default.effort,
  })
  // This terminal's column in the key table.
  const adapter = terminal.adapter || 'herdr'
  const host = machineName(hostname)
  const saved = readJson(stateFile) || {}
  // The seat's role: what the server answered on the last join (daemon, daemon-2, …), else what we ask for.
  let role = saved.role || seatRole(hostname)
  // rooms: roomId → {name, mode}; gone: key → {roomId, name, pane} (registered agents whose pane went away)
  const state = { rooms: saved.rooms || {}, gone: saved.gone || {}, role, device: saved.device || null }
  let account = null, seatName = null
  const joinedThisRun = new Set(), joinFailedAt = new Map(), handled = new Map(), busy = new Set(), jobs = new Set()
  const reported = new Map() // roomId → {minutes (idle handoff), clis (the detection), at} the last join told the server
  let detectedAt = -Infinity, detectJob = null, detectedLine = ''
  const readAgain = new Set() // rooms whose last listen was full: read the rest next round
  let owned = [], ownedAt = -Infinity, ownedMissing = false
  const ops = []
  // /spawn records: one per name, from taking the name until it joins, is /bye-d, its pane goes, or another
  // name registers that pane. stage: starting (tab, shell, CLI, first prompt) → joining; failed when it never
  // came up, late when it came up but did not join in time (both keep their pane for a person to look at).
  // While joining or late, one that stopped at its prompt on a network API error is told to carry on (nudge).
  // The name is also the herdr agent name, unique on this computer, so no room opens a second tab for it.
  // Saved, so a restarted daemon still knows these panes; one that was starting has lost its launch: failed.
  for (const op of saved.spawns || []) ops.push({ ...op, type: 'spawn', stage: op.stage === 'starting' ? 'failed' : op.stage })
  const spawnScreens = new Map() // raw pane text stays in memory, never in the saved spawn record
  const spawns = () => ops.filter((op) => op.type === 'spawn')
  const save = () => {
    try { writeJson(stateFile, { ...state, spawns: spawns().map(({ type, ...op }) => op) }) } catch {}
  }
  const drop = (op) => { const i = ops.indexOf(op); if (i >= 0) { ops.splice(i, 1); spawnScreens.delete(op); save() } }
  const roomName = (roomId) => rooms.get(roomId)?.roomName || state.rooms[roomId]?.name || roomId
  /** This computer's copy of a seat's handoff (the fallback): {file, mtimeMs}, or null. */
  const localHandoff = (roomId, name) => {
    const file = handoffPath(roomId, name)
    try { const stat = fs.statSync(file); return stat.isFile() ? { file, mtimeMs: stat.mtimeMs } : null } catch { return null }
  }

  /** The cloud's handoff of a seat, bounded: {found}, {none} (handoff_not_found only) or {failed: <code>}. */
  async function cloudHandoff(roomId, name) {
    let timer
    const bound = new Promise((resolve) => { timer = setTimeout(() => resolve({ failed: 'timeout' }), handoffFetchMs); timer.unref?.() })
    const asked = Promise.resolve().then(() => api.handoff(roomId, role, name, { budgetMs: handoffFetchMs })).then(
      (h) => (typeof h?.body === 'string' && Number.isFinite(h.updatedAt) ? { found: h } : { failed: 'server_error' }),
      (e) => (e?.code === 'handoff_not_found' ? { none: true } : { failed: String(e?.code || 'network') }))
    try { return await Promise.race([asked, bound]) } finally { clearTimeout(timer) }
  }

  /**
   * Which handoff a takeover gets, and from where: one of six sources. The cloud's
   * text, when used, is written to files/handoff-<name>.md (0600); the fallback is used where it is. Nothing is
   * uploaded or deleted here. null when the operation was /bye-d while the cloud was asked.
   */
  async function takeoverHandoff(op) {
    if (op.skipHandoff) return { source: 'skipped' }
    const cloud = await cloudHandoff(op.roomId, op.name)
    if (!ops.includes(op)) return null // /bye-d meanwhile: nothing written
    const local = localHandoff(op.roomId, op.name)
    // Newer or older compares UTC ms; what is said is relative.
    const fromLocal = (source) => ({ source, file: local.file, ago: agoText(now() - local.mtimeMs) })
    if (cloud.found && !(local && local.mtimeMs > cloud.found.updatedAt)) {
      const file = handoffCopyPath(op.roomId, op.name)
      try {
        ensureDir(topicFilesDir(op.roomId))
        writeJson(file, cloud.found.body)
      } catch (error) {
        log(`could not save ${op.name}'s handoff from the cloud: ${error.message}`)
        return local ? fromLocal('local_cloud_failed') : { source: 'none_cloud_failed', reason: 'local_write_failed' }
      }
      return { source: 'cloud', file, computer: cloud.found.computer || null, ago: agoText(now() - cloud.found.updatedAt) }
    }
    if (cloud.failed) return local ? { ...fromLocal('local_cloud_failed'), reason: cloud.failed } : { source: 'none_cloud_failed', reason: cloud.failed }
    return local ? fromLocal('local') : { source: 'none' }
  }

  // ---------------------------------------------------------------- room calls
  const members = async (roomId) => (await api.members(roomId, role)).members || []
  const inRoom = (list, name) => list.some((m) => m.name === name && m.status !== 'left')
  /** One line back to the room, @ the one who sent the command. The send's answer ({seq}), or null. */
  async function say(roomId, text, replyTo, to = account) {
    try {
      const sent = await api.send(roomId, role, `@${to || account} ${text}`, replyTo)
      if (replyTo) log(`command answer to ${to || account} in ${roomId} for #${replyTo}: #${sent?.seq || 'unknown'}`)
      return sent
    } catch (e) {
      log(`could not answer in ${roomId}: ${e.code || e.message}`)
      return null
    }
  }
  const sayIf = (roomId, text, replyTo, to) => (text ? say(roomId, text, replyTo, to) : null)
  /** Leave for an agent: whether it is out. */
  async function leaveFor(roomId, name) {
    try {
      await api.leave(roomId, shortOf(name))
      return true
    } catch (e) { return e.code === 'not_member' }
  }

  // ---------------------------------------------------------------- joining rooms
  const roleCard = (device, clis = []) =>
    `Scorpio daemon. This computer: ${device.name}${device.note ? ` — ${device.note}` : ''}. ${agentClisText(clis)} Spawn options: claude · codex (model=, effort=; see /help). Takes only commands @ it (${COMMANDS.map((c) => `/${c.name}`).join(' ')}); not an agent.`
  async function ensureJoined(roomIds) {
    for (const roomId of roomIds) if (!state.rooms[roomId]) { state.rooms[roomId] = {}; save() }
    // In parallel: on a slow network one join can take tens of seconds.
    // Joined rooms are joined again when the idle handoff setting changed: the join tells the server.
    const minutes = idleSetting.minutes()
    // ... and when a CLI became installed or not installed; a new version, or a report a day old, waits for a day
    // since the last report, to keep the per-computer report current without a join on every hourly version check.
    const clis = detector ? detector.list() : []
    const current = (roomId) => {
      const before = reported.get(roomId)
      return before?.minutes === minutes && !(clis.length && (installedChanged(before.clis, clis) || now() - before.at >= DETECT_REPORT_MS))
    }
    await Promise.all(Object.keys(state.rooms).map(async (roomId) => {
      if (wasRemoved(roomId)) return
      if (joinedThisRun.has(roomId) && current(roomId)) return
      if (now() - (joinFailedAt.get(roomId) ?? -Infinity) < JOIN_RETRY_MS) return
      joinFailedAt.set(roomId, now()) // taken: a round that starts meanwhile does not join twice
      try {
        const knownDevice = state.device || { name: 'computer-1', note: null }
        const rollback = readJson(ROLLBACK_FILE)
        const rollbackReport = rollback?.bad?.version && rollback?.bad?.build && Number.isFinite(rollback.at)
          ? { rollback: { bad: rollback.bad, at: rollback.at } } : {}
        const body = { role, host: true, perms: PERMS, device_id: deviceId(), machine: host, roleCard: roleCard(knownDevice, clis), resume: true, idleHandoffMinutes: minutes, ...(clis.length ? { clis } : {}), ...rollbackReport }
        let r = await api.join(roomId, body)
        if (r.device && roleCard(r.device, clis) !== body.roleCard) {
          state.device = r.device; save()
          r = await api.join(roomId, { ...body, role: shortOf(r.name), roleCard: roleCard(r.device, clis) })
        }
        if (r.device) state.device = r.device
        reported.set(roomId, { minutes, clis, at: now() })
        seatName = r.name; account = r.name.split('@').slice(1).join('@')
        if (shortOf(r.name) !== role) { log(`the server named this seat ${r.name}`); role = shortOf(r.name); state.role = role }
        state.rooms[roomId] = { name: r.roomName, mode: r.kind === 'host' ? 'host' : 'agent' }
        rooms.update(roomId, { roomName: r.roomName, topic: r.topic, owner: r.owner })
        joinedThisRun.add(roomId); joinFailedAt.delete(roomId); save()
        log(`seat ${r.name} in room ${roomId} (${r.roomName}) as ${state.rooms[roomId].mode}`)
      } catch (e) {
        // A network failure is retried in 30 seconds, anything else in 5 minutes.
        joinFailedAt.set(roomId, e.code === 'network' ? now() - JOIN_RETRY_MS + 30_000 : now())
        // Deleted (in its owner's bin): GET /rooms lists it again if it is restored.
        if (e.code === 'computer_removed') {
          markRemoved(roomId)
          leftTopic(roomId, `was removed from this topic; not retrying (run scorpio daemon rejoin=${roomId} here to add it back)`)
        }
        else if (e.code === 'room_not_found' || e.code === 'room_deleted') { delete state.rooms[roomId]; save(); log(`room ${roomId} is gone; not joining it again`) }
        // Nobody of this account is in this private topic any more (its person left; up to 0.5.3 the seat kept
        // trying): what is left of it here goes, unless an agent here is registered in it.
        else if (e.code === 'code_required' && !rosterEntries().some((x) => x.roomId === roomId)) leftTopic(roomId, 'cannot be joined without its passcode: this account left it')
        else if (e.code === 'name_taken') log(`seat could not join ${roomId}: ${e.next || e.message || 'name_taken'}; rename this computer in Settings → Devices`)
        else log(`seat could not join ${roomId}: ${e.code || e.message}`)
      }
    }))
  }
  /** Look at every agent CLI again (hourly, at start, /usage); a change is logged, and the next round tells the rooms. */
  async function detectClis() {
    detectedAt = now()
    const line = detectedText(await detector.detect())
    detectedAt = now()
    if (line !== detectedLine) { detectedLine = line; log(line.replace(/^Detected: /, 'detected agent CLIs: ')) }
  }
  /** The refusal for a /spawn of a CLI the last detection did not find (after looking at that kind again), else null. English: the seat speaks English in topics. */
  async function notInstalled(kind) {
    if (!detector || !detector.get(kind) || detector.get(kind).installed) return null
    const result = (await detector.detect([kind]), detector.get(kind))
    if (!result || result.installed) return null
    const at = new Date(result.at)
    const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    log(`/spawn refused: ${CLIS[kind].label} not installed`)
    return `✗ No ${CLIS[kind].label} on this computer (detected ${clock}).`
  }
  /** Join this room again next round (its connection keeps failing: the seat may have been renamed or removed). */
  function rejoin(roomId) {
    reported.delete(roomId)
    if (!joinedThisRun.delete(roomId)) return
    joinFailedAt.delete(roomId)
    log(`seat will join ${roomId} again`)
  }
  function forget(roomId, why = 'is archived or gone') {
    if (!state.rooms[roomId]) return
    delete state.rooms[roomId]; joinedThisRun.delete(roomId); save()
    log(`room ${roomId} ${why}; seat left it`)
  }
  /**
   * This account is no longer in the topic: its roster entries there go, active and left, with its gone and
   * /spawn records, and the seat forgets it, so no round joins it again (0.5.2–0.5.3 kept the left entries, and the
   * next round joined the topic again). An agent joining it again brings it back. The names that went.
   */
  function leftTopic(roomId, why) {
    const names = dropRoom(roomId)
    joinFailedAt.delete(roomId); reported.delete(roomId) // back in later (an agent joins): the seat joins at once
    for (const [key, g] of Object.entries(state.gone)) if (g.roomId === roomId) delete state.gone[key]
    for (const op of spawns()) if (op.roomId === roomId) drop(op)
    if (state.rooms[roomId]) forget(roomId, why)
    else save()
    return names
  }

  /** Rooms this account created that are still active; the seat joins them even with no agent there yet. */
  // Refreshed in the background and never waited for: rooms with agents here are joined at once,
  // the account's other rooms a round after the list comes back.
  let ownedJob = null
  async function ownedRooms() {
    if (now() - ownedAt >= (joinedThisRun.size ? OWNED_ROOMS_MS : OWNED_ROOMS_ALONE_MS) && !ownedJob) {
      ownedAt = now()
      ownedJob = refreshOwned().finally(() => { ownedJob = null })
    }
    return owned
  }
  async function refreshOwned() {
    try {
      const list = await api.rooms()
      if (list === null) {
        if (!ownedMissing) log('this server cannot list rooms yet (GET /rooms); the seat only joins rooms that agents here are in')
        ownedMissing = true
        return owned
      }
      for (const r of list) if (r.status && r.status !== 'active' && r.status !== 'folded') forget(r.roomId)
      owned = list.filter((r) => !r.status || r.status === 'active' || r.status === 'folded').map((r) => r.roomId)
    } catch (e) { log(`could not list this account's rooms: ${e.code || e.message}`) }
  }

  // ---------------------------------------------------------------- this computer's agents in a room
  function localAgents(roomId, entries, panes) {
    const alive = new Set((panes || []).map((p) => p.pane_id))
    const out = new Map()
    for (const e of entries) if (e.roomId === roomId) out.set(e.name, { name: e.name, pane: e.pane, alive: panes ? alive.has(e.pane) : true })
    for (const e of leftEntries()) if (e.roomId === roomId && !out.has(e.name)) out.set(e.name, { name: e.name, pane: e.pane, alive: panes ? alive.has(e.pane) : true, left: true })
    for (const g of Object.values(state.gone)) if (g.roomId === roomId && !out.has(g.name)) out.set(g.name, { name: g.name, pane: g.pane, alive: false })
    for (const op of spawns()) {
      if (op.roomId === roomId && !out.has(op.name)) out.set(op.name, { name: op.name, pane: op.pane, alive: panes ? alive.has(op.pane) : true, spawning: true })
    }
    return out
  }
  const kindAt = (panes, pane) => {
    const p = (panes || []).find((x) => x.pane_id === pane)
    return p && KINDS.includes(p.agent) ? p.agent : null
  }

  /**
   * Type a command's text into an agent and watch it start working. 'ok' it moved; 'unknown' typed but
   * not seen moving in time (Codex often; the text did arrive): never typed again, Codex would run it
   * twice, and the later timeouts catch it; 'blocked' a dialog is open (herdr says blocked, or the update
   * prompt is on screen), nothing typed (keys would answer it); 'gone' no agent in that pane any more
   * (only a shell), nothing typed (each line would run).
   */
  async function promptPane(pane, text) {
    if (approvalBusy(pane)) return 'blocked'
    const status = await terminal.paneStatus(pane)
    if (dialogBlocked(status)) return 'blocked'
    const screen = await terminal.read(pane, 200)
    if (dialogBlocked(status, screen) || NEVER_ANSWER.test(tail(screen, 20))) return 'blocked'
    try {
      if (approvalBusy(pane)) return 'blocked'
      await terminal.injectAndWatch(pane, text)
      return 'ok'
    } catch (error) {
      const why = `${error?.stdout || ''}${error?.stderr || ''}${error?.message || ''}`
      if (/agent_not_found/.test(why)) return 'gone'
      if (/agent_blocked/.test(why)) return 'blocked'
      logError(`typed into ${pane} but did not see it start: ${herdrExit('agent prompt', error)}`)
      return 'unknown'
    }
  }

  // Compare the raw pane text, including whitespace. A working status interrupts the waiting clock.
  function observeSpawn(op, screen, working) {
    const before = spawnScreens.get(op)
    const since = working ? null : before?.screen === screen && before.since !== null ? before.since : now()
    spawnScreens.set(op, { screen, since, at: now() })
    return since === null ? 0 : Math.floor((now() - since) / 1000)
  }

  async function reportStall(op, screen, seconds) {
    if (approvalShown(op.pane) || op.stallReported || !ops.includes(op) || rosterEntries().some((e) => e.roomId === op.roomId && e.name === op.name)) return
    op.stallReported = true; save()
    await say(op.roomId, `${shortOf(op.name)} has not joined yet. Its screen has not changed for ${seconds}s; the daemon does not answer it. Screen:\n${fence(tail(screen))}`, op.seq, op.to)
  }

  /**
   * Start the CLI with its first prompt as an argument; never answer startup dialogs.
   * Poll its screen until it works or stops, retaining the same waiting clock into joining.
   */
  async function startCli(op, kind, name, pane, cliArgs, first) {
    const argv = [...cliArgs, first]
    let started = null, failure = null, tries = 0, failedAt = 0, i = 0
    const start = () => {
      tries += 1; started = null; failure = null
      terminal.startAgent({ name, kind, pane, argv })
        .then(() => { started = true })
        .catch((error) => {
          failure = herdrError(error); started = false; failedAt = i
          if (STILL_STARTING.has(failure.code)) log(`agent start ${name} (try ${tries}): herdr returned ${failure.code} while the CLI works on its first prompt`)
          else logError(`agent start ${name} (try ${tries}): ${herdrExit('agent start', error)}${failure.code ? ` (${failure.code})` : ''}`)
        })
    }
    start()
    let me = null
    for (i = 0; i < 150; i += 1) {
      await sleep(500)
      const panes = await terminal.panes()
      me = (panes || []).find((p) => p.pane_id === pane) || null
      const up = Boolean(me && me.agent === kind)
      if (!ops.includes(op)) return { gone: true }
      if (rosterEntries().some((e) => e.roomId === op.roomId && e.name === op.name)) return { joined: true }
      if (up && me.agent_status === 'working') {
        observeSpawn(op, await terminal.read(pane, 200), true)
        return { ok: true }
      }
      if (started === false && !STILL_STARTING.has(failure.code) && !up) {
        // The shell was ready but something took the foreground again: one more try after two seconds.
        if (failure.code === 'agent_pane_busy' && tries < 2) { if (i - failedAt >= 4) start(); continue }
        return { ok: false, reason: failure.text }
      }
      const screen = await terminal.read(pane, 200)
      if (!screen && panes && !me) return { ok: false, gone: true }
      const seconds = observeSpawn(op, screen, false)
      if (NEVER_ANSWER.test(tail(screen, 20)) || (up && dialogBlocked(me.agent_status, screen)) || seconds * 1000 >= SPAWN_STALL_MS) return { stalled: true, screen, seconds }
    }
    if (me && me.agent === kind) {
      const screen = await terminal.read(pane, 200)
      return { stalled: true, screen, seconds: observeSpawn(op, screen, false) }
    }
    return { ok: false, reason: failure ? failure.text : '' }
  }

  // ---------------------------------------------------------------- /usage
  async function readUsage(kind) {
    if (!which(kind)) return { missing: true }
    if (CLIS[kind].usage === 'quota-api') {
      const answer = await claudeLimits()
      if (answer.reason) return { windows: [], reason: answer.reason }
      const windows = claudeWindows(answer.result)
      return windows.length ? { windows } : { windows, reason: 'no quota windows in the answer' }
    }
    const dir = path.join(HOME, 'usage')
    fs.mkdirSync(dir, { recursive: true })
    const answer = await codexLimits({ cwd: dir })
    if (answer.error === 'missing') return { missing: true }
    if (answer.error) return { windows: [], reason: /authentication required/i.test(answer.error) ? 'not logged in' : answer.error }
    const windows = codexWindows(answer.result)
    return windows.length ? { windows } : { windows, reason: 'no quota windows in the answer' }
  }

  /**
   * When one command @s several daemons (the page may address all of an account's daemons), each only
   * handles its own computer's agents: a named agent that is in the room but not here gets no answer
   * from this one; a name not in the room at all is answered by the first daemon named only. Answers
   * carry the computer's name so they can be told apart.
   */
  async function audience(roomId, message) {
    const named = daemonsNamed(message, await members(roomId).catch(() => null))
    const multi = named.length > 1
    const roster = new Set((await members(roomId).catch(() => [])).filter((m) => m.status !== 'left').map((m) => m.name))
    return {
      multi,
      missing(name) {
        const short = shortOf(name)
        if (!roster.has(name)) return !multi || named[0] === seatName ? `✗ ${short} · not in this topic` : null
        return multi ? null : `✗ ${short} · not on this computer`
      },
      text(lines) {
        const body = [].concat(lines).filter(Boolean)
        if (!body.length) return null
        return multi ? `${host}:${body.length > 1 ? '\n' : ' '}${body.join('\n')}` : body.join('\n')
      },
    }
  }

  // ---------------------------------------------------------------- /bye: stop delivery → leave for it → close its pane
  async function byeOne(roomId, agent, panes, unregister) {
    unregister({ roomId, name: agent.name, pane: agent.pane })
    delete state.gone[`${roomId}|${agent.name}`]; save()
    const left = await leaveFor(roomId, agent.name)
    const closed = agent.alive && agent.pane ? await terminal.closePane(agent.pane, panes) : false
    for (const op of spawns()) if (op.roomId === roomId && op.name === agent.name) drop(op)
    const short = shortOf(agent.name)
    if (!agent.alive) return `✓ ${short} · its process was already gone; left the topic for it`
    return `✓ ${short} · ${left ? 'left the topic' : 'could not leave the topic'} · ${closed ? 'pane closed' : 'pane not closed'}`
  }

  // ---------------------------------------------------------------- the second half of /spawn
  // Each await is followed by a look at ops: when /bye took it meanwhile, nothing more is said.
  async function launch(op, spec) {
    const short = shortOf(op.name), { roomId, pane } = op
    const screenText = async () => `Screen:\n${fence(tail(await terminal.read(pane)))}`
    // A takeover first finds its handoff: the operation is recorded already, so a second /spawn of the name
    // is answered "is starting", and the main loop goes on delivering meanwhile.
    if (op.keepCard) {
      op.handoff = await takeoverHandoff(op)
      if (!ops.includes(op)) { log(`${short} was /bye-d while its handoff was looked for; not answering`); return }
      log(`${short}'s handoff: ${op.handoff.source}${op.handoff.reason ? ` (${op.handoff.reason})` : ''}`)
      save()
    }
    const toRead = op.handoff?.file ? op.handoff : null
    const file = spawnPath(roomId, op.name)
    ensureDir(path.dirname(file))
    writeJson(file, `${spawnPrompt({ account, by: op.to, roomId, roomName: roomName(roomId), seq: op.seq, name: op.name, pane, prompt: spec.prompt, keepCard: op.keepCard, handoff: op.handoff, scheduled: op.scheduled })}\n`)
    const shell = await terminal.waitShell(pane, () => !ops.includes(op))
    if (!ops.includes(op)) { log(`${short} was /bye-d while its shell started; not answering`); return }
    if (shell.gone) { drop(op); await say(roomId, `${short}'s pane was closed before it started.`, op.seq, op.to); return }
    if (!shell.ok) {
      op.stage = 'failed'; save()
      await say(roomId, `Opened a tab for ${short} (pane ${pane}), but its shell was not ready within ${SHELL_READY_SECONDS} seconds, so no CLI was started. Usually a slow shell startup on this computer (nvm, oh-my-zsh, git in the prompt). The pane is still open; /bye ${short} closes it. ${await screenText()}`, op.seq, op.to)
      return
    }
    const cliArgs = spawnArgs(spec.kind, spec)
    const up = await startCli(op, spec.kind, short, pane, cliArgs, spawnLine({ by: op.to, roomName: roomName(roomId), name: op.name, file, prompt: spec.prompt, handoff: toRead }))
    if (!ops.includes(op)) { log(`${short} was /bye-d while its CLI started; not answering`); return }
    if (up.gone) { drop(op); await say(roomId, `${short}'s pane was closed before it started.`, op.seq, op.to); return }
    if (up.joined || inRoom(await members(roomId).catch(() => []), op.name)) { drop(op); return }
    if (up.stalled && !approvalsRunning()) {
      op.stage = 'joining'; op.deadline = now() + SPAWN_JOIN_MS; save()
      await reportStall(op, up.screen, up.seconds)
      return
    }
    if (!up.ok && !up.stalled) {
      op.stage = 'failed'; save()
      const why = up.reason ? `did not start; herdr says: ${up.reason}` : 'did not start within a minute'
      await say(roomId, `${short}'s CLI ${why}. The pane is still open; /bye ${short} closes it. ${await screenText()}`, op.seq, op.to)
      return
    }
    op.stage = 'joining'; op.deadline = now() + SPAWN_JOIN_MS; save()
    const seat = op.keepCard ? takeoverText(short, op.handoff) : 'a new name in this topic'
    const replaced = op.replacedGone ? ` ${short}'s old process on this computer was gone, so the daemon took it out of the topic first.` : ''
    const configPath = CONFIG_FILE.startsWith(os.homedir() + path.sep) ? '~' + CONFIG_FILE.slice(os.homedir().length) : CONFIG_FILE
    const permissionNote = (spec.perm === 'all' && !fullPermission(spec.kind, cliArgs) || spec.perm === 'auto' && !autoPermission(spec.kind, cliArgs))
      ? ` perm=${spec.perm} was not applied: this computer's ${configPath} spawn.${spec.kind} sets the arguments.` : ''
    const autoNote = permOf(spec.kind, cliArgs) === 'auto' ? (spec.kind === 'claude'
      ? " perm=auto: Claude Code's auto mode decides what runs. What it blocks does not come to you as a card; your own ask rules still do."
      : " perm=auto: Codex's auto-review decides what runs, without the approval hook. What it blocks does not come to you as a card.") : ''
    const codexNote = spec.kind === 'codex' && spec.perm === 'ask' && !Array.isArray(readJson(CONFIG_FILE)?.spawn?.codex) ? codexApprovalNote(cliArgs) : ''
    await say(roomId, `Started ${short} (${spec.kind}: ${modelText(spec.kind, cliArgs)}) in ${op.dir}, ${seat}.${replaced} It is working on its first prompt; waiting for it to join. ${permissionNotice(op)}${permissionNote}${autoNote}${codexNote ? ` ${codexNote}` : ''}`, op.seq, op.fromKind === 'agent' ? op.name : op.to)
  }

  /** Started but not joined, and stopped at its prompt on a network API error: tell it to carry on. */
  async function nudge(op, panes) {
    const pane = (panes || []).find((p) => p.pane_id === op.pane)
    if (!pane || !['idle', 'done'].includes(pane.agent_status) || op.nudgeEnded) return
    if (now() - (op.lookedAt ?? -Infinity) < NUDGE_LOOK_MS || now() - (op.nudgedAt ?? -Infinity) < NUDGE_GAP_MS) return
    op.lookedAt = now()
    const screen = await terminal.read(op.pane, 60)
    if (!stoppedOnNetworkError(pane.agent, screen)) return
    const short = shortOf(op.name), nudges = op.nudges || 0
    if (nudges >= NUDGE_MAX) {
      op.nudgeEnded = true; save()
      await say(op.roomId, `${short} stopped on an API connection error again after ${NUDGE_MAX} nudges to carry on; not nudging it any more. Its pane is still open (/bye ${short} closes it). Screen:\n${fence(tail(screen))}`, op.seq, op.to)
      return
    }
    const sent = await promptPane(op.pane, nudgePrompt({ file: spawnPath(op.roomId, op.name) }))
    if (sent === 'blocked' || sent === 'gone') return
    op.nudges = nudges + 1; op.nudgedAt = now(); save()
    log(`${short} stopped on an API connection error before joining; told it to carry on (${op.nudges}/${NUDGE_MAX})`)
  }

  // ---------------------------------------------------------------- handing over (/handoff, idle handoff)
  /** Type the handoff instructions into one agent: promptPane's answer and the handoff file. */
  async function askHandoff({ roomId, agent, panes, by, seq, targets, idleMinutes = null }) {
    const file = handoffPath(roomId, agent.name)
    ensureDir(path.dirname(file))
    // The takeover command starts the same CLI with the same model and effort: taking over must not quietly downgrade.
    const kind = kindAt(panes, agent.pane)
    const fg = ((await terminal.processInfo(agent.pane))?.foreground_processes || []).find((p) => runsCli({ foreground_processes: [p] }, kind))
    const perm = kind ? permOf(kind, (fg?.argv || []).slice(1)) : 'ask'
    const { model, effort } = kind ? modelOf(kind, (fg?.argv || []).slice(1)) : {}
    const items = (rooms.get(roomId)?.items || []).filter((i) => i.assignee === agent.name && (i.status === 'doing' || i.status === 'todo'))
    const text = handoffPrompt({ model, effort, perm, items, idleMinutes,
      account, by, roomId, roomName: roomName(roomId), seq, file, targets, daemonName: seatName, kind, name: agent.name,
      dir: (panes || []).find((p) => p.pane_id === agent.pane)?.cwd,
    })
    return { sent: await promptPane(agent.pane, text), file }
  }

  /**
   * Idle handoff: the main loop found this agent idle for `minutes` in a row. As if its owner
   * had sent /handoff <role>, except that the seat first says why in the room, and once the agent has
   * left says nothing more (its own handoff messages tell the rest). 'started', or why not this time.
   */
  async function idleHandoff({ entry, minutes, panes, unregister = () => {} }) {
    const { roomId } = entry
    if (!seatName || !joinedThisRun.has(roomId)) return 'the seat has not joined that topic yet'
    const agent = localAgents(roomId, [entry], panes).get(entry.name)
    if (!agent?.alive) return 'its pane is gone'
    if (ops.some((op) => (op.type === 'handoff' ? op.targets.some((a) => a.name === entry.name && !a.result) : op.name === entry.name))) return 'a command is already handling it'
    // A dialog on screen: stuck, not idle; and typed text would answer the dialog.
    const status = (panes || []).find((p) => p.pane_id === agent.pane)?.agent_status
    if (approvalBusy(agent.pane) || dialogBlocked(status)) return 'a dialog is open'
    const screen = await terminal.read(agent.pane, 200)
    if (dialogBlocked(status, screen) || NEVER_ANSWER.test(tail(screen, 20))) return 'a dialog is open'
    const role = shortOf(entry.name)
    const said = await say(roomId, idleNotice({ minutes, role }))
    if (!Number.isInteger(said?.seq)) return 'could not say so in the topic'
    const { sent, file } = await askHandoff({ roomId, agent, panes, by: account, seq: said.seq, targets: role, idleMinutes: minutes })
    if (sent === 'gone') {
      await say(roomId, (await byeOne(roomId, { ...agent, alive: false }, panes, unregister)).replace('its process was already gone', 'its CLI had exited'), said.seq)
      return 'started'
    }
    if (sent === 'blocked') {
      await say(roomId, approvalShown(agent.pane)
        ? `✗ ${role} · waiting for its owner to answer an approval card in Scorpio; the handoff instructions were not typed in, nothing done.`
        : `✗ ${role} · a dialog opened just now; the handoff instructions were not typed in, nothing done. Screen:\n${fence(tail(await terminal.read(agent.pane), 8))}`, said.seq)
      return 'a dialog is open'
    }
    ops.push({ type: 'handoff', idle: true, roomId, seq: said.seq, to: account, targets: [{ ...agent, file }], done: [], deadline: now() + HANDOFF_MS,
      aud: { text: (lines) => [].concat(lines).filter(Boolean).join('\n') || null } })
    return 'started'
  }

  // ---------------------------------------------------------------- /read, /keys, /text: a pane this daemon started
  /**
   * The CLI this daemon started for this agent of this computer, or null when it did not start it: a /spawn record
   * not joined yet (its op), or a joined one whose pane is the one its last /spawn opened (a record written
   * before /keys existed has no pane: the kind is enough).
   */
  function startedKind(roomId, agent) {
    const record = readJson(spawnRecordPath(roomId, agent.name))
    const op = spawns().find((o) => o.roomId === roomId && o.name === agent.name)
    if (op) return op.kind || record?.kind || null
    return record && KINDS.includes(record.kind) && (!record.pane || record.pane === agent.pane) ? record.kind : null
  }
  /** Name → {agent, kind}, or {reply} saying why not (null: another daemon named in the same message answers). */
  async function startedPane(roomId, name, verb, ctx, aud) {
    const here = localAgents(roomId, ctx.entries, await terminal.panes() ?? ctx.panes)
    const agent = here.get(name), short = shortOf(name)
    if (!agent) {
      const missing = aud.missing(name)
      if (!missing || aud.multi) return { reply: missing }
      const mine = [...here.values()].filter((a) => startedKind(roomId, a)).map((a) => shortOf(a.name))
      return { reply: `${missing}. ${mine.length ? `Agents this daemon started here: ${mine.join(', ')}.` : 'This daemon started no agent in this topic.'} Usage: ${usage(verb)}` }
    }
    const kind = startedKind(roomId, agent)
    if (!kind) return { reply: `✗ ${short} · not started by this daemon (/spawn), so /${verb} does not reach its pane` }
    if (!agent.alive || !agent.pane) return { reply: `✗ ${short} · its pane is closed` }
    return { agent, kind }
  }
  /** null when that CLI is in front of the pane, else the reply: nothing is sent to a shell (each line would run). */
  async function notInFront({ agent, kind }, done) {
    const info = await terminal.processInfo(agent.pane)
    if (runsCli(info, kind)) return null
    const fg = info?.foreground_processes?.[0]
    const what = fg ? `${fg.name || String(fg.argv?.[0] || '').split('/').pop()} is` : 'herdr cannot say what is'
    return `✗ ${shortOf(agent.name)} · ${CLIS[kind].label} is no longer in front of its pane (${what}), so nothing was ${done}. Screen:\n${fence(tail(await terminal.read(agent.pane)))}`
  }
  // /keys and /text to one agent run one after another, in the order they came: each queues before its first await.
  const lanes = new Map()
  function inLane(key, fn) {
    const run = (lanes.get(key) || Promise.resolve()).then(fn)
    const settled = run.catch(() => {})
    lanes.set(key, settled)
    settled.then(() => { if (lanes.get(key) === settled) lanes.delete(key) })
    return run
  }
  /** Not joined yet: it gets SPAWN_JOIN_MS from now, and its screen again if it has not joined by then. */
  function touched(roomId, name) {
    const op = spawns().find((o) => o.roomId === roomId && o.name === name)
    if (!op || op.stage === 'starting') return
    op.stage = 'joining'; op.deadline = now() + SPAWN_JOIN_MS; op.touched = true; save()
  }
  const seconds = (ms) => `${Number((ms / 1000).toFixed(1))} s`
  /** After /keys or /text: settleMs, then the screen, so whoever sent it sees what it did. */
  async function settled(roomId, message, aud, agent, did) {
    const { settleMs } = await keyTableNow()
    await sleep(settleMs)
    await sayIf(roomId, aud.text(`${shortOf(agent.name)} · ${did}. Screen ${seconds(settleMs)} later:\n${fence(tail(await terminal.read(agent.pane), 20))}`), message.seq, senderOf(message).from)
  }

  // ---------------------------------------------------------------- commands
  const runners = {
    /** /read <name> [lines]: the screen of a pane this daemon started; no other check. */
    async read({ roomId, message, command, ctx }) {
      const arg = parseRead(command.rest, account)
      if (arg.error) return say(roomId, `${arg.error}. Usage: ${usage('read')}`, message.seq, senderOf(message).from)
      const aud = await audience(roomId, message)
      const t = await startedPane(roomId, arg.name, 'read', ctx, aud)
      if (!t.agent) return sayIf(roomId, aud.text(t.reply), message.seq, senderOf(message).from)
      const screen = tail(await terminal.read(t.agent.pane, Math.max(200, arg.lines * 3)), arg.lines)
      await sayIf(roomId, aud.text(screen ? `${shortOf(arg.name)} · last ${arg.lines} lines:\n${fence(screen)}` : `${shortOf(arg.name)} · its screen is empty`), message.seq, senderOf(message).from)
    },
    /** /keys <name> <key>…: keys from the key table, KEY_GAP_MS apart, only while its CLI is in front. */
    keys: ({ roomId, message, command, ctx }) => inLane(`${roomId}|${targetOf(command.rest, account)}`, async () => {
      const keys = keysFor(await keyTableNow(), adapter)
      const arg = parseKeys(command.rest, account, (word) => findKey(keys, word))
      if (arg.error) return say(roomId, `${arg.error}. Usage: ${usage('keys')}; keys: ${keyList(keys)}.`, message.seq, senderOf(message).from)
      const aud = await audience(roomId, message)
      const t = await startedPane(roomId, arg.name, 'keys', ctx, aud)
      if (!t.agent) return sayIf(roomId, aud.text(t.reply), message.seq, senderOf(message).from)
      const refused = await notInFront(t, 'pressed')
      if (refused) return sayIf(roomId, aud.text(refused), message.seq, senderOf(message).from)
      for (const [i, key] of arg.keys.entries()) {
        if (i) await sleep(KEY_GAP_MS)
        await terminal.sendKeys(t.agent.pane, key[adapter])
      }
      touched(roomId, arg.name)
      await settled(roomId, message, aud, t.agent, `pressed ${arg.keys.map((k) => k.label || k.name).join(' ')}`)
    }),
    /** /text <name> <text>: typed, Enter not pressed, only while its CLI is in front. */
    text: ({ roomId, message, command, ctx }) => inLane(`${roomId}|${targetOf(command.rest, account)}`, async () => {
      const arg = parseText(command.rest, account)
      if (arg.error) return say(roomId, `${arg.error}. Usage: ${usage('text')}`, message.seq, senderOf(message).from)
      const aud = await audience(roomId, message)
      const t = await startedPane(roomId, arg.name, 'text', ctx, aud)
      if (!t.agent) return sayIf(roomId, aud.text(t.reply), message.seq, senderOf(message).from)
      const refused = await notInFront(t, 'typed')
      if (refused) return sayIf(roomId, aud.text(refused), message.seq, senderOf(message).from)
      await terminal.sendText(t.agent.pane, arg.text)
      touched(roomId, arg.name)
      await settled(roomId, message, aud, t.agent, 'typed the text, Enter not pressed')
    }),
    async attach({ roomId, message, command }) {
      if (senderOf(message).fromKind !== 'agent') return say(roomId, 'Only the agent that joined can attach its pane.', message.seq, senderOf(message).from)
      const code = command.rest.trim()
      const pending = consumePending({ roomId, name: senderOf(message).from, code, now: now() })
      if (pending.error) return say(roomId, 'That attach code is missing, wrong, or expired. Run join again for a fresh code, or ask your person to specify pane=.', message.seq, senderOf(message).from)
      const panes = await terminal.panes() || []
      const matches = await matchingPanes(panes, (...args) => terminal.read(...args), code)
      if (matches.length !== 1) return say(roomId, `The code appeared in ${matches.length} agent panes, so none was registered. Ask your person to identify your pane with herdr pane list, then rerun join with resume=true pane=<that pane id>.`, message.seq, senderOf(message).from)
      if (!registerLocal({ roomId, name: senderOf(message).from, role: pending.role, pane: matches[0] })) return say(roomId, 'Could not write the local delivery roster. Ask your person to check ~/.scorpio/state permissions, then rerun join.', message.seq, senderOf(message).from)
      await say(roomId, `Registered you on pane ${matches[0]}; the daemon can now deliver messages there.`, message.seq, senderOf(message).from)
    },
    async help({ roomId, message }) {
      const choices = spawnHelpOptions(optionTable.get(), detector?.list() || [])
      const lines = HELP_FULL.split('\n')
      const spawnLine = lines.findIndex((line) => line.startsWith('- `/spawn '))
      if (spawnLine >= 0 && choices) lines.splice(spawnLine + 1, 0, choices)
      await say(roomId, `${lines.join('\n')}\nKeys for /keys: ${keyList(keysFor(await keyTableNow(), adapter))}.`, message.seq, senderOf(message).from)
    },
    /** /idle [minutes|off]: this computer's idle handoff, shown or changed. */
    async idle({ roomId, message, command }) {
      const arg = parseIdle(command.rest)
      if (arg.error) return say(roomId, `${arg.error} Usage: ${usage('idle')}`, message.seq, senderOf(message).from)
      const before = idleSetting.minutes()
      if (!arg.show) {
        try { idleSetting.set(arg.minutes) } catch (error) { return say(roomId, `${host}: could not change it: ${error?.message || error}`, message.seq, senderOf(message).from) }
      }
      const m = idleSetting.minutes()
      const was = arg.show || m === before ? '' : ` (was ${before ? minutesText(before) : 'off'})`
      if (!m) return say(roomId, `${host}: idle handoff is off${was}; agents here stay until /handoff. /idle 60 turns it on.`, message.seq, senderOf(message).from)
      const agents = idleSetting.report(roomId).map((a) => `${shortOf(a.name)} ${a.idleMinutes === null ? 'not idle' : `idle ${a.idleMinutes} min`}`)
      await say(roomId, [
        `${host}: idle handoff after ${minutesText(m)}${was}. An agent here idle that long in a row (not stuck at a dialog, nothing waiting for it) is handed off as if you had sent /handoff; ${idleSetting.keepalives() ? 'keep-alives go on until then' : 'no keep-alives (it leaves before its prompt cache would go cold)'}.`,
        ...(agents.length ? [`Now: ${agents.join(', ')}.`] : []),
        '/idle 120 changes it, /idle off turns it off (idle_handoff_minutes in ~/.scorpio/config.json on this computer).',
      ].join(' '), message.seq, senderOf(message).from)
    },
    async usage({ roomId, message }) {
      if (detector) await detectClis().catch((error) => log(`detection failed: ${String(error?.message || error).slice(0, 80)}`))
      const lines = []
      for (const kind of KINDS) {
        let result
        try { result = await readUsage(kind) } catch (error) { result = { windows: [], reason: String(error?.message || error).slice(0, 80) } }
        lines.push(usageLine(CLIS[kind].label, result, now()))
      }
      await say(roomId, `${host}:\n${lines.join('\n')}`, message.seq, senderOf(message).from)
    },

    /**
     * Takes the name and opens the tab while the main loop waits, so a later /spawn or /bye in the same
     * batch sees it; launch() does the long rest in the background. An active local name is reused only
     * when its pane is gone; a live local or remote name is refused. Herdr names are unique per computer.
     */
    async spawn({ roomId, message, command, ctx, unregister }) {
      const sender = senderOf(message)
      const spec = parseSpawn(command.rest)
      const to = message.fromKind === 'scheduled' && spec.name && `${spec.name}@${account}` === sender.from ? account : sender.from
      if (spec.error) return say(roomId, spec.error, message.seq, to)
      // A CLI this computer does not have: said at once, nothing recorded or opened. It is looked
      // for again first: one installed since the last look is found, and kept for the card.
      const missing = await notInstalled(spec.kind)
      if (missing) return say(roomId, missing, message.seq, to)
      const last = spec.name ? readJson(spawnRecordPath(roomId, `${spec.name}@${account}`)) : null
      const line = (d, kind = spec.kind, model = spec.model, effort = spec.effort) => fence(`@${seatName} /spawn ${kind}${spec.name ? ` ${spec.name}` : ''}${d ? ` ${spawnDirArg(d)}` : ''}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''}${spec.prompt ? ` ${spec.prompt}` : ''}`)
      // An explicit directory in this name's previous /spawn must be repeated for a takeover.
      if (spec.needDir && last?.dir && last.explicitDir !== false) {
        return say(roomId, `Not started: ${spec.name} last worked in ${last.dir}. Copy the command with that directory, or name another one:\n${line(last.dir, last.kind, last.model, last.effort)}`, message.seq, to)
      }
      // A named directory this computer doesn't have: offer existing ones as commands to copy.
      const offer = (why) => {
        const dirs = [...new Set((ctx.panes || []).filter((p) => p.agent && p.cwd).map((p) => p.cwd))].slice(0, 3)
        const previous = last?.dir && KINDS.includes(last.kind) ? `Last time ${spec.name} worked in ${last.dir}:\n${line(last.dir, last.kind, last.model, last.effort)}\n` : ''
        const choices = dirs.length ? `Directories agents work in on this computer:\n${dirs.map((d) => line(d)).join('\n')}` : `Without a directory it starts in this topic's workspace:\n${line(null)}`
        return say(roomId, `${why} Usage: ${usage('spawn')}; a named directory starts with / or ~ and is on this computer. ${previous}${choices}`, message.seq, to)
      }
      const dir = spec.needDir ? workspaceFor(roomId) : spec.dir.replace(/^~(?=\/|$)/, os.homedir())
      if (!spec.needDir && !isDir(dir)) return offer(`Not started: this computer has no directory ${spec.dir}.`)
      const everyone = await members(roomId)
      const roster = everyone.filter((m) => m.status !== 'left')
      const live = await terminal.agents() || []
      const short = spec.name || freeName(spec.kind, [...everyone.map((m) => m.name), ...live.map((a) => a.name), ...spawns().map((op) => op.name)])
      const name = `${short}@${account}`
      const previous = permissionLevel(everyone.find((m) => m.name === name)?.perm?.level)
      const parent = sender.fromKind === 'agent' ? { name: sender.from, level: everyone.find((m) => m.name === sender.from)?.perm?.level } : null
      if (parent) {
        const local = ctx.entries.find((e) => e.roomId === roomId && e.name === sender.from)
        const record = local && readJson(spawnRecordPath(roomId, sender.from))
        if (local && record?.pane !== local.pane) parent.level = null
      }
      let permission = spawnPermission({ requested: spec.perm, previous, sender: parent })
      if (permission.needsSetting) {
        let setting
        try { setting = permissionLevel((await api.spawnPerm()).perm) } catch {}
        if (!setting) return say(roomId, SETTING_UNREADABLE, message.seq, to)
        permission = spawnPermission({ requested: spec.perm, previous, sender: parent, setting })
      }
      if (permission.error) return say(roomId, permission.error, message.seq, to)
      spec.perm = permission.level
      let replacedGone = false
      if (inRoom(roster, name)) {
        const here = localAgents(roomId, ctx.entries, ctx.panes).get(name)
        if (!here) return say(roomId, `${short} is in this topic on another computer, or is a person here. To take that seat over, use the daemon of the computer it runs on; otherwise pick another name.`, message.seq, to)
        if (here.alive) return say(roomId, `${short} is running on this computer (pane ${here.pane}). To replace it, first /handoff ${short} (it writes a handoff) or /bye ${short} (no handoff).`, message.seq, to)
        await byeOne(roomId, here, ctx.panes, unregister)
        replacedGone = true
      }
      const pending = spawns().find((op) => shortOf(op.name) === short)
      if (pending) {
        const where = { starting: 'is starting on this computer', joining: 'has started on this computer and is about to join',
          failed: 'did not start on this computer last time; its pane is still open',
          late: `started but has not joined for ${Math.round(SPAWN_JOIN_MS / MIN)} minutes; its pane is still open` }[pending.stage]
        const there = pending.roomId === roomId ? '' : ` (in the topic "${roomName(pending.roomId)}"; send /bye there)`
        return say(roomId, `${short} ${where}${there}. To start over, /bye ${short} first.`, message.seq, to)
      }
      const taken = live.find((a) => a.name === short)
      if (taken) return say(roomId, `A live agent named ${short} already runs in this computer's Herdr (pane ${taken.pane_id}); herdr allows one per name. Pick another name.`, message.seq, to)
      // A takeover (the name is in the topic, left) keeps its card as the topic has it, whatever that card says; a new name
      // gets the generic one.
      const keepCard = everyone.some((m) => m.name === name)
      if (spec.needDir) {
        try { ensureDir(dir) } catch (error) { return say(roomId, `Not started: could not create the topic workspace ${dir}: ${error.message}`, message.seq, to) }
      }
      const effectivePerm = permOf(spec.kind, argsFor(spec.kind, undefined, spec.perm))
      const op = { type: 'spawn', stage: 'starting', kind: spec.kind, roomId, seq: message.seq, name, to, fromKind: sender.fromKind, scheduled: message.scheduled, keepCard, skipHandoff: keepCard && !!spec.skipHandoff, perm: effectivePerm, permFrom: permission.from, permParent: permission.parent, dir, replacedGone }
      ops.push(op)
      const homeBin = path.join(HOME, 'bin')
      const inheritedPath = spawnEnv.PATH || process.env.PATH || ''
      const privateNode = path.join(HOME, 'node', 'bin')
      const first = fs.existsSync(path.join(privateNode, 'node')) ? [privateNode] : []
      const agentPath = [homeBin, ...first, ...inheritedPath.split(path.delimiter).filter((part) => part && part !== homeBin && !first.includes(part))].join(path.delimiter)
      try { Object.assign(op, await terminal.newTab({ label: short, cwd: dir, env: { ...spawnEnv, PATH: agentPath } })) } catch (error) { drop(op); throw error }
      try {
        const chosen = modelOf(spec.kind, spawnArgs(spec.kind, spec))
        // pane: which pane this daemon started it in, for /read, /keys and /text once it has joined.
        ensureDir(path.dirname(spawnRecordPath(roomId, name)))
        writeJson(spawnRecordPath(roomId, name), { kind: spec.kind, dir, explicitDir: !spec.needDir, model: chosen.model ?? null, effort: chosen.effort ?? null, pane: op.pane, perm: op.perm, permFrom: op.permFrom, permParent: op.permParent, at: now() })
      } catch (error) { log(`could not remember /spawn ${short}: ${error.message}`) }
      save()
      launch(op, spec).catch(async (error) => {
        logError(`/spawn ${short} failed: ${herdrExit('agent start', error)}`)
        if (ops.includes(op)) { op.stage = 'failed'; save() }
        await say(roomId, `/spawn did not finish: ${herdrError(error).text}`, message.seq, to)
      })
    },

    async handoff({ roomId, message, command, ctx, unregister }) {
      const t = parseTargets(command.rest, account)
      if (t.error) return say(roomId, `${t.error}. Usage: ${usage('handoff')}`, message.seq, senderOf(message).from)
      const here = localAgents(roomId, ctx.entries, ctx.panes)
      const aud = await audience(roomId, message)
      const picked = t.all ? [...here.values()] : t.names.map((n) => here.get(n) || { name: n, missing: true })
      if (!picked.length) return sayIf(roomId, aud.multi ? null : 'This computer has no agents in this topic.', message.seq, senderOf(message).from)
      const lines = [], waiting = []
      for (const agent of picked) {
        const short = shortOf(agent.name)
        if (agent.missing) { lines.push(aud.missing(agent.name)); continue }
        if (agent.left) { lines.push(`✗ ${shortOf(agent.name)} · already left; /bye ${shortOf(agent.name)} closes its pane`); continue }
        if (!agent.alive || agent.spawning) { lines.push(await byeOne(roomId, agent, ctx.panes, unregister)); continue }
        const { sent, file } = await askHandoff({ roomId, agent, panes: ctx.panes, by: senderOf(message).from, seq: message.seq, targets: t.all ? 'all' : t.names.map(shortOf).join(' ') })
        if (sent === 'gone') lines.push((await byeOne(roomId, { ...agent, alive: false }, ctx.panes, unregister)).replace('its process was already gone', 'its CLI had exited'))
        else if (sent === 'blocked') lines.push(approvalShown(agent.pane)
          ? `✗ ${short} · waiting for its owner to answer an approval card in Scorpio; the handoff instructions were not typed in, nothing done.`
          : `✗ ${short} · stuck on a dialog; the handoff instructions were not typed in, nothing done. Screen:\n${fence(tail(await terminal.read(agent.pane), 8))}`)
        else waiting.push({ ...agent, file })
      }
      if (waiting.length) {
        ops.push({ type: 'handoff', roomId, seq: message.seq, to: senderOf(message).from, targets: waiting, done: lines.filter(Boolean), deadline: now() + HANDOFF_MS, aud })
        await say(roomId, aud.text(`Got it; asked ${waiting.map((a) => shortOf(a.name)).join(', ')} to write a handoff.`), message.seq, senderOf(message).from)
      } else await sayIf(roomId, aud.text(lines), message.seq, senderOf(message).from)
    },

    async bye({ roomId, message, command, ctx, unregister }) {
      const t = parseTargets(command.rest, account)
      if (t.error) return say(roomId, `${t.error}. Usage: ${usage('bye')}`, message.seq, senderOf(message).from)
      const here = localAgents(roomId, ctx.entries, ctx.panes)
      const aud = await audience(roomId, message)
      const picked = t.all ? [...here.values()] : t.names.map((n) => here.get(n) || { name: n, missing: true })
      if (!picked.length) return sayIf(roomId, aud.multi ? null : 'This computer has no agents in this topic.', message.seq, senderOf(message).from)
      const lines = []
      for (const agent of picked) lines.push(agent.missing ? aud.missing(agent.name) : await byeOne(roomId, agent, ctx.panes, unregister))
      await sayIf(roomId, aud.text(lines), message.seq, senderOf(message).from)
    },
  }

  // ---------------------------------------------------------------- pending operations
  async function progress(ctx, unregister) {
    const rosters = new Map()
    const roster = async (roomId) => {
      if (!rosters.has(roomId)) rosters.set(roomId, await members(roomId).catch(() => null))
      return rosters.get(roomId)
    }
    // A tab opened during this round is not in ctx.panes, which was taken at its start.
    const livePanes = spawns().some((op) => op.stage !== 'starting') ? await terminal.panes() : null
    for (const op of [...ops]) {
      if (op.type === 'spawn' && op.stage === 'starting') continue
      const list = await roster(op.roomId)
      if (!list) continue
      if (op.type === 'spawn') {
        // Joined (even late), or its pane is gone (closed by hand): no longer a not-yet-joined agent of this computer.
        if (inRoom(list, op.name) || (livePanes && !livePanes.some((p) => p.pane_id === op.pane))) { drop(op); continue }
        if (approvalShown(op.pane)) { op.deadline = now() + SPAWN_JOIN_MS; continue }
        if (op.stage === 'joining' || op.stage === 'late') {
          const before = spawnScreens.get(op)
          if (!before || now() - before.at >= SPAWN_SCREEN_MS) {
            const screen = await terminal.read(op.pane, 200)
            const working = livePanes?.find((p) => p.pane_id === op.pane)?.agent_status === 'working'
            const seconds = observeSpawn(op, screen, working)
            if (!working && seconds * 1000 >= SPAWN_STALL_MS) await reportStall(op, screen, seconds)
          }
          await nudge(op, livePanes)
        }
        if (op.stage === 'joining' && now() >= op.deadline) {
          op.stage = 'late'; save()
          const short = shortOf(op.name)
          await say(op.roomId, `${short} has not joined after 10 minutes; its pane is still open (/bye ${short} closes it). Screen:\n${fence(tail(await terminal.read(op.pane)))}`, op.seq, op.to)
        }
      } else if (op.type === 'handoff') {
        const elapsed = Math.max(0, now() - (op.checkedAt ?? op.deadline - HANDOFF_MS))
        op.checkedAt = now()
        if (op.targets.some((a) => !a.result && approvalBusy(a.pane))) { op.deadline += elapsed; continue }
        for (const agent of op.targets.filter((a) => !a.result)) {
          if (inRoom(list, agent.name)) continue
          unregister({ roomId: op.roomId, name: agent.name, pane: agent.pane })
          const closed = await terminal.closePane(agent.pane, ctx.panes)
          agent.result = `✓ ${shortOf(agent.name)} · left the topic · ${closed ? 'pane closed' : 'pane not closed'}`
        }
        const open = op.targets.filter((a) => !a.result)
        if (open.length && now() <= op.deadline) continue
        for (const agent of open) {
          agent.result = `⏳ ${shortOf(agent.name)} · did not leave within 2 hours; pane left open. Screen:\n${fence(tail(await terminal.read(agent.pane), 8))}`
        }
        ops.splice(ops.indexOf(op), 1)
        if (op.idle && !open.length) continue // it left: its own handoff messages said the rest
        await say(op.roomId, op.aud.text([...op.done, ...op.targets.map((a) => a.result)]), op.seq, op.to)
      }
    }
  }

  // ---------------------------------------------------------------- the seat's own messages
  /** Read what @s the seat in one room, mark it, and run the commands. */
  async function handle(roomId, ctx, unregister) {
    if (!seatName || !joinedThisRun.has(roomId)) return
    let listen
    try { listen = await api.listen(roomId, role) } catch (e) { log(`seat could not read ${roomId}: ${e.code || e.message}`); return }
    const fresh = (listen.mentions || []).filter((m) => m.seq > (handled.get(roomId) || 0))
    // Read up to the room's last message, not only to the last command: the server reads everything
    // after a member's cursor on each listen, so a seat cursor left far behind costs on every read.
    // A listen returns at most 100 waking messages; when it is full, only up to the last one it returned.
    const waking = [...(listen.mentions || []), ...(listen.broadcasts || [])].map((m) => m.seq)
    const full = waking.length >= LISTEN_MAX
    if (full) readAgain.add(roomId); else readAgain.delete(roomId)
    const upTo = full ? Math.max(...waking) : Math.max(fresh.at(-1)?.seq || 0, Number.isInteger(listen.total) ? listen.total : 0)
    if (fresh.length) handled.set(roomId, fresh.at(-1).seq)
    if (upTo > (listen.cursor || 0)) { try { await api.mark(roomId, role, upTo) } catch {} }
    if (!fresh.length) return
    const roomMembers = await members(roomId).catch(() => null)
    for (const message of fresh) {
      const verdict = judge({ message, account, seatName, now: now(), members: roomMembers })
      if (verdict.act === 'ignore') continue
      if (verdict.act !== 'run') {
        await say(roomId, `${verdict.reason}${verdict.act === 'help' ? `\n${HELP_SHORT}` : ''}`, message.seq, senderOf(message).from)
        continue
      }
      const key = `${roomId}|${message.seq}`
      if (busy.has(key)) continue
      busy.add(key)
      log(`running /${verdict.command.name} (#${message.seq} in ${roomId})`)
      const job = runners[verdict.command.name]({ roomId, message, command: verdict.command, ctx, unregister })
        .catch(async (error) => {
          logError(`/${verdict.command.name} failed: ${herdrExit('operation', error)}`)
          await say(roomId, `/${verdict.command.name} did not finish: ${herdrError(error).text}`, message.seq, senderOf(message).from)
        })
        .finally(() => { busy.delete(key); jobs.delete(job) })
      jobs.add(job)
      // /bye must finish before the next delivery round; /spawn only until the name is taken and the tab is open.
      if (['bye', 'spawn'].includes(verdict.command.name)) await job
      if (verdict.command.name === 'spawn') ctx.panes = await terminal.panes() ?? ctx.panes
    }
  }

  /**
   * One round. dirty: rooms with a push for the seat (or all joined rooms when null). pruned: registry
   * entries whose pane went away this round; they stay findable for /bye and /handoff all.
   */
  /** Bookkeeping for this round's roster and joining the rooms; runs before connections are set up. */
  async function prepare({ entries, pruned = [] }) {
    // An unreachable server must not hold up joins or message delivery; the last copy is ready immediately.
    if (optionTable.refresh) void optionTable.refresh()
    // The CLIs installed here: looked at once before the first joins (they carry it), then every hour in the background.
    if (detector && detectedAt === -Infinity) await detectClis()
    else if (detector && now() - detectedAt >= DETECT_EVERY_MS && !detectJob) detectJob = detectClis().finally(() => { detectJob = null })
    for (const g of pruned) state.gone[`${g.roomId}|${g.name}`] = { roomId: g.roomId, name: g.name, pane: g.pane }
    for (const e of entries) delete state.gone[`${e.roomId}|${e.name}`]
    if (pruned.length) save()
    // A /spawn record whose pane another name registered: someone joined from that pane under another name,
    // so it is no longer "the not-yet-joined X"; kept, /bye X would close the pane of whoever uses it now.
    for (const op of spawns()) {
      const other = entries.find((e) => e.pane === op.pane && e.name !== op.name)
      if (other) { log(`${shortOf(op.name)}'s /spawn record dropped: pane ${op.pane} is now ${other.name}`); drop(op) }
    }
    await ensureJoined([...new Set([...entries.map((e) => e.roomId), ...leftEntries().map((e) => e.roomId), ...Object.values(state.gone).map((g) => g.roomId), ...await ownedRooms()])])
  }

  async function tick({ entries, panes, pruned = [], unregister, dirty = null, prepared = false }) {
    if (!prepared) await prepare({ entries, pruned })
    if (!seatName) return
    const ctx = { entries, panes }
    for (const roomId of joinedThisRun) if (!dirty || dirty.has(roomId) || readAgain.has(roomId)) await handle(roomId, ctx, unregister)
    await progress(ctx, unregister)
  }

  /** No command half done: none running, none waiting for an agent to join or leave. */
  const idle = () => busy.size === 0 && !ops.some((op) => op.type === 'handoff' || (op.type === 'spawn' && ['starting', 'joining'].includes(op.stage)))
  /** What keeps the seat from being idle, for the log when a restart waits long. */
  const busyWhy = () => [
    ...(busy.size ? [`${busy.size} command(s) running`] : []),
    ...ops.filter((op) => op.type === 'handoff').map((op) => `a handoff waiting for ${op.targets.filter((a) => !a.result).map((a) => shortOf(a.name)).join(', ')} to leave`),
    ...ops.filter((op) => op.type === 'spawn' && ['starting', 'joining'].includes(op.stage)).map((op) => `/spawn ${shortOf(op.name)} ${op.stage}`),
  ]
  /**
   * A topic's members (its room frame): this account's person left it and nobody of the account but its daemon
   * seats is still in. Up to 0.5.3 a seat came back to a public topic right after the leave; it leaves again.
   */
  const leaving = new Set()
  async function stranded(roomId, list) {
    if (!account || !joinedThisRun.has(roomId) || leaving.has(roomId)) return false
    if (!strandedSeat(list, account) || rosterEntries().some((x) => x.roomId === roomId)) return false
    leaving.add(roomId)
    try {
      await api.leave(roomId, role)
    } catch (e) {
      if (e.code !== 'not_member') { log(`seat could not leave ${roomId}, which this account left: ${e.code || e.message}`); return false }
    } finally { leaving.delete(roomId) }
    leftTopic(roomId, 'was left by this account, and its seat had come back; it left again')
    return true
  }

  return {
    /** Look at the agent CLIs now (the dashboard's u); the results are the next joins' too. */
    detect: () => (detector ? detectClis() : Promise.resolve()),
    /** The last detection, in kind order; null before the first one. */
    clis: () => (detector?.ready() ? detector.list() : null),
    prepare, tick, idle, busyWhy, ops, state, rejoin, forget, leftTopic, stranded, idleHandoff,
    approvalTargets: (panes) => approvalTargets({ panes, spawns: spawns(), entries: rosterEntries(), readRecord: (e) => readJson(spawnRecordPath(e.roomId, e.name)) }),
    reconnect() { joinedThisRun.clear(); joinFailedAt.clear(); reported.clear(); ownedAt = -Infinity },
    /** A room's last listen was full: the next round reads on. */
    more: () => readAgain.size > 0,
    /** The server said this account's rooms changed (rooms_changed): look at the list next round. */
    roomsChanged() { ownedAt = -Infinity },
    get role() { return role },
    /** Wait for the commands still running (tests). */
    settle: () => Promise.all([...jobs]),
    mode: (roomId) => (joinedThisRun.has(roomId) ? state.rooms[roomId]?.mode || null : null),
    joined: () => [...joinedThisRun],
    get name() { return seatName },
    get account() { return account },
    say,
  }
}

/** Is this CLI installed (on PATH)? */
export function onPath(bin, pathEnv = process.env.PATH || '') {
  return pathEnv.split(':').some((dir) => dir && fs.existsSync(path.join(dir, bin)))
}
