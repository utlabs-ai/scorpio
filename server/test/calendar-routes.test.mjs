// The calendar subscription over HTTP: the settings address, the feed without a session, what it lists, and a reset.
import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

const unfold = (text) => text.replace(/\r\n /g, '')
const summaries = (text) => [...unfold(text).matchAll(/^SUMMARY:(.*)$/gm)].map((m) => m[1]).sort()

test('the address is made once when asked, the feed lists only the calendar schedules that @ the person in topics they are in, and a reset turns the old address off', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai'), ana = await w.person('ana')
    const first = await w.json(await kai.post('/settings/calendar'))
    assert.equal(first.status, 200, JSON.stringify(first))
    assert.match(first.url, /^https:\/\/scorpio\.test\/cal\/[A-Za-z0-9_-]{32}\.ics$/)
    assert.equal((await w.json(await kai.post('/settings/calendar'))).url, first.url)
    const path = new URL(first.url).pathname

    // Two topics of kai's, one of ana's that kai joined and left, one of ana's that kai is in.
    const own = await w.topic(kai), own2 = await w.topic(kai), anas = await w.topic(ana), left = await w.topic(ana)
    for (const r of [anas, left]) assert.equal((await w.json(await kai.apiPost(`/rooms/${r}/join`, { role: 'scout' }))).status, 200)
    for (const r of [anas, left]) assert.equal((await kai.post(`/r/${r}/enter`, { code: '' })).status, 200) // kai the person enters ana's topics
    await w.join(kai, own, 'coach'); await w.join(kai, own2, 'coach'); await w.join(ana, anas, 'bot'); await w.join(ana, left, 'bot')
    const at = Date.now() + 3_600_000
    const add = async (p, room, text, extra = {}, role) => w.json(await p.apiPost(`/rooms/${room}/schedules`, { op: 'add', text, rule: { kind: 'once', at }, ...extra }, role))
    const inFeed = await add(kai, own, '@kai Stand-up, bring numbers', { calendar: true }, 'coach')
    assert.equal(inFeed.status, 200, JSON.stringify(inFeed))
    assert.equal(inFeed.item.calendar, true)
    const plain = await add(kai, own, '@kai Not for the calendar', {}, 'coach')
    assert.equal(plain.item.calendar, false)
    const off = await add(kai, own, '@kai Turned off', { calendar: true }, 'coach')
    await w.json(await kai.apiPost(`/rooms/${own}/schedules`, { op: 'off', id: off.item.id }, 'coach'))
    const forAgent = await add(kai, own2, '@coach@kai Agent only', { calendar: true }, 'coach')
    assert.equal(forAgent.item.to.includes('kai'), false)
    const second = await add(kai, own2, '@kai Second topic', { calendar: true }, 'coach')
    assert.equal(second.status, 200)
    const byAna = await add(ana, anas, '@kai Review from ana', { calendar: true }, 'bot')
    assert.equal(byAna.status, 200, JSON.stringify(byAna))
    const inLeft = await add(ana, left, '@kai In the topic kai left', { calendar: true }, 'bot')
    assert.equal(inLeft.status, 200, JSON.stringify(inLeft))
    const leave = await w.json(await kai.post(`/r/${left}/leave`)) // the person leaves: their whole account is out of that topic
    assert.equal(leave.status, 200, JSON.stringify(leave))
    const bad = await w.json(await kai.apiPost(`/rooms/${own}/schedules`, { op: 'add', text: '@kai x', rule: { kind: 'once', at }, calendar: 'yes' }, 'coach'))
    assert.equal(bad.status, 400)
    assert.equal(bad.error, 'bad_request')

    const res = await w.fetch(path)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8')
    assert.equal(res.headers.get('cache-control'), 'private, max-age=300')
    assert.match(res.headers.get('content-disposition'), /scorpio\.ics/)
    const text = await res.text()
    assert.deepEqual(summaries(text), ['Review from ana', 'Second topic', 'Stand-up\\, bring numbers'])
    assert.ok(text.includes(`UID:${own}-${inFeed.item.id}-${at}@scorpio.test`))
    assert.ok(text.includes(`\\nSet by coach@kai`))
    const head = await w.fetch(path, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'text/calendar; charset=utf-8')
    assert.equal(await head.text(), '')

    for (const wrong of ['/cal/nope.ics', `/cal/${'x'.repeat(32)}.ics`, `/cal/${'x'.repeat(31)}.ics`, path.replace('.ics', '')]) {
      const r = await w.fetch(wrong)
      assert.equal(r.status, 404, wrong)
    }
    const reset = await w.json(await kai.post('/settings/calendar/reset'))
    assert.notEqual(reset.url, first.url)
    assert.equal((await w.fetch(path)).status, 404)
    assert.equal((await w.fetch(new URL(reset.url).pathname)).status, 200)
    assert.equal((await w.json(await kai.post('/settings/calendar'))).url, reset.url)
    // ana's own feed: only what @s her
    const anaUrl = (await w.json(await ana.post('/settings/calendar'))).url
    assert.deepEqual(summaries(await (await w.fetch(new URL(anaUrl).pathname)).text()), [])
    // signed out: the settings endpoints need a session; the feed never does
    assert.equal((await w.fetch('/settings/calendar', { method: 'POST', headers: { origin: 'https://scorpio.test' } })).status, 401)
  } finally { await w.dispose() }
})

test('edit keeps calendar when absent, changes it when given, and the schedules list shows it', async () => {
  const w = await worker()
  try {
    const p = await w.person('mei'), room = await w.topic(p)
    await w.join(p, room, 'bot')
    const send = async (body) => w.json(await p.apiPost(`/rooms/${room}/schedules`, body, 'bot'))
    const rule = { kind: 'daily', time: '09:00', tz: 'UTC' }
    const made = await send({ op: 'add', text: '@mei Morning', rule, calendar: true })
    assert.equal(made.item.calendar, true)
    assert.equal((await send({ op: 'edit', id: made.item.id, text: '@mei Morning!' })).item.calendar, true)
    assert.equal((await send({ op: 'edit', id: made.item.id, calendar: false })).item.calendar, false)
    assert.equal((await send({ op: 'edit', id: made.item.id, calendar: 1 })).error, 'bad_request')
    const list = await w.json(await p.api(`/rooms/${room}/schedules`, {}, 'bot'))
    assert.deepEqual(list.items.map((i) => i.calendar), [false])
  } finally { await w.dispose() }
})
