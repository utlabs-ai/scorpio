import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  ACCOUNTS_SQL, ACTIVITY_INSERT_SQL, ACTIVITY_SQL, DAEMON_VERSIONS_SQL, DAY_MS, PAYMENTS_SQL, PRO_DAILY_SQL, PRO_SNAPSHOT_SQL, RECENT_ROLLBACKS_SQL, ROOM_ACTIVITY_SQL,
  activeSeries, creemFee, dayLabel, dayOf, lastDays, planLabel, proNow, proSeries, proSource, signupSeries,
} from '../src/ops-data.ts'
import { ITEMS, billingPeriod, estimate, parseUsage } from '../src/cf-usage.ts'
import { worker } from './helpers/worker.mjs'

const at = (s) => Date.parse(s.length === 10 ? `${s}T12:00:00Z` : s)

function migrated(before) {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (f.startsWith('0018')) before?.(db)
    db.exec(fs.readFileSync(new URL(f, dir), 'utf8'))
  }
  return db
}

function seed(db) {
  const user = db.prepare('INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES (?, ?, ?, ?, ?)')
  user.run('ut', 'zoe', 'ut@x', at('2026-10-04T08:00:00Z'), 0)
  user.run('a', 'ana', 'a@x', at('2026-10-04'), 0)
  user.run('j', 'jude', 'j@x', at('2026-10-04'), 0)
  user.run('m', 'mark', 'm@x', at('2026-10-08'), 0)
  user.run('t', 'impltest2', 't@x', at('2026-10-04'), 1)
  const ent = db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES (?, 'pro', 'active', ?, ?, ?)")
  ent.run('ut', null, 'comp', at('2026-10-06T03:41:34Z'))
  for (const id of ['a', 'j', 'm']) ent.run(id, at('2026-10-15T10:37:17Z'), 'trial', at('2026-10-08T10:37:17Z'))
  ent.run('t', at('2026-11-09T02:34:13Z'), 'creem', at('2026-10-09T02:34:13Z'))
}

test('ops counts only versions and rollback reports from the last 7 days', () => {
  const db = migrated()
  seed(db)
  const now = Date.now()
  const add = db.prepare('INSERT INTO devices (user_id, device_id, device_name, created_at, daemon_version, daemon_joined_at, rollback_bad_version, rollback_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  add.run('ut', 'one', 'One', now, '0.15.40', now - DAY_MS, '0.15.38', now - DAY_MS)
  add.run('a', 'two', 'Two', now, '0.15.40', now - 2 * DAY_MS, null, null)
  add.run('j', 'three', 'Three', now, '0.15.37', now - 8 * DAY_MS, '0.15.36', now - 8 * DAY_MS)
  assert.deepEqual(db.prepare(DAEMON_VERSIONS_SQL).all(now - 7 * DAY_MS).map((r) => ({ ...r })), [{ version: '0.15.40', computers: 2 }])
  assert.deepEqual(db.prepare(RECENT_ROLLBACKS_SQL).all(now - 7 * DAY_MS).map((r) => r.computer), ['One'])
  db.close()
})

test('ops page shows the host-join version and rollback as reports', async () => {
  const w = await worker()
  try {
    const ops = await w.person('ops')
    const topic = await w.topic(ops)
    const response = await ops.api(`/rooms/${topic}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-scorpio-cli': '0.15.40' },
      body: JSON.stringify({ host: true, resume: true, rollback: { bad: { version: '0.15.38', build: 'a'.repeat(64) }, at: Date.now() } }),
    })
    assert.equal(response.status, 200, await response.text().catch(() => ''))
    const page = await ops.web('/admin')
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /Versions reported in the last 7 days/)
    assert.match(html, /Computers rolled back in the last 7 days/)
    assert.match(html, /0\.15\.40/)
    assert.match(html, /0\.15\.38/)
  } finally { await w.dispose() }
})

test('migration 0018 applies on top of the others and fills Pro per day from the grants, real accounts only', () => {
  const db = migrated(seed)
  const pro = Object.fromEntries(db.prepare(PRO_DAILY_SQL).all().map((r) => [r.day, [r.paid, r.trial, r.comp]]))
  assert.deepEqual(pro['2026-10-03'], [0, 0, 0])
  assert.deepEqual(pro['2026-10-05'], [0, 0, 0])
  assert.deepEqual(pro['2026-10-06'], [0, 0, 1])
  assert.deepEqual(pro['2026-10-08'], [0, 3, 1]) // the trials started at 10:37 that day: counted at the day's end
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE activity_backfilled_at IS NULL").get().n, 0)
  db.close()
})

test('accounts, activity and the daily Pro snapshot leave test accounts out', () => {
  const db = migrated()
  seed(db)
  const ins = db.prepare(ACTIVITY_INSERT_SQL)
  ins.run('2026-10-09', 'human', 'zoe')
  ins.run('2026-10-09', 'human', 'zoe') // the same day again: one row
  ins.run('2026-10-09', 'agent', 'zoe')
  ins.run('2026-10-01', 'human', 'jude')
  ins.run('2026-10-07', 'agent', 'jude')
  ins.run('2026-10-09', 'human', 'impltest2')
  ins.run('2026-10-09', 'human', 'nobody') // no such account: nothing
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity_daily').get().n, 5)

  const rows = db.prepare(ACCOUNTS_SQL).all()
  assert.deepEqual(rows.map((r) => r.handle), ['zoe', 'ana', 'jude', 'mark'])
  const ut = rows[0], jude = rows[2]
  assert.equal(ut.last_human, '2026-10-09')
  assert.equal(ut.last_agent, '2026-10-09')
  assert.equal(jude.last_human, '2026-10-01')
  assert.equal(jude.last_agent, '2026-10-07')
  assert.equal(rows[1].last_human, null)

  const now = at('2026-10-09T10:00:00Z')
  assert.deepEqual(proNow(rows, now), { paid: 0, trial: 3, comp: 1, invite: 0 })
  assert.equal(planLabel(ut, 'zh', now).label, 'Pro（赠送）')
  // Days given for invites: a source of their own, not paid.
  const invited = { ...rows[1], provider: 'invite', period_end: at('2026-10-20') }
  assert.equal(proSource(invited, now), 'invite')
  assert.deepEqual(proNow([invited], now), { paid: 0, trial: 0, comp: 0, invite: 1 })
  assert.equal(planLabel(invited, 'zh', now).label, '邀请送的 Pro，到 2026-10-20')
  assert.equal(planLabel(rows[1], 'zh', now).label, '试用到 2026-10-15')
  assert.equal(planLabel(rows[1], 'zh', at('2026-10-16')).label, '免费')

  const activity = db.prepare(ACTIVITY_SQL).all('2026-09-01')
  assert.equal(activity.length, 4) // impltest2 is a test account
  const days = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']
  const series = activeSeries(activity, days)
  assert.deepEqual(series.human, [1, 1, 0, 1]) // jude's 10-01 is in the windows ending 10-06 and 10-07 only
  assert.deepEqual(series.agent, [0, 1, 1, 2])

  db.prepare(PRO_SNAPSHOT_SQL).run('2026-10-16', at('2026-10-16'))
  assert.deepEqual({ ...db.prepare("SELECT paid, trial, comp FROM pro_daily WHERE day = '2026-10-16'").get() }, { paid: 0, trial: 0, comp: 1 })
  db.close()
})

test('a room reads its senders per day: agents count for their owner, daemons and system lines do not', () => {
  const db = new DatabaseSync(':memory:')
  // The room's own columns, kind (text / system …) included: the query must not group by it.
  db.exec("CREATE TABLE messages (seq INTEGER PRIMARY KEY, from_name TEXT NOT NULL, from_kind TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL)")
  const put = db.prepare('INSERT INTO messages (from_name, from_kind, ts) VALUES (?, ?, ?)')
  put.run('zoe', 'human', at('2026-10-08T01:00:00Z'))
  put.run('zoe', 'human', at('2026-10-08T02:00:00Z'))
  put.run('ops@zoe', 'agent', at('2026-10-08T03:00:00Z'))
  put.run('impl@zoe', 'agent', at('2026-10-09T03:00:00Z'))
  put.run('api@kai', 'agent', at('2026-10-09T04:00:00Z'))
  put.run('daemon@zoe', 'host', at('2026-10-09T05:00:00Z'))
  put.run('zoe', 'system', at('2026-10-09T06:00:00Z'))
  put.run('old', 'human', at('2026-09-01'))
  const rows = db.prepare(ROOM_ACTIVITY_SQL).all(at('2026-09-10')).map((r) => `${dayOf(r.d * DAY_MS)} ${r.sender_kind} ${r.account}`).sort()
  assert.deepEqual(rows, ['2026-10-08 agent zoe', '2026-10-08 human zoe', '2026-10-09 agent kai', '2026-10-09 agent zoe'])
  db.close()
})

test('series: signups count those before the window, Pro carries the last snapshot and ends with now', () => {
  const days = lastDays(4, at('2026-10-09'))
  assert.deepEqual(days, ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'])
  const s = signupSeries([{ created_at: at('2026-10-04') }, { created_at: at('2026-10-08') }, { created_at: at('2026-10-08') }], days)
  assert.deepEqual(s, { daily: [0, 0, 2, 0], total: [1, 1, 3, 3] })
  const p = proSeries([{ day: '2026-10-05', paid: 0, trial: 0, comp: 1 }, { day: '2026-10-08', paid: 1, trial: 3, comp: 1 }], days, { paid: 2, trial: 3, comp: 1 })
  assert.deepEqual(p, { total: [1, 1, 5, 6], paid: [0, 0, 1, 2] })
  assert.equal(dayLabel('2026-10-09', at('2026-10-09'), 'zh'), '今天')
  assert.equal(dayLabel('2026-10-08', at('2026-10-09'), 'zh'), '昨天')
  assert.equal(dayLabel('2026-10-01', at('2026-10-09'), 'zh'), '10-01')
  assert.equal(dayLabel(null, at('2026-10-09'), 'zh'), '—')
})

test('payments: live only, no test accounts, newest first; Creem takes 3.9% + 40 cents', () => {
  const db = migrated()
  seed(db)
  const pay = db.prepare('INSERT INTO payments (id, user_id, kind, product, amount, currency, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  pay.run('tran_1', 'j', 'paid', 'prod_m', 900, 'USD', 'live', at('2026-10-10'))
  pay.run('tran_2', 'm', 'paid', 'prod_y', 9000, 'USD', 'live', at('2026-10-11'))
  pay.run('ref_1', 'j', 'refund', 'prod_m', -900, 'USD', 'live', at('2026-10-12'))
  pay.run('tran_3', 't', 'paid', 'prod_m', 900, 'USD', 'live', at('2026-10-10')) // a test account
  pay.run('tran_4', 'j', 'paid', 'prod_m', 900, 'USD', 'test', at('2026-10-10')) // Creem's sandbox
  pay.run('tran_0', 'j', 'paid', 'prod_m', 900, 'USD', 'live', at('2026-10-01')) // the period before
  const rows = db.prepare(PAYMENTS_SQL).all(at('2026-10-09T00:00:00Z'))
  assert.deepEqual(rows.map((r) => r.id), ['ref_1', 'tran_2', 'tran_1'])
  assert.equal(creemFee(900), 75)
  assert.equal(creemFee(9000), 391)
  assert.equal(creemFee(-900), 0)
  db.close()
})

test('the billing period runs from the billing day to the same day next month', () => {
  assert.deepEqual(billingPeriod(at('2026-10-09T03:00:00Z'), 9), { start: '2026-10-09', end: '2026-11-09', days: 31 })
  assert.deepEqual(billingPeriod(at('2026-10-08T23:00:00Z'), 9), { start: '2026-09-09', end: '2026-10-09', days: 30 })
  assert.deepEqual(billingPeriod(at('2027-01-05'), 9), { start: '2026-12-09', end: '2027-01-09', days: 31 })
  assert.deepEqual(billingPeriod(at('2027-02-28'), 31), { start: '2027-02-28', end: '2027-03-31', days: 31 })
  assert.deepEqual(billingPeriod(at('2027-02-27'), 31), { start: '2027-01-31', end: '2027-02-28', days: 28 })
})

test('usage: WebSocket messages count 1 in 20, R2 by class, storage is the most of each day across buckets', () => {
  const days = ['2026-10-08', '2026-10-09']
  const s = parseUsage({
    w: [{ dimensions: { date: '2026-10-08' }, sum: { requests: 100, cpuTimeUs: 5000 } }, { dimensions: { date: '2026-10-09' }, sum: { requests: 10, cpuTimeUs: 1000 } }],
    doi: [{ dimensions: { date: '2026-10-09', type: 'jsrpc' }, sum: { requests: 30 } }, { dimensions: { date: '2026-10-09', type: 'hibernation' }, sum: { requests: 40 } }],
    r2o: [{ dimensions: { date: '2026-10-09', actionType: 'PutObject' }, sum: { requests: 3 } }, { dimensions: { date: '2026-10-09', actionType: 'GetObject' }, sum: { requests: 7 } }, { dimensions: { date: '2026-10-09', actionType: 'DeleteObject' }, sum: { requests: 9 } }],
    r2s: [{ dimensions: { date: '2026-10-09', bucketName: 'a' }, max: { payloadSize: 1000, metadataSize: 10 } }, { dimensions: { date: '2026-10-09', bucketName: 'b' }, max: { payloadSize: 500, metadataSize: 0 } }],
    kvo: [{ dimensions: { date: '2026-10-08', actionType: 'read' }, sum: { requests: 4 } }],
  }, days)
  assert.deepEqual(s.wreq, [100, 10])
  assert.deepEqual(s.wcpu, [5, 1])
  assert.deepEqual(s.doreq, [0, 32])
  assert.deepEqual(s.r2a, [0, 3])
  assert.deepEqual(s.r2b, [0, 7])
  assert.deepEqual(s.r2store, [null, 1510])
  assert.deepEqual(s.kvr, [4, 0])
  assert.deepEqual(s.dostore, [null, null])
})

test('estimate: so far plus the last week’s average for each day left; beyond the included amount in whole units', () => {
  const days = lastDays(31, at('2026-10-20'))
  const flat = (v) => days.map(() => v)
  const series = Object.fromEntries(ITEMS.map((it) => [it.key, it.store ? flat(null) : flat(0)]))
  series.doreq = flat(100_000) // 100k DO requests a day: 1M included a month
  series.r2store = days.map((d, i) => (i < 20 ? 1e9 : null)) // 1 GB, no reports for the last 11 days
  const period = billingPeriod(at('2026-10-20'), 9) // 10-09 → 11-09, 31 days; 12 of them so far
  const { items, total } = estimate(series, days, period)
  const doreq = items.find((it) => it.key === 'doreq')
  assert.equal(doreq.used, 1_200_000)
  assert.equal(doreq.projected, 3_100_000)
  assert.equal(doreq.cost, 0.45) // 2.1M beyond: 3 units of 1M at $0.15
  assert.equal(items[0].key, 'doreq') // the closest to (here past) what is included comes first
  const r2 = items.find((it) => it.key === 'r2store')
  assert.equal(r2.used, 1e9)
  assert.equal(Math.round(r2.projected), 1e9)
  assert.equal(r2.cost, 0)
  assert.equal(total, 5.45)
})
