import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {memoRoom,kai,api,qa} from './helpers/memo-room.mjs';
let w;before(async()=>{w=await memoRoom();});after(async()=>{await w?.dispose();});
const add=(room,text='fact',actor=api)=>w.ok(room,'memoWrite',actor,{op:'add',text,from:'#3'});
const send=(room,p,actor=qa)=>w.ok(room,'send',actor,{text:'@kai @api@kai citing',...p});
test('send cite/misled counts per name per UTC day, own cites excluded, stored readers use ids; replay is the original answer',async()=>{
 const room='send';await w.init(room);await add(room);await add(room,'fact two',qa);
 const first=await send(room,{cite:['M1','M2'],misled:[],nonce:'send-one'});
 assert.deepEqual(first.memo.cite,[{id:'M1',counted:true,score:1},{id:'M2',counted:false,score:0,reason:'own'}]);
 assert.equal((await send(room,{cite:['M1']})).memo.cite[0].reason,'today');
 assert.equal((await send(room,{cite:['M1']},kai)).memo.cite[0].counted,true);
 const daily=await send(room,{misled:['M1']});assert.equal(daily.memo.misled[0].score,0);
 assert.equal((await send(room,{misled:['M1']})).memo.misled[0].reason,'today');
 const replay=await send(room,{nonce:'send-one',cite:['M999']});assert.deepEqual(replay.memo,first.memo);assert.equal(replay.seq,first.seq);
 const message=(await w.ok(room,'message',api,first.seq)).message;assert.deepEqual(message.memo,{cite:['M1','M2'],misled:[],uncounted:[{id:'M2',reason:'own'}]});
 for(const method of ['messages','history','around']) {
  const result=await w.ok(room,method,api,method==='messages'?{}:method==='history'?Number.MAX_SAFE_INTEGER:first.seq);
  assert.deepEqual(result.messages.find(m=>m.seq===first.seq).memo,message.memo,method);
 }
 const listen=await w.ok(room,'listen',api);assert.ok(listen.memo);assert.deepEqual(listen.mentions.find(m=>m.seq===first.seq).memo,message.memo);
 await w.call(room,'clock',1793347200000);
 assert.equal((await send(room,{cite:['M1']})).memo.cite[0].counted,true);
});
test('two agents on the same account count separately; bad references and overlaps leave no message or score; attach failure rolls everything back',async()=>{
 const room='atomic';await w.init(room);await add(room,'human fact',kai);
 assert.equal((await send(room,{cite:['M1']},api)).memo.cite[0].counted,true);
 assert.equal((await send(room,{cite:['M1']},qa)).memo.cite[0].counted,true);
 const before=await w.call(room,'inspect','SELECT COUNT(*) AS n FROM messages');
 for(const p of [{cite:['M999']},{cite:['M1'],misled:['M1']},{cite:'M1'},{misled:Array(9).fill('M1')}]) {
  const r=await w.call(room,'send',qa,{text:'@kai invalid',...p});assert.ok(['memo_not_found','bad_request'].includes(r.err?.code),JSON.stringify(r));
 }
 assert.deepEqual(await w.call(room,'inspect','SELECT COUNT(*) AS n FROM messages'),before);
 const scores=await w.call(room,'inspect','SELECT * FROM memo_scores');const cites=await w.call(room,'key','memoCites');
 await w.call(room,'failMemoAttach',true);const failed=await w.call(room,'send',kai,{text:'failure',misled:['M1'],nonce:'failure'});assert.match(failed.thrown,/injected/);await w.call(room,'failMemoAttach',false);
 assert.deepEqual(await w.call(room,'inspect','SELECT * FROM memo_scores'),scores);assert.equal(await w.call(room,'key','memoCites'),cites);assert.deepEqual(await w.call(room,'inspect','SELECT COUNT(*) AS n FROM messages'),before);
});
test('32nd counted cite halves all short scores toward zero including retired; 31st does not halve; replay never counts twice',async()=>{
 const room='halve';await w.init(room);for(let i=0;i<8;i++)await add(room,`fact ${i}`,kai);
 await w.ok(room,'memoWrite',kai,{op:'vote',id:'M8',vote:'bad'},true);await w.ok(room,'memoWrite',api,{op:'retire',id:'M8'});
 await w.ok(room,'join',{kind:'agent',account:'kai',name:'other@kai'},{role:'other'});
 const actors=[api,qa,{kind:'agent',account:'kai',name:'other@kai'}];
 let count=0;let last;
 for(let day=0;day<2;day++) {
  await w.call(room,'clock',1793433600000+day*86400000);
  for(const actor of actors) for(const id of ['M1','M2','M3','M4','M5','M6','M7','M8']) {
   if(count===32)break;
   last=await send(room,{cite:[id],nonce:`cite-${count}`},actor);count++;
   if(count===31){assert.equal((await w.ok(room,'memoRead',api)).cites,31);assert.equal((await w.call(room,'inspect',"SELECT COUNT(*) AS n FROM memo_log WHERE op='halve'"))[0].n,0);}
  }
 }
 assert.equal(count,32);const state=await w.ok(room,'memoRead',api);assert.equal(state.cites,0);assert.equal((await w.call(room,'inspect',"SELECT COUNT(*) AS n FROM memo_log WHERE op='halve'"))[0].n,1);
 assert.equal((await w.ok(room,'memoRead',api,{show:'M8'})).memo.score,1); // -2 + four cites = 2, halved to 1
 const replay=await send(room,{cite:['M8'],nonce:'cite-31'},actors[0]);
 // Last actor is api on day two; the original replay receipt is immutable.
 assert.deepEqual(replay.memo,last.memo);assert.equal((await w.ok(room,'memoRead',api)).cites,0);
});
test('one send halves before misled: negative retired score truncates toward zero and lower log uses the resulting score',async()=>{
 const room='half-lower';await w.call(room,'clock',1794000000000);await w.init(room);
 for(let i=0;i<8;i++)await add(room,`fact ${i}`,kai);
 await w.ok(room,'memoWrite',kai,{op:'vote',id:'M8',vote:'bad'},true);
 await send(room,{misled:['M8']},api);await send(room,{cite:['M8']},qa);
 await w.ok(room,'memoWrite',api,{op:'retire',id:'M8'});
 await w.ok(room,'memoWrite',api,{op:'long',slot:'L1',version:0,text:'M8 supporting detail'});
 for(let day=1;day<=5;day++){
  await w.call(room,'clock',1794000000000+day*86400000);
  for(let n=1;n<=6;n++)await send(room,{cite:[`M${n}`]},api);
 }
 assert.equal((await w.ok(room,'memoRead',api)).cites,31);
 const final=await send(room,{cite:['M7'],misled:['M8']},qa);
 assert.equal(final.memo.misled[0].score,-3); // -3 / 2 = -1, then -2.
 const lower=(await w.call(room,'inspect',"SELECT data FROM memo_log WHERE op='lower' ORDER BY id DESC LIMIT 1"))[0];
 assert.equal(JSON.parse(lower.data).score,-3);assert.deepEqual(JSON.parse(lower.data).contains,[{slot:'L1',memos:['M8']}]);
 const detail=await w.ok(room,'memoRead',api,{show:'M8'});assert.equal(detail.memo.score,-3);assert.equal(detail.halvings.length,1);
});
