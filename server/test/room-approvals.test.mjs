import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { approvalHostDue, approvalAnswerError, approvalViewer, validApproval } from '../src/room-approvals.ts'
const built = await build({ entryPoints: [new URL('../src/room/approvals.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'report', setup(b) { b.onResolve({ filter: /room-report$/ }, () => ({ path: 'report', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export async function notify(env, account, payload) { env.pushes.push({account,payload}); }' })) } }] })
const { Approvals } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
// Keep arm() and the fixture scheduler on the same clock between Date.now() reads.
beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 }))
afterEach(() => mock.timers.reset())
const card = (id = 'Abcdef0123456789', more = {}) => ({ id, name: 'newspawn@ana', cli: 'claude', detail: { tool: 'Bash', input: {command: 'private command'}, cwd: '/private', description: 'private detail' }, menu: { question: ['Proceed?'], options: [{ n: 1, label: 'Yes' }, { n: 3, label: 'No', note: 'exact note' }], hints: ['Esc to cancel'] }, screen: null, ts: Date.now(), ...more })
const socket = (a, tags) => ({ a, tags, sent: [], deserializeAttachment() { return this.a }, serializeAttachment(a) { this.a = a }, send(s) { this.sent.push(JSON.parse(s)) } })
function fixture() {
  const db = new DatabaseSync(':memory:'), queries = [], kv = new Map(), sockets = [], pushes = [], waits = []
  const sql = { exec(q, ...args) { queries.push(q); if (!args.length && q.includes(';')) { db.exec(q); return { toArray: () => [] } }; const stmt = db.prepare(q); const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []); return { toArray: () => rows } } }
  kv.put = kv.set.bind(kv)
  const members = new Map([['host@ana', {kind:'host', owner:'ana', status:'active'}], ['host@bea', {kind:'host', owner:'bea', status:'active'}]])
  const d = { sql: () => sql, ctx: () => ({ storage: { kv }, getWebSockets: tag => sockets.filter(w => !tag || w.tags.includes(tag)), waitUntil: p => waits.push(p) }), env: () => ({ pushes, KV: { get: async () => null } }), schedule: async (key, ms) => kv.set(key, Date.now() + ms), room: () => ({ id:'room', name:'Topic' }), member: name => members.get(name), hosts: names => names.flatMap(name => members.has(name) ? [{name,...members.get(name)}] : []), reader: actor => {if(actor.account === 'removed') throw Error('not_member');return {kind:'human'}} }
  Approvals.migrate(sql); const approvals = new Approvals(d); approvals.wake()
  const host = socket({kind:'host',name:'host@ana',account:'ana'}, ['host','host:host@ana']); sockets.push(host)
  const person = socket({kind:'human',name:'ana',account:'ana',visible:false}, ['browser','h:ana']); sockets.push(person)
  return { approvals, d, db, queries, kv, sockets, pushes, waits, members, host, person, finish: async () => { await Promise.all(waits); db.close() } }
}
const actor = {kind:'human',name:'ana',account:'ana'}
test('pure approval and answer validation preserve menu notes and reject wrong fields', () => {
  assert.equal(approvalHostDue({status:'active',offline_since:10}),86_400_010)
  assert.equal(approvalHostDue({status:'active',offline_since:null}),Infinity)
  assert.equal(approvalHostDue({status:'left',offline_since:10}),Infinity)
  assert.ok(validApproval(card(), 'ana'))
  assert.ok(validApproval(card(undefined,{detail:{tool:'Bash'}}),'ana'))
  assert.ok(validApproval(card(undefined,{detail:'not an object'}),'ana'))
  for (const c of [card('short'), card(undefined,{cli:'other'}), card(undefined,{menu:null}), card(undefined,{name:'x@bea'})]) assert.equal(validApproval(c,'ana'),false)
  const a=card(), keys=[{name:'esc',label:'Esc',herdr:'esc'}]
  assert.equal(approvalAnswerError(a,{n:3,message:'reason'},keys),null)
  for (const [body,field] of [[{n:2},'n'],[{n:1,key:'esc'},'n/key'],[{key:'esc'},'key'],[{n:1,message:'reason'},'message'],[{n:3,message:'x'.repeat(2001)},'message'],[{n:3,message:12},'message']]) assert.ok(approvalAnswerError(a,body,keys).startsWith(field))
  assert.ok(approvalAnswerError({...a,menu:{...a.menu,options:[{n:1,label:'Trust'},{n:2,label:'Quit'}]}},{n:2,message:'never shell text'},keys).startsWith('message'))
  assert.equal(approvalAnswerError({...a,menu:null},{key:'esc'},keys),null)
  for(const a of [{kind:'agent',account:'ana'},{kind:'human',account:'bea'},{kind:'human',account:'ana',tokenId:'token'}]) assert.equal(approvalViewer(a,'ana'),false)
})
test('account-only cached frames exclude account/host and never query on page connect', async () => {
  const f=fixture(); try {
    for (const a of [{kind:'human',account:'bea'}, {kind:'agent',account:'ana'}, {kind:'human',account:'bea',viewer:true}, {kind:'human',account:'ana',tokenId:'token'}]) f.sockets.push(socket(a,['browser']))
    assert.equal(f.approvals.open(f.host,card()),true)
    const frame=f.person.sent.at(-1); assert.equal(frame.items[0].menu.options[1].note,'exact note')
    assert.equal('account' in frame.items[0],false); assert.equal('host' in frame.items[0],false); assert.equal(f.host.sent.length,0)
    for (const s of f.sockets.slice(2)) assert.equal(s.sent.length,0)
    const before=f.queries.length; f.approvals.connectBrowser(f.person); assert.equal(f.queries.length,before)
    const cold=new Approvals(f.d); cold.wake(); const loaded=f.queries.length; cold.connectBrowser(f.person); assert.equal(f.queries.length,loaded); assert.equal(f.person.sent.at(-1).items.length,1)
  } finally { await f.finish() }
})
test('answers enforce ownership, validation, online host and exactly one dispatch', async () => {
  const f=fixture(); try {
    f.approvals.open(f.host,card())
    for (const who of [{...actor,kind:'agent'}, {...actor,account:'bea'}, {...actor,account:'removed'}]) for(const id of [card().id,'missing']) assert.equal((await f.approvals.answer(who,id,{n:1})).err.code,'approval_not_found')
    for (const b of [{n:2},{key:'esc'},{n:1,message:'no'}]) assert.equal((await f.approvals.answer(actor,card().id,b)).err.code,'bad_request')
    f.sockets.splice(0,1); assert.equal((await f.approvals.answer(actor,card().id,{n:1})).err.code,'host_offline'); f.sockets.push(f.host)
    const results=await Promise.all([f.approvals.answer(actor,card().id,{n:3,message:'why'}),f.approvals.answer(actor,card().id,{n:1})])
    assert.equal(results.filter(r=>r.ok).length,1); assert.equal(results.find(r=>r.err).err.code,'already_answered')
    assert.equal(f.host.sent.filter(x=>x.type==='approval_answer').length,1)
    assert.deepEqual({...f.host.sent.at(-1),ts:0},{type:'approval_answer',id:card().id,n:3,message:'why',by:'ana',ts:0})
    f.approvals.close(f.host,{id:card().id,reason:'answered',result:'ok'})
    assert.equal((await f.approvals.answer(actor,card().id,{n:1})).err.approval.status,'answered')
    f.approvals.open(f.host,card()); assert.equal(f.person.sent.at(-1).items[0].status,'answered')
  } finally { await f.finish() }
})
test('reconnect closes unreported open and answering, keeps replays, prunes closed at 24h', async () => {
  const f=fixture(); try {
    for (const id of ['Abcdef0123456789','Bbcdef0123456789','Cbcdef0123456789']) f.approvals.open(f.host,card(id))
    await f.approvals.answer(actor,'Bbcdef0123456789',{n:1}); f.approvals.connectHost(f.host); await Promise.all(f.waits)
    f.approvals.open(f.host,card('Cbcdef0123456789'))
    const at=Date.now()+31_000; f.approvals.alarm(at); await Promise.all(f.waits)
    assert.deepEqual(f.db.prepare('SELECT status FROM approvals ORDER BY id').all().map(r=>r.status),['gone','gone','open'])
    f.approvals.alarm(at+86_400_000); await Promise.all(f.waits)
    assert.deepEqual(f.db.prepare('SELECT id FROM approvals').all().map(r=>r.id),['Cbcdef0123456789'])
    f.approvals.close(f.host,{id:'Cbcdef0123456789',reason:'gone'}); await Promise.all(f.waits)
    f.approvals.alarm(Date.now()+86_400_001); await Promise.all(f.waits)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,0); assert.equal(f.kv.has('approvals:present'),false)
  } finally { await f.finish() }
})
test('50-card cap, same-id updates, hostile frames and per-new-card pre-join pushes', async () => {
  const f=fixture(); try {
    for(let i=0;i<50;i++) assert.equal(f.approvals.open(f.host,card(String(i).padStart(16,'A'))),true)
    await Promise.all(f.waits); assert.equal(f.pushes.length,50); assert.equal(f.pushes[0].payload.approval,'AAAAAAAAAAAAAAA0'); assert.match(f.pushes[0].payload.url,/approval=/)
    assert.equal(f.pushes[0].payload.tag,'blocked:room:newspawn@ana'); assert.equal(JSON.stringify(f.pushes).includes('private command'),false)
    assert.equal(f.approvals.open(f.host,card('Z'.repeat(16))),false); assert.equal(f.host.sent.at(-1).error,'approval_limit')
    assert.equal(f.approvals.open(f.host,card('AAAAAAAAAAAAAAA0',{screen:'updated'})),true); await Promise.all(f.waits); assert.equal(f.pushes.length,50)
    assert.equal(f.approvals.open(f.host,{id:'bad',cli:'other'}),false); assert.equal(f.host.sent.at(-1).error,'bad_request')
    const other=socket({kind:'host',name:'host@bea',account:'bea'},['host']); assert.equal(f.approvals.close(other,{id:'AAAAAAAAAAAAAAA0',reason:'gone'}),false)
    assert.equal(f.approvals.blockedOf('ana',['newspawn@ana']).length,1)
  } finally { await f.finish() }
})

test('new host connection does not inherit old socket replay ids, empty topics stay idle', async () => {
  const f=fixture(); try {
    f.approvals.connectHost(f.host); assert.equal(f.kv.has('approvals:due'),false)
    f.approvals.open(f.host,card())
    const replacement=socket({kind:'host',name:'host@ana',account:'ana'},['host','host:host@ana']); f.sockets.push(replacement)
    f.approvals.connectHost(replacement); await Promise.all(f.waits)
    f.approvals.alarm(Date.now()+31_000);await Promise.all(f.waits)
    assert.equal(f.db.prepare('SELECT status FROM approvals').get().status,'gone')
  } finally {await f.finish()}
})

test('failed press remains failed and a new id opens again; visible owner viewer suppresses push', async () => {
  const f=fixture(); try {
    f.person.a={...f.person.a,viewer:true,visible:true}
    f.approvals.open(f.host,card());await Promise.all(f.waits);assert.equal(f.pushes.length,0)
    f.approvals.close(f.host,{id:card().id,reason:'answered',result:'failed'})
    f.approvals.open(f.host,card('Bbcdef0123456789'))
    assert.deepEqual(f.person.sent.at(-1).items.map(c=>[c.status,c.result]),[['answered','failed'],['open',null]])
  } finally {await f.finish()}
})

for (const status of ['open', 'answering']) test(`host removal closes ${status} cards and broadcasts owner frame`, async () => {
  const f=fixture(); try {
    f.approvals.open(f.host,card())
    if(status==='answering') await f.approvals.answer(actor,card().id,{n:1})
    f.approvals.connectHost(f.host); f.members.delete('host@ana')
    const before=Date.now(), frames=f.person.sent.length
    f.approvals.dropHost('host@ana')
    const row=f.db.prepare('SELECT status, closed_ms FROM approvals').get()
    assert.equal(row.status,'gone'); assert.ok(row.closed_ms>=before)
    assert.equal(f.person.sent.length,frames+1); assert.equal(f.person.sent.at(-1).items[0].status,'gone')
    assert.equal(f.kv.has('approvals:reconnect'),false)
    assert.equal(f.approvals.nextDue(),row.closed_ms+86_400_000)
  } finally {await f.finish()}
})
for (const status of ['open','answering']) test(`offline host closes ${status} cards at 24h and deletes 24h later`, async () => {
  const f=fixture(); try {
    f.approvals.open(f.host,card())
    if(status==='answering') await f.approvals.answer(actor,card().id,{n:1})
    const at=Date.now(); f.members.get('host@ana').offline_since=at
    f.sockets.splice(f.sockets.indexOf(f.host),1); f.approvals.hostOffline()
    assert.equal(f.approvals.nextDue(),at+86_400_000)
    f.approvals.alarm(at+86_400_000-1)
    assert.equal(f.db.prepare('SELECT status FROM approvals').get().status,status)
    f.approvals.alarm(at+86_400_000)
    assert.equal(f.db.prepare('SELECT status FROM approvals').get().status,'gone')
    assert.equal(f.person.sent.at(-1).items[0].closed_ms,at+86_400_000)
    f.approvals.alarm(at+2*86_400_000)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,0)
    assert.equal(f.approvals.nextDue(),Infinity)
  } finally {await f.finish()}
})
test('online host keeps old cards open and reconnect cancels offline expiry', async () => {
  const f=fixture(); try {
    f.approvals.open(f.host,card())
    f.db.prepare('UPDATE approvals SET opened_ms = ?').run(Date.now()-2*86_400_000)
    f.approvals.alarm(Date.now()+86_400_000)
    assert.equal(f.db.prepare('SELECT status FROM approvals').get().status,'open')
    f.members.get('host@ana').offline_since=Date.now(); f.approvals.hostOffline()
    f.members.get('host@ana').offline_since=null
    f.approvals.connectHost(f.host); f.approvals.open(f.host,card())
    f.approvals.alarm(Date.now()+31_000)
    assert.equal(f.approvals.nextDue(),Infinity)
    f.approvals.alarm(Date.now()+2*86_400_000)
    assert.equal(f.db.prepare('SELECT status FROM approvals').get().status,'open')
  } finally {await f.finish()}
})

test('cold wake arms pending cards from the existing membership offline clock', async () => {
  const f=fixture(); try {
    f.approvals.open(f.host,card())
    f.members.get('host@ana').offline_since=Date.now()-86_400_000
    const cold=new Approvals(f.d); cold.wake()
    assert.ok(cold.nextDue()<=Date.now()); cold.alarm(Date.now())
    assert.equal(f.person.sent.at(-1).items[0].status,'gone')
  } finally {await f.finish()}
})
