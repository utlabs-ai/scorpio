import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { ROOM_STRINGS } from '../src/strings.ts'

const source = fs.readFileSync(new URL('../../web/public/static/room-search.js', import.meta.url), 'utf8')
function setup(reply) {
  const requests = [], timers = [], listeners = {}, opened = []
  const input = { focus() {} }, results = { innerHTML: '', scrollTop: 0 }
  const panel = { innerHTML: '', addEventListener(type, fn) { listeners[type] = fn }, querySelectorAll: () => [], querySelector: (q) => q === '#room-search-input' ? input : q === '#room-search-results' ? results : null }
  let now = new Date(2026, 9, 20, 12).getTime()
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])) } }
  const context = { window: {}, document: { addEventListener() {} }, Date: Clock, URLSearchParams, setTimeout(fn) { timers.push(fn); return timers.length }, clearTimeout() {}, fetch(url) {
    requests.push(new URL(url, 'http://localhost'))
    return Promise.resolve({ ok: true, json: async () => (typeof reply === 'function' ? reply(new URL(url,'http://localhost')) : reply || { groups: { messages: [], todo: [], files: [], memo: [] }, hasMore: {} }) })
  } }
  vm.runInNewContext(source, context)
  const drawer = context.window.createRoomSearch({ panel, strings: ROOM_STRINGS.en, roomId: 'r1', lang: 'en', nameOf: n => n, members: () => [{ name: 'a<&', kind: 'human' }], close() {}, openMemo(id) { opened.push(id) } })
  drawer.open()
  function click(selector, dataset = {}) { drawer.click({ target: { closest: q => q === selector ? { dataset } : null } }) }
  return { drawer, requests, panel, results, click, opened,
    key(selector, key) { listeners.keydown({ key, preventDefault() {}, target: { closest: q => q === selector ? {} : null } }) },
    change(key, value) { drawer.change({ target: { dataset: { searchFilter: key }, value } }) },
    day(value) { now = value },
    flush() { timers.splice(0).forEach(fn => fn()) } }
}

test('filter alone searches; fields AND together and are retained in requests', () => {
  const h = setup()
  assert.equal(h.requests.length, 0)
  h.click('[data-sf-by]', { sfBy: 'api@kai' })
  h.click('[data-search-at]')
  h.click('[data-sf-kind]', { sfKind: 'agent' })
  h.click('[data-sf-kind]', { sfKind: 'host' })
  h.drawer.input({ target: { id: 'room-search-input', value: 'deploy' } }); h.flush()
  const p = h.requests.at(-1).searchParams
  assert.equal(p.get('q'), 'deploy')
  assert.equal(p.get('by'), 'api@kai')
  assert.equal(p.get('at'), 'me')
  assert.equal(p.get('kind'), 'human,system,scheduled')
  h.click('[data-sf-open]', { sfOpen: 'by' }); h.drawer.open()
  assert.ok(h.panel.innerHTML.includes('a&lt;&amp;'))
})

test('all kinds omit kind; the last kind cannot be cleared; clearing q keeps a filter', () => {
  const h = setup()
  h.click('[data-search-at]')
  assert.equal(h.requests.at(-1).searchParams.has('kind'), false)
  for (const kind of ['human', 'agent', 'host']) h.click('[data-sf-kind]', { sfKind: kind })
  const count = h.requests.length
  h.click('[data-sf-kind]', { sfKind: 'system,scheduled' })
  assert.equal(h.requests.length, count)
  assert.equal(h.requests.at(-1).searchParams.get('kind'), 'system,scheduled')
  h.drawer.open()
  assert.match(h.panel.innerHTML, /data-sf-kind="system,scheduled" aria-disabled="true"/)
  h.drawer.input({ target: { id: 'room-search-input', value: '' } }); h.flush()
  assert.equal(h.requests.at(-1).searchParams.get('at'), 'me')
})

test('date inputs use local midnight and include the entire To day across DST', () => {
  const before = process.env.TZ; process.env.TZ = 'America/New_York'
  try {
    const h = setup()
    h.change('since', '2026-11-01'); h.change('until', '2026-11-01')
    const p = h.requests.at(-1).searchParams
    assert.equal(Number(p.get('since')), new Date(2026, 10, 1).getTime())
    assert.equal(Number(p.get('until')), new Date(2026, 10, 2).getTime())
    assert.equal(Number(p.get('until')) - Number(p.get('since')), 25 * 3600000)
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before }
})

test('presets calculate natural days at each request, including after midnight', () => {
  const h = setup()
  h.click('[data-sf-when]', { sfWhen: '7' })
  assert.equal(Number(h.requests.at(-1).searchParams.get('since')), new Date(2026, 9, 14).getTime())
  h.day(new Date(2026, 9, 21, 12).getTime())
  h.click('[data-search-at]')
  assert.equal(Number(h.requests.at(-1).searchParams.get('since')), new Date(2026, 9, 15).getTime())
  h.click('[data-sf-when]', { sfWhen: 'today' })
  assert.equal(Number(h.requests.at(-1).searchParams.get('since')), new Date(2026, 9, 21).getTime())
  h.click('[data-sf-when]', { sfWhen: '30' })
  assert.equal(Number(h.requests.at(-1).searchParams.get('since')), new Date(2026, 8, 22).getTime())
  h.click('[data-sf-when]', { sfWhen: 'all' })
  assert.equal(h.requests.at(-1).searchParams.has('since'), false)
})


test('scope alone searches its group, disables message controls, and survives reopening', () => {
  const h = setup()
  h.click('[data-sf-in]', { sfIn: 'todo' })
  assert.equal(h.requests.at(-1).searchParams.get('in'), 'todo')
  assert.equal(h.requests.at(-1).searchParams.get('q'), '')
  h.drawer.closed(); h.drawer.open()
  assert.match(h.panel.innerHTML, /data-sf-in="todo" role="radio" aria-checked="true"/)
  assert.equal((h.panel.innerHTML.match(/data-sf-kind="[^"]+" disabled/g) || []).length, 4)
  assert.match(h.panel.innerHTML, /data-search-at disabled aria-pressed="false"/)
  h.click('[data-sf-in]', { sfIn: 'files' })
  assert.equal(h.requests.at(-1).searchParams.get('in'), 'files')
})

test('message controls select Messages; leaving Messages resets kind and at filters', () => {
  const h = setup()
  h.click('[data-sf-kind]', { sfKind: 'agent' })
  assert.equal(h.requests.at(-1).searchParams.get('in'), 'messages')
  h.click('[data-search-at]')
  for (const scope of ['todo', 'files', '']) {
    h.click('[data-sf-in]', { sfIn: scope })
    h.drawer.open()
    assert.doesNotMatch(h.panel.innerHTML, /data-search-at[^>]*aria-pressed="true"/)
    h.click('[data-sf-when]', { sfWhen: '7' })
    const p = h.requests.at(-1).searchParams
    assert.equal(p.get('in'), scope || null)
    assert.equal(p.has('kind'), false)
    assert.equal(p.has('at'), false)
  }
  h.click('[data-search-at]')
  assert.equal(h.requests.at(-1).searchParams.get('in'), 'messages')
})

test('scope radio arrow keys wrap and choose the next scope', () => {
  const h = setup()
  h.key('[data-sf-in]', 'ArrowLeft')
  assert.equal(h.requests.at(-1).searchParams.get('in'), 'memo')
  h.key('[data-sf-in]', 'ArrowRight')
  h.drawer.open()
  assert.match(h.panel.innerHTML, /data-sf-in="" role="radio" aria-checked="true" tabindex="0"/)
  h.key('[data-sf-in]', 'ArrowRight')
  assert.equal(h.requests.at(-1).searchParams.get('in'), 'messages')
})
test('memo scope renders M and L labels and opens the memo rather than jumping to its nullable seq',async()=>{
 const h=setup({groups:{messages:[],todo:[],files:[],memo:[{id:'M3',type:'memo',status:'retired',seq:null,who:'api@kai',ts:1,snippet:'memo source'},{id:'L1',type:'memo',status:'long',seq:null,who:'api@kai',ts:1,snippet:'long source'}]},hasMore:{memo:false}})
 h.click('[data-sf-in]',{sfIn:'memo'});await new Promise(r=>setImmediate(r))
 assert.equal(h.requests.at(-1).searchParams.get('in'),'memo');assert.match(h.results.innerHTML,/M3 · retired/);assert.match(h.results.innerHTML,/L1/)
 h.click('[data-search-kind]',{searchKind:'memo',searchIndex:'0'});assert.deepEqual(h.opened,['M3'])
})
test('memo More reloads the full bounded group with limit60 and never sends a nullable message cursor',async()=>{
 const hit=id=>({id,type:'memo',status:'retired',seq:null,who:'api@kai',ts:1,snippet:'memo point'});
 const h=setup(url=>({groups:{messages:[],todo:[],files:[],memo:url.searchParams.get('limit')==='60'?[hit('M3'),hit('M4')]:[hit('M3')]},hasMore:{memo:url.searchParams.get('limit')!=='60'}}))
 h.drawer.input({target:{id:'room-search-input',value:'memo'}});h.flush();await new Promise(r=>setImmediate(r));h.click('[data-search-more]',{searchMore:'memo'});await new Promise(r=>setImmediate(r));
 const q=h.requests.at(-1).searchParams;assert.equal(q.get('in'),'memo');assert.equal(q.get('limit'),'60');assert.equal(q.has('before'),false);assert.equal((h.results.innerHTML.match(/M3 · retired/g)||[]).length,1);assert.ok(h.results.innerHTML.includes('M4 · retired'))
})
