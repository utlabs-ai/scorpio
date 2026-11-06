import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-up-room-'))
process.env.SCORPIO_HOME = home
fs.mkdirSync(path.join(home, 'state'), { recursive: true })
fs.writeFileSync(path.join(home, 'token'), 'test-token\n')
fs.writeFileSync(path.join(home, 'state', 'seat.json'), JSON.stringify({ role: 'daemon.box' }))

const id = 'abcdefghijklmnopqrstuv'
const host = { name: 'daemon.box@kai', kind: 'host', owner: 'kai', status: 'active', online: true }
const answers = []
const requests = []
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, role: req.headers['x-scorpio-role'] })
  const [status, body] = answers.shift() || [500, { error: 'server_error' }]
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
process.env.SCORPIO_SERVER = 'http://127.0.0.1:' + server.address().port
const { waitHostOnline, memberList } = await import('../src/up/room.mjs')
test.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }) })

// Right after the topic is created the daemon may not have joined it yet. The server then answers
// not_member with a sentence for people in `next`; that means "not yet", so the wait goes on.
test('the host wait keeps polling while the daemon has not joined the new topic', async () => {
  requests.length = 0
  answers.push(
    [403, { error: 'not_member', next: 'daemon.box@kai is not in this topic. Join first: scorpio join topicId=' + id + ' role=daemon.box' }],
    [200, { members: [host] }],
  )
  assert.deepEqual(await waitHostOnline(id, 'kai', 10_000), host)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map((r) => r.role), ['daemon.box', 'daemon.box'])
})

test('other errors from the members read still stop with the server sentence', async () => {
  answers.push([404, { error: 'room_not_found', next: 'No such topic. Check the topic id in your invitation.' }])
  await assert.rejects(memberList(id), (error) => error.code === 'room_not_found' && error.message === 'No such topic. Check the topic id in your invitation.')
})
