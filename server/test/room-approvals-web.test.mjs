import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../../web/public/static/room-approvals.js', import.meta.url), 'utf8')
function setup(search = '') {
  const listeners = {}, calls = [], timers = new Map(); let time = 1000000, timer = 0
  const dock = { children: [], hidden: true, addEventListener(k, f) { listeners[k] = f },
    insertBefore(el, before) { this.children = this.children.filter(x => x !== el); const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, el) } }
  const document = { addEventListener() {}, activeElement: null, createElement() { return { dataset: {}, contains() { return false },
    remove() { dock.children = dock.children.filter(x => x !== this) }, scrollIntoView() { if (!dock.hidden) this.scrolled = true }, focus() { if (!dock.hidden) this.focused = true },
    querySelector() { return { focus() {} } } } } }
  const DateMock = class extends Date { static now() { return time } }
  const sandbox = { window: {}, location: { search }, document, URLSearchParams, Map, Date: DateMock,
    setTimeout(fn, ms) { const id = ++timer; timers.set(id, {fn,ms}); return id }, clearTimeout(id) { timers.delete(id) },
    fetch(url, init) { return new Promise(resolve => calls.push({url, init, reply(status, body) { resolve({ok:status < 400, status, json:async()=>body}) }})) } }
  vm.runInNewContext(source, sandbox)
  const S = { sent:'Sent',ok:'Chose',why:'Reason',whyCodex:'Tell Codex',failed:'The last press did not take; choose again.',here:'On computer',expired:'Expired',changed:'Changed',gone:'Gone',offline:'Offline',fold:'Hide',unfold:'Show',screenOnly:'Screen',cwd:'in' }
  const ui = sandbox.window.createRoomApprovals({dock,roomId:'room',S,escape:s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),robot:()=>'',ago:()=>'',flash:()=>{},errorText:'Retry'})
  function click(id, data) { const section = dock.children.find(x => x.dataset.approval === id); const attrs = Object.keys(data); listeners.click({target:{closest:()=>({disabled:false,dataset:data,closest:()=>section,hasAttribute:k=>attrs.includes(k.replace('data-',''))})}}) }
  function input(id, value) { listeners.input({target:{classList:{contains:()=>true},value,closest:()=>({dataset:{approval:id}})}}) }
  return { ui, dock, calls, timers, click, input, advance(ms) { time+=ms; for(const [id,t]of timers) {timers.delete(id); t.fn()} } }
}
const base = { id:'a',name:'agent@owner',cli:'claude',detail:null,screen:null,menu:{question:['Proceed <now>?'],options:[{n:1,label:'Yes'},{n:2,label:'No',note:'original note'}],hints:['Esc']},status:'open',answer:null,result:null,opened_ms:900000,closed_ms:null }
const card = (overrides={}) => structuredClone({...base,...overrides})
const settle = () => new Promise(resolve=>setImmediate(resolve))

test('snapshots sort cards, escape menu content and preserve the CLI line breaks and note', () => {
  const h=setup(); const b=card({id:'b',opened_ms:800000}); b.menu.options[0].label='path/\nfile.txt'
  h.ui.snapshot({items:[card(),b]})
  assert.deepEqual(h.dock.children.map(x=>x.dataset.approval),['b','a'])
  assert.match(h.dock.children[0].innerHTML,/path\/\nfile.txt/)
  assert.match(h.dock.children[0].innerHTML,/<small>original note<\/small>/)
  assert.match(h.dock.children[0].innerHTML,/Proceed &lt;now>\?/)
})

test('only a last No option gets a reason; a middle choice never sends its draft; duplicate clicks dispatch once', async () => {
  const h=setup();h.ui.snapshot({items:[card()]});h.input('a','My reason');h.click('a',{n:'1'});h.click('a',{n:'2'})
  assert.equal(h.calls.length,1);assert.deepEqual(JSON.parse(h.calls[0].init.body),{n:1})
  assert.equal(h.calls[0].url,'/rooms/room/approvals/a/answer');assert.match(h.dock.children[0].innerHTML,/disabled/)
  h.calls[0].reply(409,{error:'host_offline'});await settle()
  assert.match(h.dock.children[0].innerHTML,/Offline/);assert.doesNotMatch(h.dock.children[0].innerHTML,/ disabled/)
  h.click('a',{n:'2'});assert.deepEqual(JSON.parse(h.calls[1].init.body),{n:2,message:'My reason'})
  for(const label of ['Quit','Continue without trusting']) { const c=card();c.menu.options[1].label=label;const x=setup();x.ui.snapshot({items:[c]});assert.doesNotMatch(x.dock.children[0].innerHTML,/textarea/)}
})

test('same-id screen snapshots update in place and keys come from the shared key table', async () => {
  const h=setup();const c=card({menu:null,screen:'first screen'});h.ui.snapshot({items:[c]});const el=h.dock.children[0]
  h.calls[0].reply(200,{keys:[{name:'esc',label:'Esc',herdr:'esc'}]});await settle()
  assert.match(el.innerHTML,/data-key="esc"/)
  h.ui.snapshot({items:[{...c,screen:'new screen'}]});assert.equal(h.dock.children[0],el);assert.match(el.innerHTML,/new screen/)
  h.click('a',{key:'esc'});assert.deepEqual(JSON.parse(h.calls[1].init.body),{key:'esc'})
})

test('server close frames dismiss cards immediately and win over an older HTTP response', async () => {
  const h=setup();h.ui.snapshot({items:[card()]});h.click('a',{n:'2'})
  const answer={n:2,label:'No',by:'owner'};h.ui.snapshot({items:[card({status:'answered',answer,result:'ok',closed_ms:1000000})]})
  assert.equal(h.dock.hidden,true);assert.equal(h.dock.children.length,0)
  h.calls[0].reply(200,{approval:card({status:'answering',answer})});await settle()
  assert.equal(h.dock.hidden,true);assert.equal(h.dock.children.length,0)
})

test('an answered ok card in a snapshot is immediately hidden', () => {
  const h=setup();h.ui.snapshot({items:[card({status:'answered',result:'ok',closed_ms:1000000})]})
  assert.equal(h.dock.hidden,true);assert.equal(h.dock.children.length,0);assert.equal(h.timers.size,0)
})

test('answered_here, expired, changed and gone cards leave the dock immediately', () => {
  for(const status of ['answered_here','expired','changed','gone']) {
    const h=setup();h.ui.snapshot({items:[card()]})
    h.ui.snapshot({items:[card({status,closed_ms:1000000})]})
    assert.equal(h.dock.hidden,true,status);assert.equal(h.dock.children.length,0,status);assert.equal(h.timers.size,0,status)
  }
})

test('a failed card disappears and its replacement carries the retry line until it closes', () => {
  const h=setup(), failed=card({status:'answered',result:'failed',closed_ms:1000000}), next=card({id:'b',opened_ms:1000000})
  h.ui.snapshot({items:[next,failed]})
  assert.equal(h.dock.hidden,false);assert.deepEqual(h.dock.children.map(x=>x.dataset.approval),['b'])
  assert.match(h.dock.children[0].innerHTML,/<p class="apv-state retry" role="status"><span class="apv-mk" aria-hidden="true">!<\/span>The last press did not take; choose again\.<\/p>/)
  assert.ok(h.dock.children[0].innerHTML.indexOf('choose again.') < h.dock.children[0].innerHTML.indexOf('class="apv-opts"'))
  assert.equal(h.timers.size,0)
  h.ui.snapshot({items:[failed,{...next,status:'answering',answer:{n:1}}]})
  assert.deepEqual(h.dock.children.map(x=>x.dataset.approval),['b']);assert.match(h.dock.children[0].innerHTML,/Sent/)
  assert.match(h.dock.children[0].innerHTML,/choose again\./);assert.match(h.dock.children[0].innerHTML,/ disabled/)
  h.ui.snapshot({items:[failed,{...next,status:'answered',result:'ok',closed_ms:1000000}]})
  assert.equal(h.dock.hidden,true);assert.equal(h.dock.children.length,0);assert.equal(h.timers.size,0)
})

test('the retry line includes replacements opened from zero through ten seconds after failure', () => {
  for(const delay of [0,1,9999,10000]) {
    const h=setup();h.ui.snapshot({items:[card({status:'answered',result:'failed',closed_ms:1000000}),card({id:'b',opened_ms:1000000+delay})]})
    assert.deepEqual(h.dock.children.map(x=>x.dataset.approval),['b'])
    assert.match(h.dock.children[0].innerHTML,/<p class="apv-state retry" role="status"><span class="apv-mk" aria-hidden="true">!<\/span>The last press did not take; choose again\.<\/p>/,String(delay));assert.equal(h.timers.size,0)
    h.advance(600000)
    assert.match(h.dock.children[0].innerHTML,/choose again\./,String(delay));assert.equal(h.timers.size,0)
  }
})

test('a failed card is hidden; unrelated, older and late cards carry no retry line', () => {
  for(const next of [null,card({id:'b',name:'other@owner',opened_ms:1000000}),card({id:'b',opened_ms:800000}),card({id:'b',opened_ms:999999}),card({id:'b',opened_ms:1010001}),card({id:'b',opened_ms:1000000,status:'expired',closed_ms:1000000})]) {
    const h=setup();h.ui.snapshot({items:[card({status:'answered',result:'failed',closed_ms:1000000}),...(next?[next]:[])]})
    const shown=next && next.status==='open'?['b']:[]
    assert.deepEqual(h.dock.children.map(x=>x.dataset.approval),shown);assert.equal(h.dock.hidden,!shown.length);assert.equal(h.timers.size,0)
    for(const el of h.dock.children) assert.doesNotMatch(el.innerHTML,/choose again\./)
  }
})

test('already_answered reconciles returned state, missing removes, and bad_request shows next', async () => {
  for(const error of ['already_answered','approval_not_found','bad_request']) {
    const h=setup();h.ui.snapshot({items:[card()]});h.click('a',{n:'1'})
    h.calls[0].reply(409,{error,next:'n: choose a current option',approval:card({status:'answered_here',closed_ms:1000000})});await settle()
    if(error==='already_answered'){assert.equal(h.dock.hidden,true);assert.equal(h.dock.children.length,0)}
    if(error==='approval_not_found')assert.equal(h.dock.children.length,0)
    if(error==='bad_request')assert.match(h.dock.children[0].innerHTML,/n: choose a current option/)
  }
})

test('push target and folding still work; only the replacement shows its screen and enabled options', () => {
  const h=setup('?approval=a');h.ui.snapshot({items:[card()]});assert.equal(h.dock.children[0].scrolled,true);assert.equal(h.dock.children[0].focused,true)
  h.click('a',{fold:''});assert.match(h.dock.children[0].className,/folded/);assert.equal(h.calls.length,0)
  h.ui.snapshot({items:[card({status:'answered',result:'failed',screen:'old failed screen',closed_ms:1000000}),card({id:'b',screen:'current menu',opened_ms:1000000})]})
  assert.deepEqual(h.dock.children.map(x=>x.dataset.approval),['b'])
  assert.match(h.dock.children[0].innerHTML,/current menu/);assert.doesNotMatch(h.dock.children[0].innerHTML,/old failed screen/)
  assert.match(h.dock.children[0].innerHTML,/choose again\./);assert.match(h.dock.children[0].innerHTML,/data-n=/);assert.doesNotMatch(h.dock.children[0].innerHTML,/ disabled/)
  h.click('b',{fold:''});assert.match(h.dock.children[0].className,/folded/);assert.doesNotMatch(h.dock.children[0].innerHTML,/choose again\./)
  h.ui.focus('b');assert.doesNotMatch(h.dock.children[0].className,/folded/);assert.equal(h.dock.children[0].focused,true)
  assert.match(h.dock.children[0].innerHTML,/choose again\./);assert.equal(h.calls.length,0)
})

test('a late already_answered response cannot regress a newer close snapshot', async () => {
  const h=setup();h.ui.snapshot({items:[card()]});h.click('a',{n:'1'})
  h.ui.snapshot({items:[card({status:'answered_here',closed_ms:1000000})]})
  assert.equal(h.dock.hidden,true);assert.equal(h.dock.children.length,0)
  h.calls[0].reply(409,{error:'already_answered',approval:card({status:'answering'})});await settle()
  assert.equal(h.dock.hidden,true);assert.equal(h.dock.children.length,0)
})

test('a replacement without a screen carries the retry line and only live cards link from the task panel', () => {
  const h=setup();h.ui.snapshot({items:[card()]});assert.equal(h.ui.forAgent(base.name),'a')
  const failed=card({status:'answered',result:'failed',closed_ms:1000000})
  h.ui.snapshot({items:[failed,card({id:'b',opened_ms:1000000})]})
  assert.equal(h.ui.forAgent(base.name),'b');assert.doesNotMatch(h.dock.children[0].innerHTML,/<pre/)
  assert.deepEqual(h.dock.children.map(x=>x.dataset.approval),['b']);assert.match(h.dock.children[0].innerHTML,/choose again\./)
  h.ui.snapshot({items:[failed]})
  assert.equal(h.ui.forAgent(base.name),null);assert.equal(h.dock.hidden,true);assert.equal(h.dock.children.length,0)
})

test('daemon Bash JSON string renders the command and description like the parsed input', () => {
  const input = {command:'printf "<hello>"',description:'Print the exact greeting'}
  const detail = {tool:'Bash',input:JSON.stringify(input),cwd:'/tmp/project',description:null}
  const h=setup(), object=setup();h.ui.snapshot({items:[card({detail})]});object.ui.snapshot({items:[card({detail:{...detail,input}})]})
  assert.equal(h.dock.children[0].innerHTML,object.dock.children[0].innerHTML)
  h.click('a',{fold:''});assert.match(h.dock.children[0].innerHTML,/Bash · printf &quot;&lt;hello>&quot;/)
})

test('daemon Edit JSON string renders the file and diff and keeps the file in its summary', () => {
  const input = {file_path:'/tmp/project/callback.ts',old_string:'const value = "old";',new_string:'const value = "new";'}
  const detail = {tool:'Edit',input:JSON.stringify(input),cwd:'/tmp/project',description:null}
  const h=setup(), object=setup();h.ui.snapshot({items:[card({detail})]});object.ui.snapshot({items:[card({detail:{...detail,input}})]})
  assert.equal(h.dock.children[0].innerHTML,object.dock.children[0].innerHTML)
  assert.match(h.dock.children[0].innerHTML,/apv-diff/)
  h.click('a',{fold:''});assert.match(h.dock.children[0].innerHTML,/Edit · \/tmp\/project\/callback.ts/)
})

test('a daemon input truncated at 2000 characters remains verbatim code and a nonempty summary', () => {
  const input=JSON.stringify({command:'printf "<start>" '+ 'x'.repeat(2100)}).slice(0,2000)
  assert.throws(()=>JSON.parse(input));assert.equal(input.length,2000)
  const h=setup();h.ui.snapshot({items:[card({detail:{tool:'Bash',input,cwd:'/tmp/project',description:null}})]})
  const escaped=input.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')
  assert.ok(h.dock.children[0].innerHTML.includes('<pre class="apv-code">'+escaped+'</pre>'))
  h.click('a',{fold:''});assert.ok(h.dock.children[0].innerHTML.includes('Bash · '+escaped))
})
