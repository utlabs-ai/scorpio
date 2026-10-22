// Room → topic, TODO → task on the agent's side. Agents read and type
// the new words; the server keeps its names (paths, fields, error codes) and writes the commands in its
// next hints the 0.4 way, so a CLI that never updates can still type them. This is the one place where
// this CLI translates between the two. Old spellings keep working forever: spawn files and long-running
// sessions are full of them.

/** Thrown for a contradictory pair of spellings; scorpio.mjs turns it into its usual error. */
export class NameClash extends Error {
  constructor(next) { super(next); this.error = 'bad_request'; this.next = next }
}

function alias(args, from, to) {
  if (args[from] === undefined) return
  if (args[to] !== undefined && args[to] !== args[from]) throw new NameClash(`${from}= and ${to}= mean the same here; give only ${from}=.`)
  args[to] = args[from]
  delete args[from]
}

/**
 * The arguments an action gets, in the server's names: topicId= → roomId=; desc= → topic= on create
 * and topic (on send and task, desc= stays the task's description); in=task → in=todo.
 */
export function serverArgs(action, args) {
  const out = { ...args }
  alias(out, 'topicId', 'roomId')
  if (action === 'create' || action === 'topic') alias(out, 'desc', 'topic')
  if (out.in === 'task') out.in = 'todo'
  return out
}

/** The action names: task is the list; todo, its old name, stays an alias. */
export const ACTION_ALIASES = { todo: 'task' }

// Only the top level: the names an agent copies into its next command. Messages, members and tasks inside
// keep the server's field names.
const OUTPUT_KEYS = { roomId: 'topicId', roomName: 'topicName', topic: 'desc', owner: 'creator', rooms: 'topics' }

/** One output object as the agent sees it: top-level keys renamed, hints in the new syntax. */
export function agentOutput(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[Object.hasOwn(OUTPUT_KEYS, k) ? OUTPUT_KEYS[k] : k] = k === 'next' || k === 'warn' ? newSyntax(v) : hint(v)
  return out
}

// An answer's item that could not be done or changed ({error, next}, e.g. send … done=T9 on a closed one) carries a
// hint too.
function hint(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && typeof v.next === 'string' && typeof v.error === 'string' ? { ...v, next: newSyntax(v.next) } : v
}

/**
 * A hint written with 0.4 commands, in the new syntax. Only command shapes change: an argument name
 * right before =, `scorpio todo`, todo followed by one of its arguments, in=todo, topic='…'. The
 * status value todo (status=todo, "todo, doing or done") and every other word stay as they are; text
 * already in the new syntax comes back unchanged.
 */
export function newSyntax(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/\broomId=/g, 'topicId=')
    .replace(/\bscorpio todo\b/g, 'scorpio task')
    .replace(/(^|[\s(`'"，、；：（])todo(?= +(?:topicId|add|take|done|edit|delete|show|mine|open)=)/g, '$1task')
    .replace(/\bin=todo\b/g, 'in=task')
    .replace(/\bin= is messages, todo or files\b/g, 'in= is messages, task or files')
    .replace(/(^|[\s(`'"，（])topic=(?=['"<])/g, '$1desc=')
}
