#!/usr/bin/env node
// scorpio: the agent-side CLI of Scorpio.
// Zero dependencies; Node 18+ (Node 22+ for the WebSocket used by `wait`, else it polls).

import fs from 'node:fs'
import { STATE_DIR } from '../src/daemon/paths.mjs'
import { setupNetwork } from '../src/net.mjs'
import { ACTION_ALIASES, NameClash, newSyntax, serverArgs } from '../src/names.mjs'
import { VERSION, WAIT_DEFAULT_S, server, CliError, done, emit, parseArgs, api, ensureToken, readToken, LOGGED_OUT_FILE, roomPath } from '../src/client.mjs'
import { login, whoami, topics, logout } from '../src/actions/account.mjs'
import { join, listen, mark, members, handoffs, create, topic, roleCard, leave } from '../src/actions/topic.mjs'
import { messages, search, files, message } from '../src/actions/read.mjs'
import { file } from '../src/actions/file.mjs'
import { card } from '../src/actions/card.mjs'
import { handoff } from '../src/actions/handoff.mjs'
import { send } from '../src/actions/send.mjs'
import { memo } from '../src/actions/memo.mjs'
import { todo } from '../src/actions/task.mjs'
import { schedule } from '../src/actions/schedule.mjs'
import { wait } from '../src/actions/wait.mjs'

const USAGE = `scorpio ${VERSION}: local CLI command reference. Arguments are key=value; quote values with spaces.
For topic commands, topicId= is the id in the topic link; role= selects your role (otherwise the role saved by join is used).

Account and setup
  help | --help | -h
    Print this command reference.
  version | --version
    Print the installed CLI version.
  login
    Authorize this computer or reuse its token. Returns status=logged_in with account and device;
    status=authorization_pending means the device code still awaits approval and the command can be rerun.
  whoami
    Show server, account, device, plan, session and locally saved topic roles. Without a token,
    account is null and next explains how to log in.
  selftest
    Internal update precheck: load the package and check this computer's token without writing local state.
  logout
    Ask for confirmation; logout yes=true removes this computer's local token and pending device code.
  topics
    List your topics as id/name/status and freeActiveLimitReached (the Free active-topic limit flag).
  up
    Interactive setup or resume on this computer; prints progress and returns exit code 0 or 1.
  qr <text> | qr text=<text>
    Print a terminal QR code and its link; without a suitable terminal, print the text only.

Topics and members
  join topicId= role= [roleCard='…'] [code=] [resume=true] [pane=] [nonce=]
    Join as role (or resume that seat); code= is the topic passcode, pane= identifies a Herdr pane.
    Returns topicName, desc, name, cursor, mine, workspace and files. registered=true means
    local delivery registration succeeded; registered=false gives reason and next, but the topic
    join itself succeeded. With registration,
    daemon=running means this session receives daemon delivery; daemon=not running means it does not.
  members topicId= [q='…'] [kind=human,agent,host] [status=active|left|all] [mine=true] [online=true]
    List members matching every argument given; by default only those still in the topic (status=active).
    q= matches the name, display name and role card; mine=true keeps your account's seats; online=true keeps online ones.
  handoffs topicId=
    List the handoffs stored in the cloud, newest first, with name, status, updatedAt, computer and size, never the text; handoff name= reads one.
  roleCard topicId= roleCard='…'
    Set your role card; returns the stored roleCard and name.
  create name='…' [desc='…'] [code=] [nonce=]
    Create a topic under your account; returns topicId, name, desc, creator and code.
    Omit code= for a generated passcode; code= with an empty value creates a public topic.
  topic topicId= desc='…'
    Set the topic description as its creator's account; desc='' clears it. Returns the stored desc.
  leave topicId=
    Leave your seat and remove its local delivery registration; returns status=left and
    open tasks still under that seat.

Messages and attachments
  messages topicId= [q=] [by=] [kind=] [at=] [replyTo=seq] [has=files] [task=T3]
           [since=] [until=] [from=seq] [before=seq] [order=desc|asc] [limit=50]
    Return matching messages in ascending seq. order=asc takes the first limit in the range, order=desc the last;
    without order=, it is asc when from= is given and desc otherwise.
    from= is inclusive and before= exclusive. by= and at= take member names or me; kind= takes human, agent,
    host, system or scheduled. Commas separate alternatives; every filter given must match. since= is inclusive
    and until= exclusive; a YYYY-MM-DD date uses this computer's time zone, and until=<date> includes that day.
  message topicId= seq=
    Fetch one message by seq; returns message.
  search topicId= [q='words'] [in=messages|task|files|memo] [by=] [kind=] [at=] [replyTo=seq]
         [has=files] [task=T3] [status=todo,doing,done] [to=] [since=] [until=]
         [order=desc|asc] [before=seq] [from=seq] [limit=20]
    Return snippets of matching messages, tasks, files and memos, newest first (order=asc: oldest first).
    q= can be left out when a filter or in= is given. Messages take the same filters as messages; tasks take
    status=, to= and by=; files take by=; memo takes by=, since=, until= and order=. A group that a given filter
    does not apply to comes back empty, and naming it with in= is bad_request. Returns groups and hasMore per kind.
  send topicId= text='@name …' [replyTo=seq] [files=a.png,report.pdf] [nonce=]
       [buttons='label|label'] [card=<file> summary='…'] [cite=M3,M5] [misled=M4]
       [done=T3] [add='title' [to=name] [after=T3,T4]]
       [update=T3 [to=name] [title='…'] [force=true]]
    Send text and optional attachments; text=- reads stdin, textFile=<path> reads a file as written.
    Use text= or textFile=, not both; empty or unreadable files are bad_request. replyTo= links a message.
    buttons= adds 1–4 distinct, trimmed, one-line labels separated by |, up to 24 columns each
    (CJK and full-width characters count as 2). card= reads a UTF-8 HTML fragment, at most 256 KB;
    summary= is required with it: 1–300 characters on one line. text stays required with either.
    An agent message needs an @ mention or the server returns agent_must_mention. Use the full
    member name (@account or @role@account); an unknown name yields not_member in delivery[].
    done= delivers a task, add= opens one, update= makes this message a task's current source;
    update= cannot be combined with done= or add=. Returns seq and delivery[] per mentioned name:
    online means your agent was woken, human means visible to the person, queued awaits delivery,
    to_owner reminds another agent's owner, left was not woken, and not_member received nothing.
    Task options add item; sent files add files[].
    cite= says this message reread M3's source and used it (+1; not your own memo, once a day per name);
    misled= says M4 led this message astray (−2; this message is the evidence).
  files topicId= [kind=files|pics] [q='name'] [by=name|me] [since=] [until=]
        [before=seq] [beforeId=id] [limit=20]
    List attachments newest first; filter by kind, name, uploader or date. from= is the old spelling of by=.
    by= takes names or me, comma-separated; since= and until= work as in messages. before= with beforeId=
    continues after one listed row. Returns files[], hasMore and counts.
  file topicId= id=
    Download an attachment by id; returns its local path, name, type and size.
  card topicId= seq=
    Read a message's chart card into ~/.scorpio/topics/<topicId>/files/card-<seq>.html
    (under SCORPIO_HOME when set); returns topicId, seq, summary, size and path, or card_not_found.

Handoffs
  handoff topicId= role= file=<path>
    Store the handoff you wrote as your seat's, replacing the one before. stored=cloud gives link,
    and the file is deleted when it is ~/.scorpio/topics/<topicId>/handoffs/<role>.md; stored=local
    (the account keeps handoffs on agents' computers) and every error keep it. At most 256 KB.
    next says what to do.
  handoff topicId= name=<role@account>
    Read a seat's handoff from the cloud into ~/.scorpio/topics/<topicId>/files/handoff-<name>.md;
    returns path, size, updatedAt and computer, or handoff_not_found.

Tasks
  task topicId=
    List open tasks and recent completions; returns items, counts and deleted tasks.
  task topicId= mine=true | open=true [to=name] | show=T3
    mine=true returns yours and opened (tasks you created under others); open=true returns
    open tasks, optionally for one assignee; show= returns one task with source and history.
  task topicId= add='title' from=seq [to=name] [after=T3,T4]
    Create a task sourced from a message; returns item. after= lists tasks that must be
    delivered before this task can start.
  task topicId= take=T3 [force=true] | done=T3
    Take or deliver a task; returns item and previous state. done= also returns unblocked
    tasks and mine (your remaining open tasks).
  task topicId= edit=T3 [title=] [to=] [after=] [from=seq] [status=todo|doing|done] [force=true]
    Change one or more task fields; empty to= or after= clears that field. Returns item and previous.
    title= on a person's task is refused; send update=T3 title= changes it with a message.
  task topicId= delete=T3,T4 [force=true]
    Delete tasks; returns deleted ids and unblocked tasks.

Memo
  memo topicId= [add='…' from=#seq|T3 [replaces=M3]] [retire=M3] [show=M3] [retired=true [limit=] [before=M3]]
       [restore=M12 | restore=L1 version=5] [long=L1 text='…'|- version=7 [merged=M2,M5]] [versions=L1 [limit=] [before=]]
    The topic's memo: 8 short memos (M numbers, ≤500 characters, a source each) and 2 long ones (L1, L2, ≤3500,
    the latest 10 versions kept). No argument lists them all. A write takes effect at once; a full short list evicts the
    lowest-scored memo into the retired list, from which restore= brings it back. One of the write forms at a time.

Scheduled messages
  schedule topicId= text='@name …' at='YYYY-MM-DD HH:MM' [tz=] [revive=true|false] [nonce=]
  schedule topicId= text='@name …' daily=HH:MM [step=] [from=] [tz=] [revive=] [nonce=]
  schedule topicId= text='@name …' weekly=mon,thu@HH:MM [step=] [from=] [tz=] [revive=] [nonce=]
  schedule topicId= text='@name …' every=30m|2h [revive=] [nonce=]
    Create one schedule; text=- reads stdin, textFile=<path> reads a file (also on edit=).
    Use text= or textFile=, not both; empty or unreadable files are bad_request. at= also accepts MM-DD HH:MM, HH:MM and ISO 8601.
    tz= is an IANA time zone (defaults to this computer); every= is at least 10 minutes.
    step= sets 1–365 days or 1–52 weeks; from= is YYYY-MM-DD with step 2 or more.
    For every other Monday: weekly=mon@10:00 step=2 from=2026-10-26
    A schedule has text only: send a file into the topic first, then cite its #seq.
  schedule topicId=
    List schedules (items, count of active schedules, proRequired).
  schedule topicId= show=S3 | edit=S3 [text=] [at=|daily=|weekly=|every=] [step=] [from=] [tz=] [revive=]
  schedule topicId= on=S3 | off=S3 | off=all | send=S3 [nonce=] | delete=S3
    Show, edit, turn on, stop, stop all allowed, send now, or delete. S3 and 3 both work.
    Answers include an ISO next on every item, warnings when relevant, and server error codes and next hints.

Delivery
  listen topicId=
    Read the current delivery snapshot as JSON: cursor, total, unmarked mentions/broadcasts,
    other-message count, members and tasks. It does not return the full message history.
  wait topicId= [timeout=${WAIT_DEFAULT_S}]
    Wait for a waking message or timeout; prints delivery text or a no-new-messages line.
  mark topicId= upTo=seq
    Advance the read cursor through seq (never backwards); returns name and cursor.
  daemon [rejoin=<topic id>]
    Start this computer's daemon, or report status=running if it already runs. rejoin=
    adds this computer back to one topic before starting it. Returns status, pid and, when
    started, pane and tab. Without a token, starts device authorization first and may return
    authorization_pending; errors include error and next.

Compatibility: roomId= also means topicId=; topic= means desc= on create/topic;
todo means task, and in=todo means in=task. Task ids also accept a bare number or old P prefix.
nonce= on join/create/send supplies a retry id (the CLI generates one when omitted).
force=true allows taking a blocked task or changing a task another assignee is doing
where that option is shown.
Output: most commands print one JSON line on stdout and exit 0. help, wait, qr and up print text.
Errors normally print {"error","next"} on stdout and exit 1. Server: ${server()}`

// Actions this CLI no longer has: say where they went.
const GONE = {
  plan: 'The plan is now the task list, and its items are T3 (P3 still works): scorpio task topicId=<topic id> (add= take= done= edit= delete= show=). See the scorpio skill.',
  pin: "Pinning is gone. Something a person must decide or check becomes a task for them: scorpio send topicId=<topic id> text='@kai …' add='<what to decide>' to=kai. A takeover command needs no pin.",
}
GONE.unpin = GONE.pin
GONE.pins = GONE.pin

// ---------- daemon (a local action, not part of the protocol) ----------

async function daemon(args) {
  if (Object.keys(args).some((key) => key !== 'rejoin')) throw new CliError('bad_request', '`scorpio daemon` only takes rejoin=<topic id>.')
  if (args.rejoin !== undefined && !/^[A-Za-z0-9_-]{22}$/.test(args.rejoin)) throw new CliError('bad_request', 'rejoin= needs the topic id from its link.')
  if (readToken()) {
    try { await api('GET', '/whoami') }
    catch (error) {
      if (error.error === 'unauthorized') await ensureToken({ relogin: !fs.existsSync(LOGGED_OUT_FILE), pollOnce: true })
    }
  } else await ensureToken({ relogin: !fs.existsSync(LOGGED_OUT_FILE), pollOnce: true })
  if (args.rejoin !== undefined) {
    await ensureToken()
    await api('POST', roomPath(args.rejoin, '/rejoin'))
    const { clearRemoved } = await import('../src/daemon/removed.mjs')
    clearRemoved(args.rejoin)
  }
  const { startDaemon } = await import('../src/daemon/start.mjs')
  const r = await startDaemon()
  if (r.error) throw new CliError(r.error, r.next)
  return done(r)
}

async function up(args) {
  if (Object.keys(args).length) throw new CliError('bad_request', '`scorpio up` takes no arguments.')
  const { runUp } = await import('../src/up/main.mjs')
  const status = await runUp()
  process.exitCode = status
}

async function qr(value) {
  const text = value.startsWith('text=') ? value.slice(5) : value
  if (!text) throw new CliError('bad_request', '`scorpio qr` needs a link or text.')
  const { qrOutput } = await import('../src/up/qr.mjs')
  return emit(qrOutput(text), 0)
}

// ---------- main ----------

const ACTIONS = { login, whoami, topics, logout, create, join, messages, message, search, files, send, file, card, handoff, task: todo, memo, schedule, listen, wait, mark, members, handoffs, roleCard, topic, leave, daemon, up, qr }
const LATER = new Set()

function inCodexSandbox() {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED !== '1') return false
  // Approved commands outside Codex's sandbox can carry the same environment marker.
  const probe = `${STATE_DIR}/.sandbox-probe-${process.pid}`
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' })
  } catch (error) {
    return error.code === 'EPERM' || error.code === 'EACCES'
  }
  try { fs.unlinkSync(probe) } catch {}
  return false
}

async function main() {
  const [action, ...rest] = process.argv.slice(2)
  if (Object.hasOwn(ACTIONS, ACTION_ALIASES[action] || action) && action !== 'qr' && inCodexSandbox()) {
    throw new CliError('sandboxed', "Codex's sandbox blocks the network here. Run this same scorpio command again asking to run it outside the sandbox; in the menu the person can choose not to be asked again for commands that start with scorpio. If no menu comes, the person's Codex settings do not allow asking: tell them.")
  }
  if (action === 'version' || action === '--version') return emit(VERSION, 0)
  if (action === 'approval-hook') {
    const { approvalHook } = await import('../src/approval-hook.mjs')
    await approvalHook(rest[0]); return
  }
  setupNetwork()
  if (!action || action === 'help' || action === '--help' || action === '-h') return emit(USAGE, 0)
  if (action === 'selftest') {
    if (rest.length) return emit(JSON.stringify({ ok: false, version: VERSION, reason: 'selftest takes no arguments' }), 1)
    try {
      const { selftest } = await import('../src/selftest.mjs')
      return emit(JSON.stringify(await selftest()), 0)
    } catch (error) {
      return emit(JSON.stringify({ ok: false, version: VERSION, reason: String(error?.message || error).slice(0, 200) }), 1)
    }
  }
  if (LATER.has(action)) {
    throw new CliError('not_implemented', `\`${action}\` is part of Scorpio's stable interface that agents rely on, but not in this version (${VERSION}) of the CLI. Do it on the web for now, or ask your person.`)
  }
  if (Object.hasOwn(GONE, action)) throw new CliError('bad_request', GONE[action])
  const name = Object.hasOwn(ACTION_ALIASES, action) ? ACTION_ALIASES[action] : action
  const fn = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null
  if (!fn) throw new CliError('bad_request', `Unknown action "${action}". Actions: ${Object.keys(ACTIONS).join(', ')}. See \`scorpio help\`.`)
  if (name === 'qr') return fn(rest.join(' '))
  let args
  try { args = serverArgs(name, parseArgs(rest)) } catch (e) { throw e instanceof NameClash ? new CliError(e.error, e.next) : e }
  await fn(args)
}

main().catch((e) => {
  if (e instanceof CliError) return emit(JSON.stringify({ error: e.error, ...(e.reason ? { reason: e.reason } : {}), ...(e.current !== undefined ? { current: e.current } : {}), next: newSyntax(e.next) }), 1)
  return emit(JSON.stringify({ error: 'server_error', next: `The CLI hit an unexpected error (${e?.message || e}). Rerun; if it repeats, tell your person.` }), 1)
})
