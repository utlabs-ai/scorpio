// Reply buttons and chart cards on the topic page (room-ai-cards.js, docs/api/messages.md): drawn per state, pressed once,
// a message_update swapping only its row, and card frames that live only while their row is in the feed's window.
import assert from 'node:assert/strict'
import test from 'node:test'
import { page, msg, range, S } from './helpers/feed-page.mjs'

const settle = () => new Promise((resolve) => setImmediate(resolve))
/** The page's objects, from its own realm, as plain values. */
const plain = (v) => JSON.parse(JSON.stringify(v))
/** Everything read: the window opens at the latest rows (no unread line pulling it up). */
const read = (p, list) => p.hello(list, { cursor: list.at(-1).seq, mentionUnread: 0 })
const ask = (seq, buttons) => msg(seq, { from: 'arch@kai', fromKind: 'agent', buttons })
const card = (seq) => msg(seq, { from: 'pm@kai', fromKind: 'agent', kind: 'card', card: { kind: 'html', summary: `chart ${seq}`, size: 10 } })
const origin = (seq) => `https://t${seq}.content.test`
/** Tickets for any card, a reply for a press. */
const respond = (what) => (what.startsWith('cards/') ? { url: `${origin(Number(what.split('/')[1]))}/token` } : { seq: 1000 })
/** What a click on a button inside a row reaches the feed as. */
const tap = (attr, value, disabled = false) => {
  const el = { dataset: { [attr]: value }, disabled }
  el.closest = (s) => (s === `[data-${attr}]` ? el : null)
  return el
}
const pressOf = (seq, i) => tap('press', `${seq}:${i}`)
const buttonsIn = (html) => [...html.matchAll(/<button type="button" class="aib-b([^"]*)" data-press="\d+:\d+"( disabled)? aria-label="([^"]*)">/g)]
  .map(([, cls, disabled, label]) => ({ cls: cls.trim(), disabled: !!disabled, label }))
const boxOf = (p, seq) => p.row(seq).querySelector('.aic').querySelector('.aic-box')
const seqOfBox = (box) => Number(box.parent.parent.dataset.seq)
const ABC = [{ label: '1 做 1–4', by: ['kai'] }, { label: '2 只做 1–3', by: ['anna'] }, { label: '3 有要改的', by: [] }]

function withAnna(p) {
  p.state.members.push({ name: 'anna', displayName: 'Anna', kind: 'human', status: 'active' })
  return p
}

test('buttons are drawn first in the foot: chosen ones grey, mine ringed, who chose them on top, with their screen-reader text', () => {
  const p = withAnna(page({ cards: { respond } }))
  p.hello([ask(1, ABC), ask(2, [{ label: 'A', by: ['anna', 'kai'] }])])
  const html = p.row(1).html
  assert.match(html, /<div class="fm-foot"><div class="aib">/)
  assert.deepEqual(buttonsIn(html), [
    { cls: 'picked mine', disabled: false, label: '1 做 1–4，你选了这个' },
    { cls: 'picked', disabled: false, label: '2 只做 1–3，Anna 选了这个' },
    { cls: '', disabled: false, label: '3 有要改的' },
  ])
  assert.match(html, /1 做 1–4<\/span><span class="aib-avs" aria-hidden="true"><span class="pav me">k<\/span>/) // my own avatar
  assert.equal(buttonsIn(p.row(2).html)[0].label, 'A，你和 Anna 选了这个')
  // A viewer, or an archived topic: drawn, not pressable.
  const v = withAnna(page({ cards: { respond, canWrite: false } }))
  v.hello([ask(1, ABC)])
  assert.ok(buttonsIn(v.row(1).html).every((b) => b.disabled))
  v.click(tap('press', '1:2', true)) // as drawn: disabled
  assert.equal(v.ai.posts.length, 0)
})

test('more than three who chose one: the latest three, and a count', () => {
  const p = page({ cards: { respond } })
  p.hello([ask(1, [{ label: 'A', by: ['a1', 'a2', 'a3', 'a4', 'a5'] }])])
  const avs = /<span class="aib-avs"[^>]*>(.*?)<\/span><\/button>/.exec(p.row(1).html)[1]
  assert.match(avs, /^<span class="aib-more">\+2<\/span>/)
  assert.equal(avs.match(/class="pav"/g).length, 3)
})

test('a press is sent once; a second tap waits, the row drawn again keeps showing it, the reply comes in like a message', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const p = withAnna(page({ cards: { respond: (what) => (what === 'press' ? pending : {}) } }))
  p.hello([ask(1, ABC)])
  p.click(pressOf(1, 2))
  p.click(pressOf(1, 2))
  p.click(pressOf(1, 0))
  await settle()
  assert.deepEqual(plain(p.ai.posts), [{ what: 'press', body: { seq: 1, index: 2 } }])
  assert.equal(p.row(1).querySelector('.aib').dataset.busy, '2')
  // Someone else's press lands meanwhile: still waiting on mine, whether only the buttons are redrawn or the whole row.
  p.roomFeed.updated(ask(1, ABC.map((b, i) => (i === 1 ? { ...b, by: ['anna', 'lee'] } : b))))
  assert.equal(p.row(1).querySelector('.aib').dataset.busy, '2')
  p.roomFeed.updated({ ...ask(1, ABC), text: 'redrawn whole' })
  assert.match(p.row(1).html, /<div class="aib" data-busy="2" aria-busy="true">/)
  release({ seq: 2, message: msg(2, { from: 'kai', text: '3 有要改的', reply: { seq: 1, from: 'arch@kai', text: 'x' } }), delivery: [{ name: 'arch@kai', status: 'left', takeover: '@d@kai /spawn claude arch ~/w x', takeover_seq: 1 }] })
  await settle()
  assert.deepEqual(p.rows(), [1, 2])
  // Its delivery goes to the composer's notes and call-back, as a send's does.
  assert.deepEqual(plain(p.ai.notes), [{ list: [{ name: 'arch@kai', status: 'left', takeover: '@d@kai /spawn claude arch ~/w x', takeover_seq: 1 }], seq: 2 }])
  const group = p.row(1).querySelector('.aib')
  assert.equal(group.dataset.busy, undefined)
  assert.equal(group.getAttribute('aria-busy'), null)
  p.click(pressOf(1, 0))
  await settle()
  assert.equal(p.ai.posts.length, 2) // pressable again
})

test('an unchanged press changes nothing; a refused one says why in the send error words', async () => {
  let answer = { unchanged: true }
  const p = page({ cards: { respond: () => (answer instanceof Error ? Promise.reject(answer.body) : answer) } })
  p.hello([ask(1, ABC)])
  const row = p.row(1)
  p.click(pressOf(1, 0))
  await settle()
  assert.equal(p.row(1), row)
  assert.deepEqual(p.rows(), [1])
  assert.deepEqual(p.flashes, [])
  assert.deepEqual(p.ai.notes, []) // nothing was sent: no delivery to look at
  answer = Object.assign(new Error('refused'), { body: { error: 'rate_limited', next: 'Wait 30 s.' } })
  p.click(pressOf(1, 1))
  await settle()
  assert.deepEqual(p.flashes, ['refused rate_limited'])
  assert.deepEqual(p.ai.notes, [])
  assert.equal(p.row(1).querySelector('.aib').dataset.busy, undefined)
})

test('a press on a message that also has a card redraws only its buttons: the card frame stays and no new ticket is asked for', async () => {
  const p = page({ cards: { respond } })
  const both = (by) => ({ ...card(1), buttons: [{ label: 'A', by }, { label: 'B', by: [] }] })
  // As the server sends them: the first copy (a message frame) carries its delivery, message_update's does not.
  p.hello([{ ...both([]), delivery: [{ name: 'kai', status: 'human' }] }])
  p.ai.observers.near.fire(boxOf(p, 1))
  await settle()
  const row = p.row(1), frame = boxOf(p, 1).children[0]
  p.ai.emit('window', 'message', { source: frame.contentWindow, origin: origin(1), data: { type: 'scorpio:size', height: 1000 } })
  p.roomFeed.updated(both(['lee']))
  await settle()
  assert.equal(p.row(1), row)
  assert.equal(boxOf(p, 1).children[0], frame)
  assert.equal(frame.style.height, '400px')
  assert.equal(p.row(1).querySelector('.aic').classList.contains('capped'), true)
  assert.equal(p.ai.posts.filter((x) => x.what.startsWith('cards/')).length, 1)
  assert.equal(buttonsIn(`<div>${p.row(1).querySelector('.aib').innerHTML}</div>`)[0].cls, 'picked')
  // A different card in the update (never sent so, but if it were): the whole row is drawn again, its card anew.
  p.roomFeed.updated({ ...both(['lee']), card: { kind: 'html', summary: 'another', size: 1 } })
  assert.notEqual(p.row(1), row)
})

test('message_update replaces that message in memory and redraws only its row, without looking at any other', () => {
  const p = page({ cards: { respond } })
  p.hello([...range(1, 5), ask(6, [{ label: 'A', by: [] }, { label: 'B', by: [] }]), ...range(7, 10)])
  const before = new Map(p.rows().map((seq) => [seq, p.row(seq)]))
  const kept = p.state.bySeq.get(6)
  let walks = 0
  const all = p.feed.querySelectorAll
  p.feed.querySelectorAll = (s) => { walks++; return all(s) }
  p.roomFeed.updated(ask(6, [{ label: 'A', by: ['lee'] }, { label: 'B', by: [] }]))
  assert.equal(walks, 0)
  for (const seq of p.rows()) assert.equal(p.row(seq), before.get(seq), `row ${seq}`) // 6 too: only its buttons were redrawn
  assert.equal(p.state.bySeq.get(6), kept) // the same message, updated in place
  assert.deepEqual(kept.buttons[0].by, ['lee'])
  assert.equal(buttonsIn(`<div>${p.row(6).querySelector('.aib').innerHTML}</div>`)[0].cls, 'picked')
  // Not on the page: memory only. Not in memory: nothing.
  const far = page({ cards: { respond } })
  read(far, [ask(1, [{ label: 'A', by: [] }]), ...range(2, 300)])
  assert.equal(far.row(1), null)
  far.roomFeed.updated(ask(1, [{ label: 'A', by: ['lee'] }]))
  assert.equal(far.row(1), null)
  assert.deepEqual(far.state.bySeq.get(1).buttons[0].by, ['lee'])
  far.roomFeed.updated(ask(5000, [{ label: 'A', by: [] }]))
  assert.equal(far.row(5000), null)
  assert.equal(far.state.bySeq.has(5000), false)
})

test('a card frame is made only for a row in the window once it nears the screen, and goes when the row is trimmed', async () => {
  const p = page({ cards: { respond } })
  read(p, range(1, 300).map((m) => (m.seq % 50 ? m : card(m.seq))))
  const near = p.ai.observers.near
  assert.equal(near.opts.root, p.feed)
  // The window holds 101–300: the cards at 50 and 100 are in memory only, never watched.
  assert.deepEqual([...near.watched].map(seqOfBox), [150, 200, 250, 300])
  assert.equal(p.ai.posts.length, 0) // nothing loads before it comes near
  assert.match(p.row(150).html, /<p class="aic-sum">chart 150<\/p>/)
  for (const seq of [150, 300]) near.fire(boxOf(p, seq))
  await settle()
  assert.deepEqual(plain(p.ai.posts), [{ what: 'cards/150/ticket', body: { theme: 'light' } }, { what: 'cards/300/ticket', body: { theme: 'light' } }])
  const frame150 = boxOf(p, 150).children[0], frame300 = boxOf(p, 300).children[0]
  assert.equal(frame300.tagName, 'IFRAME')
  assert.equal(frame300.src, `${origin(300)}/token`)
  assert.equal(frame300.getAttribute('sandbox'), 'allow-scripts allow-same-origin')
  assert.equal(frame300.getAttribute('csp'), 'default-src x')
  assert.equal(frame300.getAttribute('referrerpolicy'), 'no-referrer')
  assert.equal(frame300.title, 'chart 300')
  // 70 more below: the window is trimmed back from the top past 150, and a later card's row lets 150's go.
  for (const m of range(301, 370).map((m) => (m.seq === 370 ? card(370) : m))) p.roomFeed.append(m)
  await settle()
  assert.equal(p.row(150), null)
  assert.deepEqual([...near.watched].map(seqOfBox), [200, 250, 300, 370])
  assert.equal(frame150.parent, null)
  p.ai.emit('window', 'message', { source: frame150.contentWindow, origin: origin(150), data: { type: 'scorpio:size', height: 300 } })
  assert.equal(frame150.style.height, undefined) // its window is no longer heard
  assert.equal(boxOf(p, 300).children[0], frame300)
})

test('only the frame itself, from its own origin, sets its height: at most half the screen, capped with the full screen button', async () => {
  const p = page({ cards: { respond } })
  p.hello([card(1)])
  p.ai.observers.near.fire(boxOf(p, 1))
  await settle()
  const f = boxOf(p, 1).children[0], place = p.row(1).querySelector('.aic')
  const size = (source, from, height) => p.ai.emit('window', 'message', { source, origin: from, data: { type: 'scorpio:size', height } })
  size({ postMessage() {} }, origin(1), 300)
  size(f.contentWindow, 'https://t2.content.test', 300)
  size(f.contentWindow, 'https://scorpio.test', 300)
  assert.equal(f.style.height, undefined)
  size(f.contentWindow, origin(1), 300)
  assert.equal(f.style.height, '300px')
  assert.equal(place.classList.contains('capped'), false)
  size(f.contentWindow, origin(1), 1000) // innerHeight 800
  assert.equal(f.style.height, '400px')
  assert.equal(place.classList.contains('capped'), true)
  assert.match(p.row(1).html, new RegExp(`<button type="button" class="aic-full" data-cardfull="1" aria-label="${S.ai.fullLabel}">${S.ai.full}</button>`))
})

test('no scorpio:ready within 8 s, not_shown, or no frame settings: the not-shown sentence and the summary instead', async () => {
  // Ready in time: it stays.
  const ok = page({ cards: { respond } })
  ok.hello([card(1)])
  ok.ai.observers.near.fire(boxOf(ok, 1))
  await settle()
  const f = boxOf(ok, 1).children[0]
  ok.ai.emit('window', 'message', { source: f.contentWindow, origin: origin(1), data: { type: 'scorpio:ready' } })
  ok.ai.timers.run()
  assert.equal(ok.row(1).querySelector('.aic').classList.contains('failed'), false)
  // No ready within 8 s: the frame goes.
  const late = page({ cards: { respond } })
  late.hello([card(1)])
  late.ai.observers.near.fire(boxOf(late, 1))
  await settle()
  const g = boxOf(late, 1).children[0]
  late.ai.timers.run()
  assert.equal(late.row(1).querySelector('.aic').classList.contains('failed'), true)
  assert.equal(g.parent, null)
  assert.match(late.row(1).html, new RegExp(`<p class="aic-no">${S.ai.notShown}</p><p class="aic-sum">chart 1</p>`))
  // The ticket refused (409 not_shown): no frame at all.
  const refused = page({ cards: { respond: () => Promise.reject({ error: 'not_shown' }) } })
  refused.hello([card(1)])
  refused.ai.observers.near.fire(boxOf(refused, 1))
  await settle()
  assert.equal(refused.row(1).querySelector('.aic').classList.contains('failed'), true)
  assert.equal(boxOf(refused, 1).children.length, 0)
  // No content domain on this server (boot.card null): not even a ticket is asked for.
  const none = page({ cards: { respond, frame: null } })
  none.hello([card(1)])
  none.ai.observers.near.fire(boxOf(none, 1))
  await settle()
  assert.equal(none.ai.posts.length, 0)
  assert.equal(none.row(1).querySelector('.aic').classList.contains('failed'), true)
})

test('a theme change is posted to the loaded frames, to their own origin', async () => {
  const p = page({ cards: { respond } })
  p.hello([card(1), card(2)])
  p.ai.observers.near.fire(boxOf(p, 1))
  await settle()
  p.box.document.documentElement.dataset.scorpioEffectiveTheme = 'dark'
  p.ai.emit('document', 'scorpio-theme')
  assert.deepEqual(plain(boxOf(p, 1).children[0].contentWindow.sent), [{ data: { type: 'scorpio:theme', theme: 'dark' }, origin: origin(1) }])
})

test('full screen opens a second frame with its own ticket, registers with the overlay history, and Back or Escape closes it', async () => {
  const p = page({ cards: { respond } })
  p.hello([card(1)])
  p.click(tap('cardfull', '1'))
  const [entry] = p.ai.overlays
  assert.equal(entry.id, 'aicard')
  assert.equal(entry.isOpen(), true)
  const over = entry.el
  assert.equal(over.parent, p.ai.shell)
  assert.match(over.html, new RegExp(`<button type="button" class="aic-x" data-cardclose aria-label="${S.ai.closeFull}">×</button>`))
  assert.match(over.html, /#1 · /)
  assert.equal(p.ai.focused(), over.querySelector('.aic-x'))
  await settle()
  assert.deepEqual(plain(p.ai.posts), [{ what: 'cards/1/ticket', body: { theme: 'light' } }])
  const frame = over.querySelector('.aic').querySelector('.aic-box').children[0]
  p.ai.emit('window', 'message', { source: frame.contentWindow, origin: origin(1), data: { type: 'scorpio:size', height: 2000 } })
  assert.equal(frame.style.height, '2000px') // full height: the sheet scrolls
  entry.close() // what phone Back does (room-overlay-history.js)
  assert.equal(entry.isOpen(), false)
  assert.ok(over.classList.contains('hidden'))
  assert.equal(frame.parent, null)
  // Again, then Escape.
  p.click(tap('cardfull', '1'))
  assert.equal(entry.isOpen(), true)
  assert.equal(p.ai.overlays.length, 1) // registered once
  p.ai.emit('document', 'keydown', { key: 'Escape', stopPropagation() {} })
  assert.equal(entry.isOpen(), false)
})
