import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'
import { build } from 'esbuild'

const built = await build({ entryPoints: [new URL('../src/room-passcode-sweep.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { sweepPasscodeFailures } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const HOUR = 3_600_000
const KEY = 'room:passcodeFailuresDue'
const options = { className: 'DataRoom', append: `
export class DataRoom extends RoomDO {
  testSql(query, args = []) { return this.sql.exec(query, ...args).toArray(); }
  testKv(key) { return this.ctx.storage.kv.get(key) ?? null; }
  testDue(at) { this.ctx.storage.kv.put('room:passcodeFailuresDue', at); }
  testAlarm() { return this.alarm(); }
  testWake() { this.migrate(); return this.prunePasscodeFailures(); }
}` }

async function fixture(t) {
  const w = await worker({}, options)
  t.after(() => w.dispose())
  const kai = await w.person('kai'), mei = await w.person('mei'), zoe = await w.person('zoe')
  const id = await w.topic(kai, 'secret7')
  const ns = await w.mf.getDurableObjectNamespace('ROOMS')
  return { w, kai, mei, zoe, id, stub: ns.getByName(id) }
}

for (const joined of [true, false]) test(`accountGone clears three owned tables and preserves another account (joined=${joined})`, async (t) => {
  const { w, mei, id, stub } = await fixture(t)
  if (joined) assert.equal((await w.json(await mei.apiPost(`/rooms/${id}/join`, { role: 'api', code: 'secret7' }))).status, 200)
  for (const account of ['mei', 'zoe']) {
    await stub.testSql('INSERT INTO passcode_failures VALUES (?, ?)', [account, Date.now()])
    await stub.testSql('INSERT INTO my_data_cache VALUES (?, 0, ?, ?)', [account, Date.now(), '{}'])
    await stub.testSql('INSERT INTO removed_computers (name, owner) VALUES (?, ?)', [`box@${account}`, account])
  }
  const result = await stub.accountGone('mei')
  assert.deepEqual(result.removed, joined ? ['api@mei'] : [])
  for (const [table, column] of [['passcode_failures', 'account'], ['my_data_cache', 'account'], ['removed_computers', 'owner']]) {
    assert.deepEqual((await stub.testSql(`SELECT ${column} AS account FROM ${table}`)).map((r) => r.account), ['zoe'], table)
  }
  assert.deepEqual((await stub.accountGone('mei')).removed, [], 'retry is idempotent')
})

test('a correct passcode prunes expired failures belonging to all accounts', async (t) => {
  const { w, mei, id, stub } = await fixture(t)
  await stub.testSql('INSERT INTO passcode_failures VALUES (?, ?)', ['zoe', Date.now() - HOUR - 1000])
  assert.equal((await w.json(await mei.apiPost(`/rooms/${id}/join`, { role: 'api', code: 'secret7' }))).status, 200)
  assert.deepEqual(await stub.testSql('SELECT * FROM passcode_failures'), [])
})

test('switching a topic to public deletes its passcode failures immediately', async (t) => {
  const { w, mei, id, stub } = await fixture(t)
  assert.equal((await w.json(await mei.apiPost(`/rooms/${id}/join`, { role: 'api', code: 'wrong' }))).error, 'bad_code')
  assert.equal((await stub.testSql('SELECT * FROM passcode_failures')).length, 1)
  assert.ok((await stub.setVisibility({ kind: 'human', name: 'kai', account: 'kai' }, true, '')).ok)
  assert.deepEqual(await stub.testSql('SELECT * FROM passcode_failures'), [])
})

test('wrong guesses arm expiry; the shared alarm prunes without another passcode check, advances, then stops', async (t) => {
  const { w, mei, zoe, id, stub } = await fixture(t)
  const before = Date.now()
  assert.equal((await w.json(await mei.apiPost(`/rooms/${id}/join`, { role: 'api', code: 'wrong' }))).error, 'bad_code')
  const first = await stub.testKv(KEY)
  assert.ok(first >= before + HOUR && first <= Date.now() + HOUR)
  assert.equal((await w.json(await zoe.apiPost(`/rooms/${id}/join`, { role: 'api', code: 'wrong' }))).error, 'bad_code')
  assert.equal(await stub.testKv(KEY), first, 'a later guess never postpones the first expiry')
  // Advance the stored timestamps instead of waiting an hour. No later join or code check occurs.
  await stub.testSql('UPDATE passcode_failures SET failed_at = ? WHERE account = ?', [Date.now() - HOUR - 1000, 'mei'])
  const later = Date.now() - HOUR + 60_000
  await stub.testSql('UPDATE passcode_failures SET failed_at = ? WHERE account = ?', [later, 'zoe'])
  await stub.testDue(Date.now() - 1)
  await stub.testAlarm()
  assert.deepEqual((await stub.testSql('SELECT account FROM passcode_failures')).map((r) => r.account), ['zoe'])
  const next = await stub.testKv(KEY)
  assert.ok(Math.abs(next - (later + HOUR)) < 1000)
  await stub.testSql('UPDATE passcode_failures SET failed_at = ?', [Date.now() - HOUR - 1000])
  await stub.testDue(Date.now() - 1)
  await stub.testAlarm()
  assert.deepEqual(await stub.testSql('SELECT * FROM passcode_failures'), [])
  assert.equal(await stub.testKv(KEY), null)
  await stub.testAlarm()
  assert.equal(await stub.testKv(KEY), null, 'no recurring cleanup is armed when empty')
})

test('wake migration prunes historical rows and arms unexpired rows without another guess', async (t) => {
  const { stub } = await fixture(t)
  const at = Date.now()
  await stub.testSql('INSERT INTO passcode_failures VALUES (?, ?)', ['mei', at - HOUR - 1000])
  await stub.testSql('INSERT INTO passcode_failures VALUES (?, ?)', ['zoe', at - HOUR + 60_000])
  assert.equal(await stub.testKv(KEY), null)
  await stub.testWake()
  assert.deepEqual((await stub.testSql('SELECT account FROM passcode_failures')).map((r) => r.account), ['zoe'])
  const next = await stub.testKv(KEY)
  assert.ok(Math.abs(next - (at + 60_000)) < 1000)
})

test('my data reads remove expired caches for every account and retain valid caches', async (t) => {
  const { stub } = await fixture(t)
  const at = Date.now()
  const data = { humanMessages: 7, agentMessages: 2, lastActive: at, daily: [] }
  for (const [account, cached] of [['kai', at], ['mei', at - 60_001], ['zoe', at]]) {
    await stub.testSql('INSERT INTO my_data_cache VALUES (?, 0, ?, ?)', [account, cached, JSON.stringify(data)])
  }
  assert.deepEqual((await stub.myData({ kind: 'human', name: 'kai', account: 'kai' }, 0)).ok, data)
  assert.deepEqual((await stub.testSql('SELECT account FROM my_data_cache ORDER BY account')).map((r) => r.account), ['kai', 'zoe'])
  await stub.testSql('UPDATE my_data_cache SET cached_at = ?', [Date.now() - 60_001])
  assert.equal((await stub.myData({ kind: 'human', name: 'kai', account: 'kai' }, 0)).ok.humanMessages, 0, 'stale own cache is recomputed')
  assert.deepEqual((await stub.testSql('SELECT account FROM my_data_cache')).map((r) => r.account), ['kai'])
})

test('reading deleted tasks removes only rows older than 24 hours', async (t) => {
  const { stub } = await fixture(t)
  const at = Date.now()
  for (const [n, ms] of [[1, at - 86_400_001], [2, at]]) {
    await stub.testSql('INSERT INTO items_deleted (n, title, assignee, created_by, by_name, ms) VALUES (?, ?, NULL, ?, ?, ?)', [n, `Task ${n}`, 'kai', 'kai', ms])
  }
  const result = await stub.todoList({ kind: 'human', name: 'kai', account: 'kai' })
  assert.ok(result.ok, JSON.stringify(result))
  assert.deepEqual((await stub.testSql('SELECT n FROM items_deleted')).map((r) => r.n), [2])
})

test('the one-off sweep deletes historical failures through a real local DO and marks completion', async (t) => {
  const { w, stub } = await fixture(t)
  await stub.testSql('INSERT INTO passcode_failures VALUES (?, ?)', ['zoe', Date.now() - HOUR - 1000])
  const env = { DB: w.db, KV: w.kv, ROOMS: await w.mf.getDurableObjectNamespace('ROOMS') }
  assert.equal(await w.kv.get('passcodeSweepV1'), null)
  await sweepPasscodeFailures(env)
  assert.deepEqual(await stub.testSql('SELECT * FROM passcode_failures'), [])
  assert.equal(await w.kv.get('passcodeSweepV1'), 'done')
  await sweepPasscodeFailures(env)
  assert.equal(await w.kv.get('passcodeSweepV1:after'), null)
})
