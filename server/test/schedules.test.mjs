import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { parseSpawn } from '../../cli/src/daemon/commands.mjs'

const built = await build({ entryPoints: [new URL('../src/schedules.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { scheduleRule, nextScheduleAt, reviveCommand, scheduleRuleText } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const ms = (s) => Date.parse(s)

test('daily and weekly rules choose wall time across zones and daylight changes', () => {
  const sh = scheduleRule({ kind: 'daily', time: '10:00', tz: 'Asia/Shanghai' }, ms('2026-10-17T00:00:00Z'))
  assert.equal(nextScheduleAt(sh, ms('2026-10-17T00:00:00Z')), ms('2026-10-17T02:00:00Z'))
  const gap = scheduleRule({ kind: 'daily', time: '02:30', tz: 'America/New_York' }, ms('2026-03-08T00:00:00Z'))
  assert.equal(nextScheduleAt(gap, ms('2026-03-08T00:00:00Z')), ms('2026-03-08T07:30:00Z'))
  const repeated = scheduleRule({ kind: 'daily', time: '01:30', tz: 'America/New_York' }, ms('2026-11-01T00:00:00Z'))
  assert.equal(nextScheduleAt(repeated, ms('2026-11-01T00:00:00Z')), ms('2026-11-01T05:30:00Z'))
  assert.equal(nextScheduleAt(repeated, ms('2026-11-01T05:40:00Z')), ms('2026-11-02T06:30:00Z'))
  const weekly = scheduleRule({ kind: 'weekly', days: ['thu', 'mon', 'thu'], time: '10:00', tz: 'Asia/Shanghai' }, ms('2026-10-17T00:00:00Z'))
  assert.deepEqual(weekly.days, ['mon', 'thu'])
  assert.equal(nextScheduleAt(weekly, ms('2026-10-17T00:00:00Z')), ms('2026-10-19T02:00:00Z'))
})

test('every skips missed beats and once and invalid rules keep their codes', () => {
  const every = scheduleRule({ kind: 'every', minutes: 30 })
  assert.equal(nextScheduleAt(every, 1000), 1_801_000)
  assert.equal(nextScheduleAt(every, 1000 + 4 * 1_800_000, 1000), 1000 + 5 * 1_800_000)
  assert.throws(() => scheduleRule({ kind: 'every', minutes: 9 }), (e) => e.code === 'schedule_too_frequent')
  assert.throws(() => scheduleRule({ kind: 'once', at: 1 }, 1), (e) => e.code === 'schedule_in_past')
  assert.throws(() => scheduleRule({ kind: 'daily', time: '10:00', tz: 'Bad/Zone' }), (e) => e.code === 'bad_request')
})

test('revive replaces the takeover prompt, removes handoff=skip, and remains parseable by the CLI', () => {
  for (const command of [
    '@mbp-daemon@kai /spawn claude coach ~/run model=claude-opus-5-5 effort=high old prompt',
    '@mbp-daemon@kai /spawn claude coach cwd="/srv/My Project" model=claude-fable-5-1 handoff=skip go on',
    '@mbp-daemon@kai /spawn codex coach ～/w，旧提示',
    '@mbp-daemon@kai /spawn claude coach ~/项目 old prompt',
    '@mbp-daemon@kai /spawn claude coach ~/a,b old prompt',
    '@mbp-daemon@kai /spawn claude coach ~/x@y old prompt',
    '@mbp-daemon@kai /spawn claude coach /Users/kai/My-Notes(2) old prompt',
    '@mbp-daemon@kai /spawn claude coach ~ old prompt',
    '@mbp-daemon@kai /spawn claude coach cwd="/srv/A\\"B" effort=high old prompt',
    '@mbp-daemon@kai /spawn codex coach model=gpt-6-sol effort=xhigh old prompt',
  ]) {
    const got = reviveCommand(command, '@coach@kai do the task @kai')
    assert.equal(got.host, 'mbp-daemon@kai')
    assert.ok(!got.line.includes('handoff=skip'))
    const parsed = parseSpawn(got.line.replace(/^@\S+ \/spawn /, ''))
    assert.equal(parsed.name, 'coach')
    assert.equal(parsed.prompt, '@coach@kai do the task @kai')
  }
  assert.equal(reviveCommand('not a takeover', '@kai hi'), null)
  const noDir = reviveCommand('@mbp-daemon@kai /spawn codex coach model=gpt-6-sol old prompt', '@kai hi')
  assert.equal(parseSpawn(noDir.line.replace(/^@\S+ \/spawn /, '')).needDir, true)
})

test('calendar steps keep their anchor across missed runs, future starts and DST', () => {
  const daily = scheduleRule({ kind: 'daily', time: '09:00', tz: 'UTC', step: 3, from: '2026-10-01' })
  assert.equal(nextScheduleAt(daily, ms('2026-10-05T10:00Z')), ms('2026-10-07T09:00Z'))
  assert.equal(nextScheduleAt(daily, ms('2026-10-20T10:00Z')), ms('2026-10-22T09:00Z'))
  assert.equal(nextScheduleAt(daily, ms('2026-09-01T00:00Z')), ms('2026-10-01T09:00Z'))
  const weekly = scheduleRule({ kind: 'weekly', days: ['mon', 'thu'], time: '10:00', tz: 'UTC', step: 2, from: '2026-10-27' })
  assert.equal(nextScheduleAt(weekly, ms('2026-10-01T00:00Z')), ms('2026-10-29T10:00Z'))
  assert.equal(nextScheduleAt(weekly, ms('2026-10-29T11:00Z')), ms('2026-11-09T10:00Z'))
  const gap = scheduleRule({ kind: 'daily', time: '02:30', tz: 'America/New_York', step: 3, from: '2026-03-05' })
  assert.equal(nextScheduleAt(gap, ms('2026-03-08T00:00Z')), ms('2026-03-08T07:30Z'))
  assert.equal(nextScheduleAt(gap, ms('2026-03-08T08:00Z')), ms('2026-03-11T06:30Z'))
  const fall = scheduleRule({ kind: 'weekly', days: ['sun'], time: '01:30', tz: 'America/New_York', step: 2, from: '2026-10-19' })
  assert.equal(nextScheduleAt(fall, ms('2026-11-01T00:00Z')), ms('2026-11-08T06:30Z'))
  const repeated = { ...fall, from: '2026-10-26' }
  assert.equal(nextScheduleAt(repeated, ms('2026-11-01T00:00Z')), ms('2026-11-01T05:30Z'))
  assert.equal(nextScheduleAt(repeated, ms('2026-11-01T05:40Z')), ms('2026-11-15T06:30Z'))
})

test('step defaults to the soonest allowed run and edits preserve the same-kind cadence', () => {
  const now = ms('2026-10-21T10:00Z')
  const daily = scheduleRule({ kind: 'daily', time: '09:00', tz: 'UTC', step: 3 }, now)
  assert.equal(daily.from, '2026-10-22')
  const weekly = scheduleRule({ kind: 'weekly', days: ['mon'], time: '10:00', tz: 'UTC', step: 2 }, now)
  assert.equal(weekly.from, '2026-10-26')
  assert.deepEqual(scheduleRule({ kind: 'daily', time: '11:00', tz: 'UTC' }, now, daily), { ...daily, time: '11:00' })
  assert.deepEqual(scheduleRule({ kind: 'daily', time: '11:00', tz: 'UTC', step: 1 }, now, daily), { kind: 'daily', time: '11:00', tz: 'UTC' })
  const legacy = { kind: 'daily', time: '09:00', tz: 'UTC' }
  assert.deepEqual(scheduleRule({ ...legacy, step: 1 }, now), legacy)
  assert.equal(nextScheduleAt(legacy, now), nextScheduleAt(scheduleRule({ ...legacy, step: 1 }, now), now))
  assert.equal(scheduleRule({ kind: 'weekly', days: ['mon'], time: '10:00', tz: 'UTC' }, now, daily).step, undefined)
})

test('invalid step and from combinations are rejected', () => {
  const base = { kind: 'daily', time: '09:00', tz: 'UTC' }
  for (const rule of [
    { ...base, step: 0 }, { ...base, step: 366 }, { ...base, step: 1.5 }, { ...base, step: '3' },
    { ...base, from: '2026-10-21' }, { ...base, step: 1, from: '2026-10-21' },
    { ...base, step: 2, from: '2026-02-30' }, { ...base, step: 2, from: '2026-2-03' },
    { kind: 'weekly', days: ['mon'], time: '10:00', tz: 'UTC', step: 53 },
    { kind: 'once', at: Date.now() + 60_000, step: 2 }, { kind: 'every', minutes: 30, from: '2026-10-21' },
  ]) assert.throws(() => scheduleRule(rule), (e) => e.code === 'bad_request', JSON.stringify(rule))
  assert.equal(scheduleRule({ ...base, step: 365, from: '1970-01-01' }).from, '1970-01-01')
})


test('rule descriptions retain legacy wording and describe calendar intervals', () => {
  assert.equal(scheduleRuleText({ kind: 'daily', time: '09:00', tz: 'UTC' }), 'every day 09:00 (UTC)')
  assert.equal(scheduleRuleText({ kind: 'weekly', days: ['mon'], time: '10:00', tz: 'UTC' }), 'every mon 10:00 (UTC)')
  assert.equal(scheduleRuleText({ kind: 'daily', time: '09:00', tz: 'UTC', step: 3, from: '2026-10-21' }), 'every 3 days 09:00 (UTC)')
  assert.equal(scheduleRuleText({ kind: 'weekly', days: ['mon', 'thu'], time: '10:00', tz: 'UTC', step: 2, from: '2026-10-26' }, false), 'every 2 weeks mon,thu 10:00')
})
