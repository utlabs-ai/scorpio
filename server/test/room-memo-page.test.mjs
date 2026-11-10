import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import {ROOM_STRINGS} from '../src/strings.ts'
import {evictionPick} from '../src/memo-rules.ts'
const source=fs.readFileSync(new URL('../../web/public/static/room-memo.js',import.meta.url),'utf8')
const markdownSource=fs.readFileSync(new URL('../../web/public/static/md.js',import.meta.url),'utf8')
function classList(){const set=new Set(['hidden']);return{contains:x=>set.has(x),add:(...xs)=>xs.forEach(x=>set.add(x)),remove:(...xs)=>xs.forEach(x=>set.delete(x))}}
function setup({lang='zh',viewer=false,archived=false}={}){
 const listeners={},nodes={},fields={};let readResult=empty(),getReply=null,postReply=null;const gets=[];const hooks={},menus={};const field=sel=>fields[sel]||(fields[sel]={_html:'',get textContent(){return this._html.replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&')},set textContent(value){this._html=esc(value)},get innerHTML(){return this._html},set innerHTML(value){this._html=String(value)},disabled:false,hidden:false});const el=id=>nodes[id]||(nodes[id]={innerHTML:'',classList:classList(),addEventListener(type,fn){listeners[id+':'+type]=fn},querySelector(sel){return field(sel)}})
 const window={matchMedia:()=>({matches:true}),scorpioRoomOverlays:{register(){}}};const document={addEventListener:(type,fn)=>listeners[type]=fn}
 vm.runInNewContext(markdownSource,{window});const esc=window.escapeHtml
 const sandbox={window,document,escapeHtml:esc,URLSearchParams,crypto:{randomUUID:()=> 'nonce-'+Math.random()},fetch:async url=>{gets.push(url);return {ok:true,json:async()=>getReply?getReply(new URL(url,'http://local.test')):readResult}},JSON};vm.runInNewContext(source,sandbox)
 const tabs={},requests=[],navigation=[];let write=!viewer&&!archived
 const ctx={$:el,S:ROOM_STRINGS[lang],boot:{roomId:'r1',lang},state:{me:'kai',bySeq:new Map()},viewer,canWrite:()=>write,
  fill:(s,v)=>s.replace(/\{(\w+)\}/g,(_,k)=>v[k]??''),fmtTime:()=> '10-28 20:14',nameText:n=>n,rowName:n=>esc(String(n??'').replace(/@kai$/,'')),avatar:()=>'<svg class="bot"></svg>',
  panels:{tab:(name,entry)=>tabs[name]=entry,isOpen:()=>false,kind:()=>'',sideOpen:()=>false,sideView:()=>'',renderSide(){}},openPanel:name=>navigation.push(name),closePanel:()=>navigation.push('close'),openItem:id=>navigation.push(id),jumpTo:seq=>navigation.push(seq),rowHook:(slot,fn)=>hooks[slot]=fn,menuHook:(slot,fn)=>menus[slot]=fn,flash:e=>navigation.push(e),post:(path,body)=>{requests.push({path,body:JSON.parse(JSON.stringify(body))});return postReply?postReply(path,body):Promise.resolve({})}}
 const api=window.createRoomMemo(ctx);const receive=api.frame;api.frame=value=>{readResult=value;return receive(value)}
 return{api,ctx,tabs,listeners,nodes,fields,field,hooks,menus,requests,gets,navigation,window,setGet:fn=>getReply=fn,setPost:fn=>postReply=fn,input:text=>listeners.input({target:{value:text,hasAttribute:key=>key==='data-mm-text'}}),setWrite:v=>write=v,click:(act,more={})=>listeners.click({target:{closest:()=>({dataset:{mmAct:act,...more}})}})}
}
const empty=()=>({nextId:'M17',long:[{slot:'L1',version:0,text:''},{slot:'L2',version:0,text:''}],short:[],retired:0,pending:[],round:0,cites:0,logLast:0})
const item=(id,score,more={})=>({id,text:'fact '+id,by:'api@kai',byKind:'agent',from:'#12',score,rounds:2,lastUsedMs:1,promotable:false,misled:0,votes:{good:[],bad:[]},...more})
test('memo tab full, empty and read-only forms use frame facts and existing controls in both languages',()=>{
 for(const lang of ['zh','en']){
  const h=setup({lang});h.api.frame(empty());assert.ok(h.tabs.memo);let html=h.tabs.memo.html();assert.ok(html.includes(ROOM_STRINGS[lang].memo.helpTitle));assert.equal((html.match(/<li>/g)||[]).length,6);assert.ok(html.includes('data-mm-act="new"'))
  h.api.frame({...empty(),long:[{slot:'L1',version:7,text:'<rule>',by:'kai',byKind:'human',ms:1},{slot:'L2',version:0,text:''}],short:[item('M3',3,{promotable:true,misled:1,votes:{good:['kai'],bad:[]}}),item('M2',7)],retired:8,pending:['M3']})
  html=h.api.html();assert.ok(html.indexOf('id="mm-M2"')<html.indexOf('id="mm-M3"'));assert.ok(html.includes('&lt;rule&gt;'));assert.ok(html.includes('aria-pressed="true"'));assert.ok(html.includes('data-mm-act="merge"'));assert.ok(html.includes('data-mm-source="#12"'));assert.ok(html.includes('data-mm-act="retired"'))
  h.click('help');assert.ok(h.nodes['memo-sheet'].innerHTML.includes(ROOM_STRINGS[lang].memo.helpTitle));h.click('source',{mmSource:'T3'});assert.ok(h.navigation.includes('T3'))
  for(const mode of [{viewer:true},{archived:true}]){
   const ro=setup({lang,...mode});ro.api.frame({...empty(),short:[item('M1',3,{promotable:true})]});const body=ro.api.html();assert.ok(!/data-mm-act="(?:new|vote|replace|retire|merge)"/.test(body));assert.ok(body.includes(mode.viewer?ROOM_STRINGS[lang].memo.viewer:ROOM_STRINGS[lang].memo.archived));assert.ok(body.includes('data-mm-act="source"'));assert.match(body,/class="mm-score mm-ro"/)
  }
 }
})
test('the editor eviction choice equals the server rule, including newcomer exemption and all-new fallback',()=>{
 const h=setup();const cases=[[],[item('M1',2),item('M2',0)],[item('M1',-3,{rounds:0}),item('M2',0,{rounds:1})],[item('M1',-3,{rounds:0}),item('M2',0,{rounds:0})],[item('M10',0,{lastUsedMs:1}),item('M2',0,{lastUsedMs:1})]]
 for(const short of cases){const round=5;const server=evictionPick(short.map(m=>({n:Number(m.id.slice(1)),score:m.score,last_used_ms:m.lastUsedMs,entered_round:round-m.rounds})),round);const page=h.window.scorpioMemoEviction(short);assert.equal(page?.id??null,server?'M'+server.n:null)}
})
test('card votes toggle off, retire/restore requests are guarded, merge preserves points and sources, conflict loads current text',async()=>{
 const h=setup();const state={...empty(),long:[{slot:'L1',version:7,text:'existing rule',by:'kai',byKind:'human',ms:1},{slot:'L2',version:0,text:''}],short:[item('M3',4,{promotable:true,votes:{good:['kai'],bad:[]}}),item('M4',3,{promotable:true,from:'T3'})],pending:['M3','M4']};h.api.frame(state)
 await h.click('vote',{mmId:'M3',mmVote:'good'});assert.equal(h.requests.at(-1).body.vote,'none');assert.ok(h.requests.at(-1).body.nonce)
 await h.click('retire',{mmId:'M3'});assert.deepEqual({op:h.requests.at(-1).body.op,id:h.requests.at(-1).body.id},{op:'retire',id:'M3'})
 h.click('merge',{mmSlot:'L1'});let editor=h.nodes['memo-sheet'].innerHTML;assert.ok(editor.includes('existing rule'));assert.ok(editor.includes('fact M3（M3，api@kai，#12）'));assert.ok(editor.includes('fact M4（M4，api@kai，T3）'))
 h.input('missing ids');await h.click('save');assert.ok(h.field('[data-mm-error]').textContent.includes('M3'));const before=h.requests.length
 h.input('existing rule M3 M4');await h.click('save');assert.equal(h.requests.length,before+1);const body=h.requests.at(-1).body;assert.equal(body.op,'long');assert.equal(body.version,7);assert.deepEqual(body.merged,['M3','M4'])
 h.click('long',{mmSlot:'L1'});h.input('my change');h.setPost(()=>Promise.reject({error:'version_conflict',current:{slot:'L1',version:8,text:'current from someone else',by:'kai',ms:2}}));await h.click('save')
 assert.ok(h.nodes['memo-sheet'].innerHTML.includes('current from someone else'));assert.ok(h.field('[data-mm-error]').textContent.includes('第 8 版'))
 h.setPost(()=>Promise.resolve({}));await h.click('save');assert.equal(h.requests.at(-1).body.version,8);assert.equal(h.requests.at(-1).body.text,'current from someone else')
 h.setWrite(false);const count=h.requests.length;await h.click('retire',{mmId:'M3'});assert.equal(h.requests.length,count)
})
test('retired/history pages stay bounded, expose only allowed metadata, and call the restore forms',async()=>{
 const h=setup();h.api.frame({...empty(),retired:2,long:[{slot:'L1',version:3,text:'current',ms:1},{slot:'L2',version:0,text:''}]})
 h.setGet(url=>url.searchParams.has('retired')?{memos:[item(url.searchParams.has('before')?'M2':'M3',3,{state:'replaced',leftTo:'M9'})],hasMore:!url.searchParams.has('before')}:{versions:[{slot:'L1',version:3,text:'current',by:'kai',ms:1,merged:['M3'],big:false,lost:[],shorter:0},{slot:'L1',version:2,text:'old',by:'api@kai',ms:1,merged:[],big:true,lost:['M1'],shorter:31}],hasMore:false})
 await h.click('retired');assert.ok(h.nodes['memo-sheet'].innerHTML.includes('已替代（M9）'));await h.click('more');assert.ok(h.gets.at(-1).includes('before=M3'));assert.ok(h.nodes['memo-sheet'].innerHTML.includes('M2'))
 h.setGet(()=>empty());await h.click('restore',{mmId:'M2'});assert.equal(h.requests.at(-1).body.op,'restore');assert.equal(h.requests.at(-1).body.id,'M2')
 h.api.frame({...empty(),long:[{slot:'L1',version:3,text:'current'},{slot:'L2',version:0,text:''}]});h.setGet(()=>({versions:[{slot:'L1',version:3,by:'kai',ms:1,merged:['M3'],big:false,lost:[],shorter:0},{slot:'L1',version:2,by:'api@kai',ms:1,merged:[],big:true,lost:['M1'],shorter:31}],hasMore:false}));await h.click('history',{mmSlot:'L1'});const html=h.nodes['memo-sheet'].innerHTML;assert.ok(html.includes('并入 M3'));assert.ok(html.includes('缩短 31%，不再含 M1'));assert.ok(html.includes('当前'))
 h.setGet(()=>empty());await h.click('restore-version',{mmSlot:'L1',mmVersion:'2'});assert.equal(h.requests.at(-1).body.slot,'L1');assert.equal(h.requests.at(-1).body.version,2)
})
test('message memo tags explain counted and uncounted events without claiming points for own memos',()=>{
 const h=setup();const m={seq:12,memo:{cite:['M3'],misled:['M4'],uncounted:[{id:'M3',reason:'own'}]}};h.ctx.state.bySeq.set(12,m);const tags=h.hooks.memo(m);assert.ok(tags.includes('依据 M3'));assert.ok(tags.includes('M4 误导'))
 h.click('tag',{mmSeq:'12',mmId:'M3',mmKind:'cite'});assert.ok(h.nodes['memo-sheet'].innerHTML.includes('未计分：自己写的'));assert.ok(!h.nodes['memo-sheet'].innerHTML.includes('+1'))
 h.click('tag',{mmSeq:'12',mmId:'M4',mmKind:'misled'});assert.ok(h.nodes['memo-sheet'].innerHTML.includes('分数 −2'))
})
test('a slow save does not close or replace a newer editor, and its busy state clears when the response arrives',async()=>{
 const h=setup();h.api.frame({...empty(),long:[{slot:'L1',version:1,text:'first'},{slot:'L2',version:1,text:'second'}]});let resolve
 h.setPost(()=>new Promise(r=>resolve=r));h.click('long',{mmSlot:'L1'});h.input('save first');const saving=h.click('save');h.click('close');h.click('long',{mmSlot:'L2'});h.input('keep second draft')
 assert.equal(h.field('[data-mm-save]').disabled,true);resolve({});await saving
 assert.ok(!h.nodes['memo-sheet'].classList.contains('hidden'));assert.ok(h.nodes['memo-sheet'].innerHTML.includes('second'));assert.equal(h.field('[data-mm-save]').disabled,false)
 h.setPost(()=>Promise.resolve({}));await h.click('save');assert.equal(h.requests.at(-1).body.slot,'L2');assert.equal(h.requests.at(-1).body.text,'keep second draft')
})
test('short writing and replacement keep source, use the predicted next id, validate full text and show the server eviction candidate',async()=>{
 const h=setup();const state={...empty(),nextId:'M17',short:Array.from({length:8},(_,i)=>item('M'+(i+1),i,{rounds:i?2:0,lastUsedMs:i+1}))};h.api.frame(state)
 h.click('new');assert.ok(h.nodes['memo-sheet'].innerHTML.includes('存为 M17'));assert.ok(h.field('[data-mm-note]').textContent.includes('M2'))
 h.input('a new fact');h.listeners.input({target:{value:'#12',hasAttribute:key=>key==='data-mm-from'}});await h.click('save');let body=h.requests.at(-1).body;assert.equal(body.op,'add');assert.equal(body.from,'#12');assert.equal(body.text,'a new fact')
 h.click('replace',{mmId:'M3'});assert.ok(h.field('[data-mm-note]').textContent.includes('替代 M3'));h.input('a revised fact');await h.click('save');body=h.requests.at(-1).body;assert.equal(body.replaces,'M3');assert.equal(body.from,'#12')
 h.menus.memo()[0].run({seq:23,from:'api@kai',text:'@kai @api@kai full message\nsecond line'});assert.ok(h.nodes['memo-sheet'].innerHTML.includes('full message\nsecond line'));assert.match(h.nodes['memo-sheet'].innerHTML,/出处 <button[^>]*data-mm-source="#23"[^>]*>#23<\/button>/)
 h.input('😀'.repeat(501));const count=h.requests.length;await h.click('save');assert.equal(h.requests.length,count);assert.ok(h.field('[data-mm-error]').textContent.includes('501'))
 h.input('an acceptable point');await h.click('save');body=h.requests.at(-1).body;assert.equal(body.from,'#23');assert.equal(body.text,'an acceptable point')
 h.click('new');h.api.frame({...state,nextId:'M18'});assert.equal(h.field('[data-mm-save]').textContent,'存为 M18')
})

test('a long-editor conflict survives a later memo frame until input or a new editor',async()=>{
 const h=setup(), state={...empty(),long:[{slot:'L1',version:7,text:'old'},{slot:'L2',version:0,text:''}]};h.api.frame(state)
 h.click('long',{mmSlot:'L1'});h.input('my draft');h.setPost(()=>Promise.reject({error:'version_conflict',current:{slot:'L1',version:8,text:'latest',by:'api@kai',ms:1}}));await h.click('save')
 const hint=h.field('[data-mm-error]').textContent;assert.ok(hint.includes('第 8 版'));assert.ok(h.nodes['memo-sheet'].innerHTML.includes('latest'))
 h.api.frame({...state,logLast:1,long:[{slot:'L1',version:8,text:'latest'},{slot:'L2',version:0,text:''}]});assert.equal(h.field('[data-mm-error]').textContent,hint)
 h.input('latest with my revision');assert.equal(h.field('[data-mm-error]').textContent,'')
 await h.click('save');assert.ok(h.field('[data-mm-error]').textContent);h.click('long',{mmSlot:'L2'});assert.equal(h.field('[data-mm-error]').textContent,'')
})

test('long editor and history separate their title from the subtitle in both languages',async()=>{
 for(const lang of ['zh','en']){
  const h=setup({lang});h.api.frame({...empty(),long:[{slot:'L1',version:5,text:'rule'},{slot:'L2',version:0,text:''}],short:[item('M1',3,{promotable:true})],pending:['M1']})
  h.click('merge',{mmSlot:'L1'});let html=h.nodes['memo-sheet'].innerHTML;assert.match(html,new RegExp('<b class="mmed-t">'+(lang==='zh'?'改 L1':'Edit L1')+'</b>'));assert.match(html,/class="mmed-sub">[^<]*M1<\/span>/)
  h.setGet(()=>({versions:[],hasMore:false}));await h.click('history',{mmSlot:'L1'});html=h.nodes['memo-sheet'].innerHTML;assert.match(html,new RegExp('<b class="mmed-t">'+(lang==='zh'?'L1 历史':'L1 history')+'</b>'));assert.match(html,/class="mmed-sub">[^<]*5[^<]*10[^<]*<\/span>/)
 }
})

test('merge prefill places its full author and source before a single sentence stop',()=>{
 for(const lang of ['zh','en']){
  const h=setup({lang});h.api.frame({...empty(),short:[item('M1',3,{text:'First。'}),item('M2',3,{text:'Second.'})],pending:['M1','M2']});h.click('merge',{mmSlot:'L1'})
  const html=h.nodes['memo-sheet'].innerHTML
  assert.ok(html.includes(lang==='zh'?'First（M1，api@kai，#12）。\nSecond（M2，api@kai，#12）。':'First (M1, api@kai, #12).\nSecond (M2, api@kai, #12).'))
 }
})

test('display names reuse rowName while editor and detail message sources remain jump controls',async()=>{
 const h=setup();h.api.frame({...empty(),long:[{slot:'L1',version:2,text:'rule',by:'arch@kai',byKind:'agent',ms:1},{slot:'L2',version:0,text:''}]})
 assert.match(h.api.html(),/第 2 版 · arch ·/);assert.ok(!h.api.html().includes('arch@kai'))
 h.setGet(()=>({versions:[{version:1,by:'arch@kai',byKind:'agent',ms:1}],hasMore:false}));await h.click('history',{mmSlot:'L1'});assert.match(h.nodes['memo-sheet'].innerHTML,/mv-who">arch ·/)
 h.menus.memo()[0].run({seq:22,from:'arch@kai',fromKind:'agent',text:'fact'});let html=h.nodes['memo-sheet'].innerHTML;assert.match(html,/data-mm-act="source" data-mm-source="#22"[^>]*>#22<\/button> · arch/);assert.ok(!html.includes('arch@kai'))
 h.click('source',{mmSource:'#22'});assert.ok(h.navigation.includes(22))
 h.setGet(()=>({memo:item('M1',3,{by:'arch@kai',from:'#22'})}));await h.api.show('M1');html=h.nodes['memo-sheet'].innerHTML;assert.match(html,/data-mm-source="#22"[^>]*>#22<\/button> · arch/)
 h.setGet(()=>({memo:item('M1',3,{by:'<img>@kai',from:'#22'})}));await h.api.show('M1');assert.ok(h.nodes['memo-sheet'].innerHTML.includes('&lt;img&gt;'));assert.ok(!h.nodes['memo-sheet'].innerHTML.includes('<img>'))
})

test('empty long slots have a muted body only, no history, and no zero retired row',()=>{
 const h=setup();h.api.frame({...empty(),long:[{slot:'L1',version:1,text:'rule'},{slot:'L2',version:0,text:''}]});let html=h.api.html();const l2=html.match(/<section class="ml" id="mm-L2">([\s\S]*?)<\/section>/)[1]
 assert.equal((l2.match(/尚无内容/g)||[]).length,1);assert.match(l2,/class="ml-t mm-none">尚无内容/);assert.ok(!l2.includes('data-mm-act="history"'));assert.ok(!html.includes('data-mm-act="retired"'))
 h.api.frame({...empty(),retired:2});html=h.api.html();assert.match(html,/data-mm-act="retired"[^>]*>已淘汰 2 条<span class="chev" aria-hidden="true">›<\/span><\/button>/)
})

test('conflict hints use the same escaped short name as version metadata in both languages',async()=>{
 for(const lang of ['zh','en']){
  const h=setup({lang});h.api.frame({...empty(),long:[{slot:'L1',version:1,text:'rule'},{slot:'L2',version:0,text:''}]});h.click('long',{mmSlot:'L1'});h.input('draft')
  h.setPost(()=>Promise.reject({error:'version_conflict',current:{slot:'L1',version:2,text:'current',by:'arch@kai',byKind:'agent',ms:1}}));await h.click('save')
  assert.ok(h.field('[data-mm-error]').textContent.includes(lang==='zh'?'（arch，':'(arch,'));assert.ok(!h.field('[data-mm-error]').textContent.includes('arch@kai'))
  h.ctx.rowName=()=> 'arch<small class="acct">@mei</small>';await h.click('save');assert.ok(h.field('[data-mm-error]').innerHTML.includes('arch<small class="acct">@mei</small>'))
  h.ctx.rowName=n=>String(n).replace(/</g,'&lt;').replace(/>/g,'&gt;');h.setPost(()=>Promise.reject({error:'version_conflict',current:{version:2,text:'current',by:'<img>',byKind:'agent',ms:1}}));await h.click('save');assert.ok(h.field('[data-mm-error]').innerHTML.includes('&lt;img&gt;'));assert.ok(!h.field('[data-mm-error]').innerHTML.includes('<img>'))
 }
})

test('a numeric 409 version shows the current text in the textarea with its hint and next save version',async()=>{
 for(const lang of ['zh','en']){
  const h=setup({lang});assert.throws(()=>h.window.escapeHtml(2),/replace is not a function/)
  h.api.frame({...empty(),long:[{slot:'L1',version:1,text:'old text'},{slot:'L2',version:0,text:''}]});h.click('long',{mmSlot:'L1'});h.input('my unsaved draft')
  const current={slot:'L1',version:2,text:'current <text> & details',by:'arch@kai',byKind:'agent',ms:1};h.setPost(()=>Promise.reject({error:'version_conflict',current}));await h.click('save')
  assert.ok(h.field('[data-mm-error]').textContent.includes(lang==='zh'?'第 2 版':'version 2'))
  const textarea=h.nodes['memo-sheet'].innerHTML.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1];assert.equal(textarea,h.window.escapeHtml(current.text))
  assert.equal(h.field('[data-mm-save]').textContent,lang==='zh'?'存为第 3 版':'Save as version 3')
  h.setPost(()=>Promise.resolve({}));await h.click('save');assert.equal(h.requests.at(-1).body.version,2);assert.equal(h.requests.at(-1).body.text,current.text)
 }
})
