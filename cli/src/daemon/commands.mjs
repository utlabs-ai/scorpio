// Commands: what a person or agent of the same account types after @-ing this computer's daemon.
// Pure functions only: recognise a command, judge whether to run it, parse arguments,
// and write the texts handed to agents. Doing it (tabs, CLIs, leaving, closing panes) is seat.mjs.

import { paneTextError } from '../pane-text.mjs'
import os from 'node:os'
import { KINDS } from '../adapters/cli/index.mjs'
import { AGENT_NAME } from '../adapters/terminal/herdr.mjs'

const MIN = 60_000
const ROLE = /^[A-Za-z0-9_.-]{1,62}$/
export const READ_LINES = 30
export const READ_MAX = 100

/**
 * The command registry: {name, argsSpec, help, staleAfter}. argsSpec also drives the "usage: …" in
 * replies and, later, the web composer's check before sending. staleAfter: a command with side
 * effects that waited longer than this (a laptop asleep overnight) is not run.
 */
export const COMMANDS = [
  { name: 'attach', argsSpec: '<one-time-code>', staleAfter: 2 * MIN,
    help: 'bind a manually joined agent to the one Herdr pane showing its short-lived code; only that agent can request it.' },
  { name: 'spawn', argsSpec: 'claude|codex [name] [<dir>|cwd="…"] [model=…] [effort=…] [handoff=skip] [perm=ask|auto|all] [prompt]', staleAfter: 10 * MIN,
    help: 'start a new agent in this topic\'s workspace on this computer, or in a directory you name (use cwd="…" for spaces). It joins this topic and reports to you, then does the prompt. Without a name it becomes claude-1 and so on; model= and effort= override the configured defaults. perm=ask asks you in Scorpio; perm=auto lets the CLI decide automatically (Codex without the approval hook); perm=all skips tool approvals for this session. Without perm=, a new name follows your setting, a helper gets its sending agent\'s level on any computer, and a takeover keeps its last level. An agent may choose less permission, never more. The name is the seat: spawning a name the topic had before takes it over, with its open tasks, role card and last handoff (the one in the cloud, or this computer\'s copy if that is newer); handoff=skip leaves the handoff out, and the agent reads it only if your text says so. A takeover that previously named a directory must name it again; it never silently switches to the topic workspace. Your text after the directory (and model=, effort=, handoff=) reaches it word for word as its instruction and outranks the handoff\'s plans and next steps, so a returning agent can be given new work; rules on its card and in its handoff still hold unless the instruction names the rule and lifts it. For an agent with no history, use a new name, or none (it becomes claude-1, codex-1…, skipping every name the topic ever had).' },
  { name: 'handoff', argsSpec: 'name…|all', staleAfter: 10 * MIN,
    help: 'have it write a handoff (stored in the cloud unless the account keeps handoffs on agents\' computers), post a takeover command, and leave; then its pane is closed.' },
  { name: 'bye', argsSpec: 'name…|all', staleAfter: 10 * MIN,
    help: 'no handoff: stop delivering to it, leave the topic for it, close its pane. Also clears members whose process is gone.' },
  { name: 'idle', argsSpec: '[minutes|off]', staleAfter: 10 * MIN,
    help: "this computer's idle handoff: an agent here idle that many minutes in a row (stuck at a dialog doesn't count) is handed off as if you had sent /handoff. Without an argument: the setting and how long each agent here has been idle; off (or 0) turns it off. Default 60." },
  { name: 'read', argsSpec: '<name> [lines]', staleAfter: null,
    help: `the last lines of the screen of an agent this daemon started (/spawn), joined or not: ${READ_LINES} lines unless given, at most ${READ_MAX}.` },
  { name: 'keys', argsSpec: '<name> <key>…', staleAfter: 2 * MIN,
    help: 'press these keys, in order, in the pane of an agent this daemon started, then show its screen a few seconds later. Only keys from the key table (listed below); only while that CLI is in front of its pane, not a shell it exited to. The daemon answers no dialog by itself: only the owner can do this, from the web page.' },
  { name: 'text', argsSpec: '<name> <text>', staleAfter: 2 * MIN,
    help: 'type one line of text into the pane of an agent this daemon started, without pressing Enter (/keys <name> enter does that), then show its screen a few seconds later. Only while that CLI is in front of its pane; only the owner can do this, from the web page.' },
  { name: 'usage', argsSpec: '', staleAfter: null,
    help: "this computer's Claude Code and Codex quota, one line each: how much of each window is used, and when it resets." },
  { name: 'help', argsSpec: '', staleAfter: null,
    help: 'this table.' },
]
export const COMMAND = Object.fromEntries(COMMANDS.map((c) => [c.name, c]))

export const usage = (name) => `/${name}${COMMAND[name]?.argsSpec ? ` ${COMMAND[name].argsSpec}` : ''}`
export const HELP_SHORT = `Commands: ${COMMANDS.filter((c) => !c.later).map((c) => usage(c.name)).join(', ')}; /help explains each.`
export const HELP_FULL = [
  'Commands: @ this daemon, then the command. Only commands from its own account (the person and their agents) are run.',
  ...COMMANDS.map((c) => `- \`${usage(c.name)}\`: ${c.help}`),
  'Names are roles (e.g. api), without @; all means every agent of this computer in this topic.',
].join('\n')

/** This computer's short name: the first part of the host name, lower case. */
export function machineName(hostname = os.hostname()) {
  return String(hostname || '').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '') || 'host'
}

/**
 * The role the seat asks for on its first join: daemon.<machine>. Servers that number seats per
 * device (daemon, daemon-2, …) ignore it and answer with the name; from then on the seat
 * uses the role in that answer.
 */
export function seatRole(hostname = os.hostname()) {
  return `daemon.${machineName(hostname)}`.slice(0, 62)
}

/** A daemon seat's name: daemon@kai, daemon-2@kai, or the older daemon.<machine>@kai. */
export const SEAT_NAME = /^(?:daemon(?:-\d+|\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+-daemon)@/
export const isSeatName = (name) => SEAT_NAME.test(String(name || ''))

/**
 * Recognise a command in a message. Only prose @names may come before it; a fenced code block
 * is an example, not a command. rest is everything after the command name with only
 * the leading whitespace removed (a /spawn prompt goes into a file verbatim). null when it isn't one.
 */
export function parseCommand(text) {
  const body = String(text || '')
  const at = body.search(/(^|\s)\/[A-Za-z]+/)
  if (at < 0) return null
  const before = body.slice(0, at).trim()
  if (before && !/^(@[A-Za-z0-9_.-]+(@[A-Za-z0-9_.-]+)?\s*)+$/.test(before)) return null
  const m = body.slice(at).replace(/^\s+/, '').match(/^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/)
  return m ? { name: m[1].toLowerCase(), rest: m[2] || '' } : null
}

/** Use the server's parsed mentions; @names in code and links are not command recipients. */
export function daemonsNamed(message, members = null) {
  const hosts = members ? new Set(members.filter((m) => m.kind === 'host').map((m) => m.name)) : null
  return [...new Set((message.mentions || []).filter((name) => hosts ? hosts.has(name) : isSeatName(name)))].sort()
}

/** A scheduled command has its creator's authority; the server alone sets scheduled.by. */
export function senderOf(message) {
  const by = message.fromKind === 'scheduled' && message.scheduled?.by
  return by ? { from: by, fromKind: by.includes('@') ? 'agent' : 'human' } : { from: message.from, fromKind: message.fromKind }
}

/** The account behind a sender: a person's name is the account, an agent's is role@account. */
export const accountOf = (message) => {
  const sender = senderOf(message)
  return sender.fromKind === 'human' ? sender.from : String(sender.from || '').split('@').slice(1).join('@')
}

/**
 * What to do with a message that reached the seat. Pure:
 * - ignore: its own, system, another daemon's (daemons never command each other), or an agent's that is not a command
 * - refuse: another account's (it would start processes on someone else's computer), or /spawn naming two daemons
 * - help: no command recognised, or an unknown one
 * - stale: a command with side effects older than its staleAfter
 * - run
 */
export function judge({ message, account, seatName, now, members = null }) {
  const sender = senderOf(message)
  if (sender.from === seatName || sender.fromKind === 'system') return { act: 'ignore' }
  const agent = sender.fromKind !== 'human'
  if (agent && (sender.fromKind === 'host' || (!sender.fromKind && (members ? members.some((m) => m.name === sender.from && m.kind === 'host') : isSeatName(sender.from))))) return { act: 'ignore' }
  const command = parseCommand(message.text)
  if (agent && !command) return { act: 'ignore' }
  if (accountOf(message) !== account) return { act: 'refuse', reason: `This daemon only takes commands from ${account} and ${account}'s agents.` }
  if (!command) return { act: 'help', reason: 'No command recognised.' }
  const spec = COMMAND[command.name]
  if (!spec) return { act: 'help', reason: `Unknown command /${command.name}.` }
  if (spec.staleAfter && Number.isFinite(message.ts) && now - message.ts > spec.staleAfter) {
    return { act: 'stale', command, reason: `This one is ${Math.round((now - message.ts) / MIN)} minutes old, so it was not run; send it again if you still want it.` }
  }
  if (command.name === 'spawn' && daemonsNamed(message, members).length > 1) {
    return { act: 'refuse', command, reason: '/spawn can @ only one daemon at a time, or each would start an agent.' }
  }
  return { act: 'run', command, spec }
}

/**
 * /spawn claude|codex [name] [<dir>|cwd="…"] [model=…] [effort=…] [handoff=skip] [perm=ask|auto|all] [prompt].
 * A bare path starts with / or ~; cwd="…" allows spaces. With neither, the topic workspace is used.
 * Chinese punctuation right after a bare path separates too, and full-width ～ counts as ~.
 */
export function parseSpawn(rest) {
  const m = String(rest || '').replace(/^\s+/, '').match(/^(\S+)(?:\s+([\s\S]*))?$/)
  const kind = m ? m[1].toLowerCase() : ''
  if (!KINDS.includes(kind)) return { error: `/spawn starts with ${KINDS.join(' or ')}. Usage: ${usage('spawn')}` }
  let tail = m[2] || ''
  let name = null
  const n = tail.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  if (n && ROLE.test(n[1]) && !/^[/~]/.test(n[1])) {
    if (!AGENT_NAME.test(n[1])) return { error: `Can't use the name "${n[1]}": it must start with a lowercase letter and contain only lowercase letters, digits, - and _, at most 32 characters.` }
    name = n[1]; tail = n[2] || ''
  }
  const said = (text) => (text.trim() ? text : '')
  let dir = null, after = tail
  if (tail.startsWith('cwd=')) {
    const quoted = tail.match(/^cwd="((?:\\.|[^"\\])*)"(?=$|[\s，。、；：！？])([\s\S]*)$/)
    if (!quoted) return { error: 'cwd= needs a quoted absolute or ~/ path, for example cwd="~/My Project".' }
    dir = quoted[1].replace(/\\(["\\])/g, '$1')
    if (!/^[\/~]/.test(dir) || /[\r\n\t]/.test(dir)) return { error: 'cwd= needs an absolute or ~/ path without line breaks.' }
    after = quoted[2].replace(/^[\s，。、；：！？]*/, '')
  } else {
    const bare = tail.match(/^([/~～][^\s，。、；：！？]*)[\s，。、；：！？]*([\s\S]*)$/)
    if (bare) { dir = bare[1].replace(/^～/, '~'); after = bare[2] }
  }
  // model=, effort= and handoff=skip follow the directory, or the name when using the default.
  const opts = { model: null, effort: null }
  let skipHandoff = false
  for (let o; (o = after.match(/^(model|effort|handoff|perm)=(\S*)(?:\s+|$)([\s\S]*)$/));) {
    if (o[1] === 'perm') {
      if (!['ask', 'auto', 'all', 'default'].includes(o[2])) return { error: 'perm= only takes ask, auto or all.' }
      opts.perm = o[2] === 'default' ? 'ask' : o[2]; after = o[3]; continue
    }
    if (o[1] === 'handoff') {
      if (o[2] !== 'skip') return { error: 'handoff= only takes skip: handoff=skip starts it without reading its handoff.' }
      skipHandoff = true; after = o[3]; continue
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(o[2])) return { error: `${o[1]}= needs a value like ${o[1] === 'model' ? 'claude-opus-5-5' : 'xhigh'}.` }
    opts[o[1]] = o[2]; after = o[3]
  }
  const skip = skipHandoff ? { skipHandoff } : {}
  return dir === null ? { kind, name, needDir: true, ...opts, ...skip, prompt: said(after) }
    : { kind, name, dir, ...opts, ...skip, prompt: said(after) }
}

export const spawnDirArg = (dir) => /[\s"，。、；：！？]/.test(dir)
  ? `cwd="${dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : dir

/** No name given: claude-1, claude-2… skipping the taken ones. */
export function freeName(kind, taken) {
  const used = new Set([...taken].map((n) => String(n).split('@')[0]))
  for (let i = 1; ; i += 1) if (!used.has(`${kind}-${i}`)) return `${kind}-${i}`
}

/** /idle [minutes|off]: {show}, {minutes}, or {error}. */
export function parseIdle(rest, max = 7 * 24 * 60) {
  const arg = String(rest || '').trim().toLowerCase().replace(/\s*(min|mins|minutes|m|分钟)$/, '')
  if (!arg) return { show: true }
  if (arg === 'off' || arg === '0') return { minutes: 0 }
  if (/^\d+$/.test(arg) && Number(arg) <= max) return { minutes: Number(arg) }
  return { error: `/idle takes a number of minutes (1–${max}) or off.` }
}

export const minutesText = (n) => `${n} minute${n === 1 ? '' : 's'}`

/** What the seat says in the topic (after @ the owner) before an idle handoff, and how to change it. */
export function idleNotice({ minutes, role }) {
  return `${role} has been idle for ${minutesText(minutes)}, so it is handed off now. (This computer's setting: @ me with /idle 120 to change the time, /idle off to turn it off.)`
}

/** Targets of /handoff, /bye: names (role or full name, a leading @ dropped) or all. */
export function parseTargets(rest, account) {
  const tokens = String(rest || '').split(/[\s,，、]+/).map((t) => t.replace(/^@/, '')).filter(Boolean)
  if (!tokens.length) return { error: 'Name someone, or all' }
  if (tokens.some((t) => t.toLowerCase() === 'all')) return { all: true, names: [] }
  const names = []
  for (const t of tokens) {
    const role = t.includes('@') ? t.split('@')[0] : t
    if (!ROLE.test(role)) return { error: `"${t}" is not a role` }
    names.push(`${role}@${account}`)
  }
  return { all: false, names: [...new Set(names)] }
}

/** The first word of a command's arguments as an agent's full name, and what follows it (leading whitespace dropped). */
function nameFirst(rest, account) {
  const m = String(rest || '').replace(/^\s+/, '').match(/^(\S+)(?:\s+([\s\S]*))?$/)
  if (!m) return { error: 'Name an agent' }
  const word = m[1].replace(/^@/, '')
  const role = word.includes('@') ? word.split('@')[0] : word
  if (!ROLE.test(role)) return { error: `"${m[1]}" is not a role` }
  return { name: `${role}@${account}`, after: m[2] || '' }
}

/** The agent a command names first (its full name), or null: what /keys and /text queue by before anything else. */
export const targetOf = (rest, account) => nameFirst(rest, account).name || null

/** /read <name> [lines]: {name, lines} or {error}. More than READ_MAX lines reads READ_MAX. */
export function parseRead(rest, account) {
  const n = nameFirst(rest, account)
  if (n.error) return n
  const arg = n.after.trim()
  if (!arg) return { name: n.name, lines: READ_LINES }
  if (!/^\d+$/.test(arg) || Number(arg) < 1) return { error: `"${arg}" is not a number of lines` }
  return { name: n.name, lines: Math.min(Number(arg), READ_MAX) }
}

/**
 * /keys <name> <key>…: {name, keys} with the key table's entries in order, or {error} (unknown: the word that is
 * not a key). find(word) looks a word up in the table (keys.mjs findKey).
 */
export function parseKeys(rest, account, find) {
  const n = nameFirst(rest, account)
  if (n.error) return n
  const words = n.after.split(/[\s,，、]+/).filter(Boolean)
  if (!words.length) return { error: 'Name at least one key' }
  const keys = []
  for (const w of words) {
    const key = find(w)
    if (!key) return { error: `"${w}" is not a key here`, unknown: w }
    keys.push(key)
  }
  return { name: n.name, keys }
}

/** /text <name> <text>: {name, text} or {error}. One line: a line break would act as Enter, other control characters as keys. */
export function parseText(rest, account) {
  const n = nameFirst(rest, account)
  if (n.error) return n
  const text = n.after.replace(/[\r\n]+$/, '')
  if (!text.trim()) return { error: 'Give the text to type' }
  const error = paneTextError(text)
  if (error) return { error }
  return { name: n.name, text }
}

// ------------------------------------------------------------------ texts handed to agents
// The /spawn instruction stays verbatim in its file; the first prompt is one line for Herdr.

const label = (roomName) => String(roomName ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
const kindOf = (name) => (String(name).includes('@') ? 'agent' : 'person')

/** The role card a /spawn-ed agent joins with when its name is new in the topic. */
export const spawnCard = (role, by) => `${role}: started by ${by} with /spawn; takes work from ${by}`

/** How long ago, as the takeover line says it: under an hour N min, under two days N h, else N d. */
export function agoText(ms) {
  const min = Math.max(0, Math.floor(ms / MIN))
  if (min < 60) return `${Math.max(1, min)} min ago`
  const hours = Math.floor(min / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

/**
 * Where a takeover's handoff came from: what the seat says in the room after "Started …, " and what the first
 * prompt repeats. handoff: {source, ago, computer, reason}; sources cloud, local, local_cloud_failed,
 * none_cloud_failed, none, skipped. No final full stop: the room line adds it.
 */
export function takeoverText(role, handoff) {
  const h = handoff || { source: 'none' }
  const reason = label(h.reason) || 'unknown'
  switch (h.source) {
    case 'cloud': return `taking over ${role}: its tasks, role card and handoff (from the cloud, stored ${h.ago}${h.computer ? ` on ${label(h.computer)}` : ''}) go with it`
    case 'local': return `taking over ${role}: its tasks, role card and handoff (this computer's copy, written ${h.ago}) go with it`
    case 'local_cloud_failed': return `taking over ${role}: its tasks and role card go with it. The cloud handoff could not be fetched (${reason}), so it gets this computer's copy (written ${h.ago})`
    case 'none_cloud_failed': return `taking over ${role}: its tasks and role card go with it. The cloud handoff could not be fetched (${reason}) and there is none on this computer, so it starts without one; the topic's messages show where it stopped`
    case 'skipped': return `taking over ${role}: its tasks and role card go with it; handoff=skip, so its handoff was not read`
    default: return `taking over ${role}: its tasks and role card go with it; it left no handoff, in the cloud or on this computer`
  }
}

/**
 * Everything a /spawn-ed agent has to do: join, report in, then the prompt. Written to a file; the
 * CLI gets one line pointing at it (spawnLine), never typed into its input box (text typed while
 * Claude Code's startup hooks still run is lost). keepCard: the name is in the topic already (a
 * takeover), so the join line leaves roleCard out and the topic keeps its card as it was.
 * handoff: where the takeover's handoff came from (takeoverText), with file and ago when there is one
 * to read. handoff=skip (source skipped): the prompt says nothing about a handoff at all.
 */
export function spawnPrompt({ account, by = account, roomId, roomName, seq, name, pane, prompt, keepCard = false, handoff = null, scheduled = null }) {
  const role = name.split('@')[0]
  const skipped = keepCard && handoff?.source === 'skipped'
  const toRead = keepCard && handoff?.file ? handoff : null
  // A takeover without a handoff to read (none, could not be fetched, handoff=skip) is not told of one "below".
  const rules = keepCard && !toRead
    ? `Rules are different: the ones on your role card (each with the message that set it) still hold unless the instruction names the rule and lifts it.`
    : `The handoff below is what the previous session knew, and ${by} may have moved on since: where its plans or next steps differ, follow the instruction. Rules are different: the ones on your role card and in your handoff (each with the message that set it) still hold unless the instruction names the rule and lifts it.`
  const instruction = prompt
    ? `## ${by}'s instruction: what you are here to do\n\n${prompt}${scheduled?.id ? `\n\nSet by ${scheduled.by} · Scheduled ${scheduled.id}` : ''}\n\nThis is the latest word from ${by}, so it decides what you do now. ${rules} If part of the instruction seems to break one, ask ${account} about that part (a task, as at the end of this file), leave that part until they answer, and go on with the rest.`
    : `## ${by}'s instruction: none this time\n\n${!keepCard ? `Report in and wait for ${by}.` : toRead ? `Read your handoff, report in with what it says comes next, and wait for ${by} to say what to do (their messages appear here by themselves).` : `Report in with where your tasks and the topic's recent messages say it stopped, and wait for ${by} to say what to do (their messages appear here by themselves).`}`
  const seat = `## You are taking over\n\nThe same name in a topic is the same seat, so ${name}'s open tasks and role card are yours now.`
  const takeover = !keepCard ? null
    : skipped ? `${seat} Your tasks and the topic's recent messages show where it stopped.`
      : `${seat} The daemon told the topic: "${takeoverText(role, handoff)}." ${toRead
        ? `Its handoff: ${toRead.file} (${toRead.source === 'cloud' ? 'stored' : 'written'} ${toRead.ago}). Read it before you report in: it tells you where things stood; ${prompt ? 'the instruction above tells you what to do now' : `${by} will tell you what to do now`}.`
        : `Your tasks and the topic's recent messages show where it stopped.`}`
  const join = `   scorpio join topicId=${roomId} role=${role} resume=true pane=${pane}${keepCard ? '' : ` roleCard='${spawnCard(role, by)}'`}`
  const steps = [
    `1. Join (run it as is; no passcode needed; if it fails, stop and leave the error on screen: the daemon shows it to ${account}; do not retry under another name):`,
    join,
    keepCard
      ? `   Its answer has the topic's description, your role card and your tasks. If your work is now different, rewrite the card (scorpio roleCard), keeping the rules on it.`
      : `   Its answer has the topic's description, your role card and your tasks. Then rewrite the card in your own words (scorpio roleCard), as the skill says.`,
  ]
  if (keepCard) steps.push(toRead ? '2. Read the handoff above.' : '2. Read the last messages in the topic and your tasks.')
  const reportStep = keepCard ? 3 : 2
  const report = prompt
    ? toRead
      ? 'in a line or two, what you take the instruction to mean, what you do first, and anything in the handoff that disagrees with the instruction.'
      : 'in a line or two, what you take the instruction to mean and what you do first.'
    : !keepCard
      ? 'say you have joined and are waiting for their instruction.'
      : toRead
        ? 'in a line or two, what the handoff says comes next.'
        : 'in a line or two, where your tasks and the recent messages say it stopped.'
  steps.push(`${reportStep}. Report in: scorpio send topicId=${roomId} role=${role} replyTo=${seq} text='@${by} …': ${report}`)
  steps.push(`${reportStep + 1}. ${prompt ? 'Do the instruction; you need not wait for a reply to your report.' : `Wait for ${by}; their messages appear here by themselves.`}`)
  return [
    `# You are ${name} in the Scorpio topic "${label(roomName)}"`,
    `${by} (${kindOf(by)}) sent /spawn (#${seq}) in the Scorpio topic "${label(roomName)}" (topic ${roomId}) to bring you in. You report to ${by} and take your work from ${by}.`,
    instruction,
    ...(takeover ? [takeover] : []),
    `## Steps\n\n${steps.join('\n')}`,
    `Nobody sits at your terminal. When a person has to decide something, give them a task with the question (scorpio send topicId=${roomId} role=${role} text='@${account} …' add='<what to decide>' to=${account}) and leave that decision until they answer; never ask in the terminal. Messages for you appear in this session by themselves (this computer's Scorpio daemon types them in), so do not run \`scorpio wait\`. Everything else: the scorpio skill.`,
  ].join('\n\n')
}

/** The one line handed to the CLI as its last argument (herdr refuses arguments with newlines or tabs). handoff: one to read. */
export function spawnLine({ by, roomName, name, file, prompt, handoff = null }) {
  const start = `${by} brought you into the Scorpio topic "${label(roomName)}" as ${name}`
  if (!prompt) return `${start}, with no instruction this time. Read all of ${file} and do what it says.`.replace(/[\x00-\x1f\x7f-\x9f\s]+/g, ' ').trim()
  const chars = Array.from(prompt)
  const instruction = chars.length > 600
    ? `Their instruction begins: "${chars.slice(0, 600).join('')}…" (all of it is in the file).`
    : `Their instruction: "${prompt}".`
  return `${start}. ${instruction} First read all of ${file}: ${handoff ? 'how to join, and which handoff to read next (it says where things stood; their instruction says what to do now).' : 'how to join.'}`
    .replace(/[\x00-\x1f\x7f-\x9f\s]+/g, ' ').trim()
}

/** Typed into a /spawn-ed agent that stopped at its prompt on a network API error before joining. */
export function nudgePrompt({ file }) {
  return `Your last API request failed on this computer's network (the connection dropped), so you stopped before joining the Scorpio topic. Carry on where you left off; your instructions are in ${file}.`
}

/** The line for the owner after handoff_space_full: the CLI's next gives it, the takeover message carries it. */
export const SPACE_FULL_LINE = 'Cloud handoffs for this account in this topic are full (2.5 MB), so this handoff was not uploaded. Delete handoffs of seats you no longer need from their member cards; the next handoff will then upload.'

/** targets: what followed /handoff (roles or all), shown back to the agent. file: the seat's fallback path. */
export function handoffPrompt({ perm = 'ask', account, by = account, roomId, roomName, seq, targets, file, daemonName, kind, name, dir, model = null, effort = null, items = [], idleMinutes = null }) {
  const role = name.split('@')[0]
  const open = items.map((i) => `${i.id} ${label(i.title)}${i.status === 'doing' ? ' (doing)' : ''}`).join('; ')
  const where = dir ? spawnDirArg(dir) : '<its directory>'
  const cli = kind || '<claude if you are Claude Code, codex if you are Codex>'
  const why = idleMinutes
    ? `You have been idle for ${idleMinutes} minutes, so this computer's Scorpio daemon hands you off in the Scorpio topic "${label(roomName)}" (${roomId}), as if ${account} had sent /handoff ${role} (idle handoff, #${seq} says so in the topic): hand off, then leave.`
    : `${by} (${kindOf(by)}) sent /handoff ${targets || role} (#${seq}) in the Scorpio topic "${label(roomName)}" (${roomId}): hand off, then leave.`
  return [
    `${why} Whoever takes over gets the topic, your role card and your tasks from Scorpio, and everything else only from this handoff. In this order (\`scorpio\` is your usual client):`,
    ...(open ? [`0. Your tasks: ${open}. Close each one whose result is delivered (already live, sent, or written where it was asked for): scorpio task topicId=${roomId} role=${role} done=<id>. Set every other one to todo: scorpio task topicId=${roomId} role=${role} edit=<id> status=todo (add to=<name> when someone else goes on with it; your takeover keeps your name).`] : []),
    `1. Save your work: commit, and push where it is safe, so it outlives this computer. Never push to a branch that deploys, releases or publishes on push; never merge, deploy or release in a handoff. Commits sitting on such a branch: push them to a new branch that sets nothing off. Unsure what a push sets off: don't push, and name the branch and unpushed commits in the handoff.`,
    `2. Write the handoff to ${file}, short, facts only, under four headings (leave out the topic's description and your role card: your successor gets them anyway):\n   ## Where things stand: done, half done (how far), open tasks by id.\n   ## Next: in order; what waits on whom.\n   ## Lessons and gotchas: tricks, traps, rules people set that are not on your card (with the message that set each).\n   ## Your work: directories, branches, commits (pushed or not), uncommitted files.\n   Never put tokens, keys or passwords in a handoff: everyone who can read the topic can read it. Local paths and directory names are fine.`,
    `3. Store it: scorpio handoff topicId=${roomId} role=${role} file=${file}\n   stored "cloud": its link goes in step 4 (the file is gone from this computer; that is right). stored "local" (this account keeps handoffs on agents' computers): nothing to say about it. handoff_too_large: shorten it and run the same command again. handoff_space_full: go on, and add its line to step 5. Any other error: do what its next says, then go on and say nothing about it (the file stays; the next /spawn says where the handoff came from).`,
    `4. Tell ${account}: scorpio send topicId=${roomId} role=${role} replyTo=${seq} text='@${account} handoff written: <link>' (the link from step 3); without a link: text='@${account} handoff written.'`,
    `5. Post the takeover command: a line that explains, then a code block holding only the command (replace the angle brackets with what to do next):\n   @${account} takeover command for ${role}; to take over, copy the line below and send it:\n   \`\`\`\n   @${daemonName} /spawn ${cli} ${role} ${where}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''} perm=${perm} <what to do next>\n   \`\`\`\n   The same name gets your tasks, card and this handoff by itself, so the command only says what to do next, and whatever it says outranks your Next section; with nothing in its place, your successor reports what your Next section says and waits; to have it go straight on with your Next section, write that. Keep the explanation line: a message that is only a command runs at once. Only after handoff_space_full in step 3, the explanation line ends with: ${SPACE_FULL_LINE}`,
    `6. Leave: scorpio leave topicId=${roomId} role=${role} (this terminal is closed afterwards).`,
  ].join('\n\n')
}
