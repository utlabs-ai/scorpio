// The overview as one pure function (docs/api/topics.md "The overview"): the counting rules, the lane grouping and
// every order, from plain rows.
import assert from 'node:assert/strict'
import test from 'node:test'
import { overviewOf, OVERVIEW_WINDOW_MS, DELIVERED_WEIGHT } from '../src/room/overview.ts'

const SINCE = 1_000_000, UNTIL = SINCE + OVERVIEW_WINDOW_MS
const member = (name, kind, extra = {}) => ({ name, kind, lane: null, status: 'active', online: false, lastActive: null, ...extra })
const world = () => ({
  roomId: 'R',
  since: SINCE, until: UNTIL, person: 'kai',
  members: [
    member('kai', 'human', { online: true, lastActive: UNTIL }),
    member('mei', 'human'),
    member('zoe', 'human'),                                               // silent: not listed
    member('box-daemon@kai', 'host', { online: true }),                   // computer seat: never a node
    member('api@kai', 'agent', { lane: 'billing', online: true, lastActive: UNTIL }),
    member('web@kai', 'agent', { lane: 'billing', online: false, lastActive: SINCE + 1 }),
    member('docs@mei', 'agent', { lane: null, status: 'left', lastActive: SINCE + 5 }),
    member('old@kai', 'agent', { lane: 'release', status: 'left', lastActive: SINCE - 1 }), // nothing in the window: not listed
    member('quiet@kai', 'agent', { lane: 'daemon', online: true, lastActive: UNTIL }),     // active in the window, no messages
  ],
  sent: [
    { from_name: 'kai', from_kind: 'human', n: 40 },
    { from_name: 'mei', from_kind: 'human', n: 1 },
    { from_name: 'api@kai', from_kind: 'agent', n: 80 },
    { from_name: 'web@kai', from_kind: 'agent', n: 5 },
    { from_name: 'docs@mei', from_kind: 'agent', n: 2 },
    { from_name: 'scheduled', from_kind: 'scheduled', n: 7 },
    { from_name: 'gone@kai', from_kind: 'agent', n: 3 },               // no longer a member: counted in messages only
  ],
  mentions: [
    { from_name: 'kai', from_kind: 'human', target: 'api@kai', n: 30 },
    { from_name: 'api@kai', from_kind: 'agent', target: 'kai', n: 1 },
    { from_name: 'api@kai', from_kind: 'agent', target: 'web@kai', n: 9 },
    { from_name: 'web@kai', from_kind: 'agent', target: 'api@kai', n: 2 },
    { from_name: 'api@kai', from_kind: 'agent', target: 'api@kai', n: 4 },           // oneself: nothing
    { from_name: 'kai', from_kind: 'human', target: 'box-daemon@kai', n: 12 },        // a computer seat: nothing
    { from_name: 'scheduled', from_kind: 'scheduled', target: 'api@kai', n: 7 },
    { from_name: 'gone@kai', from_kind: 'agent', target: 'docs@mei', n: 1 },          // a sender no longer here: the @ counts, no pair
    { from_name: 'mei', from_kind: 'human', target: 'nobody@mei', n: 3 },             // a target no longer here: nothing
    { from_name: 'mei', from_kind: 'human', target: 'docs@mei', n: 1 },
  ],
  delivered: [{ assignee: 'api@kai', n: 3 }, { assignee: 'kai', n: 2 }, { assignee: 'gone@kai', n: 1 }],
})

test('counts: sent, mentioned, delivered and activity per node; messages is the window total', () => {
  const o = overviewOf(world())
  assert.equal(o.roomId, 'R')
  assert.deepEqual([o.since, o.until], [SINCE, UNTIL])
  assert.equal(o.messages, 138)
  assert.deepEqual(o.agents, [
    { name: 'api@kai', lane: 'billing', activity: 80 + 39 + DELIVERED_WEIGHT * 3, sent: 80, mentioned: 39, delivered: 3 },
    { name: 'web@kai', lane: 'billing', activity: 14, sent: 5, mentioned: 9, delivered: 0 },
    { name: 'docs@mei', lane: null, activity: 4, sent: 2, mentioned: 2, delivered: 0 },
    { name: 'quiet@kai', lane: 'daemon', activity: 0, sent: 0, mentioned: 0, delivered: 0 },
  ])
  // people: the caller first, then by name; a person's delivered tasks do not count
  assert.deepEqual(o.people, [{ name: 'kai', sent: 40, mentioned: 1 }, { name: 'mei', sent: 1, mentioned: 0 }])
})

test('pairs add both directions, a sorts before b, most first; scheduled per target', () => {
  const o = overviewOf(world())
  assert.deepEqual(o.pairs, [
    { a: 'api@kai', b: 'kai', n: 31 },
    { a: 'api@kai', b: 'web@kai', n: 11 },
    { a: 'docs@mei', b: 'mei', n: 1 },
  ])
  assert.deepEqual(o.scheduled, [{ to: 'api@kai', n: 7 }])
})

test('lanes: one per word and one null, agents by activity, stacked when nobody is in and online, in draw order', () => {
  const o = overviewOf(world())
  assert.deepEqual(o.lanes, [
    { lane: 'billing', activity: 163, stacked: false, agents: ['api@kai', 'web@kai'] },
    { lane: 'daemon', activity: 0, stacked: false, agents: ['quiet@kai'] },
    { lane: null, activity: 4, stacked: true, agents: ['docs@mei'] },
  ])
})

test('ties: agents by name, lanes by name with null last; a silent caller is listed, an agent caller is not', () => {
  const w = world()
  w.sent = []; w.mentions = []; w.delivered = []
  w.members.push(member('b@kai', 'agent', { lane: 'b', lastActive: UNTIL }), member('a@kai', 'agent', { lane: 'a', lastActive: UNTIL }))
  const o = overviewOf(w)
  assert.deepEqual(o.agents.map((a) => a.name), ['a@kai', 'api@kai', 'b@kai', 'docs@mei', 'quiet@kai', 'web@kai'])
  assert.deepEqual(o.lanes.map((l) => [l.lane, l.stacked]), [['billing', false], ['daemon', false], ['a', true], ['b', true], [null, true]])
  assert.deepEqual(o.people, [{ name: 'kai', sent: 0, mentioned: 0 }])
  assert.deepEqual(overviewOf({ ...w, person: null }).people, [])
  assert.deepEqual(overviewOf({ ...w, person: 'zoe' }).people, [{ name: 'zoe', sent: 0, mentioned: 0 }])
})

test('an empty topic', () => {
  const o = overviewOf({ roomId: 'R', since: SINCE, until: UNTIL, person: 'kai', members: [member('kai', 'human')], sent: [], mentions: [], delivered: [] })
  assert.deepEqual({ ...o, people: undefined }, { roomId: 'R', since: SINCE, until: UNTIL, messages: 0, agents: [], lanes: [], pairs: [], scheduled: [], people: undefined })
})
