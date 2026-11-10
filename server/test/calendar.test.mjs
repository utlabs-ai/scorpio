// The calendar feed's text (calendar.ts): run expansion and the iCalendar rules, and the fan-out that skips a failing topic (calendar-feed.ts).
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const load = async (file) => {
  const built = await build({ entryPoints: [new URL(`../src/${file}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}
const { calendarText, expandRuns, foldLine, icsText, icsDate, summaryOf, MAX_RUNS_PER_SCHEDULE, MAX_EVENTS } = await load('calendar.ts')
const { calendarTopics } = await load('calendar-feed.ts')

const NOW = Date.parse('2026-11-02T12:00:00Z')
const DAY = 86_400_000
const item = (over = {}) => ({ id: 'S1', text: '@kai Stand-up', rule: { kind: 'once', at: NOW + DAY }, by: 'coach@kai', updatedAt: NOW - 1000, nextAt: NOW + DAY, ...over })
const feed = (items, name = 'Launch') => calendarText([{ roomId: 'room1234567890abcdefgh', name, items }], { now: NOW, origin: 'https://scorpio.test', host: 'scorpio.test' })
const unfold = (text) => text.replace(/\r\n /g, '')
const events = (text) => unfold(text).split('BEGIN:VEVENT').slice(1)
const prop = (event, name) => { const m = new RegExp(`^${name}:(.*)$`, 'm').exec(event); return m ? m[1] : null }

test('once: its moment when ahead, nothing when past', () => {
  assert.deepEqual(expandRuns({ kind: 'once', at: NOW + 1 }, NOW + 1, NOW), [NOW + 1])
  assert.deepEqual(expandRuns({ kind: 'once', at: NOW }, NOW, NOW), [])
})

test('daily and weekly: every run in the next 60 days, from the stored next run; every: 24 hours on its own beat', () => {
  const daily = { kind: 'daily', time: '09:00', tz: 'UTC' }
  const runs = expandRuns(daily, Date.parse('2026-11-03T09:00:00Z'), NOW)
  assert.equal(runs.length, 60)
  assert.equal(runs[0], Date.parse('2026-11-03T09:00:00Z'))
  assert.equal(runs.at(-1), Date.parse('2027-01-01T09:00:00Z'))
  // a stale stored next (the alarm has not fired yet) is replaced by the first run after now
  assert.equal(expandRuns(daily, NOW - DAY, NOW)[0], Date.parse('2026-11-03T09:00:00Z'))
  const weekly = { kind: 'weekly', days: ['mon', 'thu'], time: '18:00', tz: 'Asia/Shanghai' }
  const wk = expandRuns(weekly, null, NOW)
  assert.equal(wk.length, 17)
  assert.ok(wk.every((t, i) => i === 0 || t > wk[i - 1]))
  assert.ok(wk.at(-1) <= NOW + 60 * DAY)
  const every = { kind: 'every', minutes: 10 }
  const beats = expandRuns(every, NOW + 5 * 60_000, NOW)
  assert.equal(beats.length, 144)
  assert.equal(beats[0], NOW + 5 * 60_000)
  assert.equal(beats[1] - beats[0], 600_000)
  assert.ok(beats.at(-1) <= NOW + DAY)
  // an `every` whose stored next lies in the past keeps its beat: the first run after now on that grid
  assert.equal(expandRuns(every, NOW - 25 * 60_000, NOW)[0], NOW + 5 * 60_000)
  assert.equal(expandRuns({ kind: 'daily', time: '09:00', tz: 'UTC', step: 1 }, null, NOW).length, 60)
})

test('caps: 200 runs per schedule, 2,000 events per feed', () => {
  assert.equal(expandRuns({ kind: 'daily', time: '09:00', tz: 'UTC' }, null, NOW).length, 60)
  assert.equal(MAX_RUNS_PER_SCHEDULE, 200)
  const many = Array.from({ length: 15 }, (_, i) => item({ id: `S${i + 1}`, rule: { kind: 'every', minutes: 10 }, nextAt: NOW + 60_000 }))
  assert.equal(events(feed(many)).length, MAX_EVENTS)
})

test('text values escape backslash, semicolon, comma and line breaks; lines fold at 75 octets without splitting a character', () => {
  assert.equal(icsText('a\\b;c,d\ne\r\nf'), 'a\\\\b\\;c\\,d\\ne\\nf')
  const zh = 'SUMMARY:' + '日历订阅长标题'.repeat(12)
  const folded = foldLine(zh)
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `${Buffer.byteLength(line, 'utf8')} octets`)
  assert.equal(folded.split('\r\n').slice(1).every((l) => l.startsWith(' ')), true)
  assert.equal(folded.replace(/\r\n /g, ''), zh)
  assert.equal(foldLine('x'.repeat(75)), 'x'.repeat(75))
  assert.equal(foldLine('x'.repeat(76)), 'x'.repeat(75) + '\r\n x')
  assert.equal(icsDate(Date.parse('2026-11-02T09:05:00Z')), '20261102T090500Z')
})

test('the title: first line without the leading @ names, 120 characters at most, the topic name when nothing is left', () => {
  assert.equal(summaryOf('@kai @coach@kai, Review the plan\nmore', 'Launch'), 'Review the plan')
  assert.equal(summaryOf('@kai，到点开会', 'Launch'), '到点开会')
  assert.equal(summaryOf('@kai @ana', 'Launch'), 'Launch')
  assert.equal(summaryOf('  \n@kai second line first', 'Launch'), 'second line first')
  assert.equal([...summaryOf('@kai ' + '字'.repeat(130), 'Launch')].length, 120)
})

test('the feed: header, one event per run in UTC with 15 minutes, a stable UID, the description and the alarm, CRLF line ends', () => {
  const text = feed([item({ text: '@kai Stand-up, 9 sharp\nBring the numbers; all of them', updatedAt: Date.parse('2026-11-01T08:00:00Z') })])
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Scorpio//Calendar//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:Scorpio\r\nREFRESH-INTERVAL;VALUE=DURATION:PT15M\r\nX-PUBLISHED-TTL:PT15M\r\n'))
  assert.ok(text.endsWith('END:VCALENDAR\r\n'))
  assert.equal(text.split('\r\n').length - 1, text.split('\n').length - 1) // every line break is CRLF
  const [ev] = events(text)
  assert.equal(prop(ev, 'UID'), `room1234567890abcdefgh-S1-${NOW + DAY}@scorpio.test`)
  assert.equal(prop(ev, 'DTSTART'), '20261103T120000Z')
  assert.equal(prop(ev, 'DURATION'), 'PT15M')
  assert.equal(prop(ev, 'DTSTAMP'), '20261102T120000Z')
  assert.equal(prop(ev, 'LAST-MODIFIED'), '20261101T080000Z')
  assert.equal(prop(ev, 'SEQUENCE'), String(Math.floor(Date.parse('2026-11-01T08:00:00Z') / 1000)))
  assert.equal(prop(ev, 'SUMMARY'), 'Stand-up\\, 9 sharp')
  assert.equal(prop(ev, 'DESCRIPTION'), '@kai Stand-up\\, 9 sharp\\nBring the numbers\\; all of them\\n\\nLaunch\\nhttps://scorpio.test/r/room1234567890abcdefgh\\nSet by coach@kai')
  assert.equal(prop(ev, 'URL'), 'https://scorpio.test/r/room1234567890abcdefgh')
  assert.match(ev, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:PT0S\r\nDESCRIPTION:Stand-up\\, 9 sharp\r\nEND:VALARM/)
  // the same schedule fetched a minute later: the same UIDs, so the calendar replaces its events in place
  const later = calendarText([{ roomId: 'room1234567890abcdefgh', name: 'Launch', items: [item()] }], { now: NOW + 60_000, origin: 'https://scorpio.test', host: 'scorpio.test' })
  assert.equal(prop(events(later)[0], 'UID'), prop(events(feed([item()]))[0], 'UID'))
  assert.equal(events(feed([])).length, 0)
})

test('the fan-out asks every topic the person has not left, skips an archived one and one that fails, and keeps the rest', async () => {
  const rows = [
    { id: 'r-ok', name: 'A', owned: 1, active: 1, archived_at: null },
    { id: 'r-left', name: 'B', owned: 0, active: 0, archived_at: null },
    { id: 'r-archived', name: 'C', owned: 0, active: 1, archived_at: 1 },
    { id: 'r-fail', name: 'D', owned: 0, active: 1, archived_at: null },
    { id: 'r-empty', name: 'E', owned: 0, active: 1, archived_at: null },
    { id: 'r-notmember', name: 'F', owned: 0, active: 1, archived_at: null },
  ]
  const asked = []
  const env = {
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) },
    ROOMS: { getByName: (id) => ({ async calendarItems(handle) {
      asked.push([id, handle])
      if (id === 'r-fail') throw new Error('object unavailable')
      if (id === 'r-notmember') return { err: { code: 'not_member' } }
      return { ok: { roomId: id, name: id, items: id === 'r-empty' ? [] : [item()] } }
    } }) },
  }
  const errors = []
  const original = console.error
  console.error = (line) => errors.push(line)
  try {
    const topics = await calendarTopics(env, { id: 'u1', handle: 'kai' })
    assert.deepEqual(topics.map((t) => t.roomId), ['r-ok'])
    assert.deepEqual(asked.map(([id]) => id).sort(), ['r-empty', 'r-fail', 'r-notmember', 'r-ok'])
    assert.ok(asked.every(([, handle]) => handle === 'kai'))
    assert.equal(errors.length, 1)
    assert.match(errors[0], /r-fail/)
  } finally { console.error = original }
})
