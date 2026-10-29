// The server keeps writing 0.4 commands in its hints; CLI 0.5.0 shows them in the new syntax
// (src/names.mjs). Every hint the server can send goes through newSyntax here.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { ACTION_ALIASES, NameClash, agentOutput, newSyntax, serverArgs } from '../src/names.mjs'

const SERVER = new URL('../../server/src/', import.meta.url)
const OLD = [/\broomId=/, /\bscorpio todo\b/, /(^|[\s(`'"，、；：（])todo +(?:roomId|topicId|add|take|done|edit|delete|show)=/, /\bin=todo\b/, /(^|[\s(`'"，（])topic=['"<]/]

/**
 * Every string literal in the server files that agents' hints come from and that names a command
 * (scorpio <action>, an argument=, in=, topic=), with ${…} filled in: however the hint is built
 * (ApiError, next:, a constant, a ternary), it is in here.
 */
function serverHints() {
  const out = []
  const files = ['room-do.ts', 'room-items.ts', 'room-actions.ts', 'index.ts', 'search.ts',
    ...['routes/', 'room/'].flatMap((dir) => fs.readdirSync(new URL(dir, SERVER)).filter((f) => f.endsWith('.ts')).map((f) => `${dir}${f}`))]
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, SERVER), 'utf8')
    for (const lit of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const text = (lit[1] ?? lit[2]).replace(/\$\{[^}]*\}/g, 'X')
      if (/\bscorpio [a-z]+|\b(?:roomId|topic|in)=|\btodo (?:add|take|done|edit|delete|show)=/.test(text)) out.push({ file: f, text })
    }
  }
  return out
}

test('every server hint that names a command comes out in the new syntax, and nothing else changes', { skip: !fs.existsSync(SERVER) }, () => {
  const hints = serverHints()
  assert.ok(hints.length >= 12, `found ${hints.length} hints`)
  const withCommands = hints.filter((h) => OLD.some((re) => re.test(h.text)))
  assert.ok(withCommands.length >= 10, `${withCommands.length} hints carry an old command`)
  for (const { file, text } of hints) {
    const now = newSyntax(text)
    for (const re of OLD) assert.ok(!re.test(now), `${file}: still old after the rewrite: ${now}`)
    // Only command shapes changed: undo them and the text is the server's again.
    const back = now.replace(/\btopicId=/g, 'roomId=').replace(/\bscorpio task\b/g, 'scorpio todo').replace(/(^|[\s(`'"，、；：（])task(?= +(?:roomId|add|take|done|edit|delete|show)=)/g, '$1todo')
      .replace(/\bin=task\b/g, 'in=todo').replace(/\bin= is messages, task or files\b/g, 'in= is messages, todo or files').replace(/\bin= is messages, task, files or memo\b/g, 'in= is messages, todo, files or memo').replace(/(^|[\s(`'"，（])desc=(?=['"<])/g, '$1topic=')
    assert.equal(back, text, `${file}: the rewrite touched more than commands`)
    assert.equal(newSyntax(now), now, 'already new: unchanged')
  }
})

test('newSyntax: the concrete hints, and what it must leave alone', () => {
  assert.equal(newSyntax('See: scorpio todo roomId=R1'), 'See: scorpio task topicId=R1')
  assert.equal(newSyntax('To take it over anyway: todo take=T3 force=true, then tell kai.'), 'To take it over anyway: task take=T3 force=true, then tell kai.')
  assert.equal(newSyntax('轮次已经没有了；找已交付的任务用 search in=todo，或 todo show=T…。'), '轮次已经没有了；找已交付的任务用 search in=task，或 task show=T…。')
  assert.equal(newSyntax("topic='<new description>' is required (topic='' clears it)."), "desc='<new description>' is required (desc='' clears it).")
  assert.equal(newSyntax('in= is messages, todo or files.'), 'in= is messages, task or files.')
  assert.equal(newSyntax('in= is messages, todo, files or memo.'), 'in= is messages, task, files or memo.')
  assert.equal(newSyntax('Take something that can start (scorpio todo), or force=true.'), 'Take something that can start (scorpio task), or force=true.')
  for (const keep of ['status= is todo, doing or done.', 'edit=T3 status=todo', 'This topic has a passcode.', 'the todo list of todos', 'roomIds and topics', 'a topic named x']) assert.equal(newSyntax(keep), keep)
  assert.equal(newSyntax(undefined), undefined)
})

test('agentOutput: only the top-level names an agent copies change; the hint is rewritten', () => {
  const join = { roomId: 'R', roomName: 'Login', topic: 'Ship it', owner: 'kai', name: 'api@kai', members: [{ name: 'kai', owner: 'x', roomId: 'inner' }], next: 'Read recent history (scorpio messages roomId=R)' }
  assert.deepEqual(agentOutput(join), { topicId: 'R', topicName: 'Login', desc: 'Ship it', creator: 'kai', name: 'api@kai', members: [{ name: 'kai', owner: 'x', roomId: 'inner' }], next: 'Read recent history (scorpio messages topicId=R)' })
  assert.deepEqual(Object.keys(agentOutput({ server: 's', rooms: { R: 'api' } })), ['server', 'topics'])
  assert.deepEqual(agentOutput({ error: 'x', warn: 'scorpio todo roomId=R' }), { error: 'x', warn: 'scorpio task topicId=R' })
  assert.equal(agentOutput(null), null)
  assert.deepEqual(agentOutput([1]), [1])
})

test('serverArgs: new spellings become the server names; old ones pass; desc= is the description only on create and topic', () => {
  assert.deepEqual(serverArgs('send', { topicId: 'R', text: 'hi' }), { roomId: 'R', text: 'hi' })
  assert.deepEqual(serverArgs('send', { roomId: 'R', text: 'hi' }), { roomId: 'R', text: 'hi' })
  assert.deepEqual(serverArgs('send', { topicId: 'R', roomId: 'R' }), { roomId: 'R' })
  assert.throws(() => serverArgs('send', { topicId: 'R', roomId: 'S' }), NameClash)
  assert.deepEqual(serverArgs('topic', { topicId: 'R', desc: 'Ship it' }), { roomId: 'R', topic: 'Ship it' })
  assert.deepEqual(serverArgs('create', { name: 'n', desc: '' }), { name: 'n', topic: '' })
  assert.deepEqual(serverArgs('create', { name: 'n', topic: 'old way' }), { name: 'n', topic: 'old way' })
  assert.throws(() => serverArgs('topic', { roomId: 'R', desc: 'a', topic: 'b' }), NameClash)
  assert.deepEqual(serverArgs('task', { roomId: 'R', add: 't', desc: 'the task' }), { roomId: 'R', add: 't', desc: 'the task' })
  assert.deepEqual(serverArgs('search', { roomId: 'R', q: 'x', in: 'task' }), { roomId: 'R', q: 'x', in: 'todo' })
  assert.deepEqual(serverArgs('search', { roomId: 'R', q: 'x', in: 'todo' }), { roomId: 'R', q: 'x', in: 'todo' })
  assert.equal(ACTION_ALIASES.todo, 'task')
})
