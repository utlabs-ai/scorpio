import assert from 'node:assert/strict'
import test from 'node:test'
import { indexFix } from '../src/room-index-fix.ts'

const row = { status: 'active', topic: 'old', visibility: 'private', archived_at: null, archived_reason: null }
const state = { topic: 'old', public: false, archivedAt: null, archivedReason: null, deletedAt: null, accounts: [] }
const empty = { room: {}, activate: [], deactivate: [], remove: [] }
const member = (user_id, handle, active = 1) => ({ user_id, handle, active })
const account = (handle, active, human) => ({ account: handle, active, human })
const fix = (r = row, m = [], s = state) => indexFix(r, m, s, 12345)

test('deleted DO or D1 rooms are skipped before any other change', () => {
  assert.deepEqual(fix(row, [], { ...state, deletedAt: 9, topic: 'new' }), { skip: 'deleted' })
  assert.deepEqual(fix({ ...row, status: 'deleted' }, [], { ...state, topic: 'new' }), { skip: 'deleted' })
})

test('legacy statuses are skipped', () => {
  assert.deepEqual(fix({ ...row, status: 'folded' }), { skip: 'status' })
})

test('topic and public visibility follow the DO', () => {
  assert.deepEqual(fix(row, [], { ...state, topic: 'new', public: true }), { ...empty, room: { topic: 'new', visibility: 'link' } })
})

test('DO archive changes status, timestamp and reason together', () => {
  assert.deepEqual(fix(row, [], { ...state, archivedAt: 100, archivedReason: 'downgrade' }),
    { ...empty, room: { status: 'archived', archived_at: 100, archived_reason: 'downgrade' } })
})

test('already archived rooms only correct the reason; millisecond timestamp drift is ignored', () => {
  const archived = { ...row, status: 'archived', archived_at: 101, archived_reason: 'owner' }
  assert.deepEqual(fix(archived, [], { ...state, archivedAt: 100, archivedReason: 'downgrade' }),
    { ...empty, room: { archived_reason: 'downgrade' } })
  assert.deepEqual(fix({ ...archived, archived_reason: 'downgrade' }, [], { ...state, archivedAt: 100, archivedReason: 'downgrade' }), empty)
})

test('DO restore resets the retention clock in D1', () => {
  assert.deepEqual(fix({ ...row, status: 'archived', archived_at: 100, archived_reason: 'downgrade' }),
    { ...empty, room: { status: 'active', archived_at: null, archived_reason: null, active_at: 12345 } })
})

test('active DO accounts activate missing and inactive D1 members by handle', () => {
  const s = { ...state, accounts: [account('lee', true, true), account('mei', true, false)] }
  assert.deepEqual(fix(row, [member('u-mei', 'mei', 0)], s), { ...empty, activate: ['lee', 'mei'] })
})

test('an account missing from DO is removed, not merely set inactive', () => {
  assert.deepEqual(fix(row, [member('u-lee', 'lee')]), { ...empty, remove: ['u-lee'] })
})

test('a person who left a private room is removed', () => {
  assert.deepEqual(fix(row, [member('u-lee', 'lee')], { ...state, accounts: [account('lee', false, true)] }),
    { ...empty, remove: ['u-lee'] })
})

test('a person who left a public room stays as an inactive visitor', () => {
  assert.deepEqual(fix({ ...row, visibility: 'link' }, [member('u-lee', 'lee')],
    { ...state, public: true, accounts: [account('lee', false, true)] }), { ...empty, deactivate: ['u-lee'] })
})

test('an agent-only account that left a private room stays inactive', () => {
  assert.deepEqual(fix(row, [member('u-lee', 'lee')], { ...state, accounts: [account('lee', false, false)] }),
    { ...empty, deactivate: ['u-lee'] })
})

test('inactive D1 rows, including visitors, are not removed', () => {
  assert.deepEqual(fix(row, [member('u-lee', 'lee', 0)]), empty)
})
