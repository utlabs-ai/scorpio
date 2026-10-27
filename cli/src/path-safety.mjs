import path from 'node:path'

export const TOPIC_ID = /^[A-Za-z0-9_-]{22}$/
const ACCOUNT = /^[A-Za-z0-9_.-]{1,64}$/
const ROLE = /^[A-Za-z0-9_.-]{1,62}$/

/** Server identifiers are path components, never paths. */
export function seatParts(topicId, name) {
  if (typeof topicId !== 'string' || !TOPIC_ID.test(topicId)) throw new Error('Invalid topic id.')
  const parts = typeof name === 'string' ? name.split('@') : []
  if (parts.length < 1 || parts.length > 2 || !ROLE.test(parts[0]) || ['.', '..'].includes(parts[0]) ||
      parts.length === 2 && (!ACCOUNT.test(parts[1]) || ['.', '..'].includes(parts[1]))) throw new Error('Invalid seat name or account.')
  return { role: parts[0], name }
}

export function insideHome(home, ...parts) {
  const root = path.resolve(home), target = path.resolve(root, ...parts)
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside Scorpio home.')
  return target
}
