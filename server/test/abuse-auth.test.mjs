import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { worker } from './helpers/worker.mjs'

const legacyRoom = { className: 'LegacyRoomDO', append: `
export class LegacyRoomDO extends RoomDO {
  seedLegacyCode(code) { this.sql.exec('UPDATE room SET code = ?', code); }
  ageFailures(account, at) { this.sql.exec('UPDATE passcode_failures SET failed_at = ? WHERE account = ?', at, account); }
}` }

test('topic passcode allows ten failed guesses per account in one hour', async () => {
  const w = await worker({}, legacyRoom)
  try {
    const owner = await w.person('owner')
    const attacker = await w.person('attacker')
    const neighbor = await w.person('neighbor')
    const topic = await w.topic(owner, 'secret7')
    for (let i = 0; i < 10; i++) {
      const reply = await w.json(await attacker.apiPost(`/rooms/${topic}/join`, { role: `guess${i}`, code: 'incorrect' }))
      assert.equal(reply.status, 403)
      assert.equal(reply.error, 'bad_code')
    }
    const limited = await attacker.apiPost(`/rooms/${topic}/join`, { role: 'last', code: 'secret7' })
    assert.equal(limited.status, 429)
    assert.equal((await limited.json()).error, 'rate_limited')
    assert.ok(Number(limited.headers.get('retry-after')) > 0)
    const form = await attacker.post(`/r/${topic}/enter`, { code: 'secret7' })
    assert.equal(form.status, 429)
    assert.match(await form.text(), /Too many wrong passcodes/)
    const rooms = await w.mf.getDurableObjectNamespace('ROOMS')
    await rooms.getByName(topic).ageFailures('attacker', Date.now() - 3_600_001)
    const resumed = await w.json(await attacker.apiPost(`/rooms/${topic}/join`, { role: 'last', code: 'secret7' }))
    assert.equal(resumed.status, 200)
    const other = await w.json(await neighbor.apiPost(`/rooms/${topic}/join`, { role: 'neighbor', code: 'secret7' }))
    assert.equal(other.status, 200)
  } finally { await w.dispose() }
})

test('new short passcodes are rejected but public topics remain valid', async () => {
  const w = await worker({}, legacyRoom)
  try {
    const owner = await w.person('owner')
    const short = await w.json(await owner.apiPost('/rooms', { name: 'Short', code: 'a-b' }))
    assert.equal(short.status, 400)
    assert.equal(short.error, 'bad_code')
    const webShort = await w.json(await owner.post('/rooms', { name: 'Short', code: 'abc' }, { accept: 'application/json' }))
    assert.equal(webShort.status, 400)
    assert.equal(webShort.message, 'Use a passcode of at least 6 characters.')
    const open = await w.json(await owner.apiPost('/rooms', { name: 'Public', code: '' }))
    assert.equal(open.status, 200)
    assert.equal(open.code, null)
    const topic = await w.topic(owner, 'secret7')
    const rooms = await w.mf.getDurableObjectNamespace('ROOMS')
    await rooms.getByName(topic).seedLegacyCode('abc')
    const oldCode = await w.json(await (await w.person('guest')).apiPost(`/rooms/${topic}/join`, { role: 'guest', code: 'abc' }))
    assert.equal(oldCode.status, 200)
  } finally { await w.dispose() }
})

test('device code creation is limited by source IP before a D1 write', async () => {
  const w = await worker()
  try {
    // Miniflare resets its bucket on whole minutes; keep all eleven requests in the same window.
    const remaining = 60_000 - Date.now() % 60_000
    if (remaining < 15_000) await setTimeout(remaining)
    const post = (ip) => w.fetch('/oauth/device/code', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: '{}' })
    for (let i = 0; i < 10; i++) assert.equal((await post('192.0.2.1')).status, 200)
    const limited = await post('192.0.2.1')
    assert.equal(limited.status, 429)
    assert.deepEqual(await limited.json(), { error: 'rate_limited', next: 'Too many device codes requested. Wait a minute and retry.' })
    assert.equal(limited.headers.get('retry-after'), '60')
    assert.equal((await w.db.prepare('SELECT COUNT(*) AS n FROM device_codes').first()).n, 10)
    assert.equal((await post('192.0.2.2')).status, 200)
  } finally { await w.dispose() }
})
