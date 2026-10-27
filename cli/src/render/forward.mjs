import { personName } from './person-name.mjs'

// The forwarding text: what an agent reads when a topic's messages reach it. The daemon types it into
// the agent's terminal and `scorpio wait` prints it, so it is one renderer.
// It is a stable interface that agents rely on: the skill teaches agents to read exactly this shape.
//
// What people wrote (message text, description, role cards) is passed on byte for byte between two frame
// lines, so the agent can tell quoted words from the words around them. The frame is not a security
// boundary; anybody can type one.

export const FRAME = '+' + '-'.repeat(38) + '+'
export const REMIND_EVERY = 20

const boxed = (text) => [FRAME, String(text ?? '').replace(/\n$/, ''), FRAME].join('\n')

/** Can this go into a terminal as typed text? Newline and tab only; every other control character is a key press. */
export function typeable(text) {
  return !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(String(text ?? ''))
}

// Typed into a terminal, a control character is a key press (Ctrl-C interrupts the agent, a carriage
// return submits half a message). We never alter what people wrote, so such a text is not typed at
// all: the agent gets a line telling it how to fetch the original. `wait` prints, it does not type,
// so it passes everything through.
const quoted = (text, terminal, what, fetch) => (terminal && !typeable(text)
  ? `(The ${what} contains control characters that cannot be typed into a terminal, so it is not pasted here. Read it with: ${fetch})`
  : boxed(text))

const flat = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()

const memberName = (name, members) => {
  const member = (members || []).find((m) => m.name === name)
  return personName(name, member?.kind === 'human' ? member.displayName : null)
}
const isSeat = (name, kind) => kind === 'host' || (!kind && /^(?:daemon(?:-\d+|\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+-daemon)@/.test(String(name || '')))
const accountOf = (name) => String(name || '').split('@').slice(1).join('@')

export function kindLabel(name, kind) {
  if (kind === 'human') return 'human'
  if (kind === 'system') return 'system'
  if (kind === 'scheduled') return 'scheduled message'
  return isSeat(name, kind) ? 'command seat' : 'agent'
}

/** The messages that wake an agent, oldest first: its unmarked @mentions and broadcasts from `listen`. */
export function wakeMessages(listen) {
  const all = new Map()
  for (const m of listen?.mentions || []) all.set(m.seq, { ...m, broadcast: false })
  for (const m of listen?.broadcasts || []) all.set(m.seq, { ...m, broadcast: true })
  return [...all.values()].sort((a, b) => a.seq - b.seq)
}

const roleArg = (role) => (role ? ` role=${role}` : '')

const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/**
 * One attachment: its name and size, and the command that downloads it, or that it was deleted; then
 * its own page, the link to give a person, when the server sent one.
 */
export function attachedLine(f, { roomId, role }) {
  const name = flat(f.name).slice(0, 100)
  const what = name ? `${name}${Number.isFinite(f.size) ? ` (${sizeText(f.size)})` : ''}` : ''
  if (f.deleted) return `Attached: ${what || f.id}, deleted`
  const page = typeof f.link === 'string' && /^https?:\/\/\S+$/.test(f.link) ? ` · page: ${f.link}${f.view === true ? ' (shown there)' : ''}` : ''
  return `Attached: ${what ? `${what} · ` : ''}scorpio file topicId=${roomId}${roleArg(role)} id=${f.id}${page}`
}

/**
 * A person's reply to a message carrying their task is the report (`todo[]` rel: reply):
 * the agent whose message was answered closes the task, or updates it to its next message (send … update=).
 */
export function relatedTasksLine(todos, m, { name, items }) {
  if (!todos.length) return null
  const parts = todos.map((t) => {
    const item = (items || []).find((i) => i.id === t.id)
    const title = Array.from(flat(item?.title ?? t.title))
    const head = `${t.id} ${title.slice(0, 40).join('')}${title.length > 40 ? '…' : ''}`
    if ((item?.status ?? t.status) === 'done') return `${head} (done already)`
    const closer = t.closer || (item?.reply?.seq === m.seq ? item.reply.closer : null) || item?.createdBy
    if (closer && closer !== name) return `${head} (${closer} closes it)`
    return `${head} (yours)`
  })
  return `Related tasks: ${parts.join(', ')}.`
}

/**
 * What a message does to this agent's tasks: it opens one for it, or delivers one it opened or
 * one its own tasks waited for. Whether a task can start is worked out from the blockers' states, the delivered
 * one counting as done (the items a daemon holds can be a moment behind the message).
 */
export function taskNotes(m, { name, items }) {
  const all = items || []
  const byId = new Map(all.map((i) => [i.id, i]))
  const out = []
  for (const t of m.todo || []) {
    if (t.rel === 'source' && t.assignee === name && t.status !== 'done') out.push(`Opens ${t.id} ${flat(t.title)} for you.`)
    if (t.rel !== 'result') continue
    const free = all.filter((i) => isOpen(i) && i.assignee === name && (i.blockedBy || []).includes(t.id) && i.blockedBy.every((b) => b === t.id || byId.get(b)?.status === 'done'))
    const opened = byId.get(t.id)?.createdBy === name ? ' (you opened it)' : ''
    if (free.length) out.push(`Delivers ${t.id} ${flat(t.title)}${opened}: your ${free.map((i) => i.id).join(', ')} can start now.`)
    else if (opened) out.push(`Delivers ${t.id} ${flat(t.title)}${opened}.`)
  }
  return out
}

function renderMessage(m, { roomId, terminal, role, name, items, members }) {
  let head = `#${m.seq} from ${memberName(m.from, members)} (${kindLabel(m.from, m.fromKind)})`
  if (m.broadcast) head += ', broadcast'
  if (m.reply?.seq) head += `, reply to #${m.reply.seq}`
  const out = [`${head}:`, quoted(m.text, terminal, 'text', `scorpio message topicId=${roomId}${roleArg(role)} seq=${m.seq}`)]
  const richLine = (line, what, fetch) => terminal && !typeable(line)
    ? `(The ${what} contains control characters that cannot be typed into a terminal, so it is not pasted here. Read it with: ${fetch})`
    : line
  if (m.buttons?.length) {
    const labels = m.buttons.map(b => `[${b.label}${b.by?.length ? ` · ${b.by.join(', ')}` : ''}]`)
    out.push(richLine(`Buttons: ${labels.join(' ')}`, 'button list', `scorpio message topicId=${roomId}${roleArg(role)} seq=${m.seq}`))
  }
  if (m.card) {
    const fetch = `scorpio card topicId=${roomId}${roleArg(role)} seq=${m.seq}`
    out.push(richLine(`Card: ${m.card.summary} (to read it: ${fetch})`, 'card summary', fetch))
  }
  if (m.scheduled?.id && m.scheduled?.by) {
    let setBy = `Set by ${flat(m.scheduled.by)} · Scheduled ${flat(m.scheduled.id)} · scorpio schedule topicId=${roomId}${roleArg(role)} show=${flat(m.scheduled.id)}`
    const late = Number(m.ts) - Number(m.scheduled.at)
    if (Number.isFinite(late) && late > 10 * 60_000) {
      const minutes = Math.floor(late / 60_000)
      setBy += ` · due ${minutes >= 120 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`} ago`
    }
    out.push(setBy)
  }
  for (const f of m.files || []) out.push(attachedLine(f, { roomId, role }))
  out.push(...taskNotes(m, { name, items }))
  const related = relatedTasksLine((m.todo || []).filter((x) => x.rel === 'reply'), m, { name, items })
  if (related) out.push(related)
  if (m.broadcast) out.push('This is a broadcast to everyone in the topic.')
  return out.join('\n')
}

/** Who is in the topic and what each says they do, plus its description: what an agent needs to judge whose words count. */
export function renderReminder({ room, name, reason, terminal = false, role = null, now = Date.now() }) {
  const roomId = room?.roomId ?? ''
  const fetchCards = `scorpio members topicId=${roomId}${roleArg(role)}`
  const below = []
  const card = (who, text) => {
    if (!text) return '(none)'
    if (terminal && !typeable(text)) return `(contains control characters; read it with: ${fetchCards})`
    if (!/[\n|]/.test(text)) return text
    below.push(`${who}'s role card:`, boxed(text))
    return '(several lines, below the table)'
  }
  const members = (room?.members || []).filter((m) => m.status !== 'left')
  const mine = members.find((m) => m.name === name)?.roleCard ?? ''
  const rows = [`| ${name} (you) | agent | ${card(name, mine)} |`]
  for (const m of members.filter((x) => x.name !== name)) {
    if (m.kind === 'human') {
      const tags = ['person']
      if (room?.owner && m.name === room.owner) tags.push('creator')
      if (m.name === accountOf(name)) tags.push('your owner')
      rows.push(`| ${memberName(m.name, members)} | ${tags.join(', ')} | — |`)
    } else if (isSeat(m.name, m.kind)) {
      rows.push(`| ${m.name} | command seat | ${m.roleCard ? card(m.name, m.roleCard) : 'runs commands (/spawn, /handoff, /bye); takes no work'} |`)
    } else rows.push(`| ${m.name} | agent | ${card(m.name, m.roleCard)} |`)
  }
  const label = flat(room?.roomName)
  const where = `You are in ${label ? `"${label}" (topic ${roomId})` : `topic ${roomId}`}${room?.owner ? `, created by ${memberName(room.owner, room?.members)}` : ''}.`
  return [
    `Topic reminder (${reason})`,
    ...(room?.topic
      ? [`${where} Its description:`, quoted(room.topic, terminal, 'description', `scorpio listen topicId=${roomId}${roleArg(role)}`)]
      : [`${where} It has no description.`]),
    '',
    'Who is in the topic (each member writes their own role card):',
    '| Member | Who | Role card |',
    '|---|---|---|',
    ...rows,
    ...(below.length ? ['', ...below] : []),
    ...taskLines({ items: room?.items, members: room?.members, name, roomId, role, now }),
    '',
    'How topics work and the rules: the scorpio skill.',
  ].join('\n')
}

/** Tasks under this agent's name: what it is doing, and what was assigned to it but not started yet. */
export function myItems(items, name) {
  const mine = (items || []).filter((i) => i.assignee === name)
  return { doing: mine.filter((i) => i.status === 'doing'), todo: mine.filter((i) => i.status === 'todo') }
}
const itemList = (list) => list.map((i) => `${i.id} ${flat(i.title)}`).join('; ')
/** "T7 Rate limit copy (by kai; waits for T3 to be delivered)": who opened it, and what still holds it (open items only are listed). */
function assignedList(list, items, name) {
  const open = new Set((items || []).filter((i) => i.status !== 'done').map((i) => i.id))
  return list.map((i) => {
    const waits = (i.blockedBy || []).filter((b) => open.has(b))
    const notes = [i.createdBy && i.createdBy !== name ? `by ${i.createdBy}` : null, i.blocked && waits.length ? `waits for ${waits.join(', ')} to be delivered` : null].filter(Boolean)
    return `${i.id} ${flat(i.title)}${notes.length ? ` (${notes.join('; ')})` : ''}`
  }).join('; ')
}
const isOpen = (i) => i.status === 'todo' || i.status === 'doing'
const DAY_MS = 86_400_000
const OPENED_MAX = 10
const IDS_MAX = 5
/** How long ago, roughly: 20 min, 5 h, 3 d. */
export function ago(ms, now = Date.now()) {
  const min = Math.max(0, Math.floor((now - ms) / 60_000))
  return min < 60 ? `${min} min` : min < 24 * 60 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / (24 * 60))} d`
}

/**
 * The reminder's task block, always there: its own tasks (or that it has none), what it
 * opened under other names, replies it must close or update, and a line on the whole topic.
 */
export function taskLines({ items, members, name, roomId, role = null, now = Date.now() }) {
  const all = items || []
  const { doing, todo } = myItems(all, name)
  const lines = []
  if (doing.length) lines.push(`In progress under your name: ${itemList(doing)}`)
  if (todo.length) lines.push(`Assigned to you, not started: ${assignedList(todo, all, name)}`)
  if (!doing.length && !todo.length) lines.push('No task under your name.')
  const opened = all.filter((i) => isOpen(i) && i.createdBy === name && i.assignee && i.assignee !== name).sort((a, b) => a.updatedMs - b.updatedMs)
  if (opened.length) {
    const more = opened.length > OPENED_MAX ? `; and ${opened.length - OPENED_MAX} more: scorpio task topicId=${roomId}${roleArg(role)} mine=true` : ''
    lines.push(`You opened, waiting on others: ${opened.slice(0, OPENED_MAX).map((i) => `${i.id} ${flat(i.title)} (${i.assignee}, ${ago(i.updatedMs, now)})`).join('; ')}${more}`)
  }
  const replied = all.filter((i) => (i.reply?.closer || i.createdBy) === name && i.reply?.seq && i.status !== 'done')
  if (replied.length) {
    lines.push(`Replies waiting for you: ${replied.map((i) => `${i.id} ${flat(i.title)} (under ${i.assignee}'s name; ${i.reply.from} replied in #${i.reply.seq} — close it, or update it to your next message)`).join('; ')}`)
  }
  const open = all.filter(isOpen)
  if (open.length) {
    const ids = (list) => list.slice(0, IDS_MAX).join(', ') + (list.length > IDS_MAX ? ` and ${list.length - IDS_MAX} more` : '')
    const present = new Set((members || []).filter((m) => m.status !== 'left').map((m) => m.name))
    const left = members?.length ? open.filter((i) => i.assignee && !present.has(i.assignee)).map((i) => i.id) : []
    const stale = open.filter((i) => i.status === 'doing' && now - i.updatedMs > DAY_MS).map((i) => i.id)
    const parts = [`${open.filter((i) => i.status === 'todo').length} todo, ${open.filter((i) => i.status === 'doing').length} doing`]
    if (left.length) parts.push(`under members who left: ${ids(left)}`)
    if (stale.length) parts.push(`doing with no change for over a day: ${ids(stale)}`)
    lines.push(`The topic's open tasks: ${parts.join('; ')}. All of them: scorpio task topicId=${roomId}${roleArg(role)} open=true`)
  }
  return ['', ...lines]
}

/** What an agent's tasks were at its last delivery: the open items under its name or created by it. */
export function taskSnapshot(items, name) {
  const out = {}
  for (const i of items || []) {
    if (isOpen(i) && (i.assignee === name || i.createdBy === name)) out[i.id] = { title: i.title, assignee: i.assignee ?? null, blocked: !!i.blocked, after: i.blockedBy || [] }
  }
  return out
}

/**
 * "Your tasks changed:" — what someone other than this agent changed in its tasks since the last delivery.
 * Nothing when there is no earlier snapshot (state from before 0.5.3, or a first delivery). What a message in this
 * delivery opens or delivers (`shown`: their seqs) is said under that message instead.
 */
export function taskChanges(before, { items, deleted, name, shown = [] }) {
  if (!before) return []
  const byId = new Map((items || []).map((i) => [i.id, i]))
  const gone = new Map((deleted || []).map((d) => [d.id, d]))
  const seqs = new Set(shown)
  const yours = [], start = [], moved = [], closed = [], removed = []
  for (const i of items || []) {
    if (!isOpen(i) || i.assignee !== name || i.updatedBy === name || before[i.id]?.assignee === name || seqs.has(i.createdSeq)) continue
    yours.push(`${i.id} ${flat(i.title)} is now yours (by ${i.updatedBy})`)
  }
  for (const [id, b] of Object.entries(before)) {
    const i = byId.get(id)
    const title = flat(i?.title ?? b.title)
    if (!i) {
      const d = gone.get(id)
      if (d && d.by !== name) removed.push(`${id} ${title} was deleted by ${d.by}`)
    } else if (i.status === 'done') {
      if (i.updatedBy !== name && !seqs.has(i.doneSeq)) closed.push(`${id} ${title} was closed by ${i.updatedBy}`)
    } else if (i.assignee !== b.assignee && i.assignee !== name) {
      if (i.updatedBy !== name) moved.push(`${id} ${title} moved to ${i.assignee ?? 'nobody'} (by ${i.updatedBy})`)
    } else if (b.blocked && !i.blocked && i.assignee === name) {
      // Freed by a blocker delivered (by someone else, not in a message shown here), deleted, or taken off its list.
      const delivered = b.after.filter((x) => byId.get(x)?.status === 'done' && byId.get(x).updatedBy !== name && !seqs.has(byId.get(x).doneSeq))
      const dropped = b.after.filter((x) => gone.has(x) && gone.get(x).by !== name)
      if (delivered.length) start.push(`${id} ${title} can start: ${delivered.join(', ')} ${delivered.length > 1 ? 'were' : 'was'} delivered`)
      else if (dropped.length) start.push(`${id} ${title} can start: ${dropped.join(', ')} ${dropped.length > 1 ? 'were' : 'was'} deleted`)
      else if (!b.after.some((x) => byId.get(x)?.status === 'done' || gone.has(x)) && i.updatedBy !== name) start.push(`${id} ${title} can start (by ${i.updatedBy})`)
    }
  }
  return [...yours, ...start, ...moved, ...closed, ...removed]
}

/**
 * Reminder or roster changes (reminderDue) plus the task changes, and what to remember: the roster, and the task
 * snapshot when this delivery knew the topic's items (a daemon that has not read them yet keeps the old one).
 */
export function deliveryDue(prev, { session = null, room, name, shown = [], every = REMIND_EVERY }) {
  const due = reminderDue(prev, { session, roster: rosterOf(room), every })
  const known = Array.isArray(room?.items)
  const tasks = known ? taskChanges(prev?.tasks, { items: room.items, deleted: room.deleted, name, shown }) : []
  const snapshot = known ? taskSnapshot(room.items, name) : prev?.tasks
  return { ...due, tasks, next: { ...due.next, ...(snapshot ? { tasks: snapshot } : {}) } }
}

/**
 * The part of a topic the reminder shows, kept so the next delivery can say what changed. A field not read yet
 * (after a restart, or when a read failed) is null: unknown, not empty. '' from the server is a real "no description".
 */
export function rosterOf(room) {
  return {
    name: typeof room?.roomName === 'string' ? room.roomName : null,
    topic: typeof room?.topic === 'string' ? room.topic : null,
    // roleCardBy (storage): who wrote the card last, the agent itself or its owner's account. Rosters kept
    // before it have three entries; only the card text decides whether it changed.
    members: Array.isArray(room?.members)
      ? room.members.filter((m) => m.status !== 'left').map((m) => [m.name, m.kind, m.roleCard || '', m.roleCardBy ?? null])
      : null,
  }
}

/** The roster to keep: each field not known now keeps its last known value, so the next comparison is with a real reading. */
function keptRoster(before, after) {
  return Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v ?? before?.[k] ?? null]))
}

/** A topic read since the daemon started: its description and members are known. */
const rosterKnown = (roster) => roster.topic !== null && roster.members !== null

/** The room as a delivery shows it: a name not read yet is the last one kept, never the topic's ID. */
export function namedRoom(room, prev) {
  return typeof room?.roomName !== 'string' && prev?.roster?.name ? { ...room, roomName: prev.roster.name } : room
}

/** What changed between two rosters. A field unknown on either side (null) reports nothing. */
export function rosterChanges(before, after) {
  const changes = []
  const known = (k) => before?.[k] != null && after?.[k] != null
  if (known('topic') && before.topic !== after.topic) changes.push({ type: 'topic', text: after.topic })
  if (!known('members')) return changes
  const old = new Map(before.members.map(([name, kind, card]) => [name, { kind, card }]))
  const cur = new Map(after.members.map(([name, kind, card, by]) => [name, { kind, card, by: by ?? null }]))
  for (const [name, { kind, card }] of cur) if (!old.has(name)) changes.push({ type: 'join', name, kind, card })
  for (const [name, { kind }] of old) if (!cur.has(name)) changes.push({ type: 'leave', name, kind })
  for (const [name, { kind, card, by }] of cur) {
    if (old.has(name) && kind !== 'human' && old.get(name).card !== card) changes.push({ type: 'card', name, kind, card, by })
  }
  return changes
}

export function renderChanges(changes, { roomId, name, members, terminal = false, role = null }) {
  const fetchCards = `scorpio members topicId=${roomId}${roleArg(role)}`
  const lines = ['Topic changes:']
  for (const c of changes) {
    const who = c.name === name ? `${c.name} (you)` : `${c.name} (${kindLabel(c.name, c.kind)})`
    if (c.type === 'topic') {
      lines.push(...(c.text
        ? ['- The description changed to:', quoted(c.text, terminal, 'description', `scorpio listen topicId=${roomId}${roleArg(role)}`)]
        : ['- The description was cleared']))
    } else if (c.type === 'leave') lines.push(`- ${who} left`)
    else if (c.type === 'join') {
      lines.push(...(c.kind === 'human' || isSeat(c.name, c.kind) || !c.card
        ? [`- ${who} joined`]
        : [`- ${who} joined; its role card (its own words):`, quoted(c.card, terminal, 'role card', fetchCards)]))
    } else if (c.name === name && c.by && c.by !== name) {
      // Someone else (its owner, on the web) rewrote this agent's card: say who, and that it now applies.
      const by = `${memberName(c.by, members)} (${c.by.includes('@') ? kindLabel(c.by) : c.by === accountOf(name) ? 'person, your owner' : 'person'})`
      lines.push(...(c.card
        ? [`- Your role card was changed by ${by} to:`, quoted(c.card, terminal, 'role card', fetchCards), 'Act on the new role card from now on.']
        : [`- Your role card was cleared by ${by}.`]))
    } else {
      lines.push(...(c.card
        ? [`- ${who} changed ${c.name === name ? 'your' : 'its'} role card to:`, quoted(c.card, terminal, 'role card', fetchCards)]
        : [`- ${who} cleared ${c.name === name ? 'your' : 'its'} role card`]))
    }
  }
  return lines.join('\n')
}

/**
 * Whether this delivery carries the topic reminder, or just what changed since the last one, and what
 * to remember afterwards. Pure; the daemon and `wait` share it. The reminder goes with the first
 * delivery a session gets from a topic (session = when the agent registered), and again after `every`
 * deliveries; in between only changes are listed. count is deliveries since the reminder, the
 * reminder itself being the first.
 */
export function reminderDue(prev, { session = null, roster, every = REMIND_EVERY }) {
  let remind = null
  if (!prev || (prev.session ?? null) !== session) remind = 'the first message from this topic in your session'
  else if (!prev.roster) remind = 'the reminder format changed'
  else if (!(prev.count < every)) remind = `${every} deliveries since the last reminder`
  // A reminder of a topic not read yet would say it has no description and no members: it waits, still due.
  if (remind && !rosterKnown(roster)) return { remind: null, changes: [], next: prev ?? null }
  const changes = remind ? [] : rosterChanges(prev.roster, roster)
  return { remind, changes, next: { session, roster: keptRoster(prev?.roster, roster), count: remind ? 1 : prev.count + 1 } }
}

/**
 * One topic's batch for one agent. terminal: it will be typed into a terminal (the daemon).
 * role: put role= into the commands it shows (the daemon does; a renewed session may have lost its binding).
 * again: the wait command to run next (wait only).
 */
export function renderDelivery({ room, messages, name, remind = null, changes = [], tasks = [], terminal = false, role = null, again = null, now = Date.now() }) {
  const roomId = room.roomId
  const n = messages.length
  const label = flat(room.roomName) || roomId
  const parts = [`Scorpio topic "${label}" (${roomId}): ${n} new message${n === 1 ? '' : 's'} for you.`]
  if (remind) parts.push(renderReminder({ room, name, reason: remind, terminal, role, now }))
  else if (changes.length) parts.push(renderChanges(changes, { roomId, name, members: room.members, terminal, role }))
  if (tasks.length) parts.push(['Your tasks changed:', ...tasks.map((t) => `- ${t}`)].join('\n'))
  for (const m of messages) parts.push(renderMessage(m, { roomId, terminal, role, name, items: room.items, members: room.members }))
  const markLine = `Mark them read first: scorpio mark topicId=${roomId}${roleArg(role)} upTo=${messages[n - 1].seq}`
  parts.push(again ? `${markLine}\nThen do the work (if any), and run wait again: ${again}` : `${markLine}\nThen do the work (if any).`)
  return parts.join('\n\n')
}

/** Keep-alive: no news, only a cheap touch of the model so the agent's prompt cache does not expire. */
export function renderKeepalive(room) {
  const label = flat(room?.roomName) || room?.roomId || ''
  return `Scorpio topic "${label}" (${room?.roomId ?? ''}): no new messages. Nothing new to do; carry on with what you were doing. No reply needed.`
}
