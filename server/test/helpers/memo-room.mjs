import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const built = await build({entryPoints:[new URL('../../src/room-do.ts',import.meta.url).pathname],bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent',external:['cloudflare:workers']});
const script = `let memoTestClock = 1793260800000; const Date = class extends globalThis.Date { static now() { return memoTestClock; } };
${built.outputFiles[0].text}
export class MemoTestRoom extends RoomDO {
  async armAlarm() {}
  async migrateAgain() { this.migrate(); return true; }
  async scheduledSend(p) { return this.doSend({kind:'agent',account:'kai',name:'scheduled'},p,await this.ownerLimits(),{id:'S1',by:'kai',at:Date.now()}); }
  async inspect(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  async key(key) { return this.ctx.storage.kv.get(key) ?? null; }
  async failMemoAttach(on) { this.writeMemoFailure = on; }
  insertMessage(p, attach) { return super.insertMessage(p, seq => { attach?.(seq); if (this.writeMemoFailure) throw new Error('injected attach failure'); }); }
}
export default { async fetch(req,env) {
 const {room='memo', method,args=[]}=await req.json();
 if (method==='clock') { memoTestClock=args[0]; return Response.json(memoTestClock); }
 try {return Response.json((await env.ROOMS.getByName(room)[method](...args)) ?? null);}
 catch(e) {return Response.json({thrown:String(e)});}
} };`;
export const kai={kind:'human',account:'kai',name:'kai'}, lee={kind:'human',account:'lee',name:'lee'}, api={kind:'agent',account:'kai',name:'api@kai'}, qa={kind:'agent',account:'kai',name:'qa@kai'};
export async function memoRoom() {
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-10-03',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOMS:{className:'MemoTestRoom',useSQLite:true}},d1Databases:{DB:'db'},kvNamespaces:['KV'],r2Buckets:['FILES']}));
 const db=await mf.getD1Database('DB');
 for(const f of fs.readdirSync(new URL('../../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) {
  const sql=fs.readFileSync(new URL('../../migrations/'+f,import.meta.url),'utf8').split('\n').map(l=>l.replace(/--.*$/,'')).join('\n');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
 }
 async function call(room,method,...args) { const res=await mf.dispatchFetch('http://local.test/',{method:'POST',body:JSON.stringify({room,method,args})});assert.equal(res.status,200);return res.json(); }
 async function ok(room,method,...args) { const r=await call(room,method,...args);assert.ok(r.ok,JSON.stringify(r));return r.ok; }
 async function init(room) {await call(room,'init',{id:room,name:room,topic:'',owner:'kai',code:null});await ok(room,'join',api,{role:'api'});await ok(room,'join',qa,{role:'qa'});return ok(room,'send',kai,{text:'source message'});}
 return {mf,call,ok,init,dispose:()=>mf.dispose()};
}
