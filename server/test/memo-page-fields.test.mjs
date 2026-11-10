import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {memoRoom,kai,api,qa} from './helpers/memo-room.mjs';
let w;before(async()=>{w=await memoRoom();});after(async()=>{await w?.dispose();});
test('readers get uncounted reasons but no send-time score, while replay keeps the original receipt',async()=>{
 const room='page-receipt';await w.init(room);await w.ok(room,'memoWrite',api,{op:'add',text:'fact',from:'#3'});
 const own=await w.ok(room,'send',api,{text:'@kai own',cite:['M1'],nonce:'own'});
 const receipt=own.memo;assert.equal(receipt.cite[0].reason,'own');
 const message=(await w.ok(room,'message',kai,own.seq)).message;assert.deepEqual(message.memo,{cite:['M1'],misled:[],uncounted:[{id:'M1',reason:'own'}]});assert.ok(!JSON.stringify(message.memo).includes('score'));
 const counted=await w.ok(room,'send',qa,{text:'@kai use',cite:['M1']});assert.deepEqual((await w.ok(room,'message',kai,counted.seq)).message.memo.uncounted,[]);
 const today=await w.ok(room,'send',qa,{text:'@kai again',cite:['M1']});assert.deepEqual((await w.ok(room,'message',api,today.seq)).message.memo.uncounted,[{id:'M1',reason:'today'}]);
 assert.deepEqual((await w.ok(room,'send',api,{text:'@kai replay',nonce:'own'})).memo,receipt);
});
test('memo badge counts kept misled events; long reads expose lost and shrink versus previous kept version',async()=>{
 const room='page-long';await w.init(room);await w.ok(room,'memoWrite',api,{op:'add',text:'fact',from:'#3'});
 await w.ok(room,'send',qa,{text:'@kai misleading',misled:['M1']});await w.ok(room,'send',qa,{text:'@kai duplicate',misled:['M1']});
 assert.equal((await w.ok(room,'memoRead',kai)).short[0].misled,1);
 let l=await w.ok(room,'memoWrite',api,{op:'long',slot:'L1',version:0,text:'M1 abcd',merged:['M1']});assert.equal(l.long.shorter,null);assert.deepEqual(l.long.lost,[]);
 l=await w.ok(room,'memoWrite',api,{op:'long',slot:'L1',version:1,text:'M1'});assert.equal(l.long.shorter,71);
 l=await w.ok(room,'memoWrite',api,{op:'long',slot:'L1',version:2,text:'a much longer body without the reference'});assert.deepEqual(l.long.lost,['M1']);assert.equal(l.long.shorter,0);
 const versions=await w.ok(room,'memoRead',kai,{versions:'L1'});assert.deepEqual(versions.versions.map(v=>v.shorter),[0,71,null]);
 for(let version=3;version<12;version++)await w.ok(room,'memoWrite',api,{op:'long',slot:'L1',version,text:'retained body'});
 const kept=await w.ok(room,'memoRead',kai,{versions:'L1',limit:'20'});assert.equal(kept.versions.at(-1).shorter,null);
});
test('nextId derives from lastMemo even when the highest written memo is not in a short slot',async()=>{
 const room='page-next';await w.init(room);assert.equal((await w.ok(room,'memoRead',kai)).nextId,'M1');await w.ok(room,'memoWrite',api,{op:'add',text:'first',from:'#3'});await w.ok(room,'memoWrite',api,{op:'retire',id:'M1'});const list=await w.ok(room,'memoRead',kai);assert.equal(list.short.length,0);assert.equal(list.nextId,'M2');assert.equal((await w.ok(room,'listen',api)).memo.nextId,'M2')
});
test('memo search can return every retained short and both long slots without a message cursor',async()=>{
 const room='page-search-all';await w.init(room);for(let n=1;n<=58;n++)await w.ok(room,'memoWrite',api,{op:'add',text:'needle '+n,from:'#3'});for(const slot of ['L1','L2'])await w.ok(room,'memoWrite',api,{op:'long',slot,version:0,text:'needle long'});
 const {build}=await import('esbuild');const out=await build({entryPoints:[new URL('../src/search.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm'});const {searchQuery}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
 const all=await w.ok(room,'search',api,searchQuery({in:'memo',q:'needle',limit:'60'}));assert.equal(all.groups.memo.length,60);assert.equal(all.hasMore.memo,false);assert.equal(new Set(all.groups.memo.map(m=>m.id)).size,60);
 const first=await w.ok(room,'search',api,searchQuery({q:'needle'}));assert.equal(first.groups.memo.length,20);assert.equal(first.hasMore.memo,true)
});
