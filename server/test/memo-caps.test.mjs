import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {memoRoom,kai,api,qa} from './helpers/memo-room.mjs';
let w;before(async()=>{w=await memoRoom();});after(async()=>{await w?.dispose();});
const write=(room,p,actor=api,page=false)=>w.ok(room,'memoWrite',actor,p,page);
const read=(room,p={})=>w.ok(room,'memoRead',api,p);
async function fill(room,count){for(let n=1;n<=count;n++){await w.call(room,'clock',1795000000000+n*60000);await write(room,{op:'add',text:`fact ${n}`,from:'#3'});}}
test('long cap keeps ten per slot, restores keep counting, pruned version next is precise; lost only uses kept merged lists',async()=>{
 const room='long-cap';await w.init(room);await write(room,{op:'add',text:'first',from:'#3'});
 for(let version=0;version<12;version++)await write(room,{op:'long',slot:'L1',version,text:'M1 kept source, version '+version,...(version===0?{merged:['M1']}:{})});
 assert.deepEqual((await read(room,{versions:'L1',limit:'20'})).versions.map(v=>v.version),[12,11,10,9,8,7,6,5,4,3]);
 const gone=await w.call(room,'memoWrite',api,{op:'restore',slot:'L1',version:2});assert.equal(gone.err?.code,'memo_not_found');assert.equal(gone.err.next,'L1 version 2 is gone: the latest 10 versions are kept.');
 const restored=await write(room,{op:'restore',slot:'L1',version:3});assert.equal(restored.long.version,13);assert.equal(restored.long.restoredFrom,3);
 const log=await w.call(room,'inspect',"SELECT * FROM memo_log WHERE op IN ('long','merge')");
 assert.ok(log.every(r=>!Object.hasOwn(JSON.parse(r.data),'text')));assert.ok(log.some(r=>r.op==='merge'));
 const noLost=await write(room,{op:'long',slot:'L1',version:13,text:'A longer replacement text without the old reference to a memo number.'});assert.equal(noLost.long.big,false);
 assert.deepEqual(JSON.parse((await w.call(room,'inspect','SELECT lost FROM memo_long WHERE slot=1 AND version=14'))[0].lost),[]);
 await write(room,{op:'long',slot:'L2',version:0,text:'independent'});assert.equal((await read(room,{versions:'L2'})).versions.length,1);
});
test('retired cap deletes oldest plus scores and votes, never reuses M numbers, and gone cite/misled leave no orphan scores',async()=>{
 const room='short-cap';await w.init(room);await fill(room,1);
 await write(room,{op:'vote',id:'M1',vote:'bad'},kai,true);
 await w.ok(room,'send',qa,{text:'@kai used',cite:['M1'],nonce:'before-prune'});
 for(let n=2;n<=60;n++){await w.call(room,'clock',1795000000000+n*60000);await write(room,{op:'add',text:`fact ${n}`,from:'#3'});}
 const state=await read(room);assert.equal(state.retired,50);assert.equal(state.short.length,8);assert.equal(await w.call(room,'key','lastMemo'),60);
 for(const table of ['memos','memo_scores','memo_votes'])assert.deepEqual(await w.call(room,'inspect',`SELECT * FROM ${table} WHERE n=1`),[]);
 for(const p of [{show:'M1'}]){const r=await w.call(room,'memoRead',api,p);assert.equal(r.err?.code,'memo_not_found');assert.equal(r.err.next,'M1 is gone: the retired list keeps the latest 50 memos.');}
 const restore=await w.call(room,'memoWrite',api,{op:'restore',id:'M1'});assert.equal(restore.err?.next,'M1 is gone: the retired list keeps the latest 50 memos.');
 const sent=await w.ok(room,'send',qa,{text:'@kai stale refs',cite:['M1'],misled:['M2'],nonce:'gone'});
 assert.deepEqual(sent.memo,{cite:[{id:'M1',counted:false,reason:'gone'}],misled:[{id:'M2',counted:false,reason:'gone'}]});
 const replay=await w.ok(room,'send',qa,{text:'@kai changed',cite:['M999'],nonce:'gone'});assert.deepEqual(replay.memo,sent.memo);assert.equal(replay.seq,sent.seq);
 assert.deepEqual((await w.ok(room,'message',api,sent.seq)).message.memo,{cite:['M1'],misled:['M2'],uncounted:[{id:'M1',reason:'gone'},{id:'M2',reason:'gone'}]});
 assert.deepEqual(await w.call(room,'inspect','SELECT * FROM memo_scores WHERE n IN (1,2)'),[]);
 const before=await w.call(room,'inspect','SELECT COUNT(*) AS n FROM messages');const never=await w.call(room,'send',qa,{text:'@kai never existed',cite:['M999']});assert.equal(never.err?.code,'memo_not_found');assert.match(never.err.next,/No memo M999/);assert.deepEqual(await w.call(room,'inspect','SELECT COUNT(*) AS n FROM messages'),before);
 assert.equal((await write(room,{op:'add',text:'next',from:'#3'})).memo.id,'M61');
});
test('log cap keeps newest 500 with monotonic ids; send attach rollback restores rows deleted by trim',async()=>{
 const room='log-cap';await w.init(room);await fill(room,260);
 const before=await w.call(room,'inspect','SELECT * FROM memo_log ORDER BY id');assert.equal(before.length,500);assert.equal(before.at(-1).id,512);assert.equal(before[0].id,13);
 const listen=await w.ok(room,'listen',api);assert.equal(listen.memo.log.length,50);assert.equal(listen.memo.logLast,512);
 await w.call(room,'failMemoAttach',true);const failed=await w.call(room,'send',qa,{text:'@kai fail after trim',misled:['M260']});assert.match(failed.thrown,/injected/);await w.call(room,'failMemoAttach',false);
 assert.deepEqual(await w.call(room,'inspect','SELECT * FROM memo_log ORDER BY id'),before);
 const sent=await w.ok(room,'send',qa,{text:'@kai lower',misled:['M260']});assert.equal(sent.memo.misled[0].counted,true);
 const after=await w.call(room,'inspect','SELECT * FROM memo_log ORDER BY id');assert.equal(after.length,500);assert.equal(after[0].id,14);assert.equal(after.at(-1).id,513);
});
test('a failed memo nonce insert rolls retired pruning, scores, votes and lastMemo back in the same transaction',async()=>{
 const room='prune-rollback';await w.init(room);await fill(room,58); // 8 slots + 50 retired.
 const before=await w.call(room,'inspect','SELECT * FROM memos ORDER BY n');
 await w.call(room,'inspect',"CREATE TRIGGER fail_memo_nonce BEFORE INSERT ON nonces WHEN NEW.nonce='fail-trim' BEGIN SELECT RAISE(ABORT,'forced nonce failure'); END");
 const failed=await w.call(room,'memoWrite',api,{op:'add',text:'must roll back',from:'#3',nonce:'fail-trim'});assert.match(failed.thrown,/forced nonce failure/);
 assert.deepEqual(await w.call(room,'inspect','SELECT * FROM memos ORDER BY n'),before);assert.equal(await w.call(room,'key','lastMemo'),58);
});
test('score history stores counted events only; 100+ repeat cites stay uncounted, and next UTC day counts once',async()=>{
 const room='score-cite-cap';await w.call(room,'clock',1796000000000);await w.init(room);await write(room,{op:'add',text:'counted source',from:'#3'});
 const first=await w.ok(room,'send',qa,{text:'@kai first',cite:['M1']});assert.equal(first.memo.cite[0].counted,true);
 for(let i=0;i<105;i++){
  await w.call(room,'clock',1796000000000+i*60000);
  const repeat=await w.ok(room,'send',qa,{text:'@kai repeat',cite:['M1']});assert.equal(repeat.memo.cite[0].reason,'today');
 }
 const own=await w.ok(room,'send',api,{text:'@kai own',cite:['M1']});assert.equal(own.memo.cite[0].reason,'own');
 assert.equal((await read(room,{show:'M1'})).scores.length,1);
 await w.call(room,'clock',1796086400000);
 const next=await w.ok(room,'send',qa,{text:'@kai next day',cite:['M1']});assert.equal(next.memo.cite[0].counted,true);
 assert.equal((await w.ok(room,'send',qa,{text:'@kai next repeat',cite:['M1']})).memo.cite[0].reason,'today');
 assert.equal((await read(room,{show:'M1'})).scores.length,2);
});
test('150 vote toggles trim to newest 100, preserve standing vote and running score, and cannot evict today cite/misled dedup',async()=>{
 const room='score-vote-cap';await w.call(room,'clock',1797000000000);await w.init(room);await write(room,{op:'add',text:'vote source',from:'#3'});await write(room,{op:'add',text:'vote only',from:'#3'});
 await w.ok(room,'send',qa,{text:'@kai counted',cite:['M1'],nonce:'score-original'});
 await w.ok(room,'send',qa,{text:'@kai misled',misled:['M1']});
 for(let i=0;i<150;i++){
  await w.call(room,'clock',1797000000000+i*60000);
  await write(room,{op:'vote',id:'M1',vote:i%2?'bad':'good'},kai,true);await write(room,{op:'vote',id:'M2',vote:i%2?'bad':'good'},kai,true);
 }
 assert.equal((await read(room,{show:'M2'})).scores.length,100);
 const detail=await read(room,{show:'M1'});assert.equal(detail.scores.filter(s=>['good','bad','unvote'].includes(s.kind)).length,100);assert.equal(detail.scores.length,102);
 assert.ok(detail.scores.every(s=>s.counted));assert.equal(detail.memo.score,-3);assert.deepEqual(detail.memo.votes.bad,['kai']);
 assert.equal((await w.ok(room,'send',qa,{text:'@kai still today',cite:['M1']})).memo.cite[0].reason,'today');
 assert.equal((await w.ok(room,'send',qa,{text:'@kai still misled',misled:['M1']})).memo.misled[0].reason,'today');
 await w.call(room,'clock',1797086400000);
 const next=await w.ok(room,'send',qa,{text:'@kai next',cite:['M1']});assert.equal(next.memo.cite[0].counted,true);
 assert.equal((await read(room,{show:'M1'})).scores.length,100);
});
