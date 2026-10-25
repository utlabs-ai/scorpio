#!/usr/bin/env node
// The Scorpio daemon process (`scorpio daemon` starts it in its own terminal tab; run-daemon.sh keeps
// it running). One per computer, serving every room: it hands room messages to the agents registered
// on this computer by typing them into their terminals, keeps idle Claude sessions warm, hands off
// agents idle for too long, holds the computer's seat in each room for room commands (seat.mjs), and
// relays the CLI's requests over its open connections (relay.mjs).
//
// Who to deliver to comes only from the local roster (the CLI writes it on join, removes it on leave).
// Delivering writes nothing to the room: the agent marks what it read itself. The only things the daemon
// says in rooms are the seat's answers to commands and its idle-handoff notices.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DELIVERY_FILE, HOME, PKG_DIR, idleHandoffMinutes, isDefaultHome, readJson, server, setIdleHandoffMinutes, version, writeJson } from './paths.mjs'
import { takeLock } from './pid.mjs'
import { entries, markLeft, prune, unregister } from './registry.mjs'
import { createApi } from './api.mjs'
import { forgetRejectedToken } from '../client.mjs'
import { createLogoutMonitor, OFFLINE_LINE, ONLINE_LINE } from './logout.mjs'
import { setupNetwork } from '../net.mjs'
import { createLinks } from './links.mjs'
import { createHealth } from './health.mjs'
import { MIN_NODE, newerNode } from './node.mjs'
import { minutesText } from './commands.mjs'
import { createRelay } from './relay.mjs'
import { createSeat } from './seat.mjs'
import { createHerdr, tail } from '../adapters/terminal/herdr.mjs'
import { CLIS, NEVER_ANSWER } from '../adapters/cli/index.mjs'
import { createDetector } from '../adapters/cli/detect.mjs'
import { createBlockedReasons } from './blocked.mjs'
import { createDaemonLog, herdrExit } from './log.mjs'
import { createDeliveryStats } from './stats.mjs'
import { createDashboardTerminal } from './dashboard-terminal.mjs'
import { createPobiAnimator } from './dashboard.mjs'
import { selfUpdate } from './update.mjs'
import { dashboardState } from './dashboard-state.mjs'
import { cleanupIfDue, DAY_MS } from '../cleanup.mjs'
import { deliveryDue, namedRoom, renderDelivery, renderKeepalive, wakeMessages } from '../render/forward.mjs'

const MIN = 60_000
export const TICK_MS = 5_000
export const MIN_ROUND_MS = 1_000 // a round woken early (a push, a finished command) still starts at least this long after the last
export const RETRY_MS = 5 * MIN // typed in but not marked after this long: type it again
export const KEEPALIVE_MS = 50 * MIN // Claude Code's prompt cache lives an hour
export const HUMAN_WINDOW_MS = 2 * 60 * MIN // keep-alive only where a person spoke this recently
const SWEEP_MS = MIN // read everyone once a minute when their connection is down
const NO_AGENT_GRACE_MS = 15_000 // a pane without an agent this long: its CLI exited
const FAILED_RETRY_MS = 10_000 // typing failed or a dialog was open: try again this soon
export function updateIntervals(env = process.env) {
  const override = Number(env.SCORPIO_UPDATE_CHECK_MS)
  const enabled = Number.isFinite(override) && override > 0
  return { first: enabled ? override : 5 * MIN, every: enabled ? override : 60 * MIN }
}
export const IDLE_GAP_MS = 2 * MIN // not watched this long (computer asleep, daemon stopped): the idle clock starts again
export const KEEPALIVE_TURN_MS = 3 * MIN // working this soon after a keep-alive is answering it, not work
const IDLE_SAVE_MS = MIN
// What an agent is doing, from herdr's status, as the room shows it (Member.work).
export const WORK = { working: 'working', blocked: 'blocked', idle: 'idle', done: 'idle' }
export const EXIT_STOPPED = 3 // the guard leaves on this code; a signed-out daemon must not restart
export const EXIT_LOCKED = EXIT_STOPPED
export const EXIT_CODE_GONE = 4

const log = createDaemonLog()
const keyOf = (roomId, name) => `${roomId}|${name}`

// ------------------------------------------------------------------ pure parts (tested on their own)

/**
 * What to do for one agent this round. Messages are always delivered, busy or not (the CLI queues
 * input while it works). A keep-alive needs a quiet agent of a CLI that wants them, not working.
 * quiet: move the quiet-since mark to now.
 */
export function plan({ messages, kind, status, quietSince, pokedSeq, pokedTs, resentSeq, now, keepaliveMs = KEEPALIVE_MS, retryMs = RETRY_MS }) {
  if (messages.length > 0) {
    const due = deliveryMessages(messages, pokedSeq, pokedTs, now, retryMs, resentSeq)
    return { act: due.length ? 'message' : 'none', quiet: true }
  }
  if (!keepaliveMs) return { act: 'none', quiet: false }
  if (quietSince === undefined) return { act: 'none', quiet: true }
  if (now - quietSince < keepaliveMs) return { act: 'none', quiet: false }
  if (!kind || !CLIS[kind]) return { act: 'skip', why: 'cannot tell which CLI it is', quiet: true }
  if (!CLIS[kind].keepalive) return { act: 'skip', why: `${kind} gets no keep-alives`, quiet: true }
  if (status === 'working') return { act: 'skip', why: 'it is working, its context is warm', quiet: true }
  return { act: 'keepalive', quiet: false }
}

/**
 * What to type in now. Within the retry window only what is newer than the last delivery; after it,
 * include the unmarked ones for a short seq reminder, but each message is reminded once at most
 * (resentSeq: the last seq already resent), so an agent that never marks is not typed at forever.
 */
export function deliveryMessages(messages, pokedSeq, pokedTs, now, retryMs = RETRY_MS, resentSeq = undefined) {
  if (!Number.isFinite(pokedSeq)) return messages
  if (now - (pokedTs || 0) < retryMs) return messages.filter((m) => m.seq > pokedSeq)
  return Number.isFinite(resentSeq) ? messages.filter((m) => m.seq > resentSeq) : messages
}

/** Ask Herdr about this pane now (a dialog shows as blocked), then look for the update prompt before any text is typed. */
export async function injectWhenReady(terminal, pane, text) {
  let status
  try { status = await terminal.paneStatus(pane) } catch { return 'unavailable' }
  if (status === 'blocked') return 'blocked'
  if (!['idle', 'done', 'working'].includes(status)) return 'unavailable'
  const screen = tail(await terminal.read(pane, 40), 20)
  if (NEVER_ANSWER.test(screen)) return 'dialog'
  await terminal.inject(pane, text)
  return 'sent'
}

/**
 * One agent's idle clock, moved each round from what herdr shows: {since, seen}
 * or null. Only idle and done count; working, blocked and unknown stop it, and so does anything
 * delivered or waiting to be (busy). The short turn a keep-alive starts is not work. A gap in watching
 * (the computer slept, the daemon was down) starts it again: nobody knows what happened meanwhile.
 */
export function idleClock(prev, { status, busy = false, now, keptAliveAt = null }) {
  const answeringKeepalive = status === 'working' && prev && Number.isFinite(keptAliveAt) && keptAliveAt >= prev.since && now - keptAliveAt < KEEPALIVE_TURN_MS
  if (busy || !(status === 'idle' || status === 'done' || answeringKeepalive)) return null
  if (!prev || now - prev.seen > IDLE_GAP_MS) return { since: now, seen: now }
  return { since: prev.since, seen: now }
}

/**
 * Keep-alives for an agent, given this computer's idle handoff (minutes, 0 = off). Handed off within
 * the hour its prompt cache lasts anyway, an agent never needs one: they stop. Longer, they go on
 * until the handoff.
 */
export function keepaliveFor(idleMinutes, { handsOff = true } = {}) {
  return handsOff && idleMinutes > 0 && idleMinutes * MIN <= KEEPALIVE_MS + 10 * MIN ? 0 : KEEPALIVE_MS
}

/** Did a person speak after since? Newest first: a person's message first is yes, one older than since first is no; null when undecided. */
export function humanSpokeWithin(messages, since) {
  for (const m of [...messages].sort((a, b) => b.seq - a.seq)) {
    if (Number.isFinite(m.ts) && m.ts < since) return false
    if (m.fromKind === 'human') return true
  }
  return null
}

/**
 * The text for one delivery, what to remember after it was typed in, and how far it reaches (upTo).
 * A resend (the batch starts at or below the last delivered seq: it was not marked in 5 minutes)
 * summarizes those seqs in one line; newer messages still appear in full. It carries no reminder or
 * changes and does not count towards the next reminder. A batch too
 * long for one injection is cut to what fits; the mark line and upTo stop at the last message sent,
 * the rest goes next round. The task changes leave out what the messages sent say themselves.
 */
export function composeDelivery({ entry, room: read, messages, reminded, pokedSeq, maxBytes, now = Date.now() }) {
  const room = namedRoom(read, reminded)
  const resend = Number.isFinite(pokedSeq) && messages.length > 0 && messages[0].seq <= pokedSeq
  let batch = messages
  const due = () => (resend && reminded
    ? { remind: null, changes: [], tasks: [], next: reminded }
    : deliveryDue(reminded, { session: entry.ts ?? null, room, name: entry.name, shown: batch.map((m) => m.seq) }))
  let d = due()
  const render = () => {
    if (!resend) return renderDelivery({ room, messages: batch, name: entry.name, remind: d.remind, changes: d.changes, tasks: d.tasks, terminal: true, role: entry.role, now })
    const old = batch.filter((m) => m.seq <= pokedSeq)
    const fresh = batch.filter((m) => m.seq > pokedSeq)
    const seqs = old.map((m) => `#${m.seq}`).join(', ')
    const mark = `scorpio mark topicId=${room.roomId}${entry.role ? ` role=${entry.role}` : ''} upTo=${old.at(-1).seq}`
    const line = `Still unmarked: ${seqs}. After reading, ${mark}`
    return fresh.length ? `${line}\n\n${renderDelivery({ room, messages: fresh, name: entry.name, terminal: true, role: entry.role, now })}` : line
  }
  let text = render()
  while (batch.length > 1 && Buffer.byteLength(text) > maxBytes) { batch = batch.slice(0, -1); d = due(); text = render() }
  return { text, next: d.next, upTo: batch.at(-1).seq, remind: d.remind, changes: d.changes, tasks: d.tasks, count: batch.length }
}

/** This code's version: name, size and mtime of every source file. Changes when the package is reinstalled. */
export function codeVersion(dir = PKG_DIR) {
  const out = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (/\.(mjs|sh)$/.test(f.name)) { const s = fs.statSync(p); out.push(`${path.relative(dir, p)}:${s.size}:${Math.round(s.mtimeMs)}`) }
    }
  }
  for (const sub of ['bin', 'src']) if (fs.existsSync(path.join(dir, sub))) walk(path.join(dir, sub))
  return out.join('|')
}

/** Exit for a restart once the change has settled for a round (an install writes file by file) and no command is half done. */
export function restartDue({ started, pending, current, idle }) {
  if (current === started) return { exit: false, pending: null }
  return { exit: current === pending && idle, pending: current }
}

export const RESTART_NOTE_MS = 15 * MIN
/**
 * New code that has waited RESTART_NOTE_MS for the daemon to be idle says in the log what holds it, once an hour
 * (a relay request that never ended once held every update off, and nothing said so). null: nothing to say.
 */
export function restartNote({ waitingSince, notedAt, now, holders }) {
  if (waitingSince == null || now - waitingSince < RESTART_NOTE_MS || now - (notedAt ?? -Infinity) < 60 * MIN) return null
  const since = new Date(waitingSince).toTimeString().slice(0, 5)
  return `New code is on disk since ${since}; the daemon restarts on it once nothing is half done. Waiting for: ${holders.join('; ') || 'nothing any more'}.`
}

/**
 * The loop's pace: a round every tickMs, sooner when kicked (a push came in, the seat has more to read),
 * but never sooner than minGapMs after the last round started, so no run of kicks turns it into a spin
 * (it did once: herdr asked and the code walked hundreds of times a second). A kick during a round
 * shortens the nap after it.
 */
export function createPacer({ tickMs = TICK_MS, minGapMs = MIN_ROUND_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let startedAt = -Infinity, kicked = false, wake = null
  return {
    round() { startedAt = now(); kicked = false },
    kick() { if (wake) wake(); else kicked = true },
    nap() {
      return new Promise((resolve) => {
        let timer = null
        const done = () => { clearTimer(timer); wake = null; resolve() }
        const soon = () => { clearTimer(timer); wake = null; timer = setTimer(done, Math.max(0, startedAt + minGapMs - now())) }
        if (kicked) return soon()
        timer = setTimer(done, tickMs)
        wake = soon
      })
    },
  }
}

export const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

// ------------------------------------------------------------------ state

// Delivery marks, quiet timers and reminder records are on disk: a restart must not resend what was
// delivered, reset keep-alive timers, or repeat reminders.
const STATE_KEYS = ['pokedSeq', 'pokedTs', 'resentSeq', 'quietSince', 'reminded', 'idle']
function readState(file = DELIVERY_FILE) {
  const saved = readJson(file) || {}
  return Object.fromEntries(STATE_KEYS.map((k) => [k, new Map(Object.entries(saved[k] || {}))]))
}
function writeState(state, file = DELIVERY_FILE) {
  try { writeJson(file, Object.fromEntries(STATE_KEYS.map((k) => [k, Object.fromEntries(state[k])]))) } catch {}
}

/**
 * What the agents this daemon starts get in their environment besides PATH. SCORPIO_HOME only for a home other
 * than ~/.scorpio (staging): the launcher first on their PATH sets the default home itself, and anything an agent
 * runs (tests, installers) must not write into the live home by inheritance. SCORPIO_SERVER whenever it is set.
 */
export function agentEnv(env = process.env) {
  return {
    ...(env.SCORPIO_HOME && !isDefaultHome(env.SCORPIO_HOME) ? { SCORPIO_HOME: env.SCORPIO_HOME } : {}),
    ...(env.SCORPIO_SERVER ? { SCORPIO_SERVER: env.SCORPIO_SERVER } : {}),
  }
}

/** What the daemon knows about each room: name, topic, owner, members, when a person last spoke. */
function createRooms() {
  const map = new Map()
  return {
    get: (roomId) => map.get(roomId) || null,
    update(roomId, patch) {
      const cur = map.get(roomId) || { roomId }
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) cur[k] = v
      map.set(roomId, cur)
      return cur
    },
  }
}

// ------------------------------------------------------------------ the loop

async function main() {
  const other = takeLock()
  if (other) {
    log(`A Scorpio daemon is already running on this computer (pid ${other}); this one stops.`)
    process.exit(EXIT_LOCKED)
  }
  log(`Scorpio daemon ${version()} (pid ${process.pid}, ${PKG_DIR}, server ${server()})`)
  cleanupIfDue({ home: HOME, force: true, log: log.error })
  let nextCleanup = Date.now() + DAY_MS
  if (typeof globalThis.WebSocket !== 'function') {
    log(`This Node (${process.version}, ${process.execPath}) has no WebSocket and this computer has no Node ${MIN_NODE} or newer that the daemon could find, so rooms are read once a minute instead of live and this computer shows offline. Install Node ${MIN_NODE}+ (nvm install ${MIN_NODE}, or set SCORPIO_NODE to its path), then close this tab and run scorpio daemon again.`)
  }
  if (!setupNetwork()) log('Could not apply the network settings (60 s to connect, 2 kept connections); on a slow network, requests may fail.')
  log('Delivers to the agents in the local roster (the CLI adds them on join, removes them on leave); writes nothing to rooms except command answers and idle-handoff notices.')
  const state = readState()
  const stats = createDeliveryStats()
  process.on('exit', () => { try { stats.save() } catch {} })
  const { pokedSeq, pokedTs, resentSeq, quietSince, reminded, idle } = state
  const saveState = () => writeState(state)
  const rooms = createRooms()
  // ~/.scorpio/config.json {"debug": true}: log every frame (read at start).
  const debug = Boolean(readJson(path.join(HOME, 'config.json'))?.debug)
  const terminal = createHerdr()
  const blockedReasons = createBlockedReasons({ explain: (pane) => terminal.explain(pane) })
  const pacer = createPacer()
  const kick = pacer.kick
  // A server that no longer talks to this version (upgrade_required) gets the update checked at once.
  const updateInterval = updateIntervals()
  let nextUpdate = Date.now() + updateInterval.first, updateAsked = false
  const updateNow = () => {
    if (updateAsked) return
    updateAsked = true
    nextUpdate = 0
    log('the server answered upgrade_required: checking for a new version now')
    kick()
  }
  let logout
  const api = createApi({ onUpgradeRequired: updateNow, onResult: (result) => logout?.observe(result) })
  const tokenCheckFailed = (error) => {
    if (error.code !== 'unauthorized' && error.code !== 'not_logged_in') log.warn(`token check failed: ${error?.code || error?.name || 'unknown'}`)
  }
  const env = agentEnv()
  const relay = createRelay({ log, onUpgradeRequired: updateNow })
  try { await relay.start(); process.on('exit', () => relay.stop()) } catch (e) {
    log.error(`Could not listen for the CLI on ${HOME}/state/relay.sock (${e.code || 'unknown'}); the CLI goes to the server itself.`)
  }
  // Idle handoff: this computer's setting, read every round so an edit of config.json counts at once.
  let idleMinutes = idleHandoffMinutes()
  log(idleMinutes ? `Idle handoff: an agent idle for ${minutesText(idleMinutes)} is handed off (idle_handoff_minutes in config.json, /idle in a room; 0 turns it off).` : 'Idle handoff is off (idle_handoff_minutes is 0 in config.json).')
  const keptAliveAt = new Map() // key → when the last keep-alive was typed in
  const idleJobs = new Set() // keys being handed off for idleness
  let idleSavedAt = 0
  const idleSetting = {
    minutes: () => idleMinutes,
    set(n) { setIdleHandoffMinutes(n); idleMinutes = idleHandoffMinutes(); return idleMinutes },
    keepalives: () => keepaliveFor(idleMinutes) > 0,
    /** This computer's agents in a room and how long each has been idle, for /idle. */
    report(roomId) {
      return entries().filter((e) => e.roomId === roomId).map((e) => {
        const c = idle.get(keyOf(e.roomId, e.name))
        return { name: e.name, idleMinutes: c ? Math.floor((Date.now() - c.since) / MIN) : null }
      })
    },
  }
  const seat = createSeat({ api, terminal, rooms, log, spawnEnv: env, idleSetting, detector: createDetector({ log }) })

  const dirty = new Set() // keys with something pushed
  const seatDirty = new Set() // rooms with something pushed to the seat
  const awaiting = new Set() // keys delivered to and not yet seen marked
  const dropped = new Map() // key → registry ts: the server moved its delivery elsewhere (it runs wait itself)
  const noAgentSince = new Map()
  const retryAt = new Map() // key → when to try again after a failed delivery
  const workSent = new Map() // host link key → Map(name → work last reported on it)
  const pushed = new Map() // key → Map(seq → envelope) pushed for it and not yet typed in
  const keep = (roomId, name, list) => {
    const key = keyOf(roomId, name)
    const m = pushed.get(key) || new Map()
    for (const env of list || []) if (Number.isInteger(env?.seq)) m.set(env.seq, env)
    pushed.set(key, m)
    dirty.add(key)
  }
  const spokeFor = new Set() // keys found to have had a person speaking, until their quiet mark moves
  const disconnectedAt = new Map()
  const pobiAnimator = createPobiAnimator()

  const links = createLinks({
    api,
    onTokenRejected: () => logout.checkToken(api.whoami).catch(tokenCheckFailed),
    log,
    onFrame(link, frame) {
      const roomId = link.roomId
      if (debug) console.log(new Date().toTimeString().slice(0, 8), `frame ${link.key}: ${JSON.stringify(frame).slice(0, 300)}`)
      const isSeat = (to) => link.seat || to === seat.name || (link.host && (!to || to === seat.name))
      switch (frame.type) {
        case 'ready':
          if (frame.room) rooms.update(roomId, { roomName: frame.room.name, topic: frame.room.topic, owner: frame.room.owner })
          if (link.host || link.seat) { if (frame.pending?.length) seatDirty.add(roomId) } else dirty.add(keyOf(roomId, link.name))
          break
        case 'carried':
          for (const r of frame.rejected || []) log.warn(`server would not let this daemon carry ${r.name} in ${roomId}: ${r.reason}`)
          for (const [name, list] of Object.entries(frame.pending || {})) if (list?.length) keep(roomId, name, list)
          for (const name of frame.names || []) dirty.add(keyOf(roomId, name))
          break
        case 'push': {
          const to = link.host ? frame.to : link.name
          if (isSeat(to)) seatDirty.add(roomId)
          else keep(roomId, to, [frame.message])
          break
        }
        case 'room':
          rooms.update(roomId, {
            roomName: frame.room?.name, topic: frame.room?.topic, owner: frame.room?.owner,
            members: frame.members, lastHumanTs: frame.last_human_ts,
          })
          // A seat that came back to a topic this account left (up to 0.5.3) leaves it again.
          if (link.host) seat.stranded(roomId, frame.members).then((gone) => gone && kick()).catch(() => {})
          break
        case 'activity':
          rooms.update(roomId, { lastHumanTs: frame.last_human_ts })
          break
        case 'rooms_changed': // a room of this account was created, archived or restored
          seat.roomsChanged()
          break
        case 'todo': // the visible TODO items; legacy round fields are ignored
        case 'items': // the plan, from a server before v0.8
          rooms.update(roomId, { items: frame.items, ...(Array.isArray(frame.deleted) ? { deleted: frame.deleted } : {}) })
          break
        case 'removed':
          topicLeft(roomId, frame, { leftTopic: seat.leftTopic, log })
          break
        case 'dropped': {
          const e = entries().find((x) => x.roomId === roomId && x.name === frame.name)
          dropped.set(keyOf(roomId, frame.name), e?.ts ?? null)
          log(`${frame.name} in ${roomId} now gets messages on another connection (its own wait?); no longer delivering to it until it joins again`)
          break
        }
        case 'open':
          workSent.delete(link.key) // a new connection: report everyone's work again
          if (disconnectedAt.has(link.key)) {
            log(`connection restored: ${link.key} after ${Math.max(0, Math.round((Date.now() - disconnectedAt.get(link.key)) / 1000))} s`)
            disconnectedAt.delete(link.key)
            pobiAnimator.note('recovered')
          } else log(`connected: ${link.key}`)
          break
        case 'latency':
          break
        case 'closed':
          disconnectedAt.set(link.key, Date.now())
          log.warn(`connection lost: ${link.key}${frame.code || frame.reason ? ` (${[frame.code, frame.reason].filter(Boolean).join(' ')})` : ''}; reconnecting`)
          if (link.host && frame.code === 4002) seat.rejoin(roomId)
          break
        case 'failing':
          log.warn(`connection ${link.key} keeps failing; checking why`)
          if (!link.host && !link.seat) dirty.add(keyOf(roomId, link.name))
          else seat.rejoin(roomId)
          break
        default:
      }
      kick()
      dashboard?.paint()
    },
  })
  let offlineNotices = new Set(), onlineNotices = new Set()
  const panesToNotify = () => new Set(entries().map((entry) => entry.pane))
  const typeNotices = async (pending, line, waitFor = new Set()) => {
    for (const pane of pending) {
      if (waitFor.has(pane)) continue
      try { if (await injectWhenReady(terminal, pane, line) === 'sent') pending.delete(pane) }
      catch (e) { log.warn(`could not type logout status in pane ${pane}: ${herdrExit('agent prompt', e)}`) }
    }
  }
  const reconnect = () => { links.closeAll(); seat.reconnect(); kick() }
  logout = createLogoutMonitor({
    onExpected: (cause, refusedToken) => {
      log(`signed out (${cause}); stopping delivery and exiting`)
      forgetRejectedToken(refusedToken)
      links.closeAll(); relay.stop(); process.exit(EXIT_STOPPED)
    },
    onOffline: (cause) => {
      log(`signed out unexpectedly (${cause}); requesting authorization again`)
      offlineNotices = panesToNotify()
      links.closeAll(); kick()
    },
    onReload: () => { log('a newer token replaced this one; rejoining with it'); reconnect() },
    onOnline: () => {
      log('signed in again; rejoining and resuming delivery')
      onlineNotices = panesToNotify()
      reconnect()
    },
    onError: (e) => log.warn(`relogin request failed: ${e?.error || e?.code || e?.name || 'unknown'}`),
  })
  const health = createHealth({ api, links })

  // The agent CLIs on this computer: the seat looks (at start, every hour, /usage) and keeps the last result; `u` looks now.
  const detectClis = () => seat.detect().then(() => dashboard?.paint())
  const detectedAt = () => { const at = (seat.clis() || []).map((c) => c.at); return at.length ? Math.max(...at) : null }
  let update = null
  let lastPanes = new Map()
  const statusSince = new Map()
  let dashboard = null
  dashboard = createDashboardTerminal({ log, onDetect: detectClis, onStop: () => process.exit(EXIT_LOCKED), state: () => dashboardState({ seat, rooms, roster: entries(), ops: seat.ops, links, panes: lastPanes, idle, idleMinutes, statusSince, clis: seat.clis(), detectedAt: detectedAt(), update, stats, pobiAnimator, logout }) })
  if (dashboard.enabled) {
    log.setOutput(() => {})
    log.onLine(() => dashboard.paint())
  }
  process.on('exit', () => dashboard?.close())

  // Idle handoff takes an agent registered in one room only: closing the pane of one in two rooms
  // would take it out of the other one too. roomsOfPane: counted each round from the roster.
  let roomsOfPane = new Map()
  const handsOff = (entry) => (roomsOfPane.get(entry.pane) || 1) === 1
  const keepaliveMsOf = (entry) => keepaliveFor(idleMinutes, { handsOff: handsOff(entry) })
  const idleRetryAt = new Map() // key → not before: an idle handoff that could not start waits a minute

  /** Read one agent's unmarked messages and act on them. */
  const inflight = new Set()
  async function check(entry, paneOf) {
    const key = keyOf(entry.roomId, entry.name)
    if (inflight.has(key)) { dirty.add(key); return }
    inflight.add(key)
    try {
      // Fast path: what the server just pushed, typed in without another round trip, when the room's
      // members are known (host connections send them). Everything else reads listen, the authority.
      const fresh = pushed.get(key)
      pushed.delete(key)
      let room = rooms.get(entry.roomId)
      let messages
      if (fresh?.size && Array.isArray(room?.members)) {
        messages = [...fresh.values()].sort((a, b) => a.seq - b.seq)
      } else {
        let listen
        try { listen = await api.listen(entry.roomId, entry.role) } catch (e) {
          if (e.code === 'not_member') {
            notMember(entry, { markLeft, log })
          } else {
            if (fresh?.size) pushed.set(key, fresh)
            retryAt.set(key, Date.now() + FAILED_RETRY_MS)
            log.error(`could not read ${entry.name} in ${entry.roomId}: ${e.code || 'unknown'}`)
          }
          return
        }
        room = rooms.update(entry.roomId, {
          members: listen.members,
          ...(Array.isArray(listen.items) ? { items: listen.items } : {}),
          ...(Array.isArray(listen.deleted) ? { deleted: listen.deleted } : {}),
          ...(listen.room ? { roomName: listen.room.name, topic: listen.room.topic, owner: listen.room.owner } : {}),
        })
        messages = wakeMessages(listen)
        if (!messages.length) awaiting.delete(key)
      }
      if (logout.offline()) return
      const pane = paneOf.get(entry.pane)
      const now = Date.now()
      const since = quietSince.get(key)
      const { act, quiet, why } = plan({
        messages, kind: pane?.agent, status: pane?.agent_status, quietSince: since,
        pokedSeq: pokedSeq.get(key), pokedTs: pokedTs.get(key), resentSeq: resentSeq.get(key), now,
        keepaliveMs: keepaliveMsOf(entry),
      })
      if (quiet) { quietSince.set(key, now); spokeFor.delete(key); saveState() }
      if (act === 'none') return
      if (act === 'skip') { log(`no keep-alive for ${entry.name} in ${entry.roomId}: ${why}`); return }
      if (act === 'keepalive' && !spokeFor.has(key)) {
        if (!await humanSpoke(entry, room, now - HUMAN_WINDOW_MS)) {
          quietSince.set(key, now); saveState()
          log(`no keep-alive for ${entry.name} in ${entry.roomId}: no person spoke there in the last ${HUMAN_WINDOW_MS / (60 * MIN)} hours`)
          return
        }
        spokeFor.add(key)
      }
      const waitForPane = (reason) => {
        if (reason === 'sent') return false
        retryAt.set(key, now + FAILED_RETRY_MS)
        if (reason === 'blocked') log.warn(`${entry.name}'s pane ${entry.pane} is blocked (a dialog may be open); delivery waits`)
        else if (reason === 'dialog') log.warn(`${entry.name}'s pane ${entry.pane} shows a dialog; delivery waits`)
        else log.warn(`${entry.name}'s pane ${entry.pane} status is unavailable; delivery waits`)
        return true
      }
      if (act === 'keepalive') {
        try {
          if (waitForPane(await injectWhenReady(terminal, entry.pane, renderKeepalive(namedRoom(room, reminded.get(key)))))) return
          quietSince.set(key, now); spokeFor.delete(key); keptAliveAt.set(key, now); saveState()
          log(`keep-alive to ${entry.name} in ${entry.roomId} (quiet ${Math.round((now - since) / MIN)} min)`)
        } catch { retryAt.set(key, now + FAILED_RETRY_MS); log.warn(`keep-alive to ${entry.name} failed; trying again shortly`) }
        return
      }
      const batch = deliveryMessages(messages, pokedSeq.get(key), pokedTs.get(key), now, RETRY_MS, resentSeq.get(key))
      const d = composeDelivery({ entry, room, messages: batch, reminded: reminded.get(key), pokedSeq: pokedSeq.get(key), maxBytes: terminal.maxPromptBytes })
      try {
        if (waitForPane(await injectWhenReady(terminal, entry.pane, d.text))) return
        const previousSeq = pokedSeq.get(key) ?? 0
        const resend = Number.isFinite(pokedSeq.get(key)) && batch[0].seq <= pokedSeq.get(key)
        if (resend) resentSeq.set(key, d.upTo)
        pokedSeq.set(key, Math.max(d.upTo, pokedSeq.get(key) ?? 0)); pokedTs.set(key, now); reminded.set(key, d.next); saveState()
        const newCount = batch.slice(0, d.count).filter((message) => message.seq > previousSeq).length
        stats.add(entry.roomId, entry.name, newCount)
        if (newCount) pobiAnimator.note('delivery')
        awaiting.add(key)
        const rest = batch.length - d.count
        log(`delivered to ${entry.name} in ${entry.roomId} (pane ${entry.pane}, ${d.count} up to #${d.upTo}${rest ? `, ${rest} more next round` : ''}${d.remind ? ', with reminder' : d.changes.length ? ', with changes' : ''})`)
        if (rest) dirty.add(key)
      } catch (e) {
        retryAt.set(key, now + FAILED_RETRY_MS)
        log.error(`delivery to ${entry.name} (pane ${entry.pane}) failed; ${herdrExit('agent prompt', e)}; trying again shortly`)
      }
    } finally { inflight.delete(key) }
  }

  /** Has a person spoken in the room since? From the room frames when the server sends them, else from the messages. */
  async function humanSpoke(entry, room, since) {
    if (Number.isFinite(room?.lastHumanTs)) return room.lastHumanTs >= since
    let from
    try {
      for (let page = 0; page < 10; page += 1) {
        const { messages = [] } = await api.messages(entry.roomId, entry.role, { limit: 50, ...(from ? { from } : {}) })
        const spoke = humanSpokeWithin(messages, since)
        if (spoke !== null) return spoke
        const first = Math.min(...messages.map((m) => m.seq))
        if (!Number.isFinite(first) || first <= 1) return false
        from = Math.max(1, first - 50)
      }
    } catch { return false }
    return false
  }

  const started = codeVersion()
  const installed = path.resolve(PKG_DIR) === path.resolve(path.join(HOME, 'app'))
  let seatJob = null
  let pending = null, lastSweep = 0, lastShape = null, waitingSince = null, notedAt = null
  for (;;) {
    if (Date.now() >= nextCleanup) {
      cleanupIfDue({ home: HOME, force: true, log: log.error })
      nextCleanup = Date.now() + DAY_MS
    }
    logout.checkLocalLogout()
    logout.checkTokenFile(api.whoami).catch(tokenCheckFailed)
    pacer.round()
    if (logout.offline()) {
      await typeNotices(offlineNotices, OFFLINE_LINE)
      health.round()
      await pacer.nap()
      continue
    }
    if (offlineNotices.size) await typeNotices(offlineNotices, OFFLINE_LINE)
    if (onlineNotices.size) await typeNotices(onlineNotices, ONLINE_LINE, offlineNotices)
    try {
      const panes = await terminal.panes()
      health.herdr(panes !== null)
      health.probe()
      const paneOf = new Map((panes || []).map((p) => [p.pane_id, p]))
      lastPanes = paneOf
      const pruned = panes ? prune(panes.map((p) => p.pane_id)) : []
      for (const g of pruned) log(`removed ${g.name} in ${g.roomId} from the roster: pane ${g.pane} is gone`)
      // A pane whose agent CLI exited (only a shell left) gets nothing typed in and is taken off the roster:
      // otherwise the agent looks online in the room and messages queue for nobody.
      const now = Date.now()
      for (const e of entries()) {
        const key = keyOf(e.roomId, e.name)
        const p = panes ? paneOf.get(e.pane) : null
        if (!p || p.agent) { noAgentSince.delete(key); continue }
        if (!noAgentSince.has(key)) noAgentSince.set(key, now)
        if (now - noAgentSince.get(key) >= NO_AGENT_GRACE_MS) {
          unregister({ roomId: e.roomId, name: e.name, pane: e.pane })
          pruned.push({ roomId: e.roomId, name: e.name, pane: e.pane })
          noAgentSince.delete(key)
          log(`removed ${e.name} in ${e.roomId} from the roster: no agent in pane ${e.pane} any more`)
        }
      }
      const targets = entries()
      for (const e of targets) {
        const key = keyOf(e.roomId, e.name)
        const status = paneOf.get(e.pane)?.agent_status
        if (status === 'blocked' && statusSince.get(key)?.status !== 'blocked') log(`${e.name} needs confirmation`)
        if (statusSince.get(key)?.status !== status) statusSince.set(key, { status, since: now })
      }
      roomsOfPane = new Map()
      for (const e of targets) roomsOfPane.set(e.pane, (roomsOfPane.get(e.pane) || 0) + 1)
      for (const [key, ts] of dropped) {
        const e = targets.find((x) => keyOf(x.roomId, x.name) === key)
        if (!e || e.ts !== ts) dropped.delete(key) // joined again, or gone: carry it again / forget
      }
      const live = targets.filter((e) => !panes || paneOf.get(e.pane)?.agent).filter((e) => !dropped.has(keyOf(e.roomId, e.name)))
      const shape = live.map((e) => `${e.roomId}/${e.name}@${e.pane}`).sort().join(', ')
      if (shape !== lastShape) {
        if (lastShape !== null && live.length > 0) pobiAnimator.note('delivery')
        lastShape = shape
        log(`delivering to ${live.length} agent(s): ${shape || '(nobody registered yet)'}`)
      }

      // The seat joins first: how it joined decides the kind of connection for the room.
      await seat.prepare({ entries: targets, pruned })
      if (logout.offline()) continue
      // Connections: per room as the host when the server knows hosts, else per agent (and one for the seat).
      const wanted = []
      for (const roomId of new Set([...live.map((e) => e.roomId), ...seat.joined()])) {
        const here = live.filter((e) => e.roomId === roomId)
        const mode = seat.mode(roomId)
        if (mode === 'host') wanted.push({ key: `h|${roomId}`, roomId, role: seat.role, host: true, carry: here.map((e) => e.name) })
        else {
          for (const e of here) wanted.push({ key: `a|${roomId}|${e.name}`, roomId, role: e.role, name: e.name })
          if (mode === 'agent') wanted.push({ key: `a|${roomId}|${seat.name}`, roomId, role: seat.role, name: seat.name, seat: true })
        }
      }
      links.sync(wanted)
      // Work status of the agents each host connection carries, sent when it changes; for blocked, at what.
      for (const w of wanted.filter((x) => x.host)) {
        const sent = workSent.get(w.key) || new Map()
        for (const name of w.carry) {
          const e = live.find((x) => x.roomId === w.roomId && x.name === name)
          const status = paneOf.get(e?.pane)?.agent_status
          const work = WORK[status] ?? null
          const reason = await blockedReasons.of(e?.pane, status) // null unless blocked (and forgets the last one)
          const said = `${work}|${reason ?? ''}`
          if (sent.get(name) === said) continue
          if (links.send(w.key, { type: 'work', name, work, ...(reason ? { reason } : {}) })) sent.set(name, said)
        }
        workSent.set(w.key, sent)
      }

      // Idle clocks, and the handoff of those idle long enough.
      const minutes = idleHandoffMinutes()
      if (minutes !== idleMinutes) { log(`idle handoff: ${idleMinutes ? minutesText(idleMinutes) : 'off'} → ${minutes ? minutesText(minutes) : 'off'}`); idleMinutes = minutes }
      const liveKeys = new Set(live.map((e) => keyOf(e.roomId, e.name)))
      for (const key of [...idle.keys()]) if (!liveKeys.has(key)) idle.delete(key)
      for (const e of live) {
        const key = keyOf(e.roomId, e.name)
        const prev = idle.get(key) || null
        const busy = Boolean(pushed.get(key)?.size) || awaiting.has(key) || (prev !== null && (pokedTs.get(key) || 0) >= prev.since)
        const next = idleClock(prev, { status: paneOf.get(e.pane)?.agent_status, busy, now, keptAliveAt: keptAliveAt.get(key) })
        if (next) idle.set(key, next); else idle.delete(key)
        if (!next || !idleMinutes || now - next.since < idleMinutes * MIN || !handsOff(e)) continue
        if (idleJobs.has(key) || now < (idleRetryAt.get(key) || 0)) continue
        idleJobs.add(key)
        seat.idleHandoff({ entry: e, minutes: idleMinutes, panes, unregister })
          .then((r) => {
            if (r === 'started') { idle.delete(key); idleRetryAt.delete(key); log(`idle handoff of ${e.name} in ${e.roomId} (idle ${Math.round((now - next.since) / MIN)} min)`) }
            else { idleRetryAt.set(key, Date.now() + MIN); log(`idle handoff of ${e.name} in ${e.roomId} not started: ${r}; trying again in a minute`) }
          })
          .catch((err) => { idleRetryAt.set(key, Date.now() + MIN); log(`idle handoff of ${e.name} failed: ${String(err?.message || err).slice(0, 160)}`) })
          .finally(() => idleJobs.delete(key))
      }
      if (now - idleSavedAt >= IDLE_SAVE_MS) { idleSavedAt = now; saveState(); stats.save() }

      const sweep = now - lastSweep >= SWEEP_MS
      if (sweep) lastSweep = now
      const linkOpen = (e) => (seat.mode(e.roomId) === 'host' ? links.get(`h|${e.roomId}`) : links.get(`a|${e.roomId}|${e.name}`))?.isOpen
      const due = live.filter((e) => {
        const key = keyOf(e.roomId, e.name)
        if (dirty.delete(key)) return true
        if (retryAt.has(key) && now >= retryAt.get(key)) { retryAt.delete(key); return true }
        if (!quietSince.has(key)) return true // first sight
        if (awaiting.has(key) && now - (pokedTs.get(key) || 0) >= RETRY_MS) return true
        const keepaliveMs = keepaliveMsOf(e)
        if (keepaliveMs && now - quietSince.get(key) >= keepaliveMs) return true
        return sweep && !linkOpen(e)
      })
      // Deliveries and room commands run on their own: a slow request on one side (a few seconds each
      // on a bad network, more with retries) never holds up the other or the next round.
      for (const e of due) check(e, paneOf).catch((err) => log.error(`delivery check failed: ${err?.code || err?.name || 'unknown'}`))

      if (!seatJob) {
        // The seat reads a room when something was pushed to it, and in the minute sweep only where its
        // connection is down: an open connection pushes every command, and on reconnect ready says what is pending.
        const seatOpen = (roomId) => (seat.mode(roomId) === 'host' ? links.get(`h|${roomId}`) : links.get(`a|${roomId}|${seat.name}`))?.isOpen
        const seatRooms = new Set([...seatDirty, ...(sweep ? seat.joined().filter((r) => !seatOpen(r)) : [])])
        seatDirty.clear()
        seatJob = seat.tick({ entries: entries(), panes, pruned, unregister, dirty: seatRooms, prepared: true })
          .catch((e) => log.error(`room commands failed this round: ${e?.code || e?.name || 'unknown'}`))
          // Another round at once only when the seat has more to read (a push came meanwhile, a listen was full).
          .finally(() => { seatJob = null; if (seatDirty.size || seat.more()) kick() })
      }

      relay.tick()

      if (installed && Date.now() >= nextUpdate && seat.idle()) {
        nextUpdate = Date.now() + updateInterval.every
        await selfUpdate({ newer, whoami: () => api.whoami(), log, checked: (result) => { update = result; dashboard.paint() } })
        updateAsked = false // asked again later (a newer version may not be out yet): check again
      }
    } catch (error) {
      log.error(`round failed: ${error?.code || error?.name || 'unknown'}`)
    }
    health.round()
    let current
    try { current = codeVersion() } catch {
      log.error('The code directory is gone; exiting, and so does the loop around it.')
      process.exit(EXIT_CODE_GONE)
    }
    const r = restartDue({ started, pending, current, idle: seat.idle() && !relay.busy() && idleJobs.size === 0 })
    pending = r.pending
    waitingSince = r.pending ? (waitingSince ?? Date.now()) : null
    const holders = [...seat.busyWhy(), ...(relay.busy() ? [`${relay.inflight()} CLI request(s) through the relay`] : []), ...(idleJobs.size ? [`${idleJobs.size} idle handoff(s) starting`] : [])]
    const note = r.exit ? null : restartNote({ waitingSince, notedAt, now: Date.now(), holders })
    if (note) { log(note); notedAt = Date.now() }
    if (r.exit) {
      log('The code changed; exiting so the loop starts the new code.')
      links.closeAll()
      relay.stop()
      process.exit(0)
    }
    await pacer.nap()
  }
}

/**
 * An agent's listen answered not_member: it left (its own leave, pushed to the seat before its CLI marks the entry
 * left) or was asked to. The entry is marked left, not removed, so delivery stops and /bye still finds its pane; the
 * pane going, or /bye, takes it off. Removing it here lost the pane to /bye.
 */
export function notMember(entry, { markLeft, log }) {
  markLeft({ roomId: entry.roomId, name: entry.name })
  log(`${entry.name} is no longer a member of ${entry.roomId}; marked left (/bye closes its pane)`)
}

/**
 * `removed` on a topic's connection: this account left it (a person leaves with their agents) or its creator
 * asked it to leave. This computer's entries there go, active and left (no /bye or takeover line can reach the seat
 * there now), and the seat forgets the topic, so no round joins it again; an agent joining again brings it back.
 */
export function topicLeft(roomId, frame, { leftTopic, log }) {
  const names = leftTopic(roomId, frame.by === frame.account ? 'was left by this account' : `was left at ${frame.by}'s request`)
  log(`${frame.account} left ${roomId}${names.length ? `; ${names.join(', ')} no longer delivered to` : ''}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // An older Node first on the tab's PATH: run on a newer one from this computer (node.mjs), exit as it does.
  const better = typeof globalThis.WebSocket !== 'function' && !process.env.SCORPIO_REEXEC && !process.env.SCORPIO_GUARD ? newerNode() : null
  if (better) {
    log(`Node ${process.version} (${process.execPath}) has no WebSocket; running the daemon on ${better} instead.`)
    const r = spawnSync(better, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, SCORPIO_REEXEC: '1' } })
    process.exit(r.status ?? 1)
  }
  await main()
}
