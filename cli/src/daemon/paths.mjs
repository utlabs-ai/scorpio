// Where Scorpio keeps things on this computer: SCORPIO_HOME, default ~/.scorpio.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const HOME = process.env.SCORPIO_HOME || path.join(os.homedir(), '.scorpio')
/** Whether a home is the default ~/.scorpio; a trailing / or a relative spelling of it is the same home. */
export const isDefaultHome = (home = HOME) => path.resolve(home) === path.resolve(os.homedir(), '.scorpio')
export const STATE_DIR = path.join(HOME, 'state')
export const REGISTRY_FILE = path.join(STATE_DIR, 'registry.json')
export const PID_FILE = path.join(STATE_DIR, 'daemon.pid')
export const HEALTH_FILE = path.join(STATE_DIR, 'health')
export const ROLLBACK_FILE = path.join(STATE_DIR, 'rollback.json')
export const DELIVERY_FILE = path.join(STATE_DIR, 'delivery.json')
export const SEAT_FILE = path.join(STATE_DIR, 'seat.json')
export const SPAWN_CONFIG_FILE = path.join(STATE_DIR, 'spawn-config.json')
export const REMOVED_FILE = path.join(STATE_DIR, 'removed-computers.json')
// The daemon listens here for the CLI's requests (relay.mjs). A unix socket path longer than about
// 100 bytes (104 on macOS, 108 on Linux) is cut short without an error: then there is no relay.
export const RELAY_SOCKET = path.join(STATE_DIR, 'relay.sock')
export const relaySocketFits = (p = RELAY_SOCKET) => Buffer.byteLength(p) <= 100
export const TOKEN_FILE = path.join(HOME, 'token')
export const CONFIG_FILE = path.join(HOME, 'config.json')
export const LAUNCHER = path.join(HOME, 'bin', 'scorpio')

// The package this code runs from (cli/ in the repository, ~/.scorpio/app once installed).
export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const roleOf = (name) => String(name).split('@')[0]
// A seat's handoff kept on this computer: written by the outgoing agent, deleted once
// `scorpio handoff` has stored it in the cloud, so it stays only when that did not happen.
export const handoffPath = (roomId, name) => path.join(HOME, 'topics', roomId, 'handoffs', `${roleOf(name)}.md`)
// A seat's handoff read from the cloud (by /spawn, or `scorpio handoff name=`): never the fallback directory.
export const handoffCopyPath = (roomId, name) => path.join(HOME, 'topics', roomId, 'files', `handoff-${name}.md`)
/** The most a handoff may be: 256 KB. */
export const HANDOFF_MAX_BYTES = 256 * 1024
export const spawnPath = (roomId, name) => path.join(HOME, 'spawns', roomId, `${roleOf(name)}.md`)
export const spawnRecordPath = (roomId, name) => path.join(HOME, 'spawns', roomId, `${roleOf(name)}.json`)
export const memoryPath = (roomId) => path.join(HOME, 'memory', `${roomId}.md`)

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// Write through a temp file and rename: a reader (the CLI, a restarted daemon) never sees half a file.
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * This computer's id: random, made once (by setup, or by whatever needs it first) and kept in
 * config.json. The server ties the daemon's seat number to it, so a new token on the same computer
 * keeps the number, and two computers with the same host name don't collide. Deleting
 * ~/.scorpio makes a new device.
 */
export function deviceId(file = CONFIG_FILE) {
  const config = readJson(file) || {}
  if (typeof config.device_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(config.device_id)) return config.device_id
  const id = randomUUID()
  // Re-read just before writing: keep anything another process wrote meanwhile, and its id if it made one.
  const now = readJson(file) || {}
  if (typeof now.device_id === 'string' && now.device_id) return now.device_id
  writeJson(file, JSON.stringify({ ...now, device_id: id }, null, 2) + '\n')
  return id
}

/** Idle handoff when config.json does not say. */
export const IDLE_HANDOFF_DEFAULT = 60
const IDLE_HANDOFF_MAX = 7 * 24 * 60

/** idle_handoff_minutes from config.json: a whole number of minutes, 0 = off; anything else is the default. */
export function idleHandoffMinutes(file = CONFIG_FILE) {
  const v = readJson(file)?.idle_handoff_minutes
  return Number.isInteger(v) && v >= 0 && v <= IDLE_HANDOFF_MAX ? v : IDLE_HANDOFF_DEFAULT
}

/** Write it (/idle), keeping everything else in config.json. */
export function setIdleHandoffMinutes(minutes, file = CONFIG_FILE) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > IDLE_HANDOFF_MAX) throw new Error(`idle_handoff_minutes must be a whole number from 0 to ${IDLE_HANDOFF_MAX}`)
  writeJson(file, JSON.stringify({ ...(readJson(file) || {}), idle_handoff_minutes: minutes }, null, 2) + '\n')
}

export function server() {
  const s = process.env.SCORPIO_SERVER || readJson(CONFIG_FILE)?.server || readJson(path.join(PKG_DIR, 'defaults.json'))?.server
  return String(s || 'https://scorpio.utlabs.ai').replace(/\/+$/, '')
}

export function version() {
  return readJson(path.join(PKG_DIR, 'package.json'))?.version ?? '0.0.0'
}
