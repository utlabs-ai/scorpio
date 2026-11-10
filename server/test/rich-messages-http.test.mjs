import assert from 'node:assert/strict'
import test from 'node:test'
import { worker, ORIGIN } from './helpers/worker.mjs'

const card = { kind: 'html', summary: 'Revenue 610, peak Wednesday', html: '<svg>Private fragment</svg>' }
const limits = { TEST_LIMITS: JSON.stringify({ self: { msgsPerRoomMinute: 1000 } }) }
const message = (seq, text = '@ops chart') => ({ text, buttons: [' Yes ', 'No '], card, nonce: `send-${seq}` })
const expect = async (res, status, error) => {
  const body = await res.json()
  assert.equal(res.status, status, JSON.stringify(body))
  if (error) assert.equal(body.error, error)
  return body
}

test('agent sends cards and buttons; all message reads and replay keep metadata without HTML', async () => {
  const w = await worker(limits)
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    await w.join(p, room, 'bot')
    const sent = await expect(await p.apiPost(`/rooms/${room}/send`, message(1), 'bot'), 200)
    const again = await expect(await p.apiPost(`/rooms/${room}/send`, message(1), 'bot'), 200)
    assert.equal(again.seq, sent.seq)
    for (const response of [
      await p.api(`/rooms/${room}/messages`, {}, 'bot'),
      await p.api(`/rooms/${room}/messages/${sent.seq}`, {}, 'bot'),
      await p.web(`/r/${room}/history?before=999999`),
      await p.web(`/r/${room}/around?seq=${sent.seq}`),
    ]) {
      const body = await expect(response, 200)
      const m = body.message || body.messages.find(m => m.seq === sent.seq)
      assert.equal(m.kind, 'card')
      assert.deepEqual(m.buttons, [{ label: 'Yes', by: [] }, { label: 'No', by: [] }])
      assert.deepEqual(m.card, { kind: 'html', summary: card.summary, size: Buffer.byteLength(card.html) })
      assert.equal(JSON.stringify(body).includes(card.html), false)
    }
    await expect(await p.post(`/r/${room}/send`, message(2)), 400, 'bad_request')
    for (const [buttons, code] of [[[], 'bad_buttons'], [['   '], 'bad_buttons'], [['x', ' x '], 'bad_buttons'], [['yes', 'yes'], 'bad_buttons'], [['中'.repeat(13)], 'bad_buttons']]) await expect(await p.apiPost(`/rooms/${room}/send`, { text: '@ops test', buttons }, 'bot'), 400, code)
    for (const [input, code, status] of [[{ ...card, summary: '' }, 'card_summary_required', 400], [{ ...card, html: '中'.repeat(87382) }, 'card_too_large', 413], [{ ...card, kind: 'svg' }, 'bad_request', 400]]) await expect(await p.apiPost(`/rooms/${room}/send`, { text: '@ops test', card: input }, 'bot'), status, code)
    const zh = await expect(await p.api(`/rooms/${room}/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'zh-CN' }, body: JSON.stringify({ text: '@ops test', buttons: [] }) }, 'bot'), 400, 'bad_buttons')
    assert.match(zh.next, /^按钮最多/)
    await expect(await p.apiPost(`/rooms/${room}/send`, { text: '@ops ' + '文'.repeat(9000), card: { ...card, html: 'x'.repeat(262144) } }, 'bot'), 200)
  } finally { await w.dispose() }
})

test('card reads share access; presses are ordinary replies, suppress doubles and move answers', async () => {
  const w = await worker(limits)
  try {
    const p = await w.person('ops'), guest = await w.person('guest'), room = await w.topic(p)
    await w.join(p, room, 'bot')
    await w.join(p, room, 'other') // a second agent: a press must not reach it
    const sent = await expect(await p.apiPost(`/rooms/${room}/send`, { ...message(10), add: 'Pick one', to: 'ops' }, 'bot'), 200)
    assert.deepEqual(await expect(await p.api(`/rooms/${room}/messages/${sent.seq}/card`, {}, 'bot'), 200), { seq: sent.seq, ...card, size: Buffer.byteLength(card.html) })
    await expect(await p.api(`/rooms/${room}/messages/1/card`, {}, 'bot'), 404, 'card_not_found')
    await expect(await guest.post(`/r/${room}/press`, { seq: sent.seq, index: 0 }), 403, 'forbidden')
    await expect(await p.post(`/r/${room}/press`, { seq: sent.seq, index: -1 }), 400, 'bad_request')
    await expect(await p.post(`/r/${room}/press`, { seq: sent.seq, index: '0' }), 400, 'bad_request')
    await expect(await p.post(`/r/${room}/press`, { seq: 99999, index: 0 }), 404, 'message_not_found')
    await expect(await p.post(`/r/${room}/press`, { seq: 1, index: 0 }), 400, 'bad_request')
    const [a,b] = await Promise.all([p.post(`/r/${room}/press`, { seq: sent.seq, index: 0 }), p.post(`/r/${room}/press`, { seq: sent.seq, index: 0 })])
    const results = [await expect(a, 200), await expect(b, 200)]
    assert.equal(results.filter(x => x.unchanged).length, 1)
    const reply = results.find(x => x.message)
    assert.equal(reply.message.from, 'ops')
    // To the agent that asked only, as the page's reply menu writes a reply (docs/api/messages.md): not a message to everyone.
    assert.equal(reply.message.text, '@bot@ops Yes')
    assert.deepEqual(reply.message.mentions, ['bot@ops'])
    assert.equal(reply.message.broadcast, false)
    assert.equal(reply.message.reply.seq, sent.seq)
    assert.deepEqual(reply.delivery.map(d => d.name), ['bot@ops'])
    assert.ok(reply.message.todo.some(t => t.rel === 'reply'))
    const changed = await expect(await p.post(`/r/${room}/press`, { seq: sent.seq, index: 1 }), 200)
    assert.equal(changed.message.text, '@bot@ops No')
    assert.equal(changed.message.broadcast, false)
    assert.deepEqual(changed.delivery.map(d => d.name), ['bot@ops'])
    const original = await expect(await p.api(`/rooms/${room}/messages/${sent.seq}`, {}, 'bot'), 200)
    assert.deepEqual(original.message.buttons, [{ label: 'Yes', by: [] }, { label: 'No', by: ['ops'] }])
    await expect(await p.post(`/r/${room}/press`, { seq: 0, index: 0 }), 400, 'bad_request')
    const cross = await p.post(`/r/${room}/press`, { seq: sent.seq, index: 0 }, { origin: 'https://evil.test' })
    assert.equal(cross.status, 403)
    await expect(await w.fetch(`/r/${room}/press`, { method: 'POST', headers: { origin: ORIGIN } }), 401, 'not_logged_in')
    await p.post(`/r/${room}/archive`, { on: true })
    await expect(await p.post(`/r/${room}/press`, { seq: sent.seq, index: 1 }), 409, 'room_archived')
  } finally { await w.dispose() }
})

test('summary participates in full-message and snippet search; buttons and HTML do not', async () => {
  const w = await worker(limits)
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    await w.join(p, room, 'bot')
    const sent = await expect(await p.apiPost(`/rooms/${room}/send`, { text: '@ops chart', buttons: ['ButtonOnlyTerm'], card: { ...card, summary: '营收 Revenue_610', html: '<p>FragmentOnlyTerm</p>' } }, 'bot'), 200)
    for (const term of ['营', '营收', 'Revenue_610', 'chart Revenue_610']) {
      const q = encodeURIComponent(term)
      const full = await expect(await p.api(`/rooms/${room}/messages?q=${q}`, {}, 'bot'), 200)
      assert.equal(full.messages[0]?.seq, sent.seq, term)
      const search = await expect(await p.api(`/rooms/${room}/search?in=messages&q=${q}`, {}, 'bot'), 200)
      assert.equal(search.groups.messages[0]?.seq, sent.seq, term)
      assert.match(search.groups.messages[0].snippet, /Revenue_610/)
    }
    for (const term of ['ButtonOnlyTerm', 'FragmentOnlyTerm']) {
      const r = await expect(await p.api(`/rooms/${room}/search?in=messages&q=${term}`, {}, 'bot'), 200)
      assert.deepEqual(r.groups.messages, [])
    }
  } finally { await w.dispose() }
})

test('card ticket uses fresh sealed hosts, rechecks readers, HEAD is free and GET consumes once', async () => {
  const w = await worker(limits)
  try {
    const p = await w.person('ops'), guest = await w.person('guest'), room = await w.topic(p, 'private-code')
    await w.join(p, room, 'bot')
    const sent = await expect(await p.apiPost(`/rooms/${room}/send`, message(20), 'bot'), 200)
    const path = `/r/${room}/cards/${sent.seq}/ticket`
    await expect(await guest.post(path), 403, 'not_member')
    await expect(await w.fetch(path, { method: 'POST', headers: { origin: ORIGIN } }), 401, 'not_logged_in')
    await expect(await p.post(path, {}, { origin: 'https://evil.test' }), 403, 'forbidden')
    await expect(await p.post(`/r/${room}/cards/1/ticket`), 404, 'card_not_found')
    const ticket = async theme => (await expect(await p.post(path, { theme }), 200)).url
    const first = await ticket('dark'), second = await ticket('dark')
    assert.notEqual(new URL(first).host, new URL(second).host)
    assert.equal(first.includes(room), false)
    const head = await w.fetch(first, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    const responses = await Promise.all([w.fetch(first), w.fetch(first)])
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 403])
    const frame = responses.find(r => r.status === 200)
    assert.match(frame.headers.get('content-security-policy'), /connect-src 'none'/)
    assert.match(frame.headers.get('content-security-policy'), /form-action 'none'/)
    assert.match(frame.headers.get('content-security-policy'), /frame-ancestors https:\/\/scorpio.test/)
    assert.equal(frame.headers.get('allow-csp-from'), ORIGIN)
    const html = await frame.text()
    assert.match(html, /^<!doctype html>/)
    assert.ok(html.includes(card.html))
    assert.match(html, /color-scheme:dark;--sc-fg:#e9edf5/)
    assert.match(html, /scorpio:size/)
    assert.match(html, /scorpio:ready/)
    assert.equal(frame.headers.get('set-cookie'), null)
    assert.equal((await w.fetch(second, { headers: { 'sec-fetch-dest': 'document' } })).status, 403)
    await expect(await guest.post(`/r/${room}/enter`, { code: 'private-code' }), 200)
    const removed = (await expect(await guest.post(path), 200)).url
    await expect(await guest.post(`/r/${room}/leave`), 200)
    assert.equal((await w.fetch(removed)).status, 403)
  } finally { await w.dispose() }
})

test('no ticket key is not_shown, so a page can use the summary', async () => {
  const w = await worker({ ...limits, VIEW_TICKET_KEY: undefined })
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    await w.join(p, room, 'bot')
    const sent = await expect(await p.apiPost(`/rooms/${room}/send`, message(30), 'bot'), 200)
    await expect(await p.post(`/r/${room}/cards/${sent.seq}/ticket`), 409, 'not_shown')
    const page = await p.web(`/r/${room}`)
    assert.equal(roomBoot(await page.text()).card, null)
    assert.match(page.headers.get('content-security-policy'), /frame-src 'self';/)
  } finally { await w.dispose() }
})

const roomBoot = (html) => JSON.parse(/<script type="application\/json" id="boot">(.*?)<\/script>/s.exec(html)[1])

test('the topic page may frame the content domain, and gives the card frame the file page\'s sandbox and csp', async () => {
  const w = await worker(limits)
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    const page = await p.web(`/r/${room}`)
    assert.equal(page.status, 200)
    const csp = page.headers.get('content-security-policy')
    assert.match(csp, /frame-src 'self' [a-z]+:\/\/\*\.[^ ;]+/)
    const boot = roomBoot(await page.text())
    // The file page's for HTML (file-view.ts FRAME_SANDBOX.html, FRAME_CSP.html): scripts, no network, no frame-ancestors.
    assert.equal(boot.card.sandbox, 'allow-scripts allow-same-origin')
    assert.match(boot.card.csp, /connect-src 'none'/)
    assert.doesNotMatch(boot.card.csp, /frame-ancestors/)
  } finally { await w.dispose() }
})

test('browser members and public viewers get button updates; agents only get the ordinary reply', async () => {
  const w = await worker(limits), sockets = []
  const collect = async response => {
    assert.equal(response.status, 101)
    const socket = response.webSocket, messages = []
    socket.accept(); sockets.push(socket)
    socket.addEventListener('message', event => { try { messages.push(JSON.parse(event.data)) } catch {} })
    return { socket, messages }
  }
  const next = (channel, type, predicate = () => true) => new Promise((resolve, reject) => {
    const existing = channel.messages.find(m => m.type === type && predicate(m))
    if (existing) return resolve(existing)
    const timer = setTimeout(() => { channel.socket.removeEventListener('message', listener); reject(new Error(`missing ${type}`)) }, 5000)
    const listener = event => { const m = JSON.parse(event.data); if (m.type === type && predicate(m)) { clearTimeout(timer); channel.socket.removeEventListener('message', listener); resolve(m) } }
    channel.socket.addEventListener('message', listener)
  })
  try {
    const p = await w.person('ops'), guest = await w.person('guest'), room = await w.topic(p)
    await w.join(p, room, 'bot')
    const browser = await collect(await p.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } }))
    const viewer = await collect(await guest.web(`/r/${room}/ws`, { headers: { upgrade: 'websocket', origin: ORIGIN } }))
    const agent = await collect(await p.api(`/rooms/${room}/ws`, { headers: { upgrade: 'websocket' } }, 'bot'))
    const sent = await expect(await p.apiPost(`/rooms/${room}/send`, message(40), 'bot'), 200)
    const publicTicket = await expect(await guest.post(`/r/${room}/cards/${sent.seq}/ticket`), 200)
    assert.equal((await w.fetch(publicTicket.url)).status, 200)
    const live = await next(browser, 'message', f => f.message.seq === sent.seq)
    assert.deepEqual(live.message.card, { kind: 'html', summary: card.summary, size: Buffer.byteLength(card.html) })
    const press = await expect(await p.post(`/r/${room}/press`, { seq: sent.seq, index: 0 }), 200)
    for (const channel of [browser, viewer]) {
      const frame = await next(channel, 'message_update')
      assert.deepEqual(frame.message.buttons[0].by, ['ops'])
      assert.equal('delivery' in frame.message, false)
      assert.equal('html' in frame.message.card, false)
    }
    const reply = await next(agent, 'push', f => f.message.seq === press.seq)
    assert.equal(reply.message.text, '@bot@ops Yes')
    assert.equal(agent.messages.some(m => m.type === 'message_update'), false)
    // A second agent of the same account receives the card in its daemon-style push envelope as metadata only.
    await w.join(p, room, 'other')
    const toAgent = await expect(await p.apiPost(`/rooms/${room}/send`, { text: '@bot@ops chart', card }, 'other'), 200)
    const envelope = await next(agent, 'push', f => f.message.seq === toAgent.seq)
    assert.deepEqual(envelope.message.card, live.message.card)
    assert.equal(JSON.stringify(envelope).includes(card.html), false)
    const listen = await expect(await p.api(`/rooms/${room}/listen`, {}, 'bot'), 200)
    assert.deepEqual(listen.mentions.find(m => m.seq === toAgent.seq).card, live.message.card)
  } finally { for (const s of sockets) s.close(); await w.dispose() }
})


test('a press to an agent that left answers like a send: its delivery row is left, with the takeover command', async () => {
  const w = await worker(limits)
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    const host = await w.json(await p.apiPost(`/rooms/${room}/join`, { role: 'box-daemon', host: true, machine: 'box' }))
    await w.join(p, room, 'bot')
    const sent = await expect(await p.apiPost(`/rooms/${room}/send`, { text: '@ops pick', buttons: ['Yes', 'No'] }, 'bot'), 200)
    const command = `@${host.name} /spawn claude bot ~/work task`
    const left = await expect(await p.apiPost(`/rooms/${room}/send`, { text: ['@ops takeover command:', '```', command, '```'].join('\n') }, 'bot'), 200)
    await expect(await p.apiPost(`/rooms/${room}/leave`, {}, 'bot'), 200)
    const press = await expect(await p.post(`/r/${room}/press`, { seq: sent.seq, index: 0 }), 200)
    assert.equal(press.message.text, '@bot@ops Yes')
    assert.ok(press.seq > left.seq)
    assert.deepEqual(press.delivery, [{ name: 'bot@ops', status: 'left', takeover: command, takeover_seq: left.seq }])
  } finally { await w.dispose() }
})

test('press refuses agents and leaves button state unchanged when the ordinary send hits quota', async () => {
  const w = await worker({ TEST_LIMITS: JSON.stringify({ self: { msgsPerRoomDay: 1, msgsPerRoomMinute: 1000 } }) })
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    await w.join(p, room, 'bot')
    const sent = await expect(await p.apiPost(`/rooms/${room}/send`, message(50), 'bot'), 200)
    const stub = (await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room)
    const agent = await stub.press({ kind: 'agent', account: 'ops', name: 'bot@ops' }, sent.seq, 0)
    assert.equal(agent.err.code, 'forbidden')
    await expect(await p.post(`/r/${room}/press`, { seq: sent.seq, index: 0 }), 429, 'quota_exceeded')
    const original = await expect(await p.api(`/rooms/${room}/messages/${sent.seq}`, {}, 'bot'), 200)
    assert.deepEqual(original.message.buttons, [{ label: 'Yes', by: [] }, { label: 'No', by: [] }])
  } finally { await w.dispose() }
})
