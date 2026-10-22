// One short-lived local receipt for a join that Herdr could not place. The agent shows its code in
// its own terminal, then sends it to this computer's daemon. No server endpoint or shared secret.

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { STATE_DIR, readJson, writeJson } from '../daemon/paths.mjs'

export const ATTACH_MS = 2 * 60_000
const DIR = path.join(STATE_DIR, 'attach')
const fileFor = (roomId, name, dir) => path.join(dir, `${createHash('sha256').update(`${roomId}\0${name}`).digest('hex')}.json`)
const digest = (code) => createHash('sha256').update(code).digest()

export function clearPending(roomId, name, dir = DIR) {
  fs.rmSync(fileFor(roomId, name, dir), { force: true })
}

export function createPending({ roomId, name, role, now = Date.now(), dir = DIR }) {
  const code = `SCORPIO-ATTACH-${randomBytes(16).toString('base64url')}`
  writeJson(fileFor(roomId, name, dir), { roomId, name, role, codeHash: digest(code).toString('hex'), expiresAt: now + ATTACH_MS })
  return { code, expiresAt: now + ATTACH_MS }
}

/** A matching attempt consumes the code before any pane scan; retries must use a fresh join. */
export function consumePending({ roomId, name, code, now = Date.now(), dir = DIR }) {
  const file = fileFor(roomId, name, dir)
  const record = readJson(file)
  if (!record || record.roomId !== roomId || record.name !== name) return { error: 'missing' }
  if (record.expiresAt <= now) { fs.rmSync(file, { force: true }); return { error: 'expired' } }
  if (!/^SCORPIO-ATTACH-[A-Za-z0-9_-]{22}$/.test(code || '')) return { error: 'invalid' }
  const expected = Buffer.from(record.codeHash || '', 'hex')
  const received = digest(code)
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return { error: 'invalid' }
  fs.rmSync(file, { force: true })
  return { role: record.role }
}

export async function matchingPanes(panes, read, code) {
  const matches = []
  for (const pane of panes.filter((p) => p.agent && p.pane_id)) {
    let screen = await read(pane.pane_id, 160, 'recent-unwrapped')
    if (!screen.includes(code)) screen = await read(pane.pane_id, 120, 'visible')
    if (screen.includes(code)) matches.push(pane.pane_id)
  }
  return matches
}
