import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'
import { labelWidth } from '../src/label-width.mjs'
import { renderDelivery, FRAME, typeable } from '../src/render/forward.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-rich-'))
process.env.SCORPIO_HOME = home
const { richMessageArgs, CARD_MAX } = await import('../src/rich-message.mjs')
const bin = fileURLToPath(new URL('../bin/scorpio.mjs', import.meta.url))
const topicId = 'AbCdEf0123456789_-ghIJ'
const html = '<svg aria-label="Messages"><text>120 → 610</text></svg>'
const fragment = path.join(home, 'chart.html')
fs.writeFileSync(fragment, html)
fs.writeFileSync(path.join(home, 'token'), 'test-token')
const bad = (args, code) => assert.throws(() => richMessageArgs(args), e => e.error === code && !!e.next)

test('button parsing trims each pipe-separated label and uses Unicode W/F columns', () => {
  assert.deepEqual(richMessageArgs({ buttons: ' 1 照这个做 | 2 有要改的 ' }), { buttons: ['1 照这个做', '2 有要改的'] })
  for (const [label, width] of [['a', 1], ['中', 2], ['Ａ', 2], ['😀', 2], ['©', 1], ['e\u0301', 2], ['\u{20000}', 2], ['\u{1fae9}', 2]]) assert.equal(labelWidth(label), width)
  for (const label of ['a'.repeat(24), '中'.repeat(12), '😀'.repeat(12), 'Ａ'.repeat(12), 'a'.repeat(22) + '中']) assert.deepEqual(richMessageArgs({ buttons: label }), { buttons: [label] })
  assert.equal(richMessageArgs({ buttons: 'a|b|c|d' }).buttons.length, 4)
  for (const buttons of ['', ' ', '|a', 'a|', 'a||b', 'a|b|c|d|e', 'a| a ', '中'.repeat(13), '😀'.repeat(13), 'a'.repeat(25), '\na', 'a\tb', 'a\x03b', 'a\x7fb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) bad({ buttons }, 'bad_buttons')
})

test('cards read UTF-8, require a one-line summary and enforce the byte limit', () => {
  assert.deepEqual(richMessageArgs({ card: fragment, summary: 'Messages rose from 120 to 610.' }), { card: { kind: 'html', summary: 'Messages rose from 120 to 610.', html } })
  for (const summary of [undefined, '', ' ', 'a\nb', 'a\u2028b', 'a\x00b', 'a'.repeat(301)]) bad({ card: fragment, summary }, 'card_summary_required')
  assert.equal(richMessageArgs({ card: fragment, summary: '😀'.repeat(300) }).card.summary.length, 600)
  bad({ summary: 'Only a summary' }, 'bad_request')
  bad({ card: fragment + '.missing', summary: 'Chart' }, 'bad_request')
  bad({ card: home, summary: 'Chart' }, 'bad_request')
  const limit = path.join(home, 'limit.html')
  fs.writeFileSync(limit, 'é'.repeat(CARD_MAX / 2))
  assert.equal(Buffer.byteLength(richMessageArgs({ card: limit, summary: 'Chart' }).card.html), CARD_MAX)
  fs.appendFileSync(limit, 'x')
  bad({ card: limit, summary: 'Chart' }, 'card_too_large')
})

const metadata = { kind: 'html', summary: 'Messages: 120 to 610.', size: Buffer.byteLength(html) }
const message = { seq: 7, from: 'api@kai', fromKind: 'agent', text: '@kai Messages rose.', buttons: [{ label: '1 照这个做', by: ['kai', 'mei'] }, { label: '2 有要改的', by: [] }], card: metadata }
const seen = []
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  seen.push({ url: req.url, method: req.method, role: req.headers['x-scorpio-role'], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null })
  res.setHeader('content-type', 'application/json')
  if (req.url.endsWith('/messages/8/card')) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'card_not_found', next: 'This message has no card.' })) }
  if (req.url.endsWith('/messages/7/card')) return res.end(JSON.stringify({ seq: 7, ...metadata, html }))
  if (req.url.includes('/messages?')) return res.end(JSON.stringify({ roomId: topicId, messages: [message] }))
  if (req.url.endsWith('/messages/7')) return res.end(JSON.stringify({ roomId: topicId, message }))
  if (req.url.endsWith('/listen')) return res.end(JSON.stringify({ roomId: topicId, mentions: [message], broadcasts: [] }))
  res.end(JSON.stringify({ seq: 7, delivery: [] }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
test.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }) })
function cli(...args) {
  const options = typeof args.at(-1) === 'object' ? args.pop() : {}
  const before = seen.length
  return new Promise(resolve => {
    const child = execFile(process.execPath, [bin, ...args, 'role=api'], { env: testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: url }), timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, out: JSON.parse(stdout || '{}'), stderr, requests: seen.slice(before) })
    })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
  })
}

test('send combines textFile and stdin text with buttons and a card in one ordinary send', async () => {
  const textFile = path.join(home, 'message.md')
  const text = '@kai Review the trend.\nNumbers are in the chart.\n'
  fs.writeFileSync(textFile, text)
  for (const textArgs of [[`textFile=${textFile}`], ['text=-', { stdin: text }]]) {
    const options = typeof textArgs.at(-1) === 'object' ? textArgs.pop() : {}
    const result = await cli('send', `topicId=${topicId}`, ...textArgs, 'buttons= 1 Use this | 2 Revise ', `card=${fragment}`, 'summary=Messages rose from 120 to 610.', options)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.requests.length, 1)
    const request = result.requests[0]
    assert.equal(request.url, `/api/v1/rooms/${topicId}/send`)
    assert.equal(request.role, 'api')
    assert.equal(request.method, 'POST')
    assert.deepEqual(request.body.buttons, ['1 Use this', '2 Revise'])
    assert.deepEqual(request.body.card, { kind: 'html', summary: 'Messages rose from 120 to 610.', html })
    assert.equal(request.body.text, textArgs[0] === 'text=-' ? text.trimEnd() : text)
    assert.ok(request.body.nonce)
  }
})

test('invalid rich arguments and missing text stop before any upload or send', async () => {
  for (const [extra, code] of [[['buttons=a| a '], 'bad_buttons'], [[`card=${fragment}`], 'card_summary_required'], [['summary=Chart'], 'bad_request']]) {
    const result = await cli('send', `topicId=${topicId}`, 'text=@kai Review', `files=${fragment}`, ...extra)
    assert.equal(result.code, 1)
    assert.equal(result.out.error, code)
    assert.deepEqual(result.requests, [])
  }
  const result = await cli('send', `topicId=${topicId}`, `card=${fragment}`, 'summary=Chart')
  assert.equal(result.out.error, 'bad_request')
  assert.deepEqual(result.requests, [])
})

test('card downloads into the guarded topic directory, replaces a symlink without following it, and passes through errors', async () => {
  const target = path.join(home, 'topics', topicId, 'files', 'card-7.html')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const other = path.join(home, 'other.html')
  fs.writeFileSync(other, 'keep')
  fs.symlinkSync(other, target)
  const result = await cli('card', `topicId=${topicId}`, 'seq=7')
  assert.equal(result.code, 0)
  assert.deepEqual(result.out, { topicId, seq: 7, summary: metadata.summary, size: metadata.size, path: target })
  assert.equal(fs.readFileSync(target, 'utf8'), html)
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep')
  assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  assert.equal(result.requests[0].url, `/api/v1/rooms/${topicId}/messages/7/card`)
  const missing = await cli('card', `topicId=${topicId}`, 'seq=8')
  assert.deepEqual(missing.out, { error: 'card_not_found', next: 'This message has no card.' })
  assert.equal(fs.existsSync(path.join(path.dirname(target), 'card-8.html')), false)
  for (const args of [[`topicId=../escape`, 'seq=7'], [`topicId=${topicId}`, 'seq=../7'], [`topicId=${topicId}`]]) {
    const invalid = await cli('card', ...args)
    assert.equal(invalid.out.error, 'bad_request')
    assert.deepEqual(invalid.requests, [])
  }
  fs.rmSync(path.dirname(target), { recursive: true })
  const redirected = path.join(home, 'redirected')
  fs.mkdirSync(redirected)
  fs.symlinkSync(redirected, path.dirname(target))
  const blocked = await cli('card', `topicId=${topicId}`, 'seq=7')
  assert.equal(blocked.code, 1)
  assert.match(blocked.out.next, /Not a directory/)
  assert.deepEqual(fs.readdirSync(redirected), [])
})

test('messages, message and listen retain buttons and card metadata as received', async () => {
  for (const [action, args, key] of [['messages', [], 'messages'], ['message', ['seq=7'], 'message'], ['listen', [], 'mentions']]) {
    const result = await cli(action, `topicId=${topicId}`, ...args)
    assert.equal(result.code, 0)
    const found = Array.isArray(result.out[key]) ? result.out[key][0] : result.out[key]
    assert.deepEqual(found, message)
    assert.equal('html' in found.card, false)
  }
})

test('forwarding golden puts buttons and card after the body with optional role in the read command', () => {
  for (const role of [undefined, 'api']) {
    const roleArg = role ? ' role=api' : ''
    const text = renderDelivery({ room: { roomId: topicId }, messages: [message], name: 'api@kai', role })
    assert.equal(text, [
      `Scorpio topic "${topicId}" (${topicId}): 1 new message for you.`, '',
      '#7 from api@kai (agent):', FRAME, '@kai Messages rose.', FRAME,
      'Buttons: [1 照这个做 · kai, mei] [2 有要改的]',
      `Card: Messages: 120 to 610. (to read it: scorpio card topicId=${topicId}${roleArg} seq=7)`, '',
      `Mark them read first: scorpio mark topicId=${topicId}${roleArg} upTo=7`,
      'Then do the work (if any).',
    ].join('\n'))
  }
})

test('forwarding withholds unsafe labels, names and summaries only for terminal delivery', () => {
  for (const extra of [{ buttons: [{ label: 'stop\x03', by: [] }] }, { buttons: [{ label: 'Go', by: ['kai\r'] }] }, { card: { ...metadata, summary: 'stop\x1b[31m' } }]) {
    const m = { ...message, ...extra }
    const terminal = renderDelivery({ room: { roomId: topicId }, messages: [m], name: 'api@kai', terminal: true })
    assert.ok(typeable(terminal))
    assert.match(terminal, /contains control characters/)
    assert.match(terminal, /Read it with: scorpio (?:message|card) topicId=/)
    const wait = renderDelivery({ room: { roomId: topicId }, messages: [m], name: 'api@kai' })
    assert.ok(!typeable(wait))
  }
  const plain = renderDelivery({ room: { roomId: topicId }, messages: [{ ...message, buttons: null, card: null }], name: 'api@kai' })
  assert.ok(!plain.includes('Buttons:') && !plain.includes('Card:'))
})
