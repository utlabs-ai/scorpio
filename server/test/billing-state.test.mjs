import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ENTITLEMENT_UPSERT_SQL, RENEWAL_SLACK, accessFrom, carryOf, paidThrough } from '../src/billing-state.ts'

const DAY = 86400_000
const T = Date.UTC(2026, 9, 9)

test('subscription states map to access: renewing keeps slack, canceled runs to the paid end, expired ends now', () => {
  assert.deepEqual(accessFrom('active', T + 30 * DAY, T), { status: 'active', periodEnd: T + 30 * DAY + RENEWAL_SLACK, canceled: false })
  assert.deepEqual(accessFrom('active', null, T), { status: 'active', periodEnd: T + 31 * DAY + RENEWAL_SLACK, canceled: false })
  assert.deepEqual(accessFrom('scheduled_cancel', T + 30 * DAY, T), { status: 'active', periodEnd: T + 30 * DAY, canceled: true })
  assert.deepEqual(accessFrom('canceled', T + 30 * DAY, T), { status: 'active', periodEnd: T + 30 * DAY, canceled: true })
  assert.deepEqual(accessFrom('canceled', T - DAY, T), { status: 'canceled', periodEnd: T - DAY, canceled: true })
  assert.deepEqual(accessFrom('canceled', null, T), { status: 'canceled', periodEnd: null, canceled: true })
  assert.deepEqual(accessFrom('expired', T + 30 * DAY, T), { status: 'canceled', periodEnd: T, canceled: true })
  assert.equal(accessFrom('incomplete', T + 30 * DAY, T), null)
})

test('the pages show the paid end without the renewal slack, and a canceled subscription as not renewing', () => {
  const end = T + 30 * DAY
  assert.deepEqual(paidThrough({ provider: 'creem', status: 'active', period_end: end + RENEWAL_SLACK, canceled_at: null }), { until: end, canceled: false, renewsOn: end, carryDays: 0 })
  assert.deepEqual(paidThrough({ provider: 'creem', status: 'active', period_end: end, canceled_at: T }), { until: end, canceled: true, renewsOn: null, carryDays: 0 })
  assert.equal(paidThrough({ provider: 'trial', status: 'active', period_end: end, canceled_at: null }), null)
  assert.equal(paidThrough({ provider: 'comp', status: 'active', period_end: null, canceled_at: null }), null)
  assert.equal(paidThrough({ provider: 'creem', status: 'canceled', period_end: end, canceled_at: T }), null)
  assert.equal(paidThrough(null), null)
})

const schema = 'CREATE TABLE entitlements (user_id TEXT PRIMARY KEY, plan TEXT NOT NULL, status TEXT NOT NULL, period_end INTEGER, provider TEXT NOT NULL, customer_id TEXT, subscription_id TEXT, updated_at INTEGER NOT NULL, grace_until INTEGER, downgraded_at INTEGER);' +
  'CREATE TABLE billing_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL);'
const migration = fs.readFileSync(new URL('../migrations/0017_billing_canceled.sql', import.meta.url), 'utf8')
const carryMigration = fs.readFileSync(new URL('../migrations/0023_trial_carry.sql', import.meta.url), 'utf8')
const refundMigration = fs.readFileSync(new URL('../migrations/0024_refund_ends.sql', import.meta.url), 'utf8')

test('the webhook write: a purchase replaces a trial, a cancel is stamped once, renewing again clears it', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  db.exec(migration)
  db.exec(carryMigration)
  db.exec(refundMigration)
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('u1', 'pro', 'active', ?, 'trial', ?)").run(T + 7 * DAY, T - DAY)
  const write = (status, end, at, canceledAt) => db.prepare(ENTITLEMENT_UPSERT_SQL).run('u1', status, end, 'cust_1', 'sub_1', at, canceledAt, null)
  const row = () => db.prepare('SELECT plan, status, period_end, provider, customer_id, subscription_id, canceled_at FROM entitlements WHERE user_id = ?').get('u1')
  write('active', T + 32 * DAY, T, null)
  assert.deepEqual({ ...row() }, { plan: 'pro', status: 'active', period_end: T + 32 * DAY, provider: 'creem', customer_id: 'cust_1', subscription_id: 'sub_1', canceled_at: null })
  write('active', T + 30 * DAY, T + DAY, T + DAY)
  write('active', T + 30 * DAY, T + 2 * DAY, T + 2 * DAY)
  assert.equal(row().canceled_at, T + DAY)
  write('active', T + 32 * DAY, T + 3 * DAY, null)
  assert.equal(row().canceled_at, null)
  db.close()
})

test('0017 marks subscriptions whose last handled event was a cancel, and nothing else', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  const ent = db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES (?, 'pro', 'active', ?, ?, ?)")
  ent.run('gone', T + 30 * DAY, 'creem', T)
  ent.run('paying', T + 32 * DAY, 'creem', T)
  ent.run('trial', T + 7 * DAY, 'trial', T)
  const ev = db.prepare('INSERT INTO billing_events VALUES (?, ?, ?, ?)')
  ev.run('e1', 'subscription.paid', 'gone', T - 2 * DAY)
  ev.run('e2', 'subscription.canceled', 'gone', T - DAY)
  ev.run('e3', 'subscription.canceled', 'paying', T - 3 * DAY)
  ev.run('e4', 'subscription.active', 'paying', T - 2 * DAY)
  db.exec(migration)
  const rows = Object.fromEntries(db.prepare('SELECT user_id, canceled_at FROM entitlements').all().map((r) => [r.user_id, r.canceled_at]))
  assert.deepEqual(rows, { gone: T - DAY, paying: null, trial: null })
  db.close()
})

test('the trial time a purchase keeps comes after every paid end, whatever the subscription does', () => {
  const C = 5 * DAY + 4 * 3600_000
  assert.deepEqual(accessFrom('active', T + 30 * DAY, T, C), { status: 'active', periodEnd: T + 30 * DAY + RENEWAL_SLACK + C, canceled: false })
  assert.deepEqual(accessFrom('active', null, T, C), { status: 'active', periodEnd: T + 31 * DAY + RENEWAL_SLACK + C, canceled: false })
  assert.deepEqual(accessFrom('canceled', T + 30 * DAY, T, C), { status: 'active', periodEnd: T + 30 * DAY + C, canceled: true })
  assert.deepEqual(accessFrom('canceled', T - DAY, T, C), { status: 'active', periodEnd: T - DAY + C, canceled: true }, 'canceled at once (a refund): the rest of the trial still')
  assert.deepEqual(accessFrom('canceled', null, T, C), { status: 'active', periodEnd: T + C, canceled: true })
  assert.deepEqual(accessFrom('expired', T + 30 * DAY, T, C), { status: 'active', periodEnd: T + C, canceled: true })
  assert.deepEqual(accessFrom('canceled', T - 6 * DAY, T, C), { status: 'canceled', periodEnd: T - 6 * DAY + C, canceled: true }, 'used up')
  assert.deepEqual(accessFrom('expired', T + 30 * DAY, T, 0), { status: 'canceled', periodEnd: T, canceled: true }, 'no carry: as before')
})

test('which events keep trial time — a purchase over a running trial, then that subscription only', () => {
  const trial = (end, status = 'active') => ({ provider: 'trial', status, period_end: end, subscription_id: null, carry_ms: null })
  assert.equal(carryOf(trial(T + 5 * DAY), 'sub_1', T), 5 * DAY)
  assert.equal(carryOf(trial(T - DAY), 'sub_1', T), 0, 'the trial was over')
  assert.equal(carryOf(trial(T + 5 * DAY, 'canceled'), 'sub_1', T), 0)
  const paid = { provider: 'creem', status: 'active', period_end: T + 40 * DAY, subscription_id: 'sub_1', carry_ms: 5 * DAY }
  assert.equal(carryOf(paid, 'sub_1', T + 30 * DAY), 5 * DAY, 'a renewal or cancel of that subscription keeps it')
  assert.equal(carryOf(paid, 'sub_2', T + 90 * DAY), 0, 'a later subscription starts without it')
  assert.equal(carryOf({ ...paid, carry_ms: null }, 'sub_1', T), 0)
  assert.equal(carryOf({ provider: 'comp', status: 'active', period_end: null, subscription_id: null, carry_ms: null }, 'sub_1', T), 0)
  assert.equal(carryOf(null, 'sub_1', T), 0)
})

test('the pages get the last day of Pro, the next charge and the trial days kept', () => {
  const end = T + 30 * DAY, C = 5 * DAY + 4 * 3600_000
  assert.deepEqual(paidThrough({ provider: 'creem', status: 'active', period_end: end + RENEWAL_SLACK + C, canceled_at: null, carry_ms: C }), { until: end + C, canceled: false, renewsOn: end, carryDays: 5 })
  assert.deepEqual(paidThrough({ provider: 'creem', status: 'active', period_end: end + C, canceled_at: T, carry_ms: C }), { until: end + C, canceled: true, renewsOn: null, carryDays: 5 })
  assert.deepEqual(paidThrough({ provider: 'creem', status: 'active', period_end: end + RENEWAL_SLACK, canceled_at: null, carry_ms: null }), { until: end, canceled: false, renewsOn: end, carryDays: 0 })
})
