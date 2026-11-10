import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { worker, ORIGIN } from './helpers/worker.mjs'

// The send contract (split by domain, S6): what a send answers over HTTP and what it puts on the sockets, recorded once
// on the code from before tasks left RoomDO. Moving tasks out (S6a) and reshaping doSend into steps (S6b) change neither
// this file nor its golden; RECORD_SEND_GOLDEN=1 is only for that first recording.
const golden = new URL('./send-contract.golden.json', import.meta.url)

// countMessage runs after the message is written and before done= closes its task: failing it there shows which
// writes a send has made by then.
const append = `
export class TestRoom extends RoomDO {
  countMessage(...a) { if (this.ctx.storage.kv.get('test:failCount')) throw new Error('forced'); return super.countMessage(...a) }
  async testFlag(k, v) { if (v) this.ctx.storage.kv.put(k, v); else this.ctx.storage.kv.delete(k); }
}`
// A task-write limit the main topic stays under and the rate topic drains quickly; message limits never come first.
const limits = { self: { todoWritesPerRoomMinute: 20, msgsPerRoomMinute: 1000 } }
// The todo frame comes from the alarm about a second after the change; a step waits this long before saying "none".
const QUIET_MS = 3000
// Topics have a passcode, so no public snapshot timer (10 s) shares the alarm with the todo frame; the public-topic test
// at the end covers the two together.
const CODE = 'XK7-9QD-4M2'
const timeKeys = new Set(['ts', 'ms', 'at', 'since', 'createdMs', 'updatedMs', 'doneMs', 'openedMs', 'createdAt', 'nextAt'])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(ok, ms) {
  const end = Date.now() + ms
  while (!(await ok()) && Date.now() < end) await sleep(20)
  return ok()
}

async function socket(res) {
  assert.equal(res.status, 101, await res.text().catch(() => ''))
  const frames = []
  res.webSocket.addEventListener('message', (e) => frames.push(JSON.parse(e.data)))
  res.webSocket.accept()
  return { frames, ws: res.webSocket }
}

test('a send keeps its answer, message frames and todo frame', async () => {
  const w = await worker({ TEST_LIMITS: JSON.stringify(limits) }, { append, className: 'TestRoom' })
  const sockets = []
  try {
    const kai = await w.person('kai'), lee = await w.person('lee')
    const placeholders = new Map()
    const norm = (value) => {
      if (Array.isArray(value)) return value.map(norm)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, timeKeys.has(k) && typeof v === 'number' ? 0 : norm(v)]))
      }
      if (typeof value === 'string') {
        let s = value
        for (const [id, label] of placeholders) s = s.split(id).join(label)
        return s
      }
      return value
    }

    // One topic: owner kai, person lee, agents api@kai and helper@lee. kai's browser sees api@kai's delivery;
    // helper@lee's own socket sees what wakes it.
    async function cast(label) {
      const room = await w.topic(kai, CODE)
      placeholders.set(room, `<${label}>`)
      assert.equal((await lee.post(`/r/${room}/enter`, { code: CODE })).status, 200)
      assert.equal((await w.join(kai, room, 'api')).status, 200)
      assert.equal((await w.join(lee, room, 'helper')).status, 200)
      const browser = await socket(await kai.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } }))
      const agent = await socket(await lee.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, 'helper'))
      sockets.push(browser.ws, agent.ws)
      assert.ok(await until(() => browser.frames.filter((f) => f.type === 'members').length >= 2 && agent.frames.length > 0, 10_000), 'sockets ready')
      await sleep(200)
      const t = { room, browser, agent }
      clear(t)
      const api = (path, init) => kai.api(`/rooms/${room}${path}`, init, 'api')
      return {
        ...t,
        api: (sub, body) => kai.apiPost(`/rooms/${room}/${sub}`, body, 'api'),
        helper: (sub, body) => lee.apiPost(`/rooms/${room}/${sub}`, body, 'helper'),
        lee: (sub, body) => lee.post(`/r/${room}/${sub}`, body),
        get: (path) => api(path),
        upload: (name, type, text) => api('/files', { method: 'POST', body: text, headers: { 'content-type': type, 'x-file-name': name } }),
      }
    }
    function clear(t) {
      t.browser.frames.length = 0
      t.agent.frames.length = 0
    }
    async function json(res) {
      const text = await res.text()
      try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
    }
    // Writes that are not the case itself. When they change tasks, their todo frames are let through before the case:
    // the first, and any that follows within 1.5 s (writes spread over more than a second get a frame each).
    async function setup(t, todo, ...requests) {
      const out = []
      for (const request of requests) {
        const r = await json(await request())
        assert.ok(r.status === 200, `setup: ${JSON.stringify(r)}`)
        out.push(r.body)
      }
      const todos = () => t.browser.frames.filter((f) => f.type === 'todo').length
      if (todo) {
        assert.ok(await until(() => todos() > 0, 15_000), 'setup todo frame')
        for (let n = todos(); await until(() => todos() > n, 1500); n = todos());
      }
      await sleep(100)
      clear(t)
      return out
    }

    // A loaded machine can hold the alarm past QUIET_MS, so a step waits (up to 15 s) for the frames the golden has for
    // it, and QUIET_MS more only to catch a todo frame the golden does not have.
    const expected = process.env.RECORD_SEND_GOLDEN === '1' ? new Map() : new Map(JSON.parse(fs.readFileSync(golden, 'utf8')).map((r) => [r.step, r]))
    const records = []
    async function step(name, t, request, after) {
      clear(t)
      const r = await json(await request())
      const want = expected.get(name)
      if (want) await until(() => t.browser.frames.length >= want.browser.types.length && t.agent.frames.length >= want.agent.types.length, 15_000)
      if (!want || want.browser.todo === 'none') await until(() => t.browser.frames.some((f) => f.type === 'todo'), QUIET_MS)
      const { browser, agent } = t
      const record = {
        step: name,
        status: r.status,
        body: r.body,
        browser: {
          types: browser.frames.map((f) => f.type),
          message: browser.frames.find((f) => f.type === 'message') ?? 'none',
          todo: browser.frames.find((f) => f.type === 'todo') ?? 'none',
        },
        agent: {
          types: agent.frames.map((f) => f.type),
          push: agent.frames.find((f) => f.type === 'push') ?? 'none',
        },
      }
      if (after) record.after = (await json(await after())).body
      records.push(norm(record))
      return r.body
    }

    const main = await cast('topic')

    // 1. A plain send.
    const plain = await step('1 plain send', main, () => main.api('send', { text: '@kai The build is green.' }))

    // 2. add= with to= a person, under a nonce (case 10 replays it).
    const addBody = { text: '@lee Please review the draft.', add: 'Review the draft', to: 'lee', nonce: 'case-2' }
    await step('2 add to person', main, () => main.api('send', addBody))

    // 3. done= on a valid task that another one waits for.
    await setup(main, true,
      () => main.api('todo', { op: 'add', title: 'Fix the login bug', to: 'api@kai', from: plain.seq }),
      () => main.api('todo', { op: 'add', title: 'Release the fix', to: 'api@kai', from: plain.seq, after: ['T2'] }))
    await step('3 done', main, () => main.api('send', { text: '@kai Fixed the login bug.', done: 'T2' }))

    // 4. done= on a task that does not exist: the message stands.
    await step('4 done missing', main, () => main.api('send', { text: '@kai Done with that one.', done: 'T999' }))

    // 5. update= with to= and title=.
    await step('5 update to and title', main, () => main.api('send', { text: '@lee Please take over the release.', update: 'T3', to: 'lee', title: 'Release v2' }))

    // 6. update= on a task that does not exist.
    await step('6 update missing', main, () => main.api('send', { text: '@kai Updating a missing task.', update: 'T999' }))

    // 7. update= of helper@lee's doing task, handed on without force.
    await setup(main, true,
      () => main.helper('todo', { op: 'add', title: 'Check the logs', to: 'helper@lee', from: plain.seq }),
      () => main.helper('todo', { op: 'take', id: 'T4' }))
    await step('7 update taken', main, () => main.api('send', { text: '@helper@lee I will handle the logs.', update: 'T4', to: 'api@kai' }))

    // 8. lee answers on the web, into the thread of a task under lee that helper@lee opened: the reply reports to
    // helper@lee, which lee's message wakes.
    const [asked] = await setup(main, true,
      () => main.helper('send', { text: '@lee Can you confirm the log level?', add: 'Confirm the log level', to: 'lee' }))
    await step('8 person reply into thread', main, () => main.lee('send', { text: '@kai Debug level is fine.', replyTo: asked.seq }))

    // 9. A message naming a task's one T number joins its thread.
    await step('9 T-number join', main, () => main.api('send', { text: '@lee Any news on T1?' }))

    // 10. The nonce replay of case 2, and of an add= with done=.
    await step('10a replay add', main, () => main.api('send', addBody))
    await setup(main, true, () => main.api('todo', { op: 'add', title: 'Prepare the release notes', to: 'api@kai', from: plain.seq }))
    const addDone = { text: '@kai The release notes are out.', done: 'T6', add: 'Announce the release', nonce: 'case-10' }
    await step('10b add and done', main, () => main.api('send', addDone))
    await step('10c replay add and done', main, () => main.api('send', addDone))

    // 11. A scheduled post sent now (the plan is self: no PLANS binding).
    await setup(main, false, () => main.api('schedules', { op: 'add', text: '@lee Reminder: T1 is still open.', rule: { kind: 'once', at: Date.UTC(2030, 0, 1, 9) } }))
    await step('11 scheduled send now', main, () => main.api('schedules', { op: 'send', id: 'S1' }))

    // 12. countMessage fails after the message is written, with done=: in its own topic, since the failure leaves
    // the flag and the quota's in-memory counters behind.
    const fail = await cast('topic-fail')
    const [report] = await setup(fail, false, () => fail.api('send', { text: '@kai The app crashes on start.' }))
    await setup(fail, true, () => fail.api('todo', { op: 'add', title: 'Fix the crash', to: 'api@kai', from: report.seq }))
    const ns = await w.mf.getDurableObjectNamespace('ROOMS')
    await ns.get(ns.idFromName(fail.room)).testFlag('test:failCount', true)
    await step('12 countMessage fails', fail, () => fail.api('send', { text: '@kai Fixed the crash.', done: 'T1' }), () => fail.get('/todo/T1'))

    // 13. One file: uploaded, claimed by the send, attached to its message.
    const [file] = await setup(main, false, () => main.upload('notes.txt', 'text/plain', 'release notes'))
    placeholders.set(file.id, '<file-1>')
    await step('13 file', main, () => main.api('send', { text: '@kai Notes attached.', files: [file.id] }))

    // 14. Refused before anything is written.
    await step('14a update with done', main, () => main.api('send', { text: '@kai Both at once.', update: 'T1', done: 'T1' }))
    await step('14b add to person not mentioned', main, () => main.api('send', { text: '@kai A task for lee.', add: 'Task for lee', to: 'lee' }))

    // 14c. Task writes exhausted: drained with todo add from=, which writes no message, then send add= is refused.
    // The limit counts per calendar minute, so the drain and the send start early in one.
    const rate = await cast('topic-rate')
    const [seed] = await setup(rate, false, () => rate.api('send', { text: '@kai Seed for the drain.' }))
    if (Date.now() % 60_000 > 40_000) await sleep(60_000 - (Date.now() % 60_000) + 100)
    let drained = 0
    for (;;) {
      const res = await rate.api('todo', { op: 'add', title: `Drain ${drained + 1}`, from: seed.seq })
      await res.text()
      if (res.status === 429) break
      assert.equal(res.status, 200)
      assert.ok(++drained <= limits.self.todoWritesPerRoomMinute, 'the drain reaches the limit')
    }
    await setup(rate, true)
    await step('14c task writes exhausted', rate, () => rate.api('send', { text: '@kai One more task.', add: 'One more' }))

    const recorded = `${JSON.stringify(records, null, 2)}\n`
    if (process.env.RECORD_SEND_GOLDEN === '1') fs.writeFileSync(golden, recorded)
    assert.deepEqual(records, JSON.parse(fs.readFileSync(golden, 'utf8')))
  } finally {
    for (const ws of sockets) try { ws.close() } catch {}
    await w.dispose()
  }
})

// The todo frame and a public topic's snapshot share the room's one alarm, and one event can arm both. Each arming must
// aim at the earliest due time, or the later write pushes the other back: the todo frame of a send with add= came
// 10 s late, and a schedule added to a public topic held its snapshot until the schedule's first run.
async function publicTopic() {
  const w = await worker()
  const kai = await w.person('kai')
  const room = await w.topic(kai)
  assert.equal((await w.join(kai, room, 'api')).status, 200)
  const browser = await socket(await kai.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } }))
  const api = async (sub, body) => (await kai.apiPost(`/rooms/${room}/${sub}`, body, 'api')).json()
  const total = async () => JSON.parse((await w.kv.get(`public:${room}`)) || '{"total":0}').total
  // A case starts once the snapshot holds the last message: then no alarm is pending.
  const settled = async (seq) => {
    assert.ok(await until(async () => (await total()) >= seq, 15_000), `snapshot through #${seq}`)
    await sleep(200)
  }
  await settled((await api('send', { text: '@kai Seed.' })).seq)
  return { browser, api, total, settled, dispose: async () => { try { browser.ws.close() } catch {} await w.dispose() } }
}

test('in a public topic a send with add= has its todo frame within 2 s', async () => {
  const t = await publicTopic()
  try {
    t.browser.frames.length = 0
    const sent = Date.now()
    const added = await t.api('send', { text: '@kai Review the draft.', add: 'Review the draft', to: 'api@kai' })
    assert.equal(added.item?.id, 'T1')
    assert.ok(await until(() => t.browser.frames.some((f) => f.type === 'todo'), 2000), `todo frame within 2 s of the send (waited ${Date.now() - sent} ms)`)
  } finally { await t.dispose() }
})

test('in a public topic adding a schedule leaves the snapshot rewritten within 12 s', async () => {
  const t = await publicTopic()
  try {
    const before = await t.total()
    const scheduled = await t.api('schedules', { op: 'add', text: '@kai Hourly check.', rule: { kind: 'every', minutes: 60 } })
    assert.equal(scheduled.item?.id, 'S1')
    assert.ok(await until(async () => (await t.total()) > before, 12_000), 'snapshot rewritten within 12 s of adding a schedule')
  } finally { await t.dispose() }
})
