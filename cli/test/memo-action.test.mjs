import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { testEnv } from './env.mjs'
const bin = new URL('../bin/scorpio.mjs', import.meta.url).pathname
const topicId = 'AbCdEf0123456789_-ghIJ'

test('memo forms send their methods, bodies and fresh nonces; reads page the right collection', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-memo-action-'))
  fs.writeFileSync(path.join(home, 'token'), 'fixture-token')
  const seen = []
  const current = {slot:'L1', version:3, text:'current text', by:'kai', ms:42}
  const server = http.createServer(async (req,res) => {
    const chunks=[];for await(const c of req)chunks.push(c)
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null
    seen.push({method:req.method,url:new URL(req.url,'http://localhost'),body,role:req.headers['x-scorpio-role']})
    res.setHeader('content-type','application/json')
    if(body?.text==='conflict'){res.statusCode=409;return res.end(JSON.stringify({error:'version_conflict',next:'Use the current text.',current}))}
    res.end(JSON.stringify({roomId:topicId,memo:{cite:[{id:'M3',counted:true,score:4}],misled:[]},groups:{memo:[{id:'M3',type:'memo'}]}}))
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(home,{recursive:true,force:true})})
  const env=testEnv(home,{SCORPIO_HOME:home,SCORPIO_SERVER:`http://127.0.0.1:${server.address().port}`})
  const run=(action,args=[],stdin)=>new Promise(resolve=>{
    const child=execFile(process.execPath,[bin,action,`topicId=${topicId}`,'role=api',...args],{env,timeout:15000},(e,stdout,stderr)=>resolve({code:e?.code??0,out:JSON.parse(stdout||'{}'),stderr}))
    if(stdin!==undefined)child.stdin.end(stdin)
  })
  const writes=[
    [['add=fact','from=#12'],{op:'add',text:'fact',from:'#12'}],
    [['add=revised','from=T3','replaces=M1'],{op:'add',text:'revised',from:'T3',replaces:'M1'}],
    [['retire=M3'],{op:'retire',id:'M3'}],
    [['restore=M3'],{op:'restore',id:'M3'}],
    [['long=L1','version=0','text=rules','merged=M1,M2'],{op:'long',slot:'L1',version:0,text:'rules',merged:['M1','M2']}],
    [['restore=L2','version=2'],{op:'restore',slot:'L2',version:2}],
  ]
  const nonces=new Set()
  for(const [args,want] of writes){const r=await run('memo',args);assert.equal(r.code,0,JSON.stringify(r));const req=seen.at(-1);const {nonce,...body}=req.body;assert.equal(req.method,'POST');assert.equal(req.url.pathname,`/api/v1/rooms/${topicId}/memo`);assert.equal(req.role,'api');assert.deepEqual(body,want);assert.match(nonce,/^[\w-]{36}$/);nonces.add(nonce)}
  assert.equal(nonces.size,writes.length)
  for(const [args,want] of [[[],{}],[['show=M3'],{show:'M3'}],[['retired=true','limit=2','before=M7'],{retired:'1',limit:'2',before:'M7'}],[['versions=L1','limit=2','before=5'],{versions:'L1',limit:'2',before:'5'}]]){
    assert.equal((await run('memo',args)).code,0);const req=seen.at(-1);assert.equal(req.method,'GET');assert.deepEqual(Object.fromEntries(req.url.searchParams),want)
  }
  const file=path.join(home,'long.md');fs.writeFileSync(file,'rules\nkept bytes\n')
  assert.equal((await run('memo',['long=L2','version=0',`textFile=${file}`])).code,0);assert.equal(seen.at(-1).body.text,'rules\nkept bytes\n')
  assert.equal((await run('memo',['long=L2','version=1','text=-'],'from stdin\n')).code,0);assert.equal(seen.at(-1).body.text,'from stdin')
  const conflict=await run('memo',['long=L1','version=2','text=conflict']);assert.equal(conflict.code,1);assert.equal(conflict.out.error,'version_conflict');assert.deepEqual(conflict.out.current,current)
  const count=seen.length
  for(const args of [['add=a','retire=M1','from=#1'],['from=#1'],['add=a','from=12'],['show=M0'],['restore=L3','version=1'],['long=L1','text=a'],['long=L1','version=-1','text=a'],['long=L1','version=0'],['long=L1','version=0','text=a',`textFile=${file}`],['long=L1','version=0','text=a','merged=M1,'],['retired=false'],['retired=true','limit=51'],['versions=L1','limit=21'],['show=M1','before=M2'],['typo=x']]){
    const r=await run('memo',args);assert.equal(r.code,1,JSON.stringify(args));assert.equal(r.out.error,'bad_request')
  }
  for(const args of [['add=a'],['add=a','from=']]){
    const r=await run('memo',args);assert.equal(r.code,1,JSON.stringify(args));assert.equal(r.out.error,'source_required');assert.equal(r.out.next,"from= is the memo's source: a message (#123) or a task (T45).")
  }
  const bad=await run('memo',['add=a','from=12']);assert.equal(bad.out.next,"from= is the memo's source: a message (#123) or a task (T45).")
  assert.equal(seen.length,count)
  const sent=await run('send',['text=@kai used the source','cite=M3,M5','misled=M4']);assert.equal(sent.code,0);assert.deepEqual(seen.at(-1).body.cite,['M3','M5']);assert.deepEqual(seen.at(-1).body.misled,['M4']);assert.deepEqual(sent.out.memo,{cite:[{id:'M3',counted:true,score:4}],misled:[]})
  const sentCount=seen.length
  for(const args of [['cite=M1','misled=M1'],['cite=M1,'],['cite='+Array(9).fill('M1').join(',')]]){assert.equal((await run('send',['text=@kai invalid',...args])).out.error,'bad_request')}
  assert.equal(seen.length,sentCount)
  const search=await run('search',['in=memo']);assert.equal(search.code,0);assert.equal(seen.at(-1).url.searchParams.get('in'),'memo');assert.equal(search.out.groups.memo[0].id,'M3')
})
