import assert from 'node:assert/strict';
import test from 'node:test';
import {worker,ORIGIN} from './helpers/worker.mjs';
const append=`export class MemoRouteRoom extends RoomDO {
 async inspect(query,...args) { return this.sql.exec(query,...args).toArray(); }
 async flushMemo() { this.ctx.storage.kv.put('memoDue',Date.now()-1); await this.alarm(); }
 async writeSnapshotNow() { await this.writeSnapshot(); }
}`;
const settings={append,className:'MemoRouteRoom'};
async function setup(){const w=await worker({},settings);const p=await w.person('ops'),room=await w.topic(p);await w.join(p,room,'api');const source=await w.json(await p.apiPost(`/rooms/${room}/send`,{text:'@ops real local source'},'api'));return{w,p,room,source};}
async function socket(res) {assert.equal(res.status,101,await res.text());const ws=res.webSocket,frames=[];ws.addEventListener('message',e=>{if(e.data!=='pong')frames.push(JSON.parse(e.data));});ws.accept();return{ws,frames};}
async function until(fn){const end=Date.now()+2500;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'expected frame');}
test('both HTTP routes execute add/read/replace/retire/restore/long/merge/versions/vote and preserve conflict current',async()=>{
 const {w,p,room,source}=await setup();try{
  const url=`/rooms/${room}/memo`,page=`/r/${room}/memo`;
  const post=(b)=>p.apiPost(url,b,'api').then(w.json),get=q=>p.api(url+(q?'?'+q:''),{},'api').then(w.json);
  assert.equal((await get()).short.length,0);
  const add=await post({op:'add',text:'local fact',from:`#${source.seq}`,nonce:'memo-one'});assert.equal(add.status,200);assert.equal(add.memo.id,'M1');assert.deepEqual((await get('show=M1')).memo,add.memo);
  assert.equal((await post({op:'add',text:'changed',from:`#${source.seq}`,nonce:'memo-one'})).memo.text,'local fact');
  const replaced=await post({op:'add',text:'revised fact',from:`#${source.seq}`,replaces:'M1'});assert.equal(replaced.replaced.state,'replaced');
  assert.equal((await post({op:'retire',id:'M2'})).memo.state,'retired');assert.equal((await post({op:'restore',id:'M2'})).memo.id,'M2');
  const long=await post({op:'long',slot:'L1',version:0,text:'M2 revised fact (api, source)',merged:['M2']});assert.equal(long.merged[0].state,'merged');
  const conflict=await post({op:'long',slot:'L1',version:0,text:'stale'});assert.equal(conflict.status,409);assert.equal(conflict.error,'version_conflict');assert.equal(conflict.current.text,long.long.text);
  assert.equal((await post({op:'restore',slot:'L1',version:1})).long.version,2);assert.equal((await get('versions=L1')).versions.length,2);assert.equal((await get('retired=1')).memos.length,2);
  const webAdd=await w.json(await p.post(page,{op:'add',text:'person fact',from:`#${source.seq}`}));assert.equal(webAdd.memo.by,'ops');
  const vote=await w.json(await p.post(page,{op:'vote',id:webAdd.memo.id,vote:'good'}));assert.equal(vote.memo.score,2);
  assert.equal((await w.json(await p.web(page+'?show='+webAdd.memo.id))).memo.score,2);
  assert.equal((await w.json(await p.web(page+'?versions=L1'))).versions.length,2);
  assert.ok((await w.json(await p.web(page+'?retired=1'))).memos.length);
  assert.equal((await w.json(await p.post(page,{op:'retire',id:webAdd.memo.id}))).memo.state,'retired');
  assert.equal((await w.json(await p.post(page,{op:'restore',id:webAdd.memo.id}))).memo.id,webAdd.memo.id);
  assert.equal((await w.json(await p.post(page,{op:'long',slot:'L2',version:0,text:'person long'}))).long.version,1);
  assert.equal((await w.json(await p.post(page,{op:'restore',slot:'L2',version:1}))).long.version,2);
 }finally{await w.dispose();}
});
test('HTTP every new refusal, session/same-origin gates, viewers and command/scheduled seats, archive and Retry-After',async()=>{
 const {w,p,room,source}=await setup();try{
  const url=`/rooms/${room}/memo`,page=`/r/${room}/memo`,post=(b)=>p.apiPost(url,b,'api').then(w.json);
  for(const [body,status,error] of [
   [{op:'add',text:'x'},400,'source_required'],[{op:'add',text:'x',from:'#999'},404,'source_not_found'],
   [{op:'add',text:'x'.repeat(501),from:`#${source.seq}`},413,'memo_too_long'],[{op:'retire',id:'M1'},404,'memo_not_found'],
   [{op:'vote',id:'M1',vote:'good'},403,'forbidden'],[{op:'long',slot:'L1',version:0,text:'x'.repeat(3501)},413,'memo_too_long'],
  ]){const r=await post(body);assert.equal(r.status,status,JSON.stringify(r));assert.equal(r.error,error);}
  await post({op:'add',text:'fact',from:`#${source.seq}`});
  assert.equal((await post({op:'restore',id:'M1'})).error,'already_in_slot');
  assert.equal((await post({op:'long',slot:'L1',version:0,text:'missing',merged:['M1']})).error,'merge_unnamed');
  await post({op:'retire',id:'M1'});assert.equal((await post({op:'retire',id:'M1'})).error,'not_in_slot');
  const viewer=await w.person('guest');assert.equal((await viewer.web(page)).status,200);assert.equal((await viewer.post(page,{op:'add',text:'no',from:`#${source.seq}`})).status,403);assert.equal((await viewer.post(page,{op:'vote',id:'M1',vote:'good'})).status,403);
  assert.equal((await w.fetch(page)).status,303);assert.equal((await p.web(page,{method:'POST',headers:{origin:'https://wrong.test','content-type':'application/json'},body:'{}'})).status,403);
  const stub=(await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room);
  for(const [name,kind] of [['daemon@ops','host'],['scheduled','scheduled']]){
   await stub.inspect('INSERT INTO members(name,kind,owner,joined_at) VALUES(?,?,?,?)',name,kind,'ops',Date.now());
   const actor={kind:'agent',account:'ops',name};assert.equal((await stub.memoWrite(actor,{op:'add',text:'no',from:`#${source.seq}`})).err.code,'forbidden');
  }
  await p.post(`/r/${room}/archive`);assert.equal((await post({op:'add',text:'x',from:`#${source.seq}`})).error,'room_archived');assert.equal((await p.web(page)).status,200);
  await p.post(`/r/${room}/archive`,{archived:false});
  const second=await w.topic(p);const secondStub=(await w.mf.getDurableObjectNamespace('ROOMS')).getByName(second);
  // Real domain writes reach both rate counters; HTTP then translates the domain refusal and Retry-After.
  for(let i=0;i<30;i++)assert.ok((await secondStub.memoWrite({kind:'human',account:'ops',name:'ops'},{op:'long',slot:'L1',version:i,text:'x'})).ok);
  const limited=await p.post(`/r/${second}/memo`,{op:'long',slot:'L1',version:30,text:'x'});assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);assert.equal((await limited.json()).error,'rate_limited');
 }finally{await w.dispose();}
});
test('memo error next lines follow the topic page language; agent routes keep English',async()=>{
 const {w,p,room}=await setup();try{
  const url=`/rooms/${room}/memo`,page=`/r/${room}/memo`,zh={'accept-language':'zh-CN,zh;q=0.9'};
  const web=await w.json(await p.post(page,{op:'add',text:'x',from:'#99999'},zh));
  assert.equal(web.error,'source_not_found');assert.equal(web.next,'主题里没有消息 #99999。请选择 memo 所依据的消息或任务。');
  assert.equal((await w.json(await p.post(page,{op:'add',text:'x',from:'T99'},zh))).next,'主题里没有任务 T99。请选择 memo 所依据的消息或任务。');
  const cookie=await w.json(await p.web(page+'?show=M9',{headers:{cookie:`${p.cookie}; lang=zh`}}));
  assert.equal(cookie.error,'memo_not_found');assert.equal(cookie.next,`主题里没有 memo M9。查看列表：scorpio memo topicId=${room}`);
  assert.equal((await w.json(await p.post(page,{op:'add',text:'x',from:'#99999'}))).next,'No message #99999 in this topic. Pick the message or task the memo comes from.');
  const agent=await w.json(await p.api(url,{method:'POST',body:JSON.stringify({op:'add',text:'x',from:'#99999'}),headers:{'content-type':'application/json',...zh}},'api'));
  assert.equal(agent.next,'No message #99999 in this topic. Pick the message or task the memo comes from.');
 }finally{await w.dispose();}
});
test('memo frame is in hello and follows daemon todo; signed-in viewer reads it; changes coalesce; snapshots omit memo and message tags',async()=>{
 const {w,p,room,source}=await setup();const opened=[];try{
  const stub=(await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room),viewer=await w.person('reader');
  const browser=await socket(await p.web(`/r/${room}/ws`,{headers:{upgrade:'websocket',origin:ORIGIN}}));opened.push(browser);
  const guest=await socket(await viewer.web(`/r/${room}/ws`,{headers:{upgrade:'websocket',origin:ORIGIN}}));opened.push(guest);
  await stub.inspect("INSERT INTO members(name,kind,owner,joined_at) VALUES('daemon@ops','host','ops',?)",Date.now());
  const host=await socket(await p.api(`/rooms/${room}/ws`,{headers:{upgrade:'websocket'}},'daemon'));opened.push(host);
  await until(()=>browser.frames.some(f=>f.type==='memo')&&guest.frames.some(f=>f.type==='memo')&&host.frames.some(f=>f.type==='memo'));
  assert.equal(browser.frames.find(f=>f.type==='hello').memo.short.length,0);assert.equal(guest.frames.find(f=>f.type==='hello').me.member,false);
  const types=host.frames.map(f=>f.type);assert.equal(types.indexOf('memo'),types.indexOf('todo')+1);
  const initial=host.frames.filter(f=>f.type==='memo').length;
  await p.apiPost(`/rooms/${room}/memo`,{op:'add',text:'socket fact',from:`#${source.seq}`},'api');
  await p.apiPost(`/rooms/${room}/memo`,{op:'add',text:'second fact',from:`#${source.seq}`},'api');
  await until(()=>host.frames.filter(f=>f.type==='memo').length===initial+1);
  assert.equal(host.frames.filter(f=>f.type==='memo').at(-1).short.length,2);
  assert.equal(guest.frames.filter(f=>f.type==='memo').at(-1).short.length,2);
  await p.apiPost(`/rooms/${room}/send`,{text:'@ops @daemon@ops message cites memo',cite:['M1']},'api');
  await until(()=>browser.frames.some(f=>f.type==='message'&&f.message?.memo)||browser.frames.some(f=>f.type==='message'&&f.memo));
  const msgFrame=browser.frames.filter(f=>f.type==='message').at(-1);assert.deepEqual((msgFrame.message??msgFrame).memo,{cite:['M1'],misled:[],uncounted:[{id:'M1',reason:'own'}]});
  await until(()=>host.frames.some(f=>f.type==='push'&&f.message?.memo));
  const listen=await w.json(await p.api(`/rooms/${room}/listen`,{},'api'));assert.equal(listen.memo.short.length,2);
  await stub.writeSnapshotNow();const snap=await w.kv.get(`public:${room}`,'json');assert.ok(snap);assert.equal(snap.memo,undefined);assert.ok(snap.messages.every(m=>m.memo===undefined));
 }finally{for(const s of opened)s.ws.close();await w.dispose();}
});
test('concurrent mergers of one long version commit once and return current text to the loser',async()=>{
 const {w,p,room,source}=await setup();try{
  const path=`/rooms/${room}/memo`;
  await p.apiPost(path,{op:'add',text:'merge fact',from:`#${source.seq}`},'api');
  const requests=await Promise.all([1,2].map(n=>p.apiPost(path,{op:'long',slot:'L1',version:0,text:`M1 merge ${n}`,merged:['M1']},'api').then(w.json)));
  const success=requests.find(r=>r.status===200),conflict=requests.find(r=>r.status===409);
  assert.ok(success,JSON.stringify(requests));assert.equal(conflict.error,'version_conflict');assert.equal(conflict.current.text,success.long.text);
  const state=await w.json(await p.api(path,{},'api'));assert.equal(state.long[0].version,1);assert.deepEqual(state.short,[]);
 }finally{await w.dispose();}
});
