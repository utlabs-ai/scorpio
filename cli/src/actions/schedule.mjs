import { randomUUID } from 'node:crypto'
import { CliError, api, done, remember, roomCtx, roomPath, textArg } from '../client.mjs'

const RULE_KEYS = ['at', 'daily', 'weekly', 'every']
const OPS = ['show', 'edit', 'on', 'off', 'send', 'delete']
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const fileHint = 'A scheduled message takes no files: send the file into the topic first and write its #seq in the text.'

function scheduleId(value, key) {
  const match = /^[Ss]?(\d+)$/.exec(String(value ?? '').trim())
  if (!match) throw new CliError('bad_request', `${key}= takes a schedule id like S3 (or 3). List schedules: scorpio schedule topicId=<topic id>`)
  return `S${match[1]}`
}

function timeZone(value) {
  const tz = value || Intl.DateTimeFormat().resolvedOptions().timeZone
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { throw new CliError('bad_request', `tz= needs an IANA time zone, such as Asia/Shanghai.`) }
  return tz
}

function partsAt(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms)
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
}

const wallMs = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hour || 0, p.minute || 0, p.second || 0)
const calendarDay = (year, month, day) => {
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) throw new CliError('bad_request', 'at= has an invalid date.')
  return d
}
const clock = (value, key) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || '')
  if (!m) throw new CliError('bad_request', `${key}= needs HH:MM in 24-hour time.`)
  return { hour: Number(m[1]), minute: Number(m[2]) }
}

// Convert a wall time in an IANA zone. A repeated time chooses its first occurrence;
// a spring gap moves forward by that gap, like the server's daily/weekly rules.
function zonedMs(p, tz) {
  const wanted = wallMs(p)
  const offsets = new Set()
  for (let h = -24; h <= 24; h += 6) {
    const sample = wanted + h * 3_600_000
    offsets.add(wallMs(partsAt(sample, tz)) - sample)
  }
  const options = [...offsets].map((offset) => {
    const ms = wanted - offset
    return { ms, wall: wallMs(partsAt(ms, tz)) }
  })
  return (options.filter((o) => o.wall === wanted).sort((a, b) => a.ms - b.ms)[0]
    || options.filter((o) => o.wall > wanted).sort((a, b) => a.wall - b.wall || a.ms - b.ms)[0])?.ms
}

function atMs(value, tz, now = Date.now()) {
  const input = String(value ?? '').trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)$/.exec(input)
  if (m) {
    const p = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }
    calendarDay(p.year, p.month, p.day)
    return zonedMs(p, tz)
  }
  m = /^(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)$/.exec(input)
  if (m) {
    const year = partsAt(now, tz).year
    const p = { year, month: Number(m[1]), day: Number(m[2]), hour: Number(m[3]), minute: Number(m[4]) }
    for (let i = 0; i <= 8; i++) {
      p.year = year + i
      const day = new Date(Date.UTC(p.year, p.month - 1, p.day))
      if (day.getUTCFullYear() !== p.year || day.getUTCMonth() + 1 !== p.month || day.getUTCDate() !== p.day) continue
      const candidate = zonedMs(p, tz)
      if (candidate > now) return candidate
    }
    throw new CliError('bad_request', 'at= has an invalid month or day.')
  }
  if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(input)) {
    const p = { ...partsAt(now, tz), ...clock(input, 'at'), second: 0 }
    if (zonedMs(p, tz) <= now) {
      const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
      p.year = next.getUTCFullYear(); p.month = next.getUTCMonth() + 1; p.day = next.getUTCDate()
    }
    return zonedMs(p, tz)
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) {
    const ms = Date.parse(input)
    if (Number.isFinite(ms)) return ms
  }
  m = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(input)
  if (m) {
    const p = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] || 0) }
    calendarDay(p.year, p.month, p.day)
    return zonedMs(p, tz) + Number((m[7] || '').padEnd(3, '0'))
  }
  throw new CliError('bad_request', 'at= needs YYYY-MM-DD HH:MM, MM-DD HH:MM, HH:MM, or ISO 8601 with an offset.')
}

function ruleArg(args, { required = false, now = Date.now() } = {}) {
  const hasStep = args.step !== undefined || args.from !== undefined
  if (hasStep && args.daily === undefined && args.weekly === undefined) throw new CliError('bad_request', 'step= and from= go with daily= or weekly=')
  const keys = RULE_KEYS.filter((k) => args[k] !== undefined)
  if (keys.length > 1 || (required && keys.length !== 1)) throw new CliError('bad_request', 'Give exactly one of at=, daily=, weekly= or every=.')
  if (!keys.length) {
    if (args.tz !== undefined) throw new CliError('bad_request', 'tz= goes with at=, daily= or weekly=.')
    return null
  }
  const key = keys[0]
  if (key === 'every') {
    if (args.tz !== undefined) throw new CliError('bad_request', 'every= has no time zone; use daily= for a wall-clock time.')
    const m = /^([1-9]\d*)(m|h)$/.exec(args.every)
    if (!m) throw new CliError('bad_request', 'every= needs minutes or hours, for example 30m or 2h.')
    const minutes = Number(m[1]) * (m[2] === 'h' ? 60 : 1)
    if (minutes < 10) throw new CliError('schedule_too_frequent', 'At least every 10 minutes')
    if (!Number.isSafeInteger(minutes) || minutes > 10080) throw new CliError('bad_request', 'every= is at most one week; use weekly= for a longer interval.')
    return { rule: { kind: 'every', minutes } }
  }
  const extra = {}
  if (hasStep) {
    if (key !== 'daily' && key !== 'weekly') throw new CliError('bad_request', 'step= and from= go with daily= or weekly=')
    if (args.step !== undefined) {
      const step = Number(args.step)
      if (!/^\d+$/.test(args.step) || !Number.isInteger(step) || step < 1 || step > (key === 'daily' ? 365 : 52)) throw new CliError('bad_request', 'step= is out of range.')
      extra.step = step
    }
    if (args.from !== undefined) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.from)
      if (!match || !Number.isFinite(Date.parse(`${args.from}T00:00:00Z`)) || new Date(`${args.from}T00:00:00Z`).toISOString().slice(0, 10) !== args.from) throw new CliError('bad_request', 'from= needs a real YYYY-MM-DD date.')
      if (extra.step === 1 || (required && extra.step === undefined)) throw new CliError('bad_request', 'from= needs step 2 or more.')
      extra.from = args.from
    }
  }
  const tz = timeZone(args.tz)
  if (key === 'at') return { rule: { kind: 'once', at: atMs(args.at, tz, now) }, tz }
  if (key === 'daily') return { rule: { kind: 'daily', time: args.daily, tz, ...extra }, tz, ...clock(args.daily, 'daily') }
  const m = /^([a-z,]+)@(.+)$/.exec(args.weekly || '')
  if (!m) throw new CliError('bad_request', 'weekly= needs days and time, for example mon,thu@10:00.')
  clock(m[2], 'weekly')
  const days = m[1].split(',')
  if (days.length > 7 || new Set(days).size !== days.length || days.some((d) => !DAYS.includes(d))) throw new CliError('bad_request', 'weekly= days must be unique mon,tue,wed,thu,fri,sat,sun names.')
  return { rule: { kind: 'weekly', days: DAYS.filter((d) => days.includes(d)), time: m[2], tz, ...extra }, tz }
}

function nextIso(item, fallbackTz = null) {
  if (!item || item.nextAt == null) return null
  const tz = timeZone(item.rule?.tz || fallbackTz)
  const ms = Number(item.nextAt)
  if (!Number.isFinite(ms)) return null
  const p = partsAt(ms, tz)
  const milli = ((ms % 1000) + 1000) % 1000
  const offset = Math.round((wallMs(p) - (ms - milli)) / 60_000)
  const pad = (n) => String(n).padStart(2, '0')
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${milli ? `.${String(milli).padStart(3, '0')}` : ''}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function withNext(res, fallbackTz = null) {
  if (res?.item) res.item = { ...res.item, next: nextIso(res.item, fallbackTz) }
  if (Array.isArray(res?.items)) res.items = res.items.map((item) => ({ ...item, next: nextIso(item, fallbackTz) }))
  return res
}

function reviveArg(value) {
  if (value === undefined) return undefined
  if (value !== 'true' && value !== 'false') throw new CliError('bad_request', 'revive= takes true or false.')
  return value === 'true'
}

async function schedule(args) {
  const ctx = roomCtx(args)
  if (args.files !== undefined) throw new CliError('schedule_no_files', fileHint)
  const ops = OPS.filter((key) => args[key] !== undefined)
  if (ops.length > 1) throw new CliError('bad_request', 'Use one of show=, edit=, on=, off=, send= or delete= at a time.')
  const op = ops[0]
  const base = roomPath(ctx.roomId, '/schedules')
  const hasText = args.text !== undefined || args.textFile !== undefined
  let res, tz = null
  if (!op && !hasText && !RULE_KEYS.some((k) => args[k] !== undefined)) {
    if (args.step !== undefined || args.from !== undefined || args.tz !== undefined || args.revive !== undefined || args.nonce !== undefined) throw new CliError('bad_request', 'A schedule needs text= and one time rule; leave them all out to list.')
    res = await api('GET', base, { role: ctx.role })
  } else if (!op) {
    const parsed = ruleArg(args, { required: true })
    tz = parsed.tz
    const body = { op: 'add', text: textArg(args), rule: parsed.rule, nonce: args.nonce || randomUUID() }
    const revive = reviveArg(args.revive)
    if (revive !== undefined) body.revive = revive
    res = await api('POST', base, { role: ctx.role, body })
  } else if (op === 'show') {
    if (hasText || RULE_KEYS.some((k) => args[k] !== undefined) || args.step !== undefined || args.from !== undefined || args.tz !== undefined || args.revive !== undefined || args.nonce !== undefined) throw new CliError('bad_request', 'show= takes only a schedule id.')
    res = await api('GET', `${base}/${scheduleId(args.show, 'show')}`, { role: ctx.role })
  } else {
    const body = { op: op === 'off' && args.off === 'all' ? 'stop_all' : op }
    if (body.op !== 'stop_all') body.id = scheduleId(args[op], op)
    if (op === 'edit') {
      if (hasText) body.text = textArg(args)
      const parsed = ruleArg(args)
      if (parsed) { body.rule = parsed.rule; tz = parsed.tz }
      const revive = reviveArg(args.revive)
      if (revive !== undefined) body.revive = revive
      if (!Object.hasOwn(body, 'text') && !parsed && revive === undefined) throw new CliError('bad_request', 'edit= needs text=, one time rule or revive=.')
    } else if (hasText || RULE_KEYS.some((k) => args[k] !== undefined) || args.step !== undefined || args.from !== undefined || args.tz !== undefined || args.revive !== undefined) throw new CliError('bad_request', `${op}= takes only a schedule id.`)
    if (args.nonce !== undefined && !['send'].includes(op)) throw new CliError('bad_request', 'nonce= goes with create or send= only.')
    if (op === 'send') body.nonce = args.nonce || randomUUID()
    res = await api('POST', base, { role: ctx.role, body })
  }
  remember(ctx)
  return done(withNext(res, tz))
}

export { schedule, scheduleId, ruleArg, atMs, nextIso, withNext }
