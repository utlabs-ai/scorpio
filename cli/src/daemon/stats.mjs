import path from 'node:path'
import { STATE_DIR, readJson, writeJson } from './paths.mjs'

export const STATS_FILE = path.join(STATE_DIR, 'daemon-stats.json')
const dayOf = (date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`

/** Counters survive daemon restarts. A retry of a previously typed message is not a new delivery. */
export function createDeliveryStats({ file = STATS_FILE, now = () => new Date() } = {}) {
  const saved = readJson(file) || {}
  let day = saved.day || dayOf(now())
  let total = Number(saved.total) || 0
  const totalSince = Number(saved.totalSince) || now().getTime()
  let today = saved.today && typeof saved.today === 'object' ? saved.today : { total: 0, rooms: {} }
  let dirty = !saved.v
  const record = () => ({ v: 1, day, today, total, totalSince })
  const save = () => { rollover(); if (dirty) { writeJson(file, record()); dirty = false } }
  const rollover = () => {
    const current = dayOf(now())
    if (current !== day) {
      day = current; today = { total: 0, rooms: {} }; dirty = true
      try { writeJson(file, record()); dirty = false } catch {}
    }
  }
  return {
    add(roomId, name, count) {
      rollover()
      if (!Number.isInteger(count) || count <= 0) return
      total += count; today.total += count
      const room = today.rooms[roomId] ||= { total: 0, agents: {} }
      room.total += count
      room.agents[name] = (room.agents[name] || 0) + count
      dirty = true
    },
    snapshot() { rollover(); return structuredClone(record()) },
    save,
  }
}
