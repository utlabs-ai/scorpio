import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function load(entry) {
  const out = await build({
    entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
    plugins: [{
      name: 'cloudflare-workers-stub',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
      },
    }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const { RoomDO } = await load('room-do.ts')
const { Quota } = await load('room/quota.ts')

function quotaRoom({ today = 0, minute = { n: 0, first: null }, cappedDay = null } = {}) {
  return {
    messagesToday: () => today,
    countMinuteSince: () => minute,
    room: () => ({ owner: 'ana' }),
    ctx: { storage: { kv: { get: () => cappedDay } } },
  }
}

test('DO minute quota stops at the limit with the same error and wait', () => {
  const room = quotaRoom({ minute: { n: 3, first: Date.now() - 59_000 } })
  assert.throws(() => Quota.prototype.checkQuota.call(room, { msgsPerRoomMinute: 3, msgsPerRoomDay: null, msgsPerAccountDay: null }), (e) => {
    assert.equal(e.code, 'rate_limited')
    assert.equal(e.status, 429)
    assert.match(e.next, /More than 3 messages in this topic within a minute/)
    assert.ok(e.retryAfter >= 1)
    return true
  })
  assert.doesNotThrow(() => Quota.prototype.checkQuota.call(room, { msgsPerRoomMinute: 4, msgsPerRoomDay: null, msgsPerAccountDay: null }))
})

test('DO room and account day quotas still stop only at their limits', () => {
  const room = quotaRoom({ today: 5 })
  const limits = { msgsPerRoomMinute: 10, msgsPerRoomDay: 5, msgsPerAccountDay: null }
  assert.throws(() => Quota.prototype.checkQuota.call(room, limits), (e) => e.code === 'quota_exceeded' && e.next.includes('5 per topic per day'))
  assert.doesNotThrow(() => Quota.prototype.checkQuota.call(room, { ...limits, msgsPerRoomDay: null }))
  const day = new Date().toISOString().slice(0, 10)
  const capped = quotaRoom({ cappedDay: day })
  assert.throws(() => Quota.prototype.checkQuota.call(capped, { ...limits, msgsPerRoomDay: null, msgsPerAccountDay: 20 }), (e) => e.code === 'quota_exceeded' && e.next.includes('20 messages today'))
  assert.doesNotThrow(() => Quota.prototype.checkQuota.call(capped, { ...limits, msgsPerRoomDay: null, msgsPerAccountDay: null }))
})

test('DO does not read accountCapped KV when the account has no daily limit', () => {
  const room = quotaRoom()
  room.ctx.storage.kv.get = () => { throw Error('unexpected KV read') }
  assert.doesNotThrow(() => Quota.prototype.checkQuota.call(room, { msgsPerRoomMinute: 10, msgsPerRoomDay: null, msgsPerAccountDay: null }))
})

function counted(before, limit) {
  const sent = []
  const pushed = []
  const saved = []
  const room = {
    messagesToday: () => before,
    ctx: {
      storage: { kv: { put: (...args) => saved.push(args) } },
      waitUntil: () => {},
      getWebSockets: () => ['browser'],
    },
    afterCount: async () => {},
    safeSend: (...args) => sent.push(args),
    pushQuotaWarn: (...args) => pushed.push(args),
  }
  const quota = Quota.prototype.countMessage.call(room, { msgsPerRoomDay: limit }, 4)
  return { quota, sent, pushed, saved }
}

test('DO sends quota at 80 percent, warns once, and reports every 20 messages', () => {
  const below = counted(78, 100)
  assert.equal(below.quota, undefined)
  assert.equal(below.sent.length, 0)
  const crossing = counted(79, 100)
  assert.equal(crossing.quota.used, 80)
  assert.equal(crossing.quota.limit, 100)
  assert.deepEqual(crossing.pushed, [[{ used: 80, limit: 100, resetsAt: crossing.quota.resetsAt }]])
  assert.equal(JSON.parse(crossing.sent[0][1]).type, 'quota')
  assert.equal(crossing.saved[0][0], 'dayCount')
  assert.equal(counted(80, 100).pushed.length, 0)
  assert.equal(counted(79, null).quota, undefined)
  assert.equal(counted(18, null).saved.length, 0)
})

test('DO ops threshold accepts a positive override and falls back for zero', async () => {
  const room = (roomDbAlertBytes) => ({
    opsCfg: null,
    env: { KV: { get: async () => ({ roomDbAlertBytes }) } },
  })
  assert.equal(await Quota.prototype.roomDbAlertBytes.call(room(123)), 123)
  assert.equal(await Quota.prototype.roomDbAlertBytes.call(room(0)), 1024 ** 3)
})

test('DO does not read dbAlerted KV when database size is below its threshold', async () => {
  const room = {
    roomInfo: () => ({ id: 'room-1', owner: 'ana' }),
    roomDbAlertBytes: async () => 100,
    ctx: { storage: { sql: { databaseSize: 99 }, kv: { get: () => { throw Error('unexpected KV read') } } } },
  }
  await Quota.prototype.afterCount.call(room, { msgsPerAccountDay: null }, 'today', 1)
})

const quota = await load('room-quota.ts')

test('minuteLimit is absent below the cap and keeps the exact wait at and above it', () => {
  const nowMs = 100_000
  assert.equal(quota.minuteLimit({ n: 2, first: nowMs - 59_000 }, 3, nowMs), null)
  assert.deepEqual(quota.minuteLimit({ n: 3, first: nowMs - 59_000 }, 3, nowMs), { wait: 1 })
  assert.deepEqual(quota.minuteLimit({ n: 4, first: nowMs - 57_001 }, 3, nowMs), { wait: 3 })
  assert.deepEqual(quota.minuteLimit({ n: 3, first: null }, 3, nowMs), { wait: 60 })
})

test('dayLimitHit holds the exact day boundary and unlimited branch', () => {
  assert.equal(quota.dayLimitHit(4, 5), false)
  assert.equal(quota.dayLimitHit(5, 5), true)
  assert.equal(quota.dayLimitHit(6, 5), true)
  assert.equal(quota.dayLimitHit(6, null), false)
})

test('accountCapped needs the same day and a finite account limit', () => {
  assert.equal(quota.accountCapped('today', 'today', 20), true)
  assert.equal(quota.accountCapped('yesterday', 'today', 20), false)
  assert.equal(quota.accountCapped(null, 'today', 20), false)
  assert.equal(quota.accountCapped('today', 'today', null), false)
})

test('countsNow fires exactly on each count interval', () => {
  assert.equal(quota.countsNow(19, 20), false)
  assert.equal(quota.countsNow(20, 20), true)
  assert.equal(quota.countsNow(21, 20), false)
  assert.equal(quota.countsNow(40, 20), true)
})

test('quotaFrame begins at 80 percent and warns only on the first crossing', () => {
  assert.deepEqual(quota.quotaFrame(79, 78, 100, 999), { quota: undefined, warnOwner: false })
  assert.deepEqual(quota.quotaFrame(80, 79, 100, 999), { quota: { used: 80, limit: 100, resetsAt: 999 }, warnOwner: true })
  assert.deepEqual(quota.quotaFrame(81, 80, 100, 999), { quota: { used: 81, limit: 100, resetsAt: 999 }, warnOwner: false })
  assert.deepEqual(quota.quotaFrame(101, 100, 100, 999), { quota: { used: 101, limit: 100, resetsAt: 999 }, warnOwner: false })
  assert.deepEqual(quota.quotaFrame(80, 79, null, 999), { quota: undefined, warnOwner: false })
})

test('usageDelta subtracts only a report from the same day', () => {
  assert.equal(quota.usageDelta({ day: 'today', n: 20 }, 'today', 20), 0)
  assert.equal(quota.usageDelta({ day: 'today', n: 20 }, 'today', 21), 1)
  assert.equal(quota.usageDelta({ day: 'yesterday', n: 20 }, 'today', 21), 21)
  assert.equal(quota.usageDelta(null, 'today', 21), 21)
})

test('dbAlertDue needs size above threshold and no alert today', () => {
  assert.equal(quota.dbAlertDue(99, 100, null, 'today'), false)
  assert.equal(quota.dbAlertDue(100, 100, null, 'today'), false)
  assert.equal(quota.dbAlertDue(101, 100, null, 'today'), true)
  assert.equal(quota.dbAlertDue(101, 100, 'today', 'today'), false)
})

test('opsThreshold uses positive finite override or the provided fallback', () => {
  assert.equal(quota.opsThreshold({ roomDbAlertBytes: 100 }, 1024), 100)
  assert.equal(quota.opsThreshold({ roomDbAlertBytes: 0 }, 1024), 1024)
  assert.equal(quota.opsThreshold({ roomDbAlertBytes: -1 }, 1024), 1024)
  assert.equal(quota.opsThreshold({ roomDbAlertBytes: 'bad' }, 1024), 1024)
  assert.equal(quota.opsThreshold(null, 1024), 1024)
})
