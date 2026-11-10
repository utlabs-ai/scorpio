import assert from 'node:assert/strict'
import test from 'node:test'
import { worker, ORIGIN } from './helpers/worker.mjs'

function track(ws) {
  const frames=[], pending=[]
  ws.accept()
  ws.addEventListener('message', e => {
    const f=JSON.parse(e.data); frames.push(f)
    for (const p of [...pending]) if(p.check(f)) { clearTimeout(p.timer); pending.splice(pending.indexOf(p),1); p.resolve(f) }
  })
  return {ws,frames, next(check) { const found=frames.find(check); if(found) return Promise.resolve(found); return new Promise((resolve,reject)=>{ const p={check,resolve,timer:setTimeout(()=>{pending.splice(pending.indexOf(p),1);reject(Error('frame timeout'))},5000)};pending.push(p) }) }}
}
const base={id:'Abcdef0123456789',name:'unjoined@ana',cli:'codex',detail:{tool:'Bash',input:{command:'PRIVATE_APPROVAL_SENTINEL'}},menu:{question:['Proceed?'],options:[{n:1,label:'Yes'},{n:2,label:'No',note:'exact note'}],hints:['Esc to cancel']},screen:null,ts:Date.now()}

test('Worker HTTP/WS: owner-only cards, answer dispatch, errors and no history/listen/search/public leaks', async () => {
  const w=await worker({}, {append:'export class ApprovalTestRoom extends RoomDO { async testSnapshot() { await this.writeSnapshot(); } }',className:'ApprovalTestRoom'}), sockets=[]
  try {
    const ana=await w.person('ana'), bea=await w.person('bea'), viewer=await w.person('viewer'), room=await w.topic(ana)
    await w.join(ana,room,'agent'); await w.join(bea,room,'other')
    const hostJoin=await w.json(await ana.apiPost(`/rooms/${room}/join`,{host:true,device_id:'approval-test'})); assert.equal(hostJoin.kind,'host',JSON.stringify(hostJoin))
    const hostRole=hostJoin.name.split('@')[0]
    async function open(p,path,api=false,role) { const res=api?await p.api(path,{headers:{upgrade:'websocket',origin:ORIGIN}},role):await p.web(path,{headers:{upgrade:'websocket',origin:ORIGIN}}); assert.equal(res.status,101, res.status===101?path:await res.text()); const t=track(res.webSocket);sockets.push(t.ws);return t }
    const host=await open(ana,`/rooms/${room}/ws`,true,hostRole); await host.next(f=>f.type==='ready')
    const owner=await open(ana,`/r/${room}/ws`); await owner.next(f=>f.type==='approvals')
    const other=await open(bea,`/r/${room}/ws`); await other.next(f=>f.type==='hello')
    const view=await open(viewer,`/r/${room}/ws`); await view.next(f=>f.type==='hello')
    const agent=await open(ana,`/rooms/${room}/ws`,true,'agent'); await agent.next(f=>f.type==='ready')
    host.ws.send(JSON.stringify({type:'approval_open',approval:base}))
    const cards=await owner.next(f=>f.type==='approvals'&&f.items.length===1)
    assert.equal(cards.items[0].detail.description,null);assert.equal(cards.items[0].detail.cwd,null)
    assert.equal(cards.items[0].menu.options[1].note,'exact note');assert.equal('account' in cards.items[0],false);assert.equal('host' in cards.items[0],false)
    const still=await w.json(await ana.post('/push/resolved',{tags:[`blocked:${room}:unjoined@ana`]}));assert.deepEqual(still.stale,[])
    const endpoint=`/rooms/${room}/approvals/${base.id}/answer`
    assert.equal((await w.json(await bea.post(endpoint,{n:1}))).error,'approval_not_found')
    assert.equal((await w.json(await w.fetch(endpoint,{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:'{"n":1}'}))).error,'approval_not_found')
    assert.equal((await w.json(await ana.apiPost(endpoint,{n:1},'agent'))).error,'approval_not_found')
    const cross=await w.json(await ana.post(endpoint,{n:1},{origin:'https://evil.test'}));assert.equal(cross.status,403)
    const invalid=await w.json(await ana.post(endpoint,{n:7}));assert.equal(invalid.error,'bad_request');assert.match(invalid.next,/n:/)
    const answered=await w.json(await ana.post(endpoint,{n:2,message:'try again'}));assert.equal(answered.status,200,JSON.stringify(answered));assert.equal(answered.approval.status,'answering')
    const answer=await host.next(f=>f.type==='approval_answer');assert.equal(answer.n,2);assert.equal(answer.message,'try again');assert.equal(answer.by,'ana')
    const duplicate=await w.json(await ana.post(endpoint,{n:1}));assert.equal(duplicate.status,409);assert.equal(duplicate.error,'already_answered');assert.equal(duplicate.approval.status,'answering')
    host.ws.send(JSON.stringify({type:'approval_close',id:base.id,reason:'answered',result:'ok'}))
    await owner.next(f=>f.type==='approvals'&&f.items[0]?.status==='answered')
    for(const [path,role] of [[`/rooms/${room}/messages`,'agent'],[`/rooms/${room}/listen`,'agent'],[`/rooms/${room}/search?q=PRIVATE_APPROVAL_SENTINEL`,'agent']]) {
      const r=await w.json(await ana.api(path,{},role));assert.equal(r.status,200,JSON.stringify(r));const {q,...data}=r;assert.equal(JSON.stringify(data).includes('PRIVATE_APPROVAL_SENTINEL'),false);assert.equal('approvals' in r,false)
    }
    assert.equal(other.frames.some(f=>f.type==='approvals'&&f.items.length),false)
    assert.equal(view.frames.some(f=>f.type==='approvals'&&f.items.length),false)
    assert.equal(agent.frames.some(f=>f.type==='approvals'),false)
    assert.equal(JSON.stringify(host.frames).includes('PRIVATE_APPROVAL_SENTINEL'),false)
    const stub=(await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room);await stub.testSnapshot()
    const snapshot=JSON.parse(await w.kv.get(`public:${room}`));assert.equal(JSON.stringify(snapshot).includes('PRIVATE_APPROVAL_SENTINEL'),false);assert.equal('approvals' in snapshot,false)
    const snap=await w.fetch(`/r/${room}`);assert.equal(snap.status,200);assert.equal((await snap.text()).includes('PRIVATE_APPROVAL_SENTINEL'),false)
    const trust={...base,id:'Cbcdef0123456789',menu:{...base.menu,options:[{n:1,label:'Trust and continue'},{n:2,label:'Quit'}]}}
    host.ws.send(JSON.stringify({type:'approval_open',approval:trust}));await owner.next(f=>f.type==='approvals'&&f.items.some(c=>c.id===trust.id))
    const refusedMessage=await w.json(await ana.post(`/rooms/${room}/approvals/${trust.id}/answer`,{n:2,message:'never type into shell'}))
    assert.equal(refusedMessage.error,'bad_request');assert.match(refusedMessage.next,/message:/)
    // Bea has only an agent seat here. Her existing page is a signed-in public viewer.
    const beaHostJoin=await w.json(await bea.apiPost(`/rooms/${room}/join`,{host:true,device_id:'bea-approval-test'}))
    const beaHost=await open(bea,`/rooms/${room}/ws`,true,beaHostJoin.name.split('@')[0]);await beaHost.next(f=>f.type==='ready')
    const beaCard={...base,id:'Bbcdef0123456789',name:'other@bea'}
    beaHost.ws.send(JSON.stringify({type:'approval_open',approval:beaCard}))
    await other.next(f=>f.type==='approvals'&&f.items.some(c=>c.id===beaCard.id))
    const beaAnswer=await w.json(await bea.post(`/rooms/${room}/approvals/${beaCard.id}/answer`,{n:1}));assert.equal(beaAnswer.status,200,JSON.stringify(beaAnswer))
    await beaHost.next(f=>f.type==='approval_answer')
    assert.equal(owner.frames.some(f=>f.type==='approvals'&&f.items.some(c=>c.id===beaCard.id)),false)
    assert.equal(view.frames.some(f=>f.type==='approvals'&&f.items.length),false)
    host.ws.send(JSON.stringify({type:'approval_close',id:trust.id,reason:'gone'}))
    await owner.next(f=>f.type==='approvals'&&f.items.some(c=>c.id===trust.id&&c.status==='gone'))
    const resolved=await w.json(await ana.post('/push/resolved',{tags:[`blocked:${room}:unjoined@ana`]}));assert.deepEqual(resolved.stale,[`blocked:${room}:unjoined@ana`])
  } finally { for(const ws of sockets) ws.close(); await w.dispose() }
})

for (const operation of ['accountGone','removeAccount']) test(`Worker lifecycle ${operation} deletes open cards, cache and marker before a page reconnects`, async () => {
  const w=await worker({}, {append:`export class ApprovalCleanupRoom extends RoomDO {
    async testApprovalRows(account) { return this.ctx.storage.sql.exec('SELECT id FROM approvals WHERE account = ?', account).toArray(); }
    async testApprovalMarker() { return this.ctx.storage.kv.get('approvals:present') ?? null; }
  }`,className:'ApprovalCleanupRoom'}), sockets=[]
  try {
    const owner=await w.person('owner'), ana=await w.person('ana'), room=await w.topic(owner)
    await w.join(ana,room,'agent')
    const joined=await w.json(await ana.apiPost(`/rooms/${room}/join`,{host:true,device_id:'cleanup-test'}))
    const hostRes=await ana.api(`/rooms/${room}/ws`,{headers:{upgrade:'websocket',origin:ORIGIN}},joined.name.split('@')[0]);assert.equal(hostRes.status,101)
    const host=track(hostRes.webSocket);sockets.push(host.ws);await host.next(f=>f.type==='ready')
    async function page() { const res=await ana.web(`/r/${room}/ws`,{headers:{upgrade:'websocket',origin:ORIGIN}});assert.equal(res.status,101);const t=track(res.webSocket);sockets.push(t.ws);return t }
    const before=await page();await before.next(f=>f.type==='approvals')
    host.ws.send(JSON.stringify({type:'approval_open',approval:base}))
    await before.next(f=>f.type==='approvals'&&f.items.some(c=>c.id===base.id))
    const stub=(await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room)
    assert.equal((await stub.testApprovalRows('ana')).length,1)
    const cursor=before.frames.length
    if(operation==='accountGone') await stub.accountGone('ana')
    else assert.ok((await stub.removeAccount({kind:'human',account:'owner',name:'owner'},'ana')).ok)
    assert.deepEqual(await stub.testApprovalRows('ana'),[]);assert.equal(await stub.testApprovalMarker(),null)
    await before.next(f=>before.frames.indexOf(f)>=cursor&&f.type==='approvals'&&f.items.length===0)
    // The test retains its signed-in fixture session to probe the DO again as a public viewer.
    const after=await page();assert.deepEqual((await after.next(f=>f.type==='approvals')).items,[])
    assert.equal((await w.json(await ana.post(`/rooms/${room}/approvals/${base.id}/answer`,{n:1}))).error,'approval_not_found')
  } finally {for(const ws of sockets) ws.close();await w.dispose()}
})

for (const operation of ['removeOwnComputer','leave','leaveAccount','closeTokens']) test(`Worker host ${operation} closes pending cards and sends owner frames`, async () => {
  const w=await worker(), sockets=[]
  try {
    const owner=await w.person('owner'), ana=await w.person('ana'), room=await w.topic(owner)
    await w.join(ana,room,'agent')
    assert.equal((await ana.post(`/r/${room}/enter`,{})).status,200)
    const joined=await w.json(await ana.apiPost(`/rooms/${room}/join`,{host:true,device_id:'gone-test'}))
    const hostRes=await ana.api(`/rooms/${room}/ws`,{headers:{upgrade:'websocket',origin:ORIGIN}},joined.name.split('@')[0])
    assert.equal(hostRes.status,101);const host=track(hostRes.webSocket);sockets.push(host.ws);await host.next(f=>f.type==='ready')
    const page=await ana.web(`/r/${room}/ws`,{headers:{upgrade:'websocket',origin:ORIGIN}})
    assert.equal(page.status,101);const browser=track(page.webSocket);sockets.push(browser.ws);await browser.next(f=>f.type==='approvals')
    host.ws.send(JSON.stringify({type:'approval_open',approval:base}))
    await browser.next(f=>f.type==='approvals'&&f.items.some(c=>c.id===base.id))
    assert.equal((await w.json(await ana.post(`/rooms/${room}/approvals/${base.id}/answer`,{n:1}))).approval.status,'answering')
    await host.next(f=>f.type==='approval_answer')
    const before=Date.now()
    if(operation==='closeTokens') {
      const stub=(await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room)
      assert.ok(await stub.closeTokens(['t-ana'],'revoked'))
    }
    if(operation==='removeOwnComputer') assert.equal((await ana.post(`/r/${room}/removeComputer`,{name:joined.name})).status,200)
    if(operation==='leave') assert.equal((await ana.apiPost(`/rooms/${room}/leave`,{},joined.name.split('@')[0])).status,200)
    if(operation==='leaveAccount') assert.equal((await ana.post(`/r/${room}/leave`,{})).status,200)
    const gone=await browser.next(f=>f.type==='approvals'&&f.items.some(c=>c.id===base.id&&c.status==='gone'))
    assert.ok(gone.items.find(c=>c.id===base.id).closed_ms>=before)
  } finally {for(const ws of sockets) ws.close();await w.dispose()}
})
