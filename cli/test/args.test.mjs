import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testEnv } from './env.mjs'

const bin = fileURLToPath(new URL('../bin/scorpio.mjs', import.meta.url))
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('offline CLI arguments keep their exact output and exit status', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-args-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: 'http://127.0.0.1:9', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' })
  const cases = [
    { args: ['unknown'], status: 1, out: { error: 'bad_request', next: 'Unknown action "unknown". Actions: login, whoami, topics, logout, create, join, messages, message, search, files, send, file, card, handoff, task, memo, schedule, listen, wait, mark, members, handoffs, roleCard, topic, leave, daemon, up, qr. See `scorpio help`.' } },
    { args: ['plan'], status: 1, out: { error: 'bad_request', next: 'The plan is now the task list, and its items are T3 (P3 still works): scorpio task topicId=<topic id> (add= take= done= edit= delete= show=). See the scorpio skill.' } },
    { args: ['messages'], status: 1, out: { error: 'bad_request', next: 'Missing topicId=. Use the topic id from your invitation.' } },
    { args: ['send', 'topicId=x', 'role=bad name'], status: 1, out: { error: 'invalid_role', next: 'Use a role of 1–62 characters from A-Z a-z 0-9 _ . -' } },
    { args: ['messages', 'topicId=x', 'role=a', 'limit=abc'], status: 1, out: { error: 'bad_request', next: 'limit= must be a whole number ≥ 1, got "abc".' } },
    { args: ['task', 'topicId=x', 'role=a', 'take=T1', 'done=T2'], status: 1, out: { error: 'bad_request', next: 'One of add=, take=, done=, edit=, delete=, show=, mine=, open= at a time (got take, done).' } },
    { args: ['daemon', 'x=1'], status: 1, out: { error: 'bad_request', next: '`scorpio daemon` only takes rejoin=<topic id>.' } },
    { args: ['daemon', 'rejoin=wrong'], status: 1, out: { error: 'bad_request', next: 'rejoin= needs the topic id from its link.' } },
    { args: ['up', 'x=1'], status: 1, out: { error: 'bad_request', next: '`scorpio up` takes no arguments.' } },
    { args: ['qr'], status: 1, out: { error: 'bad_request', next: '`scorpio qr` needs a link or text.' } },
    { args: ['messages', 'topicId=x', 'roomId=y', 'role=a'], status: 1, out: { error: 'bad_request', next: 'topicId= and topicId= mean the same here; give only topicId=.' } },
  ]
  const help = spawnSync(process.execPath, [bin, 'help'], { env, encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.equal(help.stdout.split('\n')[0], `scorpio ${version}: local CLI command reference. Arguments are key=value; quote values with spaces.`)
  assert.match(help.stdout, /Scheduled messages\n[\s\S]*on=S3 \| off=S3 \| off=all/)
  assert.match(help.stdout, /\[buttons='label\|label'\] \[card=<file> summary='…'\]/)
  assert.match(help.stdout, /^  card topicId= seq=$/m)
  assert.match(help.stdout, /^  memo topicId= \[add=/m)
  assert.match(help.stdout, /the latest 10 versions kept/)
  assert.match(help.stdout, /\[cite=M3,M5\] \[misled=M4\]/)
  assert.match(help.stdout, /in=messages\|task\|files\|memo/)
  assert.match(help.stdout, /returns topicId, seq, summary, size and path, or card_not_found/)
  for (const { args, status, out } of cases) {
    const run = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' })
    assert.equal(run.status, status, `${args.join(' ')}: ${run.stderr}`)
    assert.equal(run.stdout, `${JSON.stringify(out)}\n`, args.join(' '))
  }
})
