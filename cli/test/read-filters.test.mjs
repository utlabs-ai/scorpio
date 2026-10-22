import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { testEnv } from './env.mjs'
const bin = new URL('../bin/scorpio.mjs', import.meta.url).pathname
const topic = 'AbCdEf0123456789_-ghIJ'

test('read filters, local calendar boundaries, members default and handoff summaries through CLI', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-read-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, 'token'), 'fixture-token')
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    seen.push(url)
    res.setHeader('content-type', 'application/json')
    if (url.pathname.endsWith('/members')) return res.end(JSON.stringify({ roomId: topic, members: [
      { name: 'api@kai', status: 'active', handoff: { updatedAt: 100, computer: 'box', size: 10 } },
      { name: 'pm@mei', status: 'left', handoff: { updatedAt: 200, computer: null, size: 20 } },
      { name: 'kai', status: 'active' },
    ] }))
    if (url.pathname.endsWith('/files')) return res.end(JSON.stringify({ roomId: topic, files: [], hasMore: false, counts: {} }))
    res.end(JSON.stringify({ roomId: topic, messages: [], groups: {}, hasMore: {} }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: `http://127.0.0.1:${server.address().port}`, TZ: 'America/New_York' })
  const run = (action, ...args) => new Promise(resolve => execFile(process.execPath, [bin, action, `topicId=${topic}`, 'role=api', ...args], { env, timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? error.signal ?? 'unknown') : 0, out: stdout ? JSON.parse(stdout) : stderr })))
  const messages = await run('messages', 'by=me,kai', 'at=me', 'kind=human,agent', 'replyTo=12', 'task=T3', 'has=files', 'since=2026-03-08', 'until=2026-03-08', 'order=asc', 'from=10', 'before=20', 'q=word')
  assert.equal(messages.code, 0, JSON.stringify(messages.out))
  const q = seen.at(-1).searchParams
  assert.equal(q.get('since'), String(Date.UTC(2026, 2, 8, 5)))
  assert.equal(q.get('until'), String(Date.UTC(2026, 2, 9, 4)))
  for (const [key, value] of Object.entries({ by: 'me,kai', at: 'me', kind: 'human,agent', replyTo: '12', task: 'T3', has: 'files', order: 'asc', from: '10', before: '20', q: 'word', limit: '50' })) assert.equal(q.get(key), value)
  assert.equal((await run('search', 'in=task', 'status=doing', 'to=me', 'by=kai', 'since=0', 'until=1000')).code, 0)
  assert.equal(seen.at(-1).searchParams.get('in'), 'todo')
  assert.equal(seen.at(-1).searchParams.has('q'), false)
  assert.equal((await run('search', 'in=task')).code, 0)
  assert.equal(seen.at(-1).searchParams.get('in'), 'todo')
  assert.equal(seen.at(-1).searchParams.has('q'), false)
  await run('files', 'by=me', 'since=2026-10-20', 'until=2026-10-20', 'before=30', 'beforeId=file')
  assert.equal(seen.at(-1).searchParams.get('by'), 'me')
  assert.equal(seen.at(-1).searchParams.get('since'), String(Date.UTC(2026, 9, 20, 4)))
  assert.equal(seen.at(-1).searchParams.get('until'), String(Date.UTC(2026, 9, 21, 4)))
  await run('members')
  assert.equal(seen.at(-1).searchParams.get('status'), 'active')
  await run('members', 'q=legal', 'status=all', 'kind=agent', 'mine=true', 'online=true')
  assert.equal(seen.at(-1).searchParams.get('status'), 'all')
  const handoffs = await run('handoffs')
  assert.equal(handoffs.code, 0)
  assert.deepEqual(handoffs.out.handoffs, [
    { name: 'pm@mei', status: 'left', updatedAt: 200, computer: null, size: 20 },
    { name: 'api@kai', status: 'active', updatedAt: 100, computer: 'box', size: 10 },
  ])
  assert.equal(seen.at(-1).searchParams.get('status'), 'all')
  const count = seen.length
  for (const action of ['messages', 'search', 'files', 'members', 'handoffs']) {
    const r = await run(action, 'typo=value')
    assert.equal(r.code, 1, JSON.stringify({ action, ...r })); assert.equal(r.out.error, 'bad_request'); assert.match(r.out.next, /typo=/)
  }
  for (const date of ['2026-02-30', '2026-03-00', '2026-13-01', '-1', 'yesterday']) assert.equal((await run('messages', `since=${date}`)).out.error, 'bad_request')
  assert.equal((await run('files', 'from=kai', 'by=me')).out.error, 'bad_request')
  assert.equal(seen.length, count)
})
