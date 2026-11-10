// Numbers that change without a release: KV config read with defaults and their rules.
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { retentionDays } from '../src/retention.ts'
import { CREEM_FEE, creemFee, creemFeeOf } from '../src/ops-data.ts'

const kv = (values) => ({ get: async (k) => values[k] ?? null })

test('config:retention: Pro grace only longer (from 30); account restore either way within 1–21 days (from 7)', async () => {
  assert.deepEqual(await retentionDays({ KV: kv({}) }), { archiveAfterDays: 90, binAfterDays: 90, proGraceDays: 30, accountRestoreDays: 7 })
  const r = await retentionDays({ KV: kv({ 'config:retention': { proGraceDays: 45, accountRestoreDays: 14, archiveAfterDays: 30 } }) })
  assert.equal(r.proGraceDays, 45)
  assert.equal(r.accountRestoreDays, 14)
  assert.equal(r.archiveAfterDays, 90, 'never shorter')
  assert.equal((await retentionDays({ KV: kv({ 'config:retention': { proGraceDays: 10 } }) })).proGraceDays, 30, 'never shorter')
  assert.equal((await retentionDays({ KV: kv({ 'config:retention': { accountRestoreDays: 3 } }) })).accountRestoreDays, 3, 'shorter is fine')
  assert.equal((await retentionDays({ KV: kv({ 'config:retention': { accountRestoreDays: 30 } }) })).accountRestoreDays, 7, 'over 21: the policy\'s 30 days would not hold')
  assert.equal((await retentionDays({ KV: kv({ 'config:retention': { accountRestoreDays: 0 } }) })).accountRestoreDays, 7)
})

test('config:creem.fee: the ops page estimate, 3.9% + 40¢ by default', () => {
  assert.deepEqual(creemFeeOf(null), CREEM_FEE)
  assert.equal(creemFee(900), Math.round(900 * 0.039 + 40))
  const fee = creemFeeOf({ monthly: 'prod_x', fee: { percent: 5, fixedCents: 50 } })
  assert.deepEqual(fee, { percent: 5, fixedCents: 50 })
  assert.equal(creemFee(900, fee), 95)
  assert.deepEqual(creemFeeOf({ fee: { percent: 150, fixedCents: 10 } }), CREEM_FEE, 'nonsense falls back')
  assert.equal(creemFee(-900, fee), 0)
})

test('config:plans: task changes per room and minute, 120 by default, only raised', async () => {
  const out = await build({ entryPoints: [new URL('../src/plans.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  const { limitsFor } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
  for (const plan of ['free', 'pro', 'self']) assert.equal((await limitsFor({ KV: kv({}) }, plan)).todoWritesPerRoomMinute, 120)
  assert.equal((await limitsFor({ KV: kv({ 'config:plans': { pro: { todoWritesPerRoomMinute: 300 } } }) }, 'pro')).todoWritesPerRoomMinute, 300)
  assert.equal((await limitsFor({ KV: kv({ 'config:plans': { pro: { todoWritesPerRoomMinute: 60 } } }) }, 'pro')).todoWritesPerRoomMinute, 120)
})

test('config:keys: the keys /keys can press, the defaults unless KV has the basic shape; read once a minute', async () => {
  const { DEFAULT_KEYS, keysOf, configKeys } = await import('../src/config-keys.ts')
  assert.deepEqual(DEFAULT_KEYS, { keys: [{ name: 'up', label: '↑', herdr: 'up' }, { name: 'down', label: '↓', herdr: 'down' }, { name: 'enter', label: 'Enter', herdr: 'enter' }, { name: 'esc', label: 'Esc', herdr: 'esc' }], settleMs: 3000 })
  assert.deepEqual(keysOf(null), DEFAULT_KEYS)
  const more = { keys: [...DEFAULT_KEYS.keys, { name: 'tab', label: 'Tab', herdr: 'tab' }], settleMs: 2000 }
  assert.deepEqual(keysOf(more), more)
  for (const bad of [{ keys: {}, settleMs: 3000 }, { keys: [{ name: 'up' }], settleMs: 3000 }, { keys: [null], settleMs: 3000 }, { keys: [], settleMs: 0 }, { keys: [], settleMs: '3000' }, 'up']) {
    assert.deepEqual(keysOf(bad), DEFAULT_KEYS, JSON.stringify(bad))
  }
  assert.deepEqual(await configKeys({ KV: kv({ 'config:keys': more }) }), more)
  assert.deepEqual(await configKeys({ KV: kv({}) }), more, 'the isolate keeps it for a minute')
})

test('GET /api/v1/config/keys answers without signing in', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../src/routes/agent-rooms.ts', import.meta.url), 'utf8')
  const api = source.slice(source.indexOf('export async function agentApi('))
  assert.match(source, /match: ["']\/config\/keys["']/)
  assert.ok(api.indexOf('runRoutes(base, preAuthRoutes)') > 0 && api.indexOf('runRoutes(base, preAuthRoutes)') < api.indexOf('agentFromRequest('))
})
