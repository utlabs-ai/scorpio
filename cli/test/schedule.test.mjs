import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'
import { atMs, nextIso, ruleArg } from '../src/actions/schedule.mjs'

const BIN = fileURLToPath(new URL('../bin/scorpio.mjs', import.meta.url))
const ROOM = 'AbCdEf0123456789_-ghIJ'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-schedule-'))
fs.writeFileSync(path.join(home, 'token'), 'test-token')

test('time rules use the requested wall clock, including DST gaps and repeats', () => {
  const sh = 'Asia/Shanghai', ny = 'America/New_York'
  assert.equal(atMs('2026-10-18 10:00', sh), Date.parse('2026-10-18T02:00:00Z'))
  assert.equal(atMs('2026-10-18 10:00', ny), Date.parse('2026-10-18T14:00:00Z'))
  assert.equal(atMs('10:00', sh, Date.parse('2026-10-18T01:00Z')), Date.parse('2026-10-18T02:00Z'))
  assert.equal(atMs('10:00', sh, Date.parse('2026-10-18T01:00:42Z')), Date.parse('2026-10-18T02:00Z'))
  assert.equal(atMs('10:00', sh, Date.parse('2026-10-18T03:00Z')), Date.parse('2026-10-19T02:00Z'))
  assert.equal(atMs('10-18 10:00', sh, Date.parse('2026-10-18T03:00Z')), Date.parse('2027-10-18T02:00Z'))
  assert.equal(atMs('02-29 10:00', sh, Date.parse('2026-01-01T00:00Z')), Date.parse('2028-02-29T02:00Z'))
  assert.equal(atMs('2026-10-18T10:00:00+08:00', ny), Date.parse('2026-10-18T02:00Z'))
  assert.equal(atMs('2026-03-08 02:30', ny), Date.parse('2026-03-08T07:30Z'), 'gap moves forward by an hour')
  assert.equal(atMs('2026-11-01 01:30', ny), Date.parse('2026-11-01T05:30Z'), 'first repeated time')
  assert.deepEqual(ruleArg({ weekly: 'thu,mon@10:00', tz: sh }).rule, { kind: 'weekly', days: ['mon', 'thu'], time: '10:00', tz: sh })
  assert.deepEqual(ruleArg({ every: '2h' }).rule, { kind: 'every', minutes: 120 })
  assert.throws(() => ruleArg({ every: '9m' }), { error: 'schedule_too_frequent' })
  assert.throws(() => ruleArg({ daily: '10:00', weekly: 'mon@10:00' }, { required: true }), { error: 'bad_request' })
  assert.equal(nextIso({ nextAt: Date.parse('2026-10-18T02:00Z'), rule: { kind: 'daily', tz: sh } }), '2026-10-18T10:00:00+08:00')
  assert.equal(nextIso({ nextAt: Date.parse('2026-10-18T14:00Z'), rule: { kind: 'once' } }, ny), '2026-10-18T10:00:00-04:00')
  assert.equal(nextIso({ nextAt: null, rule: { kind: 'once' } }), null)
})

const seen = []
const item = (rule = { kind: 'daily', time: '10:00', tz: 'Asia/Shanghai' }) => ({ id: 'S3', rule, nextAt: Date.parse('2026-10-18T02:00Z') })
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
  seen.push({ method: req.method, url: req.url, body })
  res.setHeader('content-type', 'application/json')
  if (body?.op === 'send' && body.id === 'S9') {
    res.statusCode = 409; return res.end(JSON.stringify({ error: 'no_takeover', next: 'No takeover line for this agent.' }))
  }
  if (body?.op === 'add' && body.text.includes('@free')) {
    res.statusCode = 403; return res.end(JSON.stringify({ error: 'pro_required', next: "Scheduling is a Pro feature of the topic owner's plan (kai); tell your owner." }))
  }
  if (body?.op === 'edit' && body.id === 'S8') {
    res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden', next: 'Only the account that set it can edit it.' }))
  }
  if (body?.op === 'add' && body.rule.kind === 'once' && body.rule.at < Date.now()) {
    res.statusCode = 400; return res.end(JSON.stringify({ error: 'schedule_in_past', next: 'Choose a future time.' }))
  }
  if (req.method === 'GET' && req.url.endsWith('/schedules')) return res.end(JSON.stringify({ roomId: ROOM, items: [item()], count: 1, proRequired: false }))
  if (req.method === 'GET') return res.end(JSON.stringify({ roomId: ROOM, item: item() }))
  if (body.op === 'stop_all') return res.end(JSON.stringify({ roomId: ROOM, stopped: 2 }))
  if (body.op === 'delete') return res.end(JSON.stringify({ roomId: ROOM, deleted: body.id }))
  if (body.op === 'send') return res.end(JSON.stringify({ roomId: ROOM, seq: 81, item: null }))
  return res.end(JSON.stringify({ roomId: ROOM, item: item(body.rule), warn: 'This keeps the agent in one session.', warnCode: 'keeps_awake' }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
test.after(() => server.close())
const url = `http://127.0.0.1:${server.address().port}`

function cli(...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {}
  const before = seen.length
  assert.ok(fs.existsSync(path.join(home, 'token')), 'test token exists')
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, 'schedule', `topicId=${ROOM}`, 'role=agent', ...args],
      { env: testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: url }), timeout: 30_000 }, (error, stdout) => {
        resolve({ code: error?.code || 0, out: JSON.parse(stdout), sent: seen.length > before ? seen.at(-1) : null })
      })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
  })
}

test('schedule command routes and response fields match the server\'s API', async () => {
  const made = await cli('text=@agent@kai check', 'daily=10:00', 'tz=Asia/Shanghai')
  assert.equal(made.code, 0, JSON.stringify(made.out))
  assert.equal(made.sent.url, `/api/v1/rooms/${ROOM}/schedules`)
  assert.equal(made.sent.body.op, 'add')
  assert.deepEqual(made.sent.body.rule, { kind: 'daily', time: '10:00', tz: 'Asia/Shanghai' })
  assert.equal(made.sent.body.text, '@agent@kai check')
  assert.ok(made.sent.body.nonce)
  assert.equal(made.out.warnCode, 'keeps_awake')
  assert.equal(made.out.item.next, '2026-10-18T10:00:00+08:00')
  assert.equal((await cli('text=Background topic note', 'every=2h')).sent.body.text, 'Background topic note', 'the server applies send-style mention rules')
  const list = await cli()
  assert.deepEqual([list.out.count, list.out.proRequired, list.out.items[0].next], [1, false, '2026-10-18T10:00:00+08:00'])
  assert.equal((await cli('show=3')).sent.url, `/api/v1/rooms/${ROOM}/schedules/S3`)
  assert.deepEqual((await cli('edit=3', 'text=-', 'revive=false', { stdin: '@agent@kai changed\n' })).sent.body,
    { op: 'edit', id: 'S3', text: '@agent@kai changed', revive: false })
  assert.deepEqual((await cli('off=all')).out, { topicId: ROOM, stopped: 2 })
  assert.deepEqual((await cli('send=3')).out, { topicId: ROOM, seq: 81, item: null })
  assert.deepEqual((await cli('delete=3')).out, { topicId: ROOM, deleted: 'S3' })
})

test('local rejection and server errors preserve code and next', async () => {
  for (const [args, code] of [
    [['text=@agent@kai x', 'every=5m'], 'schedule_too_frequent'],
    [['text=@agent@kai x', 'daily=10:00', 'weekly=mon@10:00'], 'bad_request'],
    [['text=@agent@kai x', 'daily=10:00', 'files=x'], 'schedule_no_files'],
  ]) {
    const r = await cli(...args)
    assert.equal(r.out.error, code)
    assert.equal(r.sent, null)
  }
  assert.deepEqual((await cli('text=', 'daily=10:00')).out,
    { error: 'bad_request', next: "text= needs the scheduled message (an agent's must @ someone); text=- reads stdin." })
  const past = await cli('text=@agent@kai x', 'at=2020-01-01T00:00:00Z')
  assert.deepEqual(past.out, { error: 'schedule_in_past', next: 'Choose a future time.' })
  const pro = await cli('text=@free x', 'every=1h')
  assert.equal(pro.out.error, 'pro_required')
  assert.match(pro.out.next, /topic owner's plan \(kai\); tell your owner/)
  assert.deepEqual((await cli('edit=S8', 'revive=true')).out, { error: 'forbidden', next: 'Only the account that set it can edit it.' })
  assert.deepEqual((await cli('send=S9')).out, { error: 'no_takeover', next: 'No takeover line for this agent.' })
})

test.after(() => fs.rmSync(home, { force: true, recursive: true }))

test('calendar step arguments are sent on create and edit and invalid combinations never request', async () => {
  const made = await cli('text=@agent@kai check', 'daily=09:00', 'step=3', 'from=2026-10-21', 'tz=UTC')
  assert.deepEqual(made.sent.body.rule, { kind: 'daily', time: '09:00', tz: 'UTC', step: 3, from: '2026-10-21' })
  const edited = await cli('edit=S3', 'weekly=mon,thu@10:00', 'step=2', 'from=2026-10-26', 'tz=UTC')
  assert.deepEqual(edited.sent.body.rule, { kind: 'weekly', days: ['mon', 'thu'], time: '10:00', tz: 'UTC', step: 2, from: '2026-10-26' })
  assert.equal((await cli('edit=S3', 'daily=10:00', 'from=2026-10-26', 'tz=UTC')).sent.body.rule.step, undefined)
  for (const args of [
    ['every=2h', 'step=2'], ['at=10:00', 'from=2026-10-21'], ['step=2'], ['show=S3', 'step=2'],
    ['edit=S3', 'from=2026-10-21'], ['off=S3', 'step=2'], ['daily=09:00', 'step=366'],
    ['weekly=mon@10:00', 'step=53'], ['daily=09:00', 'step=1.5'], ['daily=09:00', 'step=0'],
    ['daily=09:00', 'step=1', 'from=2026-10-21'], ['daily=09:00', 'from=2026-10-21'],
    ['daily=09:00', 'step=2', 'from=2026-02-30'],
  ]) {
    const result = await cli(...args, ...(args.some((a) => /^(edit|show|off)=/.test(a)) || args[0] === 'step=2' ? [] : ['text=@agent@kai check']))
    assert.equal(result.out.error, 'bad_request', JSON.stringify(args))
    assert.equal(result.sent, null, JSON.stringify(args))
  }
})
