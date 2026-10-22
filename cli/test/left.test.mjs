// A topic this account left stays left: up to 0.5.3 the seat kept the left
// entries, so the next round joined the topic again (a public one let it back in; a private one was retried every
// 5 minutes). Private and public, after a leave and for state an older daemon left behind; and a topic where only
// the agents handed over is not touched (its seat waits for the takeover line).
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-left-'))
process.env.SCORPIO_HOME = home
const { createSeat, strandedSeat } = await import('../src/daemon/seat.mjs')
const { topicLeft } = await import('../src/daemon/main.mjs')
const { register, markLeft, entries, leftEntries, dropRoom, readRegistry } = await import('../src/daemon/registry.mjs')

const PRIV = 'Rprivate00000000000001', PUB = 'Rpublic000000000000001', KEPT = 'Rhandover0000000000001'
const people = (person, extra = []) => [...(person ? [{ name: 'kai', kind: 'human', owner: 'kai', status: person }] : []), { name: 'daemon@kai', kind: 'host', owner: 'kai', status: 'active' }, ...extra]

function machine({ locked = [] } = {}) {
  const joins = [], left = []
  const api = {
    join: async (roomId, body) => {
      joins.push(roomId)
      if (locked.includes(roomId)) throw Object.assign(new Error('code_required'), { code: 'code_required' })
      return { name: `${body.role}@kai`, kind: 'host', roomName: roomId, topic: '', owner: 'mei' }
    },
    rooms: async () => [],
    leave: async (roomId, role) => { left.push([roomId, role]); return {} },
  }
  const rooms = { get: () => null, update: () => ({}) }
  const terminal = { panes: async () => [] }
  const seat = createSeat({ api, terminal, rooms, hostname: 'box', stateFile: path.join(home, `seat-${Math.random()}.json`), sleep: async () => {} })
  const round = async () => { joins.length = 0; await seat.prepare({ entries: entries(), pruned: [] }); return [...joins] }
  return { seat, joins, left, round, unlock: (roomId) => locked.splice(locked.indexOf(roomId), 1) }
}
const fresh = () => { for (const r of Object.keys(readRegistry())) dropRoom(r) }

test('strandedSeat: the person left and only seats are in; not when the person is in, never joined, or an agent is back', () => {
  assert.equal(strandedSeat(people('left'), 'kai'), true)
  assert.equal(strandedSeat(people('active'), 'kai'), false)
  assert.equal(strandedSeat(people(null), 'kai'), false, 'agents only, handed over: the seat waits for the takeover')
  assert.equal(strandedSeat(people('left', [{ name: 'api@kai', kind: 'agent', owner: 'kai', status: 'active' }]), 'kai'), false)
  assert.equal(strandedSeat(people('left', [{ name: 'api@kai', kind: 'agent', owner: 'kai', status: 'left' }]), 'kai'), true)
})

test('after a leave (private and public): the entries there go and the next round joins neither', async () => {
  fresh()
  const m = machine()
  register({ roomId: PRIV, name: 'api@kai', role: 'api', pane: 'p1' })
  register({ roomId: PUB, name: 'web@kai', role: 'web', pane: 'p2' })
  register({ roomId: PUB, name: 'old@kai', role: 'old', pane: 'p3' })
  markLeft({ roomId: PUB, name: 'old@kai' }) // handed over earlier
  assert.deepEqual((await m.round()).sort(), [PRIV, PUB].sort())
  for (const roomId of [PRIV, PUB]) topicLeft(roomId, { type: 'removed', account: 'kai', by: 'kai' }, { leftTopic: m.seat.leftTopic, log: () => {} })
  assert.deepEqual(entries().filter((e) => [PRIV, PUB].includes(e.roomId)), [])
  assert.deepEqual(leftEntries().filter((e) => [PRIV, PUB].includes(e.roomId)), [], 'the left entry there went too')
  assert.deepEqual(await m.round(), [], 'neither is joined again')
  assert.deepEqual(Object.keys(m.seat.state.rooms), [])
})

test('state from 0.5.2–0.5.3, private: the seat cannot join (code_required), so what is left of the topic here goes', async () => {
  fresh()
  const m = machine({ locked: [PRIV] })
  register({ roomId: PRIV, name: 'api@kai', role: 'api', pane: 'p1' })
  markLeft({ roomId: PRIV, name: 'api@kai' }) // what topicLeft did up to 0.5.3
  assert.deepEqual(await m.round(), [PRIV])
  assert.equal(readRegistry()[PRIV], undefined)
  assert.deepEqual(await m.round(), [], 'not tried again')
  // Back in (the person entered with the passcode, an agent joined): the seat joins at once, not 5 minutes later.
  m.unlock(PRIV)
  register({ roomId: PRIV, name: 'api@kai', role: 'api', pane: 'p1' })
  assert.deepEqual(await m.round(), [PRIV])
})

test('state from 0.5.2–0.5.3, public: the seat got back in; its room frame shows the person left, so it leaves again', async () => {
  fresh()
  const m = machine()
  register({ roomId: PUB, name: 'web@kai', role: 'web', pane: 'p2' })
  markLeft({ roomId: PUB, name: 'web@kai' })
  assert.deepEqual(await m.round(), [PUB])
  assert.equal(await m.seat.stranded(PUB, people('left', [{ name: 'web@kai', kind: 'agent', owner: 'kai', status: 'left' }])), true)
  assert.deepEqual(m.left, [[PUB, m.seat.role]], 'the seat leaves, as itself')
  assert.equal(readRegistry()[PUB], undefined)
  assert.deepEqual(await m.round(), [], 'not joined again')
})

test('a topic where the agents only handed over is left alone: the seat stays for the takeover line', async () => {
  fresh()
  const m = machine()
  register({ roomId: KEPT, name: 'api@kai', role: 'api', pane: 'p1' })
  markLeft({ roomId: KEPT, name: 'api@kai' }) // its own leave after /handoff
  assert.deepEqual(await m.round(), [KEPT])
  for (const person of ['active', null]) assert.equal(await m.seat.stranded(KEPT, people(person, [{ name: 'api@kai', kind: 'agent', owner: 'kai', status: 'left' }])), false)
  assert.deepEqual(m.left, [])
  assert.deepEqual(leftEntries().map((e) => e.roomId), [KEPT])
  assert.deepEqual(await m.round(), [], 'already joined this run: nothing new to join')
  assert.deepEqual(Object.keys(m.seat.state.rooms), [KEPT])
})
