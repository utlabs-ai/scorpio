import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

const append = `
export class TestRoom extends RoomDO {
  testSql(query, args = []) {
    const result = this.ctx.storage.sql.exec(query, ...args)
    return /^\\s*SELECT/i.test(query) ? result.toArray() : { rowsWritten: result.rowsWritten }
  }
  testTakeover(name, owner) { return this.takeoverFor(name, owner) }
}`

async function setup() {
  const w = await worker({}, { append, className: 'TestRoom' })
  const owner = await w.person('cap-owner')
  const other = await w.person('cap-other')
  const ns = await w.mf.getDurableObjectNamespace('ROOMS')
  async function topic(code = '') {
    const id = await w.topic(owner, code)
    const stub = ns.get(ns.idFromName(id))
    const sql = (query, ...args) => stub.testSql(query, args)
    return { id, sql, stub }
  }
  return { w, owner, other, topic }
}

async function seedAgents(sql, specials, total = 100) {
  const rows = [...specials]
  for (let n = rows.length; n < total; n++) rows.push({ name: `filler-${n}@cap-owner`, owner: 'cap-owner', status: 'active', joined: 10_000 + n })
  await sql(
    `INSERT INTO members (name, kind, owner, role_card, takeover_command, status, joined_at, last_active)
     SELECT json_extract(value, '$.name'), 'agent', json_extract(value, '$.owner'),
            'card', 'takeover', json_extract(value, '$.status'), json_extract(value, '$.joined'), json_extract(value, '$.lastActive')
     FROM json_each(?)`, JSON.stringify(rows),
  )
  await sql(
    `INSERT INTO handoffs (name, body, size, updated_at)
     SELECT json_extract(value, '$.name'), 'handoff', 7, 1 FROM json_each(?)`, JSON.stringify(specials),
  )
}

async function openTask(sql, name, n = 1, status = 'todo') {
  await sql(
    `INSERT INTO items (n, title, status, assignee, created_by, created_ms, updated_by, updated_ms)
     VALUES (?, 'Keep this task', ?, ?, 'cap-owner', 1, 'cap-owner', 1)`, n, status, name,
  )
}

const left = (name, owner, joined, lastActive = joined) => ({ name: `${name}@${owner}`, owner, status: 'left', joined, lastActive })

test('agent-seat cleanup deletes the joining account oldest even with tasks, then gives open tasks to that person', async () => {
  const { w, owner, topic } = await setup()
  try {
    const t = await topic()
    const ownTask = left('own-task', owner.handle, 1)
    const ownFree = left('own-free', owner.handle, 3)
    const otherFree = left('other-free', 'cap-other', 2)
    await seedAgents(t.sql, [ownTask, ownFree, otherFree])
    await openTask(t.sql, ownTask.name)
    await openTask(t.sql, ownTask.name, 2, 'doing')
    await openTask(t.sql, ownTask.name, 3, 'done')
    assert.equal((await w.join(owner, t.id, 'new-agent')).status, 200)
    const names = (await t.sql("SELECT name FROM members WHERE kind = 'agent'")).map((r) => r.name)
    assert.equal(names.length, 100)
    assert.equal(names.includes(ownTask.name), false)
    assert.equal(names.includes(ownFree.name), true)
    assert.equal(names.includes(otherFree.name), true)
    assert.equal((await t.sql('SELECT name FROM handoffs WHERE name = ?', ownTask.name)).length, 0)
    const tasks = await t.sql('SELECT n, status, assignee FROM items ORDER BY n')
    assert.deepEqual(tasks.map((r) => ({ ...r })), [
      { n: 1, status: 'todo', assignee: owner.handle },
      { n: 2, status: 'doing', assignee: owner.handle },
      { n: 3, status: 'done', assignee: ownTask.name },
    ])
    const logs = await t.sql('SELECT n, op, from_json, to_json FROM item_log ORDER BY n')
    assert.deepEqual(logs.map((r) => ({ n: r.n, op: r.op, from: JSON.parse(r.from_json), to: JSON.parse(r.to_json) })), [
      { n: 1, op: 'assign', from: { assignee: ownTask.name }, to: { assignee: owner.handle } },
      { n: 2, op: 'assign', from: { assignee: ownTask.name }, to: { assignee: owner.handle } },
    ])
  } finally { await w.dispose() }
})

test('agent-seat cleanup picks the oldest other left seat when the joining account has none', async () => {
  const { w, owner, topic } = await setup()
  try {
    const t = await topic()
    const old = left('other-old', 'cap-other', 1)
    const newer = left('other-new', 'cap-other', 2)
    await seedAgents(t.sql, [newer, old])
    await openTask(t.sql, old.name)
    assert.equal((await w.join(owner, t.id, 'new-agent')).status, 200)
    assert.equal((await t.sql('SELECT name FROM members WHERE name = ?', old.name)).length, 0)
    assert.equal((await t.sql('SELECT name FROM members WHERE name = ?', newer.name)).length, 1)
    assert.equal((await t.sql('SELECT assignee FROM items WHERE n = 1'))[0].assignee, 'cap-other')
  } finally { await w.dispose() }
})

test('a seat that joined early but left recently is kept over a seat that left longer ago', async () => {
  const { w, owner, topic } = await setup()
  try {
    const t = await topic()
    const recent = left('joined-early', owner.handle, 1, 90)
    const stale = left('joined-later', owner.handle, 2, 10)
    await seedAgents(t.sql, [recent, stale])
    assert.equal((await w.join(owner, t.id, 'new-agent')).status, 200)
    assert.equal((await t.sql('SELECT name FROM members WHERE name = ?', recent.name)).length, 1)
    assert.equal((await t.sql('SELECT name FROM members WHERE name = ?', stale.name)).length, 0)
  } finally { await w.dispose() }
})

test('an overfull topic trims in one new join; existing-name takeover never trims', async () => {
  const { w, owner, topic } = await setup()
  try {
    const t = await topic()
    const specials = Array.from({ length: 5 }, (_, n) => left(`old-${n}`, owner.handle, n + 1))
    await seedAgents(t.sql, specials, 103)
    await t.sql("INSERT INTO members (name, kind, owner, status, joined_at) VALUES ('daemon@cap-owner', 'host', 'cap-owner', 'active', 1)")
    const takeover = await w.join(owner, t.id, 'old-0')
    assert.equal(takeover.status, 200)
    assert.equal((await t.sql("SELECT COUNT(*) AS n FROM members WHERE kind = 'agent'"))[0].n, 103)
    const result = await w.join(owner, t.id, 'new-agent')
    assert.equal(result.status, 200)
    assert.equal((await t.sql("SELECT COUNT(*) AS n FROM members WHERE kind = 'agent'"))[0].n, 100)
    assert.equal((await t.sql("SELECT COUNT(*) AS n FROM members WHERE kind = 'host'"))[0].n, 1)
    assert.equal((await t.sql("SELECT COUNT(*) AS n FROM handoffs"))[0].n, 1)
  } finally { await w.dispose() }
})

test('100 active agents refuse a new name without changing membership', async () => {
  const { w, owner, topic } = await setup()
  try {
    const t = await topic()
    await seedAgents(t.sql, [])
    const result = await w.join(owner, t.id, 'new-agent')
    assert.equal(result.status, 409)
    assert.equal(result.error, 'agent_limit')
    assert.equal(result.next, 'This topic already has 100 agent seats, all in use. Reuse an existing name, or let one agent leave first.')
    assert.equal((await t.sql("SELECT COUNT(*) AS n FROM members WHERE kind = 'agent'"))[0].n, 100)
  } finally { await w.dispose() }
})

test('an evicted seat keeps its message but a new seat under that name cannot reuse its takeover command', async () => {
  const { w, owner, topic } = await setup()
  try {
    const t = await topic()
    const old = left('old', owner.handle, 1)
    const spare = left('spare', owner.handle, 2)
    await seedAgents(t.sql, [old, spare])
    await t.sql("INSERT INTO members (name, kind, owner, status, joined_at) VALUES ('daemon@cap-owner', 'host', 'cap-owner', 'active', 1)")
    const line = '@daemon@cap-owner /spawn claude old /work'
    await t.sql("INSERT INTO messages (seq, from_name, from_kind, text, ts) VALUES (1, ?, 'agent', ?, 1)", old.name, 'Takeover:\n```\n' + line + '\n```')
    assert.equal((await t.stub.testTakeover(old.name, owner.handle)).command, line)
    assert.equal((await w.join(owner, t.id, 'new-agent')).status, 200)
    assert.equal((await t.sql('SELECT name FROM members WHERE name = ?', old.name)).length, 0)
    assert.equal((await t.sql('SELECT seq FROM messages WHERE seq = 1')).length, 1)
    assert.equal((await w.join(owner, t.id, 'old')).status, 200)
    assert.equal(await t.stub.testTakeover(old.name, owner.handle), null)
  } finally { await w.dispose() }
})

test('20 active people refuse another person and a returning person until a place opens', async () => {
  const { w, owner, topic } = await setup()
  try {
    const t = await topic()
    const people = Array.from({ length: 19 }, (_, n) => ({ name: `person-${n}`, status: 'active' }))
    await t.sql(
      `INSERT INTO members (name, kind, owner, status, joined_at)
       SELECT json_extract(value, '$.name'), 'human', json_extract(value, '$.name'), 'active', 1 FROM json_each(?)`,
      JSON.stringify(people),
    )
    const newcomer = await w.person('person-new')
    const returning = await w.person('person-returning')
    await t.sql("INSERT INTO members (name, kind, owner, status, joined_at) VALUES (?, 'human', ?, 'left', 1)", returning.handle, returning.handle)
    for (const person of [newcomer, returning]) {
      const response = await w.json(await person.post(`/r/${t.id}/enter`))
      assert.equal(response.status, 409)
      assert.equal(response.error, 'person_limit')
    }
    await t.sql("UPDATE members SET status = 'left' WHERE name = 'person-0'")
    assert.equal((await newcomer.post(`/r/${t.id}/enter`)).status, 200)
    assert.equal((await t.sql("SELECT COUNT(*) AS n FROM members WHERE kind = 'human' AND status = 'active'"))[0].n, 20)
  } finally { await w.dispose() }
})

test('person-limit web form and automatic page entry show their own localized message; JSON keeps the code', async () => {
  const { w, owner, topic } = await setup()
  try {
    const privateTopic = await topic('strong-code')
    const people = Array.from({ length: 19 }, (_, n) => `private-${n}`)
    await privateTopic.sql(
      `INSERT INTO members (name, kind, owner, status, joined_at)
       SELECT value, 'human', value, 'active', 1 FROM json_each(?)`, JSON.stringify(people),
    )
    const newcomer = await w.person('form-new')
    const jsonResponse = await w.json(await newcomer.post(`/r/${privateTopic.id}/enter`, { code: 'strong-code' }))
    assert.equal(jsonResponse.status, 409)
    assert.equal(jsonResponse.error, 'person_limit')
    assert.equal(jsonResponse.next, 'A topic holds 20 people. Wait for someone to leave, or ask the creator to remove someone.')
    const form = await newcomer.web(`/r/${privateTopic.id}/enter`, {
      method: 'POST', body: 'code=strong-code',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'zh' },
    })
    const formHtml = await form.text()
    assert.equal(form.status, 409)
    assert.match(formHtml, /这个主题已满 20 人/)
    assert.match(formHtml, /一个主题最多 20 人。等有人离开，或请创建者移除一位。/)
    assert.doesNotMatch(formHtml, /口令不正确/)
    const englishForm = await newcomer.web(`/r/${privateTopic.id}/enter`, {
      method: 'POST', body: 'code=strong-code',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'en' },
    })
    const englishHtml = await englishForm.text()
    assert.equal(englishForm.status, 409)
    assert.match(englishHtml, /This topic is full/)
    assert.match(englishHtml, /A topic holds 20 people. Wait for someone to leave, or ask the creator to remove someone./)

    const automatic = await topic()
    await automatic.sql("UPDATE members SET status = 'left' WHERE name = ?", owner.handle)
    await automatic.sql(
      `INSERT INTO members (name, kind, owner, status, joined_at)
       SELECT value, 'human', value, 'active', 1 FROM json_each(?)`, JSON.stringify(Array.from({ length: 20 }, (_, n) => `auto-${n}`)),
    )
    const page = await owner.web(`/r/${automatic.id}`, { headers: { 'accept-language': 'zh' } })
    const pageHtml = await page.text()
    assert.equal(page.status, 409)
    assert.match(pageHtml, /这个主题已满 20 人/)
    assert.match(pageHtml, /一个主题最多 20 人。等有人离开，或请创建者移除一位。/)
    assert.doesNotMatch(pageHtml, /出了点问题/)
  } finally { await w.dispose() }
})
