import { REMOVED_FILE, readJson, writeJson } from './paths.mjs'

// A separate file lets `scorpio daemon rejoin=…` clear a block while the daemon is running.
export const wasRemoved = (roomId, file = REMOVED_FILE) => !!readJson(file)?.[roomId]

export function markRemoved(roomId, file = REMOVED_FILE) {
  writeJson(file, { ...(readJson(file) || {}), [roomId]: true })
}

export function clearRemoved(roomId, file = REMOVED_FILE) {
  const rooms = readJson(file) || {}
  delete rooms[roomId]
  writeJson(file, rooms)
}
