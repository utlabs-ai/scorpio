// The local roster: which agents on this computer are in which rooms, and which terminal pane
// each one sits in. The CLI writes an entry when an agent joins and marks it left on self-leave;
// the daemon delivers only to active entries. A left entry keeps its pane findable for /bye.
//
//   { "<roomId>": { "<full name>": { role, pane, ts } } }
//
// ts is when this agent session registered. join (including takeover) writes it; /renew rewrites
// it after clearing the context. The daemon reads a new ts as "new session" and sends the room
// reminder again. No credentials in here: the computer's one token is shared by every role.

import fs from 'node:fs'
import path from 'node:path'
import { REGISTRY_FILE, readJson, writeJson } from './paths.mjs'

const LOCK_WAIT_MS = 30_000
const UNOWNED_LOCK_MS = 5_000
const REUSED_PID_LOCK_MS = 5 * 60_000

function staleLock(lock, age) {
  if (age > REUSED_PID_LOCK_MS) return true
  let pid
  try { pid = Number(fs.readFileSync(lock, 'utf8').trim()) } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return age > UNOWNED_LOCK_MS
  try { process.kill(pid, 0); return false } catch (error) {
    return error?.code === 'ESRCH'
  }
}

function withLock(file, fn) {
  const lock = `${file}.lock`
  try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }) } catch { return null }
  const deadline = Date.now() + LOCK_WAIT_MS
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (true) {
    if (Date.now() >= deadline) return null
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs
        if (staleLock(lock, age)) {
          try { fs.unlinkSync(lock) } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') return null }
          continue
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') return null
        continue
      }
      Atomics.wait(pause, 0, 0, 10)
    }
  }
  try { return fn() } finally { try { fs.unlinkSync(lock) } catch {} }
}

export function readRegistry(file = REGISTRY_FILE) {
  const all = readJson(file)
  return all && typeof all === 'object' ? all : {}
}

function save(all, file) {
  try { writeJson(file, JSON.stringify(all, null, 2)); return true } catch { return false }
}

/** After a successful join. Without a pane there is nothing to deliver to, so nothing is written. */
export function register({ roomId, name, role, pane, ts }, file = REGISTRY_FILE) {
  if (!roomId || !name || !pane) return false
  return withLock(file, () => {
    const all = readRegistry(file)
    all[roomId] = all[roomId] || {}
    all[roomId][name] = { role: role || String(name).split('@')[0], pane, ts: ts || Date.now() }
    return save(all, file)
  }) ?? false
}

/**
 * On leave. With a pane, only the entry still pointing at that pane goes: when the same name has
 * moved to a new pane, the old session leaving must not take the new one's entry with it.
 */
export function unregister({ roomId, name, pane }, file = REGISTRY_FILE) {
  return withLock(file, () => {
    const all = readRegistry(file)
    if (!all[roomId]?.[name]) return false
    if (pane && all[roomId][name].pane !== pane) return false
    delete all[roomId][name]
    if (!Object.keys(all[roomId]).length) delete all[roomId]
    return save(all, file)
  }) ?? false
}

/**
 * This account is out of a topic (its person left, or was asked to leave): every entry there goes, active
 * or left. Nothing can reach the seat there any more, not /bye and not a takeover line. The names that went.
 */
export function dropRoom(roomId, file = REGISTRY_FILE) {
  return withLock(file, () => {
    const all = readRegistry(file)
    const names = Object.keys(all[roomId] || {})
    if (!names.length) return []
    delete all[roomId]
    save(all, file)
    return names
  }) ?? []
}

export function markLeft({ roomId, name }, file = REGISTRY_FILE) {
  return withLock(file, () => {
    const all = readRegistry(file)
    if (!all[roomId]?.[name]) return false
    all[roomId][name].status = 'left'
    return save(all, file)
  }) ?? false
}

/** Flattened: one entry per (room, agent). */
function flatten(file, left) {
  const out = []
  for (const [roomId, members] of Object.entries(readRegistry(file))) {
    for (const [name, info] of Object.entries(members || {})) if ((info.status === 'left') === left) out.push({ roomId, name, ...info })
  }
  return out
}
export const entries = (file = REGISTRY_FILE) => flatten(file, false)
export const leftEntries = (file = REGISTRY_FILE) => flatten(file, true)

/** Drop entries whose pane no longer exists, and say which: a silent drop is a person losing delivery unnoticed. */
export function prune(livePanes, file = REGISTRY_FILE) {
  return withLock(file, () => {
    const live = new Set(livePanes)
    const all = readRegistry(file)
    const dropped = []
    for (const [roomId, members] of Object.entries(all)) {
      for (const [name, info] of Object.entries(members || {})) {
        if (!live.has(info.pane)) { dropped.push({ roomId, name, pane: info.pane }); delete all[roomId][name] }
      }
      if (!Object.keys(all[roomId] || {}).length) delete all[roomId]
    }
    if (dropped.length) save(all, file)
    return dropped
  }) ?? []
}
