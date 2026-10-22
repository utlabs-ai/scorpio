import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { api, homeDir, readJson } from './services.mjs'

const seatFile = path.join(homeDir, 'state', 'seat.json')
const roomPath = (id, suffix) => '/rooms/' + encodeURIComponent(id) + suffix

function seatRole() { return readJson(seatFile)?.role || null }
export function localHostName(account) {
  const role = seatRole()
  return role ? role + '@' + account : null
}

export async function memberList(topicId) {
  const role = seatRole()
  if (!role) return null
  try { return (await api('GET', roomPath(topicId, '/members'), undefined, { role })).members || [] }
  catch (error) {
    if (/not.?member|role.?unknown/i.test(error.message)) return null
    throw error
  }
}

export async function hostOnline(topicId, account) {
  const members = await memberList(topicId)
  return members?.find((member) => member.kind === 'host' && member.owner === account &&
    member.status === 'active' && member.online === true) || null
}

export async function waitHostOnline(topicId, account, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const host = await hostOnline(topicId, account)
    if (host) return host
    await sleep(2000)
  } while (Date.now() < deadline)
  throw new Error('The daemon started locally but its room seat is not online.')
}
