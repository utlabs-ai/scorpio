import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

// The real webhook (src/billing.ts, bundled as wrangler would) against D1 stood in for by node:sqlite.
// Workers' crypto.subtle has timingSafeEqual (util.ts safeEqual); Node's has not.
if (!globalThis.crypto.subtle.timingSafeEqual) {
  Object.defineProperty(globalThis.crypto.subtle, 'timingSafeEqual', { value: (a, b) => crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)) })
}
async function loadBilling() {
  const out = await build({ entryPoints: [new URL('../src/billing.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

function fakeD1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r } },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  })
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) }
}

function setup() {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, dir), 'utf8'))
  db.prepare("INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES ('u1', 'alice', 'a@x', 1, 0)").run()
  const pending = []
  const env = {
    CREEM_WEBHOOK_SECRET: 'whsec_test', PLANS: 'hosted', DB: fakeD1(db),
    KV: { get: async () => null },
    ROOMS: { getByName: () => ({ planChanged: async () => {}, planArchive: async () => true }) },
  }
  return { db, env, ctx: { waitUntil: (p) => pending.push(p) }, settle: () => Promise.allSettled(pending) }
}

function paidEvent() {
  const body = JSON.stringify({
    id: 'evt_1', eventType: 'subscription.paid', created_at: Date.now(),
    object: {
      id: 'sub_1', status: 'active', customer: { id: 'cust_1' }, last_transaction_id: 'tran_1',
      product: { id: 'prod_m', price: 900, currency: 'USD' },
      current_period_end_date: new Date(Date.now() + 30 * 864e5).toISOString(), metadata: { userId: 'u1' },
    },
  })
  const sig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex')
  return new Request('https://scorpio.test/billing/creem/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'creem-signature': sig }, body })
}

test('a paid subscription grants Pro and is written down as a payment', async () => {
  const { creemWebhook } = await loadBilling()
  const { db, env, ctx, settle } = setup()
  const res = await creemWebhook(paidEvent(), env, ctx)
  await settle()
  assert.equal(res.status, 200)
  assert.deepEqual({ ...db.prepare("SELECT plan, status, provider FROM entitlements WHERE user_id = 'u1'").get() }, { plan: 'pro', status: 'active', provider: 'creem' })
  assert.deepEqual({ ...db.prepare('SELECT id, user_id, kind, amount, mode FROM payments').get() }, { id: 'tran_1', user_id: 'u1', kind: 'paid', amount: 900, mode: 'live' })
})

test('when writing the payment fails, the webhook still answers 200 and grants Pro', async () => {
  const { creemWebhook } = await loadBilling()
  const { db, env, ctx, settle } = setup()
  db.exec('DROP TABLE payments') // every payment write now throws
  const logged = []
  const error = console.error
  console.error = (line) => logged.push(String(line))
  try {
    const res = await creemWebhook(paidEvent(), env, ctx)
    await settle()
    assert.equal(res.status, 200)
  } finally {
    console.error = error
  }
  assert.deepEqual({ ...db.prepare("SELECT plan, status, provider FROM entitlements WHERE user_id = 'u1'").get() }, { plan: 'pro', status: 'active', provider: 'creem' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE id = 'evt_1'").get().n, 1)
  assert.ok(logged.some((l) => l.includes('payment record failed')))
})

// Bought during the trial, the rest of the trial comes after the paid time, through renewals and a cancel.
function event(id, type, at, sub) {
  const body = JSON.stringify({ id, eventType: type, created_at: at, object: { customer: { id: 'cust_1' }, product: { id: 'prod_m', price: 900, currency: 'USD' }, metadata: { userId: 'u1' }, ...sub } })
  const sig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex')
  return new Request('https://scorpio.test/billing/creem/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'creem-signature': sig }, body })
}

test('a purchase during the trial keeps the rest of it after every paid end of that subscription, and not of the next', async () => {
  const { creemWebhook } = await loadBilling()
  const { db, env, ctx, settle } = setup()
  const DAY = 864e5, SLACK = 2 * DAY, t0 = Date.now()
  const trialEnd = t0 + 5 * DAY
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('u1', 'pro', 'active', ?, 'trial', ?)").run(trialEnd, t0 - DAY)
  const row = () => ({ ...db.prepare("SELECT status, provider, period_end, carry_ms, canceled_at, subscription_id FROM entitlements WHERE user_id = 'u1'").get() })
  const end1 = t0 + 30 * DAY, end2 = t0 + 60 * DAY
  const iso = (ms) => new Date(ms).toISOString()

  await creemWebhook(event('e1', 'subscription.paid', t0, { id: 'sub_1', status: 'active', last_transaction_id: 'tr_1', current_period_end_date: iso(end1) }), env, ctx)
  let r = row()
  assert.equal(r.provider, 'creem')
  assert.equal(r.carry_ms, trialEnd - t0, 'what was left of the trial when it was bought')
  assert.equal(r.period_end, end1 + SLACK + (trialEnd - t0))

  await creemWebhook(event('e1b', 'checkout.completed', t0 + 1000, { subscription: { id: 'sub_1', status: 'active', current_period_end_date: iso(end1), metadata: { userId: 'u1' } } }), env, ctx)
  assert.equal(row().carry_ms, trialEnd - t0, 'a second event of the same purchase keeps it, not a new count')

  await creemWebhook(event('e2', 'subscription.paid', t0 + 30 * DAY, { id: 'sub_1', status: 'active', last_transaction_id: 'tr_2', current_period_end_date: iso(end2) }), env, ctx)
  r = row()
  assert.equal(r.carry_ms, trialEnd - t0, 'a renewal keeps it')
  assert.equal(r.period_end, end2 + SLACK + (trialEnd - t0))

  await creemWebhook(event('e3', 'subscription.canceled', t0 + 31 * DAY, { id: 'sub_1', status: 'canceled', current_period_end_date: iso(end2) }), env, ctx)
  r = row()
  assert.equal(r.status, 'active')
  assert.equal(r.period_end, end2 + (trialEnd - t0), 'canceled: Pro to the paid end plus the trial kept')
  assert.ok(r.canceled_at)

  await creemWebhook(event('e4', 'subscription.paid', t0 + 100 * DAY, { id: 'sub_2', status: 'active', last_transaction_id: 'tr_3', current_period_end_date: iso(t0 + 130 * DAY) }), env, ctx)
  r = row()
  assert.equal(r.subscription_id, 'sub_2')
  assert.equal(r.carry_ms, null, 'a later subscription starts without it')
  assert.equal(r.period_end, t0 + 130 * DAY + SLACK)
  await settle()
})

test('bought after the trial ended, or with no trial: nothing is kept', async () => {
  const { creemWebhook } = await loadBilling()
  const { db, env, ctx, settle } = setup()
  const DAY = 864e5, t0 = Date.now()
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('u1', 'pro', 'active', ?, 'trial', ?)").run(t0 - DAY, t0 - 8 * DAY)
  await creemWebhook(event('e1', 'subscription.paid', t0, { id: 'sub_1', status: 'active', last_transaction_id: 'tr_1', current_period_end_date: new Date(t0 + 30 * DAY).toISOString() }), env, ctx)
  assert.deepEqual({ ...db.prepare("SELECT provider, carry_ms, period_end FROM entitlements WHERE user_id = 'u1'").get() }, { provider: 'creem', carry_ms: null, period_end: t0 + 32 * DAY })
  await settle()
})

// A full refund takes back what it paid for, and stops the subscription at Creem when it still renews.
function refundEvent(id, at, { amount = 900, paid = 900, sub = 'sub_1', tran = 'tr_1' } = {}) {
  const body = JSON.stringify({ id, eventType: 'refund.created', created_at: at, object: { id: `ref_${id}`, refund_amount: amount, refund_currency: 'USD', transaction: { id: tran, amount: paid, amount_paid: paid, currency: 'USD' }, subscription: { id: sub, product: 'prod_m' } } })
  const sig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex')
  return new Request('https://scorpio.test/billing/creem/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'creem-signature': sig }, body })
}
function stubCreem(t, answer = () => new Response('{}', { status: 200 })) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body ?? null }); return answer(String(url)) }
  t.after(() => { globalThis.fetch = real })
  return calls
}

test('a full refund ends the Pro it paid for at once, cancels the renewing subscription at Creem, and a later cancel event does not give it back', async (t) => {
  const { creemWebhook } = await loadBilling()
  const { db, env, ctx, settle } = setup()
  const calls = stubCreem(t)
  const DAY = 864e5, t0 = Date.now(), iso = (ms) => new Date(ms).toISOString()
  const row = () => ({ ...db.prepare("SELECT status, period_end, canceled_at, refunded_at FROM entitlements WHERE user_id = 'u1'").get() })
  await creemWebhook(event('p1', 'subscription.paid', t0, { id: 'sub_1', status: 'active', last_transaction_id: 'tr_1', current_period_end_date: iso(t0 + 30 * DAY) }), env, ctx)
  await creemWebhook(refundEvent('r1', t0 + 1000), env, ctx)
  let r = row()
  assert.equal(r.status, 'canceled')
  assert.ok(r.period_end <= Date.now() && r.period_end >= t0, 'Pro ends now')
  assert.ok(r.refunded_at && r.canceled_at)
  assert.deepEqual(calls.map((c) => [new URL(c.url).pathname, c.body]), [['/v1/subscriptions/sub_1/cancel', '{"mode":"immediate"}']])
  assert.equal(db.prepare("SELECT SUM(amount) AS net FROM payments WHERE user_id = 'u1'").get().net, 0)
  // Creem's own cancel event for it, later, with the old period end.
  await creemWebhook(event('c1', 'subscription.canceled', t0 + 2000, { id: 'sub_1', status: 'canceled', current_period_end_date: iso(t0 + 30 * DAY) }), env, ctx)
  r = row()
  assert.equal(r.status, 'canceled', 'still ended')
  assert.ok(r.period_end < t0 + DAY)
  await settle()
})

test('refund after the person canceled: no second cancel at Creem; the trial time it kept still comes after', async (t) => {
  const { creemWebhook } = await loadBilling()
  const { db, env, ctx, settle } = setup()
  const calls = stubCreem(t)
  const DAY = 864e5, t0 = Date.now(), iso = (ms) => new Date(ms).toISOString()
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('u1', 'pro', 'active', ?, 'trial', ?)").run(t0 + 5 * DAY, t0 - DAY)
  await creemWebhook(event('p1', 'subscription.paid', t0, { id: 'sub_1', status: 'active', last_transaction_id: 'tr_1', current_period_end_date: iso(t0 + 30 * DAY) }), env, ctx)
  await creemWebhook(event('c1', 'subscription.canceled', t0 + 1000, { id: 'sub_1', status: 'canceled', current_period_end_date: iso(t0 + 30 * DAY) }), env, ctx)
  await creemWebhook(refundEvent('r1', t0 + 2000), env, ctx)
  const r = { ...db.prepare("SELECT status, period_end, carry_ms FROM entitlements WHERE user_id = 'u1'").get() }
  assert.equal(calls.length, 0, 'already canceled: Creem is not asked again')
  assert.equal(r.status, 'active')
  assert.ok(Math.abs(r.period_end - (Date.now() + 5 * DAY)) < 60_000, 'the five trial days, from now')
  await settle()
})

test('a partial refund only goes on the books; a Creem refusal to cancel leaves an alert and Pro still ends', async (t) => {
  const { creemWebhook } = await loadBilling()
  const { db, env, ctx, settle } = setup()
  const DAY = 864e5, t0 = Date.now(), iso = (ms) => new Date(ms).toISOString()
  let calls = stubCreem(t)
  await creemWebhook(event('p1', 'subscription.paid', t0, { id: 'sub_1', status: 'active', last_transaction_id: 'tr_1', current_period_end_date: iso(t0 + 30 * DAY) }), env, ctx)
  await creemWebhook(refundEvent('r1', t0 + 1000, { amount: 300 }), env, ctx)
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE user_id = 'u1'").get().status, 'active')
  assert.equal(calls.length, 0)
  globalThis.fetch = async () => new Response('{"error":"forbidden"}', { status: 403 })
  const error = console.error
  console.error = () => {}
  try {
    await creemWebhook(refundEvent('r2', t0 + 2000, { amount: 900 }), env, ctx)
  } finally {
    console.error = error
  }
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE user_id = 'u1'").get().status, 'canceled')
  assert.equal(db.prepare("SELECT kind, subject FROM alerts").all().map((a) => `${a.kind} ${a.subject}`).join(), 'refund_cancel sub_1')
  await settle()
})
