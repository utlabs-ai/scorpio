import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
  } }] })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const { RoomDO } = await load('room-do.ts')
const { Members } = await load('room/members.ts')

function entry({ member = undefined, account = 'ana', known = false } = {}) {
  const calls = []
  const row = { id: 'room-1', owner: 'owner' }
  const room = {
    wrap: (fn) => ({ ok: fn() }),
    room: () => row,
    memberRow: () => member,
    roomInfo: () => ({ id: 'room-1' }),
    activeCount: () => 0,
    accountKnown: () => { calls.push('accountKnown'); return known },
    checkCode: () => { calls.push('checkCode') },
    lastSeq: () => 5,
    sql: { exec: (sql) => { calls.push(sql) } },
    systemMessage: () => { calls.push('systemMessage') },
    broadcastMembers: () => { calls.push('broadcastMembers') },
  }
  return { room, calls, actor: { name: account, account } }
}

test('enterHuman keeps the four routes and skips needless accountKnown/code reads', async () => {
  const active = entry({ member: { status: 'active' } })
  assert.deepEqual((await Members.prototype.enterHuman.call(active.room, active.actor)).ok, { room: { id: 'room-1' } })
  assert.deepEqual(active.calls, [])

  const owner = entry({ account: 'owner' })
  await Members.prototype.enterHuman.call(owner.room, owner.actor)
  assert.equal(owner.calls.includes('accountKnown'), false)
  assert.equal(owner.calls.includes('checkCode'), false)
  assert.deepEqual(owner.calls.slice(-2), ['systemMessage', 'broadcastMembers'])

  const known = entry({ known: true })
  await Members.prototype.enterHuman.call(known.room, known.actor)
  assert.equal(known.calls.filter((x) => x === 'accountKnown').length, 1)
  assert.equal(known.calls.includes('checkCode'), false)

  const stranger = entry()
  await Members.prototype.enterHuman.call(stranger.room, stranger.actor)
  assert.deepEqual(stranger.calls.slice(0, 2), ['accountKnown', 'checkCode'])
})

test('the creator cannot be removed or leave; requireOwner checks membership and keeps refusals anonymous', async () => {
  const row = { id: 'room-1', owner: 'owner' }
  const actor = { name: 'owner', account: 'owner' }
  const room = { wrap: (fn) => ({ ok: fn() }), room: () => row, requireOwner: () => row }
  await assert.rejects(RoomDO.prototype.removeAccount.call(room, actor, 'owner'), (e) => e.code === 'the_owner_stays' && e.next === 'The creator cannot be removed from their own topic.')
  await assert.rejects(RoomDO.prototype.leaveAccount.call(room, actor), (e) => e.code === 'the_owner_stays' && e.next === 'The creator cannot leave their own topic. Archive it or delete it instead.')
  assert.equal(RoomDO.prototype.requireOwner.call({ room: () => row, requireMember: () => ({ status: 'active' }) }, actor, 'archive the topic'), row)
  assert.throws(() => RoomDO.prototype.requireOwner.call({ room: () => row, requireMember: () => ({ status: 'active' }) }, { account: 'ana' }, 'archive the topic'), (e) => e.code === 'forbidden' && e.next === "You do not have permission to archive the topic.")
})

test('planArchive writes and broadcasts only for a real archive or matching restore', async () => {
  const run = async (row, archived, reason = 'downgrade') => {
    const sql = []
    const broadcast = []
    const room = { wrap: (fn) => ({ ok: fn() }), room: () => row, sql: { exec: (...args) => sql.push(args) }, broadcastRoom: (...args) => broadcast.push(args), stopSchedules: () => {} }
    return { changed: await RoomDO.prototype.planArchive.call(room, archived, reason), sql, broadcast }
  }
  const newArchive = await run({ archived_at: null, archived_reason: null }, true)
  assert.equal(newArchive.changed, true)
  assert.equal(newArchive.sql[0][0], 'UPDATE room SET archived_at = ?, archived_reason = ?')
  assert.deepEqual(newArchive.broadcast, [[true]])
  assert.deepEqual(await run({ archived_at: 5, archived_reason: 'owner' }, true), { changed: false, sql: [], broadcast: [] })
  assert.deepEqual(await run({ archived_at: null, archived_reason: null }, false), { changed: false, sql: [], broadcast: [] })
  assert.deepEqual(await run({ archived_at: 5, archived_reason: 'owner' }, false), { changed: false, sql: [], broadcast: [] })
  assert.deepEqual(await run({ archived_at: 5, archived_reason: 'downgrade' }, false), { changed: true, sql: [["UPDATE room SET archived_at = NULL, archived_reason = NULL"]], broadcast: [[true]] })
})

const membership = await load('room-membership.ts')

test('mayEnter chooses already, owner, known and needsCode in that order', () => {
  const row = { owner: 'owner' }
  const ana = { account: 'ana' }
  assert.equal(membership.mayEnter(row, { status: 'active' }, ana, false), 'already')
  assert.equal(membership.mayEnter(row, { status: 'active' }, { account: 'owner' }, true), 'already')
  assert.equal(membership.mayEnter(row, undefined, { account: 'owner' }, false), 'owner')
  assert.equal(membership.mayEnter(row, { status: 'left' }, ana, true), 'known')
  assert.equal(membership.mayEnter(row, { status: 'left' }, ana, false), 'needsCode')
  assert.equal(membership.mayEnter(row, undefined, ana, false), 'needsCode')
})

test('agent-seat cleanup reserves one place and refuses when too few left seats exist', () => {
  assert.equal(membership.agentSeatsToRemove(99, 0), 0)
  assert.equal(membership.agentSeatsToRemove(100, 1), 1)
  assert.equal(membership.agentSeatsToRemove(123, 24), 24)
  assert.equal(membership.agentSeatsToRemove(123, 23), null)
  assert.equal(membership.personSlotAvailable(19), true)
  assert.equal(membership.personSlotAvailable(20), false)
})

test('ownerStays and requireOwner compare the actor account with the room owner', () => {
  const row = { owner: 'owner' }
  assert.equal(membership.ownerStays(row, 'owner'), true)
  assert.equal(membership.ownerStays(row, 'ana'), false)
  assert.equal(membership.requireOwner(row, { account: 'owner' }), true)
  assert.equal(membership.requireOwner(row, { account: 'ana' }), false)
})

test('planArchiveChange follows both archive and matching-reason restore branches', () => {
  assert.equal(membership.planArchiveChange({ archived_at: null, archived_reason: null }, true, 'downgrade'), true)
  assert.equal(membership.planArchiveChange({ archived_at: 5, archived_reason: 'owner' }, true, 'downgrade'), false)
  assert.equal(membership.planArchiveChange({ archived_at: null, archived_reason: null }, false, 'downgrade'), false)
  assert.equal(membership.planArchiveChange({ archived_at: 5, archived_reason: 'owner' }, false, 'downgrade'), false)
  assert.equal(membership.planArchiveChange({ archived_at: 5, archived_reason: 'downgrade' }, false, 'downgrade'), true)
})


test('summary access uses current account membership, creator or public visibility', () => {
  const privateTopic = { owner: 'owner', public: 0 }
  assert.equal(membership.mayReadSummary(privateTopic, 'owner', false), true)
  assert.equal(membership.mayReadSummary(privateTopic, 'ana', true), true)
  assert.equal(membership.mayReadSummary(privateTopic, 'ana', false), false)
  assert.equal(membership.mayReadSummary(privateTopic, undefined, false), false)
  assert.equal(membership.mayReadSummary({ ...privateTopic, public: 1 }, 'ana', false), true)
})
