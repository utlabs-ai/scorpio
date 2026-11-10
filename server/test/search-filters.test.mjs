import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { worker } from './helpers/worker.mjs'

const compiled = await build({ entryPoints: [new URL('../src/search.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'node', write: false })
const { searchFilters, searchQuery } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
test('filter parser refuses unknown values and incompatible groups', () => {
  for (const input of [{ kind: 'daemon' }, { status: 'open' }, { has: 'pictures' }, { order: 'down' }, { since: '2026-10-20' }, { until: '-1' }, { before: '1.5' }, { replyTo: '0' }, { task: 'foo' }, { by: 'kai,' }, { at: Array(21).fill('kai').join(',') }]) {
    assert.throws(() => searchFilters(input), e => e.code === 'bad_request', JSON.stringify(input))
  }
  for (const input of [{ q: 'ok', in: 'todo', at: 'me' }, { kind: 'human', status: 'todo' }, { q: 'x' }, {}]) assert.throws(() => searchQuery(input), e => e.code === 'bad_request')
  assert.equal(searchQuery({ in: 'todo' }).in, 'todo')
  assert.deepEqual(searchQuery({ at: 'me' }).groups, ['messages'])
  assert.deepEqual(searchQuery({ status: 'done' }).groups, ['todo'])
})

test('Worker routes filter messages, tasks, files, members and mention counts', async () => {
  const w = await worker({}, { className: 'Probe', append: `
export class Probe extends RoomDO {
  seed(rows) { for (const [sql, args] of rows) this.sql.exec(sql, ...args); return true; }
  rebuildMentions() { this.ctx.storage.kv.delete('messages:mentionIndexV1'); this.sql.exec('DELETE FROM message_mentions'); this.migrate(); return true; }
}` })
  try {
    const kai = await w.person('kai'), mei = await w.person('mei')
    const room = await w.topic(kai)
    await w.join(kai, room, 'api')
    await mei.web(`/r/${room}`)
    const stub = (await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room)
    const rows = []
    const add = (sql, ...args) => rows.push([sql, args])
    add('DELETE FROM messages')
    add("INSERT OR IGNORE INTO members(name,kind,owner,joined_at) VALUES('mei','human','mei',1)")
    for (const [seq, name, kind, mentions, notify, reply, files] of [
      [10, 'kai', 'human', [], [], null, null],
      [11, 'mei', 'human', ['api@kai'], ['kai'], 10, null],
      [12, 'api@kai', 'agent', ['mei'], ['mei'], 10, ['fa', 'fb'].map(id => ({ id, name: `${id}.txt`, type: 'text/plain', size: 1, url: `/f/topic/${id}` }))],
      [13, 'box@kai', 'host', ['kai'], ['kai'], null, null],
      [14, 'system', 'system', [], [], null, null],
      [15, 'Scheduled', 'scheduled', ['kai'], ['kai'], null, null],
    ]) add('INSERT INTO messages(seq,from_name,from_kind,text,mentions,notify,reply_to,files,ts) VALUES(?,?,?,?,?,?,?,?,?)', seq, name, kind, `search line ${seq}`, JSON.stringify(mentions), JSON.stringify(notify), reply, files && JSON.stringify(files), seq * 1000)
    add("INSERT INTO members(name,kind,owner,joined_at,status,role_card) VALUES('box@kai','host','kai',1,'left','build computer')")
    add("INSERT INTO items(n,title,status,assignee,created_by,created_seq,created_ms,updated_by,updated_ms) VALUES(1,'search task','doing','api@kai','mei',11,11000,'mei',11000)")
    add("INSERT INTO item_messages(n,seq,rel) VALUES(1,11,'source')")
    add("INSERT INTO items(n,title,status,assignee,created_by,created_seq,created_ms,updated_by,updated_ms,done_ms) VALUES(2,'older completed task','done','api@kai','mei',10,10000,'mei',10000,10000)")
    for (const id of ['fa', 'fb']) add('INSERT INTO files(id,name,type,size,uploaded_by,ts,seq) VALUES(?,?,?,?,?,?,?)', id, `${id}.txt`, 'text/plain', 1, 'api@kai', 1, 12)
    add('UPDATE members SET cursor = 11 WHERE name = ?', 'kai')
    await stub.seed(rows)
    const get = async (path, role = 'api') => w.json(await kai.api(`/rooms/${room}/${path}`, {}, role))
    const hits = async q => { const r = await get(`search?${q}`); assert.equal(r.status, 200, JSON.stringify(r)); return r }
    const seqs = r => r.groups.messages.map(m => m.seq)
    assert.deepEqual(seqs(await hits('by=me')), [12])
    for (const [kind, expected] of [['human', [11,10]], ['agent', [12]], ['host', [13]], ['system', [14]], ['scheduled', [15]]]) assert.deepEqual(seqs(await hits(`kind=${kind}`)), expected)
    assert.deepEqual(seqs(await hits('by=box%40kai')), [13])
    const humanAt = await w.json(await kai.web(`/r/${room}/search?at=me`))
    assert.deepEqual(seqs(humanAt), [15,13,11])
    const first = await hits('kind=human,agent&order=asc&limit=1')
    assert.equal(first.hasMore.messages, true)
    assert.deepEqual(seqs(first), [10])
    assert.deepEqual(seqs(await hits('kind=human,agent&order=asc&limit=1&from=11')), [11])
    assert.deepEqual(seqs(await hits('by=kai,mei&kind=human')), [11,10])
    assert.deepEqual(seqs(await hits('at=me')), [11])
    assert.deepEqual(seqs(await hits('at=kai')), [15,13,11])
    assert.deepEqual(seqs(await hits('at=kai,mei')), [15,13,12,11])
    assert.deepEqual(seqs(await hits('replyTo=10')), [12,11])
    assert.deepEqual(seqs(await hits('has=files')), [12])
    assert.deepEqual(seqs(await hits('task=T1')), [11])
    assert.deepEqual(seqs(await hits('since=11000&until=13000&kind=human,agent')), [12,11])
    assert.deepEqual(seqs(await hits('kind=human,agent&order=asc&from=11&before=13')), [11,12])
    const allTasks = await hits('in=todo')
    assert.deepEqual(allTasks.groups.todo.map(t => [t.id, t.status]), [['T1', 'doing'], ['T2', 'done']])
    assert.deepEqual(allTasks.groups.messages, [])
    assert.deepEqual(allTasks.groups.files, [])
    const task = await hits('status=doing&to=me&by=mei&since=11000&until=12000')
    assert.equal(task.groups.todo[0].id, 'T1'); assert.deepEqual(task.groups.files, [])
    assert.deepEqual((await hits('in=files&by=me&since=12000&until=13000')).groups.files.map(f => f.fileId).sort(), ['fa','fb'])
    const full = await get('messages?kind=human,agent&from=11&before=13&order=desc')
    assert.deepEqual(full.messages.map(m => m.seq), [11,12])
    for (const [suffix, expected] of [['from=10&before=13', [10]], ['from=10&before=13&order=desc', [12]], ['from=10&before=13&order=asc', [10]], ['before=13', [12]]]) {
      const page = await get(`messages?kind=human,agent&limit=1&${suffix}`)
      assert.deepEqual(page.messages.map(m => m.seq), expected, suffix)
    }
    assert.deepEqual((await get('messages?at=me')).messages.map(m => m.seq), [11])
    assert.deepEqual((await get('messages?q=search&by=kai')).messages.map(m => m.seq), [10])
    for (const filters of ['q=search&order=asc', 'q=search&kind=human,agent&from=11&before=13&order=asc', 'q=se&by=kai&order=asc']) {
      const messages = await get(`messages?${filters}`)
      assert.equal(messages.status, 200, JSON.stringify(messages))
      const search = await hits(`in=messages&${filters}`)
      assert.deepEqual(messages.messages.map(m => m.seq), seqs(search), filters)
    }
    assert.deepEqual((await get('files?by=me&since=12000&until=13000')).files.map(f => f.id), ['fa','fb'])
    assert.equal((await get('files?from=api%40kai')).files.length, 2)
    assert.deepEqual((await get('files?by=me&until=12000')).files, [])
    const members = await get('members')
    assert.equal(members.members.some(m => m.status === 'left'), true)
    assert.equal((await get('members?mine=true')).members.some(m => m.owner !== 'kai'), false)
    assert.equal((await get('members?status=active')).members.some(m => m.status === 'left'), false)
    assert.deepEqual((await get('members?q=build&kind=host&status=left&mine=true')).members.map(m => m.name), ['box@kai'])
    assert.deepEqual((await get('members?online=true')).members, [])
    const mentions = await w.json(await kai.web(`/r/${room}/mentions?kind=human,agent,system,scheduled`))
    assert.equal(mentions.total, 2); assert.equal(mentions.unread, 1)
    assert.deepEqual(mentions.mentions.map(m => m.seq), [15,11])
    await stub.rebuildMentions()
    assert.deepEqual(seqs(await hits('at=me')), [11])
    for (const path of ['search?by=unknown', 'search?at=unknown', 'search?to=unknown', 'search?in=files&kind=human', 'files?by=me&from=kai', 'files?from=unknown', 'members?kind=daemon', 'members?status=gone', 'members?mine=yes', 'messages?status=done']) {
      assert.equal((await get(path)).error, 'bad_request', path)
    }
    assert.equal((await w.json(await kai.web(`/r/${room}/mentions?kind=daemon`))).error, 'bad_request')
  } finally { await w.dispose() }
})
