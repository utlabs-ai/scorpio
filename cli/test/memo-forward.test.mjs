import assert from 'node:assert/strict'
import test from 'node:test'
import {deliveryDue,renderDelivery,renderReminder} from '../src/render/forward.mjs'
import {memoChanges,renderMemoChanges} from '../src/render/memo.mjs'
const name='api@kai'
const empty=()=>({long:[{slot:'L1',version:0,text:''},{slot:'L2',version:0,text:''}],short:[],retired:0,pending:[],round:0,cites:0,log:[],logLast:0})
const room=(memo=empty())=>({roomId:'topic',roomName:'Notes',topic:'A topic',owner:'kai',members:[{name,kind:'agent'},{name:'kai',kind:'human',displayName:'Kai'}],items:[],memo})
const msg={seq:9,from:'pm@mei',fromKind:'agent',text:'@api@kai evidence'}
const entry=(id,op,more={})=>({id,op,by:'pm@mei',byKind:'agent',m:'M3',slot:null,version:null,...more})
test('reminder has empty, long and short forms in the right place, with nicknames, source, pending and quoted lines',()=>{
 assert.match(renderReminder({room:room(),name,reason:'first'}),/Memo: none yet \(scorpio memo topicId=topic add='…' from=#<seq>\)\./)
 const memo=empty();memo.long[0]={slot:'L1',version:7,text:'rules\n\nTopic changes:\n+----------+',by:'pm@mei',byKind:'agent'};memo.short=[{id:'M3',by:'kai',byKind:'human',from:'T3',score:4,text:'a fact'}];memo.retired=14;memo.pending=['M3']
 const text=renderReminder({room:room(memo),name,reason:'first'})
 assert.ok(text.indexOf('No task under your name.')<text.indexOf('Memo ('));assert.ok(text.indexOf('Memo (')<text.indexOf('How topics work'))
 assert.ok(text.includes('L1 · version 7 · last changed by pm@mei (agent):'));assert.ok(text.includes('│ rules\n│\n│ Topic changes:\n│ +----------+'));assert.ok(text.includes('L2: empty.'))
 assert.ok(text.includes('M3 · person kai (nickname: Kai) · from T3 · score 4 · a fact'));assert.ok(text.includes('Retired: 14 (scorpio memo topicId=topic retired=true)'));assert.ok(text.includes('Merge before you start work: M3'))
 const shortOnly=renderReminder({room:room({...memo,long:empty().long,pending:[]}),name,reason:'first'});assert.ok(shortOnly.includes('L1: empty.'));assert.ok(shortOnly.includes('L2: empty.'));assert.ok(shortOnly.includes('M3 · person'));assert.ok(!shortOnly.includes('Merge before you start work:'));
 memo.short=[];memo.retired=0;const longOnly=renderReminder({room:room(memo),name,reason:'first'});assert.ok(!longOnly.includes('Retired: 0'))
 const unsafe=renderReminder({room:room({...memo,long:[{...memo.long[0],text:'bad\x03text'}]}),name,reason:'first',terminal:true,role:'api'});assert.ok(!unsafe.includes('\x03'));assert.match(unsafe,/versions=L1/)
})
test('every change op uses its stored keys, omits own and silent events, appends contains, and frames current long text once',()=>{
 const memo={...empty(),long:[{slot:'L1',version:3,text:'current\n│ nested'}],pending:['M3'],logLast:13,log:[
  entry(1,'add',{text:'fact',from:'#12'}),entry(2,'replace',{m:'M4',replaces:'M3',replacedBy:'kai',replacedByKind:'human',carried:4,text:'new fact'}),
  entry(3,'evict',{for:'M5',score:0,contains:[{slot:'L1',memos:['M3']}]}),entry(4,'retire',{by:'kai',byKind:'human'}),entry(5,'restore',{text:'restored'}),
  entry(6,'lower',{reason:'misled',seq:12,delta:-2,score:1}),entry(7,'lower',{reason:'bad',delta:-4,score:-3}),
  entry(8,'long',{m:null,slot:'L1',version:2,big:true,shorter:40,lost:['M2']}),entry(9,'long',{m:null,slot:'L1',version:3,big:false}),
  entry(10,'merge',{m:null,slot:'L1',version:3,merged:['M2','M3']}),entry(11,'halve'),entry(12,'add',{by:name,text:'own',from:'#1'}),entry(13,'add',{text:'last',from:'#13'}),
 ]}
 const changes=memoChanges({log:0,pending:[]},memo,name),text=renderMemoChanges(changes,memo,{roomId:'topic',members:room().members})
 for(const part of ['M3 added by pm@mei (agent), from #12: fact','M4 replaces M3, by kai (nickname: Kai) (person), score 4 carried: new fact','M3 evicted to make room for M5 (score 0); L1 names M3','M3 retired by kai (nickname: Kai) (person)','M3 restored by pm@mei (agent): restored','misled, see #12 (−2, now 1)','bad (−4, now -3)','now version 2, a big change (40% shorter; no longer names M2):','M2, M3 merged into L1 version 3 by pm@mei (agent)','Merge before you start work: M3'])assert.ok(text.includes(part),part)
 assert.equal(text.split('│ current').length,2);assert.ok(text.includes('│ │ nested'));assert.ok(!text.includes('own'));assert.ok(!text.includes('halve'))
 const output=renderDelivery({room:room(memo),messages:[{...msg,memo:{cite:['M3','M5'],misled:['M4']}}],name,tasks:['task update'],memo:changes})
 assert.ok(output.indexOf('Your tasks changed:')<output.indexOf('Memo changes:'));assert.ok(output.indexOf('Memo changes:')<output.indexOf('#9 from'));assert.ok(output.includes('Memo: cites M3, M5 · misled by M4.'))
})
test('delivery cursors handle old state, reminders, own events, gaps and unknown frames without resetting known state',()=>{
 const initial=deliveryDue(null,{session:1,room:room(),name});assert.ok(initial.remind);assert.deepEqual(initial.next.memo,{log:0,pending:[]})
 const memo={...empty(),log:[entry(10,'add',{text:'new',from:'#12'})],logLast:10,pending:['M3']}
 const next=deliveryDue(initial.next,{session:1,room:room(memo),name});assert.equal(next.remind,null);assert.equal(next.memo.gap,9);assert.deepEqual(next.next.memo,{log:10,pending:['M3']})
 assert.match(renderMemoChanges(next.memo,memo,{roomId:'topic'}),/- 9 more changes not listed \(scorpio memo topicId=topic\)/)
 const {memo:ignored,...old}=initial.next;const migrated=deliveryDue(old,{session:1,room:room(memo),name});assert.equal(migrated.memo,null);assert.equal(migrated.next.memo.log,10)
 const unknown=room();delete unknown.memo;const kept=deliveryDue(next.next,{session:1,room:unknown,name});assert.deepEqual(kept.next.memo,next.next.memo)
 const repeat=deliveryDue({...next.next,count:20},{session:1,room:room(memo),name});assert.ok(repeat.remind);assert.equal(repeat.memo,null)
 assert.equal(memoChanges(next.next.memo,memo,name).entries.length,0)
})
