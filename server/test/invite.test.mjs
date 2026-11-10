// Invites, hardened after a red-team review: the real invite.ts, device.ts and billing.ts, bundled as wrangler would,
// against D1 stood in for by node:sqlite with every migration. Every statement yields first, as a network round trip
// does, so things done at once interleave; a batch runs as one transaction, as D1's does.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { PURGE_SQL } from '../src/account-delete-sql.ts'
import { carryOf } from '../src/billing-state.ts'

if (!globalThis.crypto.subtle.timingSafeEqual) {
  Object.defineProperty(globalThis.crypto.subtle, 'timingSafeEqual', { value: (a, b) => crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)) })
}
const DAY = 864e5
async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}
const invite = await load('invite.ts')
const device = await load('device.ts')
const billing = await load('billing.ts')

const tick = () => new Promise((r) => setImmediate(r))
function fakeD1(db) {
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => { await tick(); const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r } },
    all: async () => { await tick(); return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) } },
    run: async () => { await tick(); return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } } },
  })
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      await tick()
      db.exec('BEGIN')
      try {
        // As D1, a statement with RETURNING gives its rows back (deviceToken reads the tokens it replaced).
        const out = list.map((s) => {
          if (!/\bRETURNING\b/i.test(s.sql)) return { results: [], meta: { changes: Number(db.prepare(s.sql).run(...s.args).changes) } }
          const results = db.prepare(s.sql).all(...s.args).map((r) => ({ ...r }))
          return { results, meta: { changes: results.length } }
        })
        db.exec('COMMIT')
        return out
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
  }
}
function setup({ salt = 'salt-for-tests', config = null } = {}) {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../migrations/', import.meta.url)
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, dir), 'utf8'))
  const env = {
    DB: fakeD1(db), ...(salt ? { INVITE_SALT: salt } : {}), PLANS: 'hosted', PUBLIC_URL: 'https://scorpio.test', CREEM_WEBHOOK_SECRET: 'whsec_test',
    DEVICE_CODE_LIMIT: { limit: async () => ({ success: true }) },
    KV: { get: async (k) => (k === 'config:invite' ? config : null) },
    ROOMS: { getByName: () => ({ planChanged: async () => {}, planArchive: async () => true }) },
  }
  const user = (id, handle, email, createdAt = Date.now()) => db.prepare('INSERT INTO users (id, handle, primary_email, created_at, is_test) VALUES (?, ?, ?, ?, 0)').run(id, handle, email, createdAt)
  const trial = (id, days = 7) => db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES (?, 'pro', 'active', ?, 'trial', ?)").run(id, Date.now() + days * DAY, Date.now())
  const row = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? { ...r } : null }
  /** A new account as createUser makes one, through newAccount. */
  const signup = async (id, email, code = null, { trialDays = 7, identity = `gh-${id}` } = {}) => {
    user(id, id, email)
    if (trialDays) trial(id, trialDays)
    await invite.newAccount(env, { id, email, createdAt: Date.now() }, code, { provider: 'github', subject: identity })
  }
  return { db, env, user, trial, row, signup }
}
/** A token issued on a computer with this machine id, as device.ts records it. */
async function computer(env, db, userId, deviceId, machineId) {
  const res = await device.deviceCode(new Request('https://scorpio.test/oauth/device/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_name: 'box', device_id: deviceId, cli_version: '0.5.9', ...(machineId ? { machine_id: machineId } : {}) }) }), env)
  const { device_code } = await res.json()
  db.prepare("UPDATE device_codes SET status = 'approved', user_id = ? WHERE status = 'pending'").run(userId)
  const tok = await device.deviceToken(new Request('https://scorpio.test/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code }) }), env, { waitUntil: () => {} })
  assert.equal(tok.status, 200)
}
const hex = (n) => crypto.createHash('sha256').update(String(n)).digest('hex')

test('codes: 6 characters of the alphabet, any case; one per account, given once and kept; the numbers from KV', async () => {
  const { env, user } = setup()
  assert.equal(invite.normalizeInviteCode(' ab3k9z '), 'AB3K9Z')
  assert.equal(invite.normalizeInviteCode('AB0K9Z'), null, 'no 0, O, 1 or I')
  user('u1', 'ana', 'ana@x.test')
  const c = await invite.currentInvite(env, 'u1')
  assert.match(c, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/)
  assert.equal(await invite.currentInvite(env, 'u1'), c)
  assert.deepEqual(await invite.inviteConfig(env), { monthCap: 3, rewardDays: 7, windowDays: 30 }, 'defaults: cap 3')
  assert.deepEqual(await invite.inviteConfig(setup({ config: { monthCap: 5, rewardDays: -1, windowDays: 'x' } }).env), { monthCap: 5, rewardDays: 7, windowDays: 30 }, 'bad values fall back')
})

test('canonical addresses: +tags gone, Gmail without dots; the same inbox counts once', async () => {
  assert.equal(invite.canonicalEmail('A.N.A+promo@GoogleMail.com'), 'ana@gmail.com')
  assert.equal(invite.canonicalEmail('a.na+x@example.com'), 'a.na@example.com', 'dots matter outside Gmail')
  const { env, row, signup } = setup()
  await signup('a', 'ana@gmail.com')
  const code = await invite.currentInvite(env, 'a')
  await signup('b', 'bo@x.test', code)
  assert.equal(row("SELECT invited_by FROM users WHERE id = 'b'").invited_by, 'a')
  await signup('b2', 'b.o+2@x.test'.replace('b.o', 'bo'), code) // bo+2@x.test: the same inbox as bo@
  assert.deepEqual(row("SELECT invited_by, invite_reward, invite_eligible FROM users WHERE id = 'b2'"), { invited_by: null, invite_reward: 'none', invite_eligible: null })
  await signup('c', 'a.n.a+me@gmail.com', code, { identity: 'gh-c-other' })
  assert.equal(row("SELECT invite_reward FROM users WHERE id = 'c'").invite_reward, 'none', "the inviter's own inbox, seen")
  await signup('d', 'dee@x.test', code, { identity: 'gh-b' })
  assert.equal(row("SELECT invite_reward FROM users WHERE id = 'd'").invite_reward, 'none', 'one GitHub account is new once')
})

test('same inbox as the inviter: not counted, and an alert', async () => {
  const { env, row, signup, db } = setup()
  await signup('a', 'ana@x.test')
  const code = await invite.currentInvite(env, 'a')
  // An address never seen as such, whose inbox is the inviter's: a fresh e-mail hash, so only the canonical check sees it.
  db.prepare('DELETE FROM seen_emails').run()
  await signup('b', 'ana+friend@x.test', code)
  assert.equal(row("SELECT invited_by FROM users WHERE id = 'b'").invited_by, null)
  assert.equal(row("SELECT kind FROM alerts WHERE kind = 'invite_same_inbox'")?.kind, 'invite_same_inbox')
})

test('eligibility: only accounts checked at sign-up take a code; without INVITE_SALT nothing is recorded', async () => {
  const { env, user, row, signup } = setup()
  await signup('a', 'ana@x.test')
  const code = await invite.currentInvite(env, 'a')
  user('old', 'old', 'old@x.test', Date.now() - DAY) // made before invites: never checked
  assert.equal(await invite.enterInviteCode(env, 'old', code), 'already')
  await signup('b', 'bo@x.test')
  assert.equal(await invite.enterInviteCode(env, 'b', 'ZZZZZZ'), 'unknown')
  assert.equal(await invite.enterInviteCode(env, 'b', code), 'ok')
  assert.equal(row("SELECT invited_by FROM users WHERE id = 'b'").invited_by, 'a')
  assert.equal(await invite.enterInviteCode(env, 'b', code), 'already')
  assert.equal((await invite.inviteView(env, { id: 'b' }, 'https://scorpio.test')).invitedBy, 'a')
  const off = setup({ salt: null })
  await off.signup('a', 'ana@x.test')
  await off.signup('b', 'bo@x.test')
  off.db.prepare("UPDATE users SET invite_code = 'AAAAAA' WHERE id = 'a'").run()
  assert.equal(await invite.enterInviteCode(off.env, 'b', 'AAAAAA'), 'already')
  assert.equal(off.row("SELECT invited_by FROM users WHERE id = 'b'").invited_by, null)
  assert.equal((await invite.inviteView(off.env, { id: 'b' }, 'https://scorpio.test')).canEnterCode, false)
})

test('trial off: the invite gives the friend 7 days at once; with the trial on, nothing more', async () => {
  const { env, row, signup } = setup()
  await signup('a', 'ana@x.test')
  const code = await invite.currentInvite(env, 'a')
  await signup('b', 'bo@x.test', code, { trialDays: 0 })
  const e = row("SELECT provider, period_end FROM entitlements WHERE user_id = 'b'")
  assert.equal(e.provider, 'invite')
  assert.ok(Math.abs(e.period_end - (Date.now() + 7 * DAY)) < 60_000)
  await signup('c', 'cy@x.test', code)
  assert.equal(row("SELECT provider FROM entitlements WHERE user_id = 'c'").provider, 'trial')
})

test('machines: a keyed hash on the device; the account whose device there is older owns the computer (back-filled on join)', async () => {
  const { env, db, user, row } = setup()
  user('old', 'old', 'old@x.test', Date.now() - 100 * DAY)
  db.prepare("INSERT INTO devices (user_id, device_id, device_name, created_at) VALUES ('old', 'device-old1', 'laptop', ?)").run(Date.now() - 90 * DAY)
  user('b', 'bo', 'bo@x.test')
  await computer(env, db, 'b', 'device-b001', hex('laptop'))
  const h = row("SELECT machine_hash FROM devices WHERE user_id = 'b'").machine_hash
  assert.notEqual(h, hex('laptop'), 'never the value the CLI sent')
  assert.equal(row('SELECT first_user_id FROM machine_hashes WHERE hash = ?', h).first_user_id, 'b')
  await invite.recordMachine(env, 'old', 'device-old1', hex('laptop')) // the old account's daemon joins with 0.5.9
  assert.equal(row('SELECT first_user_id FROM machine_hashes WHERE hash = ?', h).first_user_id, 'old', 'its device is older: it owns the laptop')
})

test('F/G: a friend\'s first join from their own computer gives the inviter 7 days — started on Free, banked on Pro; another\'s computer gives none', async () => {
  const { env, db, row, signup, user } = setup()
  user('a', 'ana', 'ana@x.test')
  await invite.newAccount(env, { id: 'a', email: 'ana@x.test', createdAt: Date.now() }, null, { provider: 'github', subject: 'gh-a' })
  const code = await invite.currentInvite(env, 'a')
  await signup('b', 'bo@x.test', code)
  await computer(env, db, 'b', 'device-old', null)
  await invite.rewardOnJoin(env, 'b', 'device-old')
  assert.equal(row("SELECT invite_rewarded_at FROM users WHERE id = 'b'").invite_rewarded_at, null, 'no machine id yet: judged later')
  await computer(env, db, 'b', 'device-new', hex('b-laptop'))
  await invite.rewardOnJoin(env, 'b', 'device-new')
  assert.equal(row("SELECT invite_reward FROM users WHERE id = 'b'").invite_reward, 'granted')
  assert.equal(row("SELECT provider FROM entitlements WHERE user_id = 'a'").provider, 'invite', 'the inviter was on Free: started')
  await signup('t', 'tess@x.test'); const tcode = await invite.currentInvite(env, 't')
  await signup('c', 'cy@x.test', tcode)
  await computer(env, db, 'c', 'device-c01', hex('c-box'))
  await invite.rewardOnJoin(env, 'c', 'device-c01')
  assert.equal(await invite.bankedDays(env, 't'), 7, 'on a trial: banked')
  await signup('d', 'dee@x.test', await invite.currentInvite(env, 't')) // c used tcode: t's next one
  await computer(env, db, 'd', 'device-d01', hex('c-box'))
  await invite.rewardOnJoin(env, 'd', 'device-d01')
  assert.equal(row("SELECT invite_reward FROM users WHERE id = 'd'").invite_reward, 'none', "c's computer")
  const view = await invite.inviteView(env, { id: 't' }, 'https://scorpio.test')
  assert.deepEqual(view.invitees.map((i) => i.status).sort(), ['registered', 'rewarded'])
  assert.equal(view.monthCap, 3)
})

test('a code is used once — two sign-ups at once with one code: one is invited, the other made as usual; rewards are not capped by month', async () => {
  const { env, db, row, signup } = setup()
  await signup('a', 'ana@x.test')
  const code = await invite.currentInvite(env, 'a')
  await Promise.all(['f1', 'f2', 'f3'].map((id) => signup(id, `${id}@x.test`, code)))
  assert.equal(row("SELECT COUNT(*) AS n FROM users WHERE invited_by = 'a'").n, 1, 'one of them')
  assert.equal(row('SELECT COUNT(*) AS n FROM users WHERE id IN (\'f1\', \'f2\', \'f3\')').n, 3, 'all three accounts made')
  const used = row('SELECT used_by FROM invites WHERE code = ?', code).used_by
  assert.equal(row('SELECT invited_by FROM users WHERE id = ?', used).invited_by, 'a')
  const next = await invite.currentInvite(env, 'a')
  assert.notEqual(next, code, 'the next code appears')
  const late = ['f1', 'f2', 'f3'].find((id) => id !== used)
  assert.equal(await invite.enterInviteCode(env, late, code), 'used', 'the used code, entered later')
  assert.equal(await invite.enterInviteCode(env, late, next), 'ok', "within 7 days, a's next code works")
  // Rewards: each friend once, whatever the month (the cap is on codes used, not on rewards).
  for (const id of [used, late]) { await computer(env, db, id, `device-${id}`, hex(id)); await invite.rewardOnJoin(env, id, `device-${id}`) }
  await Promise.all([used, late].map((id) => invite.rewardOnJoin(env, id, `device-${id}`)))
  assert.equal(row("SELECT COUNT(*) AS n FROM invite_ledger WHERE user_id = 'a' AND kind = 'grant'").n, 2)
  assert.equal(row("SELECT COUNT(*) AS n FROM users WHERE invite_reward = 'capped'").n, 0, 'no capped any more')
})

test('the month: 3 used and the current invite is null; a code still out is full (not used up) and works from the 1st; KV lowers the cap at once', async () => {
  const { env, db, row, signup } = setup()
  await signup('a', 'ana@x.test')
  for (const id of ['f1', 'f2']) await signup(id, `${id}@x.test`, await invite.currentInvite(env, 'a'))
  const out = await invite.currentInvite(env, 'a') // sent to someone, not used yet
  assert.equal(await invite.monthUsed(env, 'a'), 2)
  // The third this month by a code from before (this morning's fixed code, version 1): the month is full.
  await signup('m', 'em@x.test')
  db.prepare("UPDATE users SET invited_by = 'a', invited_at = ? WHERE id = 'm'").run(Date.now())
  assert.equal(await invite.currentInvite(env, 'a'), null, 'all used this month, though one is still out')
  const v = await invite.inviteView(env, { id: 'a' }, 'https://scorpio.test')
  assert.deepEqual([v.code, v.url, v.monthCount, v.monthCap], [null, null, 3, 3])
  assert.equal((await invite.inviteOf(env, out)).state, 'full')
  await signup('g', 'gee@x.test', out)
  assert.equal(row("SELECT invited_by FROM users WHERE id = 'g'").invited_by, null, 'a full code does not count')
  assert.equal(row('SELECT used_at FROM invites WHERE code = ?', out).used_at, null, 'and is not used up')
  assert.equal(await invite.enterInviteCode(env, 'g', out), 'full')
  // Next month (UTC): the code still out works again.
  db.prepare("UPDATE users SET invited_at = invited_at - 40 * 86400000 WHERE invited_by = 'a'").run()
  assert.equal((await invite.inviteOf(env, out)).state, 'ok')
  assert.equal(await invite.enterInviteCode(env, 'g', out), 'ok')
  assert.equal(await invite.monthUsed(env, 'a'), 1)
  // The cap reached by a use: an alert.
  const b = setup()
  await b.signup('a', 'ana@x.test')
  for (const id of ['f1', 'f2', 'f3']) await b.signup(id, `${id}@x.test`, await invite.currentInvite(b.env, 'a'))
  assert.equal(await invite.currentInvite(b.env, 'a'), null)
  assert.ok(b.row("SELECT 1 AS x FROM alerts WHERE kind = 'invite_cap' AND subject = 'a'"), 'the third used is an alert')
  // KV lowers the cap: at once, for the code already out too.
  const low = setup({ config: { monthCap: 1 } })
  await low.signup('a', 'ana@x.test')
  const first = await invite.currentInvite(low.env, 'a')
  await low.signup('b', 'bo@x.test', first)
  assert.equal(await invite.currentInvite(low.env, 'a'), null)
})

test('the friend gets 7 days: on its trial the trial runs 7 days longer (grant and use in the ledger); without one, 7 days at once; a seen account uses no code', async () => {
  const { env, row, signup } = setup()
  await signup('a', 'ana@x.test')
  const code = await invite.currentInvite(env, 'a')
  await signup('b', 'bo@x.test', code)
  const e = row("SELECT provider, period_end FROM entitlements WHERE user_id = 'b'")
  assert.equal(e.provider, 'trial')
  assert.ok(Math.abs(e.period_end - (Date.now() + 14 * DAY)) < 60_000, 'trial 7 + invite 7')
  assert.deepEqual(row("SELECT SUM(CASE kind WHEN 'grant' THEN days ELSE 0 END) AS g, SUM(CASE kind WHEN 'use' THEN days ELSE 0 END) AS u FROM invite_ledger WHERE user_id = 'b'"), { g: 7, u: 7 })
  assert.equal(await invite.bankedDays(env, 'b'), 0)
  const next = await invite.currentInvite(env, 'a')
  await signup('c', 'cy@x.test', next, { trialDays: 0 })
  const c = row("SELECT provider, period_end FROM entitlements WHERE user_id = 'c'")
  assert.equal(c.provider, 'invite')
  assert.ok(Math.abs(c.period_end - (Date.now() + 7 * DAY)) < 60_000)
  const third = await invite.currentInvite(env, 'a')
  await signup('bo2', 'bo@x.test'.replace('bo@', 'bo+2@'), third) // the same inbox as b: seen, not new
  assert.equal(row('SELECT used_at FROM invites WHERE code = ?', third).used_at, null, 'the code is still there')
  assert.equal(await invite.currentInvite(env, 'a'), third)
})

test("fixed codes from before: taken in as the account's first code, used once, then the next one; today's friends by a fixed code count in the month; a deleted inviter's code is no code", async () => {
  const { env, db, row, signup } = setup()
  await signup('a', 'ana@x.test')
  db.prepare("UPDATE users SET invite_code = 'FAXED2' WHERE id = 'a'").run()
  // a friend recorded this morning by the fixed code (version 1): counted in this month
  await signup('m', 'em@x.test')
  db.prepare("UPDATE users SET invited_by = 'a', invited_at = ? WHERE id = 'm'").run(Date.now())
  assert.equal(await invite.monthUsed(env, 'a'), 1)
  // The fixed link opened before a ever looked at settings: taken in, can be used now.
  assert.equal((await invite.inviteOf(env, 'faxed2')).state, 'ok')
  await signup('b', 'bo@x.test', 'FAXED2')
  assert.equal(row("SELECT invited_by FROM users WHERE id = 'b'").invited_by, 'a')
  assert.equal((await invite.inviteOf(env, 'FAXED2')).state, 'used')
  const next = await invite.currentInvite(env, 'a')
  assert.notEqual(next, 'FAXED2')
  assert.equal(await invite.monthUsed(env, 'a'), 2)
  // A drawn code is never some account's fixed code: drawn codes are checked against users.invite_code.
  assert.equal(row("SELECT COUNT(*) AS n FROM invites WHERE code IN (SELECT invite_code FROM users WHERE invite_code IS NOT NULL) AND code != 'FAXED2'").n, 0)
  db.prepare("UPDATE users SET deleted_at = ? WHERE id = 'a'").run(Date.now())
  assert.equal(await invite.inviteOf(env, next), null)
  await signup('c', 'cy@x.test', next)
  assert.equal(row("SELECT invited_by FROM users WHERE id = 'c'").invited_by, null)
})

test('starting banked days twice at once starts them once; the balance never goes below zero; a paid row is never overwritten', async () => {
  const { env, db, user, row } = setup()
  user('a', 'ana', 'ana@x.test')
  db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('a', 'grant', 7, 'f1', ?)").run(Date.now())
  await Promise.all([invite.startOrBank(env, 'a'), invite.startOrBank(env, 'a'), invite.startOrBank(env, 'a')])
  assert.equal(row("SELECT COUNT(*) AS n FROM invite_ledger WHERE user_id = 'a' AND kind = 'use'").n, 1)
  assert.equal(row("SELECT SUM(CASE kind WHEN 'grant' THEN days WHEN 'use' THEN -days ELSE 0 END) AS b FROM invite_ledger WHERE user_id = 'a'").b, 0)
  user('p', 'pay', 'pay@x.test')
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('p', 'pro', 'active', ?, 'creem', ?)").run(Date.now() + 30 * DAY, Date.now())
  db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('p', 'grant', 7, 'f2', ?)").run(Date.now())
  await invite.startOrBank(env, 'p')
  assert.equal(row("SELECT provider FROM entitlements WHERE user_id = 'p'").provider, 'creem', 'paid stays paid; the days wait')
  assert.equal(await invite.bankedDays(env, 'p'), 7)
})

test('a refund with banked days does not bring the refunded month back on Creem\'s later cancel event', async () => {
  const { env, db, user, row } = setup()
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 200 }) // Creem's cancel call
  try {
    user('a', 'ana', 'ana@x.test')
    db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('a', 'grant', 7, 'f1', ?)").run(Date.now())
    const hook = async (id, type, object, at) => {
      const body = JSON.stringify({ id, eventType: type, created_at: at, object: { customer: { id: 'c1' }, metadata: { userId: 'a' }, product: { id: 'prod_m', price: 900, currency: 'USD' }, ...object } })
      const sig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex')
      const pending = []
      const res = await billing.creemWebhook(new Request('https://scorpio.test/billing/creem/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'creem-signature': sig }, body }), env, { waitUntil: (p) => pending.push(p) })
      await Promise.allSettled(pending)
      return res
    }
    const t0 = Date.now(), end = new Date(t0 + 30 * DAY).toISOString()
    await hook('e1', 'subscription.paid', { id: 'sub_1', status: 'active', last_transaction_id: 'tr_1', current_period_end_date: end }, t0)
    await hook('e2', 'refund.created', { id: 'ref_1', refund_amount: 900, transaction: { id: 'tr_1', amount: 900, amount_paid: 900 }, subscription: { id: 'sub_1' } }, t0 + 1000)
    const mid = row("SELECT provider, period_end FROM entitlements WHERE user_id = 'a'")
    assert.equal(mid.provider, 'invite', 'the refund ended the paid month; the banked 7 days started')
    await hook('e3', 'subscription.canceled', { id: 'sub_1', status: 'canceled', current_period_end_date: end }, t0 + 2000)
    const e = row("SELECT provider, period_end FROM entitlements WHERE user_id = 'a'")
    assert.equal(e.provider, 'invite')
    assert.ok(e.period_end < Date.now() + 8 * DAY, 'the refunded month did not come back')
  } finally {
    globalThis.fetch = real
  }
})

test('a deleted account is not revived by its banked days; an inviter deleted meanwhile gets nothing', async () => {
  const { env, db, user, row, signup } = setup()
  user('a', 'ana', 'ana@x.test')
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('a', 'pro', 'canceled', ?, 'creem', ?)").run(Date.now() - 1000, Date.now() - DAY)
  db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('a', 'grant', 14, 'f1', ?)").run(Date.now())
  db.prepare("UPDATE users SET deleted_at = ? WHERE id = 'a'").run(Date.now())
  await billing.lapseExpired(env)
  assert.notEqual(row("SELECT provider FROM entitlements WHERE user_id = 'a'").provider, 'invite')
  await signup('t', 'tess@x.test'); const tcode = await invite.currentInvite(env, 't')
  await signup('c', 'cy@x.test', tcode)
  db.prepare("UPDATE users SET deleted_at = ? WHERE id = 't'").run(Date.now())
  await computer(env, db, 'c', 'device-c01', hex('c-box'))
  await invite.rewardOnJoin(env, 'c', 'device-c01')
  assert.equal(row("SELECT invite_reward FROM users WHERE id = 'c'").invite_reward, 'none')
  assert.equal(row("SELECT COUNT(*) AS n FROM invite_ledger WHERE user_id = 't'").n, 0)
})

test('a computer with 3+ accounts is not judged (a shared image), with an alert; a friend after the window is not judged', async () => {
  const { env, db, row, signup } = setup()
  await signup('a', 'ana@x.test'); const code = await invite.currentInvite(env, 'a')
  for (const id of ['x1', 'x2']) { await signup(id, `${id}@x.test`); await computer(env, db, id, `device-${id}`, hex('image')) }
  await signup('b', 'bo@x.test', code)
  await computer(env, db, 'b', 'device-b01', hex('image'))
  await invite.rewardOnJoin(env, 'b', 'device-b01')
  assert.equal(row("SELECT invite_rewarded_at FROM users WHERE id = 'b'").invite_rewarded_at, null, 'not judged: the one judgment is not burnt')
  assert.ok(row("SELECT 1 AS x FROM alerts WHERE kind = 'invite_shared_machine'"))
  await signup('late', 'late@x.test', code)
  db.prepare("UPDATE users SET created_at = ? WHERE id = 'late'").run(Date.now() - 31 * DAY)
  await computer(env, db, 'late', 'device-late', hex('late'))
  await invite.rewardOnJoin(env, 'late', 'device-late')
  assert.equal(row("SELECT invite_rewarded_at FROM users WHERE id = 'late'").invite_rewarded_at, null)
})

test('H: banked days start instead of a downgrade when what the account had ends; I: bought over, what is left is kept', async () => {
  const { env, db, user, row } = setup()
  user('a', 'ana', 'ana@x.test')
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('a', 'pro', 'active', ?, 'trial', ?)").run(Date.now() - 1000, Date.now() - 8 * DAY)
  db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('a', 'grant', 7, 'f1', ?)").run(Date.now())
  await billing.lapseExpired(env)
  const e = row("SELECT provider, downgraded_at, period_end FROM entitlements WHERE user_id = 'a'")
  assert.equal(e.provider, 'invite')
  assert.equal(e.downgraded_at, null)
  assert.equal(carryOf({ provider: 'invite', status: 'active', period_end: Date.now() + 3 * DAY, subscription_id: null, carry_ms: null }, 'sub_1', Date.now()) > 0, true)
})

test('the daily self-check: a negative balance, over the cap, given Pro on a deleted account (ended), shared computers', async () => {
  const { env, db, user, row } = setup()
  user('n', 'neg', 'neg@x.test')
  db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('n', 'revoke', 3, 'x', ?)").run(Date.now())
  user('o', 'over', 'over@x.test')
  for (let i = 0; i < 4; i++) { user(`of${i}`, `of${i}`, `of${i}@x.test`); db.prepare('UPDATE users SET invited_by = ?, invited_at = ? WHERE id = ?').run('o', Date.now(), `of${i}`) }
  user('g', 'gone', 'gone@x.test')
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('g', 'pro', 'active', ?, 'invite', ?)").run(Date.now() + 5 * DAY, Date.now())
  db.prepare("UPDATE users SET deleted_at = ? WHERE id = 'g'").run(Date.now())
  await invite.inviteDaily(env)
  const kinds = db.prepare('SELECT kind, subject FROM alerts ORDER BY kind').all().map((r) => `${r.kind}:${r.subject}`)
  assert.deepEqual(kinds, ['invite_deleted_pro:gone', 'invite_negative:neg', 'invite_over_cap:over'])
  assert.equal(row("SELECT status FROM entitlements WHERE user_id = 'g'").status, 'canceled')
})

test('L: account deletion keeps the invite tables', () => {
  const sql = PURGE_SQL.join('\n')
  for (const t of ['seen_emails', 'seen_identities', 'machine_hashes', 'invite_ledger']) assert.ok(!sql.includes(t), `${t} is not purged`)
})

test('second pass N1: a deleted account with banked days is downgraded once and not picked up again', async () => {
  const { env, db, user, row } = setup()
  user('a', 'ana', 'ana@x.test')
  db.prepare("INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at) VALUES ('a', 'pro', 'canceled', ?, 'creem', ?)").run(Date.now() - 1000, Date.now() - DAY)
  db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('a', 'grant', 14, 'f1', ?)").run(Date.now())
  db.prepare("UPDATE users SET deleted_at = ? WHERE id = 'a'").run(Date.now())
  await billing.lapseExpired(env)
  assert.ok(row("SELECT downgraded_at FROM entitlements WHERE user_id = 'a'").downgraded_at, 'marked downgraded: out of the lapse query')
})

test('second pass N2: a judgment cut short after its grant was written settles granted on retry, and the daily heal finishes it', async () => {
  const { env, db, row, signup } = setup()
  await signup('a', 'ana@x.test'); db.prepare("DELETE FROM entitlements WHERE user_id = 'a'").run()
  const code = await invite.currentInvite(env, 'a')
  await signup('b', 'bo@x.test', code)
  await computer(env, db, 'b', 'device-b01', hex('b-box'))
  // As if a judgment wrote the grant row and then stopped: the friend reset to undecided, the inviter's days not started.
  db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('a', 'grant', 7, 'b', ?)").run(Date.now())
  await invite.rewardOnJoin(env, 'b', 'device-b01')
  assert.equal(row("SELECT invite_reward FROM users WHERE id = 'b'").invite_reward, 'granted', 'not capped')
  assert.equal(row("SELECT provider FROM entitlements WHERE user_id = 'a'").provider, 'invite', 'and the days started')
  // A friend left pending for over an hour: the daily heal decides it.
  await signup('c', 'cy@x.test', code)
  db.prepare("UPDATE users SET invite_reward = 'pending', invite_rewarded_at = ? WHERE id = 'c'").run(Date.now() - 2 * 3600_000)
  await invite.inviteDaily(env)
  assert.deepEqual(row("SELECT invite_reward, invite_rewarded_at FROM users WHERE id = 'c'"), { invite_reward: null, invite_rewarded_at: null }, 'no grant row: undecided again')
})

test('second pass: a friend using an older account\'s CLI home (same device id) gets none, before any daemon reported', async () => {
  const { env, db, user, row, signup } = setup()
  await signup('a', 'ana@x.test'); const code = await invite.currentInvite(env, 'a')
  db.prepare("INSERT INTO devices (user_id, device_id, device_name, created_at) VALUES ('a', 'device-shared', 'laptop', ?)").run(Date.now() - 30 * DAY)
  await signup('b', 'bo@x.test', code)
  await computer(env, db, 'b', 'device-shared', hex('a-laptop'))
  await invite.rewardOnJoin(env, 'b', 'device-shared')
  assert.equal(row("SELECT invite_reward FROM users WHERE id = 'b'").invite_reward, 'none')
})

test('second pass: an old subscription.paid retried after the refund changes nothing (stale for that subscription)', async () => {
  const { env, db, user, row } = setup()
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 200 })
  try {
    user('a', 'ana', 'ana@x.test')
    db.prepare("INSERT INTO invite_ledger (user_id, kind, days, ref, at) VALUES ('a', 'grant', 7, 'f1', ?)").run(Date.now())
    const hook = async (id, type, object, at) => {
      const body = JSON.stringify({ id, eventType: type, created_at: at, object: { customer: { id: 'c1' }, metadata: { userId: 'a' }, product: { id: 'prod_m', price: 900, currency: 'USD' }, ...object } })
      const sig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex')
      const pending = []
      await billing.creemWebhook(new Request('https://scorpio.test/billing/creem/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'creem-signature': sig }, body }), env, { waitUntil: (p) => pending.push(p) })
      await Promise.allSettled(pending)
    }
    const t0 = Date.now(), end = new Date(t0 + 30 * DAY).toISOString()
    await hook('e1', 'subscription.paid', { id: 'sub_1', status: 'active', last_transaction_id: 'tr_1', current_period_end_date: end }, t0)
    await hook('e2', 'refund.created', { id: 'ref_1', refund_amount: 900, transaction: { id: 'tr_1', amount: 900, amount_paid: 900 }, subscription: { id: 'sub_1' } }, t0 + 1000)
    // The first delivery of a paid event had failed (401) and Creem retries it now, with its own old time.
    await hook('e0', 'subscription.paid', { id: 'sub_1', status: 'active', last_transaction_id: 'tr_1', current_period_end_date: end }, t0 - 5000)
    const e = row("SELECT provider, period_end FROM entitlements WHERE user_id = 'a'")
    assert.equal(e.provider, 'invite')
    assert.ok(e.period_end < Date.now() + 8 * DAY)
  } finally {
    globalThis.fetch = real
  }
})
