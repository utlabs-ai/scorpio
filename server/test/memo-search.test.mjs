import assert from 'node:assert/strict';
import test from 'node:test';
import {worker} from './helpers/worker.mjs';
import {build} from 'esbuild';
const built=await build({entryPoints:[new URL('../src/search.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm'});
const {searchQuery}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
test('memo filters apply only to by/since/until/order; other filters exclude it or refuse in=memo',()=>{
 for(const key of ['kind','at','replyTo','has','task','status','to','from','before']){
  const value={kind:'human',at:'me',replyTo:'1',has:'files',task:'T1',status:'todo',to:'me',from:'1',before:'2'}[key];
  assert.throws(()=>searchQuery({in:'memo',[key]:value}),e=>e.code==='bad_request',key);
  assert.ok(!searchQuery({[key]:value}).groups.includes('memo'),key);
 }
 assert.ok(searchQuery({in:'memo'}).groups.includes('memo'));
 assert.ok(searchQuery({by:'me',since:'1',until:'9',order:'asc'}).groups.includes('memo'));
});
test('in=memo searches every short state and only current long versions; viewer reads; home excludes memos',async()=>{
 const w=await worker();try{
  const p=await w.person('ops'),guest=await w.person('guest'),room=await w.topic(p);await w.join(p,room,'api');
  const source=await w.json(await p.apiPost(`/rooms/${room}/send`,{text:'@ops source'},'api'));
  const post=body=>p.apiPost(`/rooms/${room}/memo`,body,'api').then(w.json),search=q=>p.api(`/rooms/${room}/search?${q}`,{},'api').then(w.json);
  await post({op:'add',text:'alpha needle 100% _ literal',from:`#${source.seq}`});await post({op:'add',text:'alpha replaced',from:`#${source.seq}`,replaces:'M1'});await post({op:'retire',id:'M2'});
  await post({op:'long',slot:'L1',version:0,text:'alpha former version'});await post({op:'long',slot:'L1',version:1,text:'alpha latest version'});
  const all=await search('in=memo');assert.equal(all.groups.memo.length,3);assert.deepEqual(new Set(all.groups.memo.map(m=>m.status)),new Set(['replaced','retired','long']));assert.equal(all.hasMore.memo,false);
  const latest=await search('in=memo&q=latest');assert.equal(latest.groups.memo[0].id,'L1');assert.equal(latest.groups.memo[0].seq,null);
  assert.deepEqual((await search('in=memo&q=former')).groups.memo,[]);
  assert.equal((await search('in=memo&q=100%25')).groups.memo[0].id,'M1');
  const low=await search('in=memo&by=me');assert.equal(low.groups.memo.length,3);assert.equal((await search('in=memo&by=ops')).groups.memo.length,0);assert.equal((await search('in=memo&by=api@ops')).groups.memo.length,3);
  const stamp=all.groups.memo.find(m=>m.id==='M1').ts;assert.ok((await search(`in=memo&since=${stamp}`)).groups.memo.length);assert.equal((await search(`in=memo&until=${stamp}`)).groups.memo.length,0);
  const asc=await search('in=memo&order=asc');assert.ok(asc.groups.memo.every((m,i,a)=>i===0||a[i-1].ts<=m.ts));
  assert.equal((await search('q=alpha')).groups.memo.length,3);
  const view=await w.json(await guest.web(`/r/${room}/search?in=memo&q=latest`));assert.equal(view.groups.memo[0].id,'L1');
  const home=await w.json(await p.web('/search?q=latest'));assert.ok(home.rooms.every(r=>r.results.every(hit=>hit.type!=='memo')));assert.equal(home.rooms.length,0);
 }finally{await w.dispose();}
});
test('memo scope can read the whole bounded collection while other groups retain their page cap',()=>{
 assert.equal(searchQuery({in:'memo',limit:'60'}).limit,60);assert.equal(searchQuery({in:'memo',limit:'99'}).limit,60);assert.equal(searchQuery({in:'messages',limit:'60'}).limit,20);assert.equal(searchQuery({q:'memo',limit:'60'}).limit,20)
});
