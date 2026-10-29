import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {execFile} from 'node:child_process'
import {testEnv} from './env.mjs'
const topicId='AbCdEf0123456789_-ghIJ'
const name='api@kai'
const empty=()=>({type:'memo',long:[{slot:'L1',version:0,text:''},{slot:'L2',version:0,text:''}],short:[],retired:0,pending:[],log:[],logLast:0})
const changed=()=>({...empty(),long:[{slot:'L1',version:2,text:'shared rule',by:'pm@mei',byKind:'agent'}],log:[{id:1,op:'long',slot:'L1',version:2,by:'pm@mei',byKind:'agent',big:false}],logLast:1,pending:['M3']})
const message=seq=>({seq,from:'pm@mei',fromKind:'agent',text:'@api@kai A source update.',mentions:[name]})
const metadata={roomId:topicId,roomName:'Notes',topic:'A topic',owner:'kai',members:[{name,kind:'agent'},{name:'kai',kind:'human'}],items:[]}

test('daemon memo frame updates the cached topic and the next delivery, and state persists only log and pending',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'scorpio-memo-daemon-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));process.env.SCORPIO_HOME=home
 const {createRooms,composeDelivery}=await import('../src/daemon/main.mjs')
 const {writeJson,readJson}=await import('../src/daemon/paths.mjs')
 const rooms=createRooms();rooms.update(topicId,metadata);rooms.frame(topicId,empty())
 const entry={roomId:topicId,name,role:'api',ts:1}
 const first=composeDelivery({entry,room:rooms.get(topicId),messages:[message(1)],maxBytes:100000})
 assert.match(first.text,/Memo: none yet/)
 rooms.frame(topicId,changed())
 const next=composeDelivery({entry,room:rooms.get(topicId),messages:[message(2)],reminded:first.next,pokedSeq:1,maxBytes:100000})
 assert.match(next.text,/Memo changes:/);assert.match(next.text,/L1 changed by pm@mei \(agent\), now version 2:/);assert.match(next.text,/│ shared rule/);assert.match(next.text,/Merge before you start work: M3/)
 assert.deepEqual(next.next.memo,{log:1,pending:['M3']})
 const file=path.join(home,'delivery.json');writeJson(file,{reminded:[[topicId+'|'+name,next.next]]});const stored=readJson(file).reminded[0][1];assert.deepEqual(stored.memo,next.next.memo);assert.equal(stored.memo.long,undefined)
 const resend=composeDelivery({entry,room:rooms.get(topicId),messages:[message(2)],reminded:stored,pokedSeq:2,maxBytes:100000});assert.ok(!resend.text.includes('Memo changes:'));assert.deepEqual(resend.next.memo,stored.memo)
 const freshSession=composeDelivery({entry:{...entry,ts:2},room:rooms.get(topicId),messages:[message(3)],reminded:stored,pokedSeq:2,maxBytes:100000});assert.ok(freshSession.remind);assert.match(freshSession.text,/Memo \(written/)
})

test('wait renders listen.memo and keeps its cursor by session, topic and name across separate CLI calls',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'scorpio-memo-wait-'));fs.writeFileSync(path.join(home,'token'),'fixture-token')
 let round=0
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({roomId:topicId,me:name,room:{name:'Notes',topic:'A topic',owner:'kai'},members:metadata.members,items:[],mentions:[message(round+1)],broadcasts:[],memo:round?changed():empty()}))})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(home,{recursive:true,force:true})})
 const bin=new URL('../bin/scorpio.mjs',import.meta.url).pathname
 const env=testEnv(home,{SCORPIO_HOME:home,SCORPIO_SERVER:`http://127.0.0.1:${server.address().port}`,CODEX_THREAD_ID:'memo-session'})
 const run=()=>new Promise(resolve=>execFile(process.execPath,[bin,'wait',`topicId=${topicId}`,'role=api','timeout=1'],{env,timeout:10000},(e,stdout,stderr)=>resolve({code:e?.code??0,text:stdout,stderr})))
 const first=await run();assert.equal(first.code,0,first.stderr);assert.match(first.text,/Memo: none yet/)
 round=1;const second=await run();assert.equal(second.code,0,second.stderr);assert.match(second.text,/Memo changes:/);assert.match(second.text,/│ shared rule/)
 const state=JSON.parse(fs.readFileSync(path.join(home,'state','reminders.json'),'utf8'));assert.deepEqual(state[`memo-session|${topicId}|${name}`].memo,{log:1,pending:['M3']})
 round=2;const third=await run();assert.equal(third.code,0);assert.ok(!third.text.includes('Memo changes:'))
})
test('oversized memo changes omit oldest lines with an exact gap, keep newest quotes whole and advance the log cursor',async()=>{
 const {composeDelivery}=await import('../src/daemon/main.mjs')
 const entry={name,role:'api',ts:1}
 const first=composeDelivery({entry,room:{...metadata,memo:empty()},messages:[message(1)],maxBytes:120*1024})
 const longText='😀'.repeat(3500),shortText='😀'.repeat(500)
 const memo={...empty(),long:[1,2].map(n=>({slot:'L'+n,version:1,text:longText})),log:[
  ...Array.from({length:48},(_,i)=>({id:i+1,op:'add',m:'M'+(i+1),by:'pm@mei',byKind:'agent',from:'#12',text:shortText})),
  ...Array.from({length:2},(_,i)=>({id:49+i,op:'long',slot:'L'+(i+1),version:1,by:'pm@mei',byKind:'agent'})),
 ],logLast:50}
 const full=composeDelivery({entry,room:{...metadata,memo},messages:[{...message(2),text:'@api@kai update'}],reminded:first.next,pokedSeq:1,maxBytes:200*1024})
 assert.ok(Buffer.byteLength(full.text)>120*1024)
 const bounded=composeDelivery({entry,room:{...metadata,memo},messages:[{...message(2),text:'@api@kai update'}],reminded:first.next,pokedSeq:1,maxBytes:120*1024})
 assert.ok(Buffer.byteLength(bounded.text)<=120*1024)
 const gap=Number(bounded.text.match(/- (\d+) more changes not listed/)[1])
 const kept=[...bounded.text.matchAll(/^- M\d+ added /gm)].length
 assert.equal(gap,48-kept);assert.equal(gap,2)
 assert.ok(bounded.text.includes(`- M48 added by pm@mei (agent), from #12: ${shortText}`))
 assert.ok(bounded.text.includes(`- L2 changed by pm@mei (agent), now version 1:`));assert.equal(bounded.text.split(`│ ${longText}`).length,3)
 assert.deepEqual(bounded.next.memo,{log:50,pending:[]})
})
