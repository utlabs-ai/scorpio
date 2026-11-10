import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const context = { window: {} }
vm.runInNewContext(readFileSync(new URL('../../web/public/static/room-schedule-time.js', import.meta.url), 'utf8'), context)
const next = context.window.scheduleFormNext
const built = await build({ entryPoints: [new URL('../src/schedules.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { nextScheduleAt } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

test('form preview agrees with server for calendar beats, distant anchors and DST', () => {
  const old = process.env.TZ
  try {
    for (const tz of ['America/New_York', 'Asia/Shanghai', 'Europe/Berlin']) {
      process.env.TZ = tz
      for (const after of ['2026-03-08T05:00Z', '2026-03-08T07:00Z', '2026-11-01T04:00Z', '2026-11-01T05:40Z', '2026-10-21T12:00Z']) {
        for (const shape of [
          { kind: 'daily' },
          { kind: 'daily', step: 3, from: '2026-01-01' },
          { kind: 'daily', step: 365, from: '2029-01-01' },
          { kind: 'weekly', days: ['mon', 'thu'], step: 2, from: '2026-03-04' },
          { kind: 'weekly', days: ['sun'], step: 52, from: '2029-02-04' },
        ]) {
          for (const time of ['01:30', '02:30', '10:00']) {
            const rule = { ...shape, time, tz }
            assert.equal(next(rule, Date.parse(after)), nextScheduleAt(rule, Date.parse(after)), JSON.stringify({ rule, after }))
          }
        }
      }
    }
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old }
})

test('incomplete form has no first run; once and interval keep existing semantics', () => {
  assert.equal(next({ kind: 'weekly', days: [], time: '10:00' }, 1000), null)
  assert.equal(next({ kind: 'daily', time: '' }, 1000), null)
  assert.equal(next({ kind: 'once', at: 2000 }, 1000), 2000)
  assert.equal(next({ kind: 'every', minutes: 30 }, 1000), 1801000)
})


test('weekly First moves forward to an allowed weekday across calendar boundaries', () => {
  const first = context.window.scheduleFormWeekdayDate
  assert.equal(first('2026-10-21', ['mon', 'thu']), '2026-10-22')
  assert.equal(first('2026-10-22', ['mon']), '2026-10-26')
  assert.equal(first('2026-12-31', ['mon']), '2027-01-04')
  assert.equal(first('2028-02-28', ['tue']), '2028-02-29')
  assert.equal(first('2026-10-22', ['thu']), '2026-10-22')
  assert.equal(first('2026-10-21', []), '2026-10-21')
})
