import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_TRIAL, trialForSignup, trialPolicy } from '../src/trial.ts'

test('trial config defaults on for seven days and rejects malformed values', () => {
  assert.deepEqual(trialPolicy(null), DEFAULT_TRIAL)
  assert.deepEqual(trialPolicy({ enabled: false, days: 7 }), { enabled: false, days: 7 })
  assert.deepEqual(trialPolicy({ days: 14 }), { enabled: true, days: 14 })
  assert.throws(() => trialPolicy({ enabled: 'false', days: 7 }), /config:trial/)
  assert.throws(() => trialPolicy({ enabled: true, days: 0 }), /config:trial/)
})

test('malformed or unavailable config disables trial without blocking signup', async () => {
  const invalid = await trialForSignup({ KV: { get: async () => ({ enabled: 'no', days: 7 }) } })
  const unavailable = await trialForSignup({ KV: { get: async () => { throw new Error('KV unavailable') } } })
  assert.deepEqual(invalid, { enabled: false, days: 7, invalid: true })
  assert.deepEqual(unavailable, { enabled: false, days: 7, invalid: true })
})
