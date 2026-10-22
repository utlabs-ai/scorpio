import os from 'node:os'
import path from 'node:path'
import { HOME, readJson, version } from './paths.mjs'
import { DEVICE_FILE } from '../client.mjs'
import { pobiMode } from './dashboard.mjs'

const MIN = 60_000
const keyOf = (roomId, name) => `${roomId}|${name}`

/** Read the daemon's current local state for one dashboard frame. */
export function dashboardState({ seat, rooms, roster, ops = [], links, panes, idle, idleMinutes, statusSince, clis, detectedAt, update, stats, pobiAnimator, logout, now = Date.now() }) {
  const savedComputer = readJson(path.join(HOME, 'config.json')) || {}
  const device = seat.state?.device
  const spawns = ops.filter((op) => op.type === 'spawn' && ['starting', 'joining'].includes(op.stage))
  const handingOff = new Set(ops.filter((op) => op.type === 'handoff').flatMap((op) => (op.targets || []).map((target) => keyOf(op.roomId, target.name))))
  const panesOfAgent = new Map()
  for (const entry of roster) panesOfAgent.set(entry.pane, (panesOfAgent.get(entry.pane) || 0) + 1)
  const topics = [...new Set([...seat.joined(), ...roster.map((entry) => entry.roomId), ...spawns.map((op) => op.roomId)])].map((id) => ({
    id, name: rooms.get(id)?.roomName || id,
    agents: [...roster.filter((entry) => entry.roomId === id).map((entry) => {
      const key = keyOf(id, entry.name)
      const status = panes.get(entry.pane)?.agent_status
      const idleSince = idle.get(key)?.since
      const since = statusSince.get(key)?.since
      const minutes = Math.max(0, Math.floor((now - (since || now)) / MIN))
      const handoffMinutes = idleSince ? Math.floor((now - idleSince) / MIN) : minutes
      return { name: entry.name, pane: entry.pane, status: handingOff.has(key) ? 'handoff' : status === 'blocked' ? 'blocked' : status === 'working' ? 'working' : status === 'idle' || status === 'done' ? 'idle' : 'starting', minutes, idleIn: panesOfAgent.get(entry.pane) > 1 ? undefined : idleMinutes ? Math.max(0, idleMinutes - handoffMinutes) : null }
    }), ...spawns.filter((op) => op.roomId === id && !roster.some((entry) => entry.roomId === id && entry.name === op.name)).map((op) => ({ name: op.name, pane: op.pane, status: 'starting', minutes: 0 }))],
  }))
  const allLinks = links.all()
  const hostLinks = allLinks.filter((link) => link.host)
  const shownLinks = hostLinks.length ? hostLinks : allLinks
  const open = shownLinks.filter((link) => link.isOpen)
  const status = open.length === shownLinks.length && open.length ? 'connected' : open.length ? 'reconnecting' : 'disconnected'
  const pobi = pobiAnimator.current(pobiMode({ connected: status === 'connected', agents: topics.flatMap((topic) => topic.agents) }))
  return {
    version: version(), seat: seat.name,
    connection: { status, since: open.length ? Math.max(...open.map((link) => link.openedAt)) : null, latencyMs: hostLinks.find((link) => link.isOpen && link.latencyAt >= now - 60_000)?.latencyMs, attempt: Math.max(1, ...shownLinks.map((link) => link.failures)) },
    computer: { name: device?.name || savedComputer.device_name || os.hostname().split('.')[0], hostname: os.hostname(), note: device ? device.note : savedComputer.device_note },
    logout: logout?.offline() ? { url: readJson(DEVICE_FILE)?.verification_uri_complete } : null,
    clis, detectedAt, update, stats: stats.snapshot(), topics, now, pobi,
  }
}
