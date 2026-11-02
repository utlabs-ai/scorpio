// Run with node --test from cli/ (no dependencies; a local HTTP server plays the Scorpio server)
// `scorpio export`: the request it sends, where the zip lands, and what a broken download or a refusal does.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { testEnv } from './env.mjs'
import { endsWithEndRecord, nameOf } from '../src/actions/export.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'scorpio.mjs')
const ROOM = 'AbCdEf0123456789_-ghIJ'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-export-'))
fs.writeFileSync(path.join(home, 'token'), 'tok')

// A small zip as the server streams one: the local header and bytes of one stored entry, then its central directory
// and the end record (the last 22 bytes). Enough for the end-record check; the bytes are not read back as a zip.
const END = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0, 0x2e, 0, 0, 0, 0x35, 0, 0, 0, 0, 0])
const ZIP = Buffer.concat([Buffer.from('PK\x03\x04' + 'x'.repeat(49)), Buffer.from('PK\x01\x02' + 'y'.repeat(42)), END])

const seen = []
const server = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, headers: req.headers })
  const role = req.headers['x-scorpio-role']
  const json = (status, data) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
  if (!req.url.startsWith(`/api/v1/rooms/${ROOM}/export?`)) return json(404, { error: 'bad_request', next: `unexpected ${req.method} ${req.url}` })
  if (role === 'busy') return json(409, { error: 'export_busy', next: 'Another export of this account is still being downloaded.' })
  if (role === 'big') return json(413, { error: 'export_too_large', next: 'Over the limits.', limits: { messages: 100000, files: 1000, bytes: 2147483648 }, counts: { messages: 5, files: 1200, bytes: 9 } })
  res.statusCode = 200
  res.setHeader('content-type', 'application/zip')
  res.setHeader('content-disposition', `attachment; filename="_-2026-11-02.zip"; filename*=UTF-8''${encodeURIComponent('主题 one-2026-11-02.zip')}`)
  if (role === 'cut') { res.write(ZIP.subarray(0, 60)); return res.end() } // the connection ends before the end record
  if (role === 'plain') { res.removeHeader('content-disposition'); return res.end(ZIP) }
  res.end(ZIP)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

function cli(args) {
  const before = seen.length
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'export', ...args], {
      env: testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: url, CLAUDE_CODE_SESSION_ID: randomUUID(), CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', TZ: 'Asia/Shanghai' }), timeout: 30_000,
    }, (err, stdout) => resolve({ code: err ? err.code : 0, out: JSON.parse(stdout || '{}'), sent: seen.length > before ? seen.at(-1) : null }))
  })
}
const filesDir = path.join(home, 'topics', ROOM, 'files')

test('the whole topic lands in the topic files folder under the name the server gave, in this computer time zone', async () => {
  const r = await cli([`topicId=${ROOM}`, 'role=api'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const q = new URL(r.sent.url, url).searchParams
  assert.equal(q.get('tz'), 'Asia/Shanghai')
  assert.equal(q.get('include'), null, 'all parts: no include= sent')
  assert.equal(r.sent.headers['x-scorpio-role'], 'api')
  assert.deepEqual(r.out, { topicId: ROOM, path: path.join(filesDir, '主题 one-2026-11-02.zip'), size: ZIP.length, include: ['messages', 'tasks', 'files', 'handoffs', 'memo'] })
  assert.ok(fs.readFileSync(r.out.path).equals(ZIP))
  assert.deepEqual(fs.readdirSync(filesDir), ['主题 one-2026-11-02.zip'], 'no temp file left')
  // The same day again: replaced, not a second file.
  const again = await cli([`topicId=${ROOM}`, 'role=api'])
  assert.equal(again.code, 0)
  assert.deepEqual(fs.readdirSync(filesDir), ['主题 one-2026-11-02.zip'])
})

test('include= and tz= go to the server as given; an unknown part is refused before any request', async () => {
  const r = await cli([`topicId=${ROOM}`, 'role=api', 'include=messages,memo', 'tz=UTC'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  const q = new URL(r.sent.url, url).searchParams
  assert.deepEqual([q.get('include'), q.get('tz')], ['messages,memo', 'UTC'])
  assert.deepEqual(r.out.include, ['messages', 'memo'])
  const bad = await cli([`topicId=${ROOM}`, 'role=api', 'include=messages,photos'])
  assert.equal(bad.code, 1)
  assert.equal(bad.out.error, 'bad_request')
  assert.match(bad.out.next, /photos/)
  assert.equal(bad.sent, null)
})

test('a download that breaks off keeps nothing and says to run it again', async () => {
  fs.rmSync(filesDir, { recursive: true, force: true })
  const r = await cli([`topicId=${ROOM}`, 'role=cut'])
  assert.equal(r.code, 1)
  assert.equal(r.out.error, 'network')
  assert.match(r.out.next, /Run the same command again/)
  assert.deepEqual(fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : [], [])
})

test('the server\'s refusals come through as they are', async () => {
  const busy = await cli([`topicId=${ROOM}`, 'role=busy'])
  assert.deepEqual([busy.code, busy.out.error], [1, 'export_busy'])
  const big = await cli([`topicId=${ROOM}`, 'role=big'])
  assert.deepEqual([big.code, big.out.error], [1, 'export_too_large'])
})

test('without a file name from the server, the zip is named after the topic id', async () => {
  const r = await cli([`topicId=${ROOM}`, 'role=plain'])
  assert.equal(r.code, 0, JSON.stringify(r.out))
  assert.equal(path.basename(r.out.path), `${ROOM}.zip`)
})

test('nameOf keeps a plain file name; endsWithEndRecord tells a whole zip from a cut one', () => {
  assert.equal(nameOf(`attachment; filename="a.zip"; filename*=UTF-8''${encodeURIComponent('b/../c.zip')}`, 'x.zip'), 'b-..-c.zip')
  assert.equal(nameOf('attachment; filename="a.zip"', 'x.zip'), 'a.zip')
  assert.equal(nameOf('', 'x.zip'), 'x.zip')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-zipend-'))
  fs.writeFileSync(path.join(dir, 'whole.zip'), ZIP)
  fs.writeFileSync(path.join(dir, 'cut.zip'), ZIP.subarray(0, 60))
  fs.writeFileSync(path.join(dir, 'tiny.zip'), 'PK')
  assert.equal(endsWithEndRecord(path.join(dir, 'whole.zip')), true)
  assert.equal(endsWithEndRecord(path.join(dir, 'cut.zip')), false)
  assert.equal(endsWithEndRecord(path.join(dir, 'tiny.zip')), false)
})
