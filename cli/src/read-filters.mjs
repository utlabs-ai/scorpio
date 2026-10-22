import { CliError, intArg } from './client.mjs'

export const messageFilterKeys = ['q', 'by', 'kind', 'at', 'replyTo', 'has', 'task', 'since', 'until', 'from', 'before', 'order', 'limit']
export function readArgs(args, keys) {
  const allowed = ['roomId', 'role', ...keys]
  const unknown = Object.keys(args).find(k => !allowed.includes(k))
  if (unknown) throw new CliError('bad_request', `Unknown argument ${unknown}=. This command takes topicId=, role=, ${keys.map(k => `${k}=`).join(', ')}.`)
}
export function dateArg(value, key) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(0)
    date.setFullYear(year, month - 1, day)
    date.setHours(0, 0, 0, 0)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new CliError('bad_request', `${key}= must be a valid YYYY-MM-DD date or milliseconds.`)
    if (key === 'until') date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError('bad_request', `${key}= must be a YYYY-MM-DD date or milliseconds.`)
  return Number(value)
}
export function readQuery(args, keys) {
  const q = new URLSearchParams()
  for (const key of keys) if (args[key] !== undefined) {
    const value = ['since', 'until'].includes(key) ? dateArg(args[key], key)
      : ['limit', 'before', 'replyTo'].includes(key) ? intArg(args, key, { required: true }) : args[key]
    q.set(key, String(value))
  }
  return q
}
