// After join: put this agent on the local roster so the daemon delivers to it.
// The join output says how the local delivery registration went; joining the room itself succeeds
// even when this computer cannot identify the pane yet.

import { personName } from '../render/person-name.mjs'
import { findOwnPane } from '../adapters/terminal/herdr.mjs'
import { entries, register, markLeft } from '../daemon/registry.mjs'
import { daemonPid } from '../daemon/pid.mjs'
import { SEAT_FILE, readJson } from '../daemon/paths.mjs'
import { clearPending, createPending } from './attach.mjs'

export function registerAfterJoin({ roomId, name, role, ownerDisplayName = null, pane = null, env = process.env, find = findOwnPane }) {
  const owner = String(name).split('@').slice(1).join('@')
  const intro = `read recent history (scorpio messages topicId=${roomId}), mark the latest seq. Your owner is ${personName(owner, ownerDisplayName)}; report in to @${owner} with send`
  const seat = readJson(SEAT_FILE) || {}
  const spawnPane = (seat.spawns || []).find((op) => op.roomId === roomId && op.name === name && ['starting', 'joining', 'late'].includes(op.stage))?.pane || null
  const found = find({ spawnPane, explicitPane: pane })
  if (!found.pane) {
    if (found.reason === 'no-herdr') {
      return { registered: false, reason: 'no-herdr', next: `No Herdr on this computer, so no daemon delivers to you: ${intro}, then run wait in the foreground.` }
    }
    // Herdr runs, but this session is not in a Herdr pane (a plain terminal, the usual first time): no daemon
    // delivers here, and an /attach code would only mislead.
    if (found.reason === 'detached' && !env.HERDR_PANE_ID) {
      return { registered: false, reason: 'detached', next: `Herdr runs on this computer, but this session is not in a Herdr pane, so no daemon delivers to you: ${intro}, then run wait in the foreground.` }
    }
    if (found.reason === 'invalid-pane' || found.reason === 'pane-mismatch') {
      return { registered: false, reason: found.reason, next: `That pane does not match this join or has no agent in it. Ask your person to identify your pane with herdr pane list, then rerun scorpio join topicId=${roomId} role=${role} resume=true pane=<that pane id>.` }
    }
    const { code, expiresAt } = createPending({ roomId, name, role })
    const daemonRole = /^(?:daemon(?:-\d+|\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+-daemon)$/.test(seat.role || '') ? seat.role : null
    return {
      attachCode: code, registered: false, reason: 'attach-pending', expiresAt,
      next: `If you run in a Herdr pane: ${daemonRole ? `run scorpio send topicId=${roomId} role=${role} text='@${daemonRole}@${owner} /attach ${code}'` : `find this computer's daemon with scorpio members topicId=${roomId}, then send it /attach ${code}`} within two minutes. It will bind only if the code appears in exactly one Herdr pane. If it cannot, ask your person to identify your pane with herdr pane list, then rerun scorpio join topicId=${roomId} role=${role} resume=true pane=<that pane id>. Not in a Herdr pane (a plain terminal)? Don't send it: ${intro}, then run wait in the foreground.`,
    }
  }
  if (!register({ roomId, name, role, pane: found.pane })) return { registered: false, reason: 'local-write-failed', next: 'Could not write the local delivery roster; ask your person to check ~/.scorpio/state permissions, then rerun this join.' }
  clearPending(roomId, name)
  const others = [...new Set(entries().filter((e) => e.pane === found.pane && e.name !== name).map((e) => e.name))]
  const running = daemonPid()
  return {
    registered: true,
    pane: found.pane,
    via: found.via,
    daemon: running ? 'running' : 'not running',
    next: running
      ? `Registered on this computer: the Scorpio daemon types messages for you into this session, so do not run wait. Now ${intro}.`
      : `Registered on this computer, but the Scorpio daemon is not running, so nothing reaches you yet. Ask your person whether to start it: it runs in its own Herdr tab and delivers to every agent on this computer. Once they agree, run scorpio daemon (once per computer; it returns at once). Until then, ${intro}, then run wait in the foreground.`,
    ...(others.length ? { alsoOnThisPane: others, warn: `This pane is also registered as ${others.join(', ')}: either you under another name in another topic, or a stale entry.` } : {}),
  }
}

/** After leave: stop delivery, but keep its pane findable for /bye until that pane closes. */
export function unregisterAfterLeave({ roomId, name }) {
  markLeft({ roomId, name })
}
