// Transactional SQLite fixture and real local Worker/D1 routes.
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
const cards = await load('trial-codes.ts')
const { worker } = await import('./helpers/worker.mjs')

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
test('batches validate bounds, draw unique alphabet codes and list usage', async () => {
  const {env,user}=setup(); user('ops','ops','ops@x');
  for(const [count,days] of [[0,30],[501,30],[3,0],[3,366],[1.5,30]]) await assert.rejects(cards.createBatch(env,'ops',{count,days}),/bad_request/);
  const {batch,codes}=await cards.createBatch(env,'ops',{count:500,days:365,note:'test'});
  assert.equal(new Set(codes).size,500);
  for(const code of codes) assert.match(code,/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
  assert.equal((await cards.batches(env))[0].count,500); assert.equal((await cards.codesOf(env,batch.id)).length,500);
});
test('Free starts immediately, retries do not grant, another batch banks', async () => {
  const {env,user,row}=setup(); user('a','a','a@x'); user('b','b','b@x');
  const {codes}=await cards.createBatch(env,'ops',{count:3,days:30});
  const r=await cards.redeem(env,'a',codes[0].toLowerCase()); assert.equal(r.ok,true); assert.equal(r.startsNow,true); assert.equal(r.days,30);
  const ent=row("SELECT * FROM entitlements WHERE user_id='a'"); assert.equal(ent.provider,'invite'); assert.ok(Math.abs(ent.period_end-Date.now()-30*DAY)<2000);
  for(const [c,want] of [[codes[0],'used'],[codes[1],'batch_used'],['ZZZZZZZZ','unknown'],['bad','unknown']]) assert.equal(await cards.redeem(env,'a',c),want);
  assert.equal(await cards.redeem(env,'b',codes[0]),'used');
  assert.equal(row("SELECT COUNT(*) AS n FROM invite_ledger WHERE user_id='a'").n,2);
  const second=await cards.createBatch(env,'ops',{count:1,days:30});
  assert.equal((await cards.redeem(env,'a',second.codes[0])).startsNow,false); assert.equal(await invite.bankedDays(env,'a'),30);
});
test('trial extends once, duplicate same-millisecond retries change nothing; paid and comp bank', async () => {
  const {env,user,trial,row,db}=setup();user('a','a','a@x');trial('a');
  const before=row("SELECT period_end FROM entitlements WHERE user_id='a'").period_end;
  const {codes}=await cards.createBatch(env,'ops',{count:4,days:30});
  const realNow=Date.now,fixed=realNow();Date.now=()=>fixed;
  try {const r=await cards.redeem(env,'a',codes[0]); assert.equal(r.until,before+30*DAY);assert.equal(r.startsNow,true);
    assert.equal(await cards.redeem(env,'a',codes[0]),'used');assert.equal(await cards.redeem(env,'a',codes[1]),'batch_used');
  } finally {Date.now=realNow;}
  assert.equal(row("SELECT period_end FROM entitlements WHERE user_id='a'").period_end,before+30*DAY);
  assert.equal(row("SELECT provider FROM entitlements WHERE user_id='a'").provider,'trial');
  assert.equal(row("SELECT COUNT(*) AS n FROM invite_ledger WHERE user_id='a'").n,2);assert.equal(await invite.bankedDays(env,'a'),0);
  for(const [i,provider] of ['creem','comp'].entries()) {const id='p'+i;user(id,id,id+'@x');db.prepare("INSERT INTO entitlements (user_id,plan,status,period_end,provider,updated_at) VALUES (?,'pro','active',?,?,?)").run(id,Date.now()+DAY,provider,Date.now()-1000);
    assert.equal((await cards.redeem(env,id,codes[2+i])).startsNow,false);assert.equal(await invite.bankedDays(env,id),30);}
});
test('concurrent claims: one code once, one account per batch', async () => {
  const {env,user,row}=setup();user('a','a','a@x');user('b','b','b@x');
  const {codes}=await cards.createBatch(env,'ops',{count:3,days:30});
  const r=await Promise.all(['a','b'].map(id=>cards.redeem(env,id,codes[0])));assert.equal(r.filter(x=>x.ok).length,1);assert.equal(r.filter(x=>x==='used').length,1);
  const second=await cards.createBatch(env,'ops',{count:2,days:30});
  const s=await Promise.all(second.codes.map(c=>cards.redeem(env,'a',c)));assert.equal(s.filter(x=>x.ok).length,1);assert.equal(s.filter(x=>x==='batch_used').length,1);
  assert.equal(row("SELECT COUNT(*) AS n FROM invite_ledger WHERE kind='grant'").n,2);
});
test('local Worker/D1: admin authorization, CSRF, link redirects, redemption and rate limiting', async t => {
  const w=await worker({PLANS:'hosted'});t.after(()=>w.dispose());const ops=await w.person('ops'),a=await w.person('a');
  assert.equal((await w.fetch('/admin/trial-codes')).status,404);assert.equal((await a.web('/admin/trial-codes')).status,404);
  assert.equal((await ops.post('/admin/trial-codes',{count:3,days:30},{origin:'https://evil.test'})).status,403);
  const created=await ops.post('/admin/trial-codes',{count:3,days:30,note:'test'});assert.equal(created.status,303);
  const page=await ops.web(created.headers.get('location'));assert.equal(page.status,200);assert.match(await page.text(),/Copy all unused links/);
  const codes=(await w.db.prepare('SELECT code FROM trial_codes ORDER BY code').all()).results.map(c=>c.code);
  for(const code of [codes[0].toLowerCase(),'bad0','%E0']) {const path='/settings?trial='+encodeURIComponent(code.toUpperCase())+'#trial-code';
    const out=await a.web('/trial/'+code);assert.equal(out.status,302);assert.equal(out.headers.get('location'),path);
    const anon=await w.fetch('/trial/'+code);assert.equal(anon.status,302);assert.equal(anon.headers.get('location'),'/login?next='+encodeURIComponent(path));}
  assert.equal((await w.db.prepare('SELECT COUNT(*) AS n FROM invite_ledger').first()).n,0);
  const ok=await w.json(await a.post('/settings/trial-code',{code:codes[0]}));assert.equal(ok.ok,true);assert.equal(ok.days,30);assert.equal(ok.startsNow,true);
  assert.equal((await w.json(await a.post('/settings/trial-code',{code:codes[1]}))).error,'trial_batch_used');
  assert.equal((await w.json(await a.post('/settings/trial-code',{code:codes[0]}))).error,'trial_used');
  // The limit (10 a minute, helpers/worker.mjs) counts in fixed windows: on a loaded machine the requests above can
  // straddle a window boundary and reset the count, so keep trying until the limit answers, within three windows' worth.
  let refused=null;
  for(let i=0;i<31&&refused===null;i++) {const status=(await a.post('/settings/trial-code',{code:'bad'})).status;
    if(status===429) refused=i; else assert.equal(status,400);}
  assert.notEqual(refused,null,'the trial-code limit never answered 429');assert.ok(3+refused>=10,`refused after only ${3+refused} attempts`);
});
