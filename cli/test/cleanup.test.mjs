import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { cleanup, cleanupIfDue, cleanupDays, touchSession, DAY_MS, HERDR_LOG_BYTES } from '../src/cleanup.mjs'
import { testEnv } from './env.mjs'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-cleanup-')))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const now = Math.floor(Date.now() / 1000) * 1000
let counter = 0
function fixture(t) {
  const home = path.join(root, String(++counter))
  fs.mkdirSync(home)
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}
function put(home, name, age = 31, content = name) {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  fs.utimesSync(file, (now - age * DAY_MS) / 1000, (now - age * DAY_MS) / 1000)
  return file
}
const snapshot = (file) => {
  const stat = fs.lstatSync(file)
  return { bytes: fs.readFileSync(file), mtime: stat.mtimeMs, mode: stat.mode, inode: stat.ino }
}
const retained = ['topics/x/files/a.pdf', 'files/a.pdf', 'spawns/x/api.md', 'sessions/agent.json', 'handoffs/x/api.md']
const temporary = ['state/up-secrets/setup.sh', 'tmp/herdr-install-box.sh']

test('every allowed kind expires strictly after its threshold and keeps recent files', (t) => {
  const empty = fixture(t)
  for (const dir of ['topics/x/files', 'spawns/x']) fs.mkdirSync(path.join(empty, dir), { recursive: true })
  cleanup({ home: empty, now })
  for (const dir of ['topics/x/files', 'spawns/x']) assert.equal(fs.statSync(path.join(empty, dir)).isDirectory(), true)
  for (const [age, gone] of [[31, true], [30, false], [29, false]]) {
    const home = fixture(t)
    for (const name of retained) put(home, name, age)
    cleanup({ home, now })
    for (const name of retained) assert.equal(fs.existsSync(path.join(home, name)), !gone, `${name}: ${age}`)
    if (gone) for (const dir of ['topics/x/files', 'spawns/x', 'handoffs/x']) assert.equal(fs.existsSync(path.join(home, dir)), false)
  }
  for (const [age, gone] of [[2, true], [1, false], [0.5, false]]) {
    const home = fixture(t)
    for (const name of temporary) put(home, name, age)
    cleanup({ home, now })
    for (const name of temporary) assert.equal(fs.existsSync(path.join(home, name)), !gone, name)
  }
})

test('all unlisted files, including nested downloads and spawn records, retain bytes, mtime, mode and inode', (t) => {
  const home = fixture(t)
  const names = ['token', 'config.json', 'device.json', 'bin/scorpio', 'app/src/a.mjs', 'app.prev/a', 'node/bin/node', 'update/a', 'usage/a', 'memory/x.md', 'state/reminders.json', 'state/registry.json', 'state/up-secrets/keep.json', 'tmp/keep.sh', 'topics/x/handoffs/a.md', 'topics/x/workspace/f', 'spawns/x/a.json', 'spawns/record.json', 'sessions/keep.md', 'topics/x/files/nested/keep', 'files/nested/keep', 'spawns/x/nested/keep.md', 'unknown/old']
  const before = new Map(names.map((name) => {
    const file = put(home, name, 365)
    return [file, snapshot(file)]
  }))
  cleanup({ home, now })
  for (const [file, value] of before) assert.deepEqual(snapshot(file), value, path.relative(home, file))
})

test('an old handoff directory waits for its newest file, including nested files', (t) => {
  const home = fixture(t)
  const old = put(home, 'handoffs/x/api.md', 365)
  const fresh = put(home, 'handoffs/x/nested/pm.md', 5)
  cleanup({ home, now })
  assert.equal(fs.existsSync(old), true)
  assert.equal(fs.existsSync(fresh), true)
  fs.utimesSync(fresh, (now - 31 * DAY_MS) / 1000, (now - 31 * DAY_MS) / 1000)
  cleanup({ home, now })
  assert.equal(fs.existsSync(path.join(home, 'handoffs/x')), false)
})

test('links below the configured home are neither followed nor deleted', (t) => {
  const outside = fixture(t), home = fixture(t)
  const target = put(outside, 'target.md', 365), before = snapshot(target)
  const links = []
  for (const name of ['topics/x/files/a.md', 'spawns/x/api.md', 'sessions/api.json', 'handoffs/x/api.md', 'state/up-secrets/a.sh', 'tmp/herdr-install-box.sh', 'state/herdr-server.log']) {
    const file = path.join(home, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.symlinkSync(target, file); links.push(file)
  }
  const workspace = path.join(home, 'topics', 'x', 'workspace')
  fs.mkdirSync(workspace)
  const work = put(home, 'topics/x/workspace/f', 365), workBefore = snapshot(work)
  for (const [name, dest] of [['files', workspace], ['topics/y', outside], ['topics/z/files', outside], ['spawns/y', outside], ['handoffs/y', outside], ['state/up-secrets/nested', outside]]) {
    const file = path.join(home, name)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(dest, file); links.push(file)
  }
  cleanup({ home, now })
  for (const file of links) assert.equal(fs.lstatSync(file).isSymbolicLink(), true)
  assert.deepEqual(snapshot(target), before)
  assert.deepEqual(snapshot(work), workBefore)
  for (const prefix of ['topics', 'spawns', 'sessions', 'handoffs', 'state', 'tmp']) {
    const other = fixture(t), file = path.join(other, prefix)
    fs.symlinkSync(outside, file)
    cleanup({ home: other, now })
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true)
  }
})

test('the configured home and its parents may be linked, while links inside remain excluded', (t) => {
  const home = fixture(t), parent = fixture(t), outside = fixture(t)
  const direct = path.join(parent, 'home'), linkedParent = path.join(parent, 'parent')
  fs.symlinkSync(home, direct)
  fs.symlinkSync(path.dirname(home), linkedParent)
  const outsideFile = put(outside, 'api.md', 365), before = snapshot(outsideFile)
  fs.mkdirSync(path.join(home, 'spawns/x'), { recursive: true })
  const internalLink = path.join(home, 'spawns/x/api.md')
  fs.symlinkSync(outsideFile, internalLink)
  for (const configured of [direct, path.join(linkedParent, path.basename(home))]) {
    const session = put(home, 'sessions/api.json', 2, '{}')
    touchSession(path.join(configured, 'sessions/api.json'), now)
    assert.ok(Math.abs(fs.statSync(session).mtimeMs - now) < 1)
    const old = put(home, 'files/old.pdf', 365)
    const key = put(home, 'state/up-secrets/key.sh', 2)
    assert.equal(cleanupIfDue({ home: configured, now, force: true }), true)
    assert.equal(fs.existsSync(old), false)
    assert.equal(fs.existsSync(key), false)
    assert.equal(fs.lstatSync(internalLink).isSymbolicLink(), true)
    assert.deepEqual(snapshot(outsideFile), before)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state/cleanup.json'))).lastRun, now)
  }
})

test('spawn prompts are repaired to 0600 without rewriting their contents or time', (t) => {
  const home = fixture(t), file = put(home, 'spawns/x/api.md', 5)
  fs.chmodSync(file, 0o644)
  const before = snapshot(file)
  cleanup({ home, now })
  const after = snapshot(file)
  assert.equal(after.mode & 0o777, 0o600)
  assert.deepEqual(after.bytes, before.bytes)
  assert.equal(after.mtime, before.mtime)
  assert.equal(after.inode, before.inode)
})

test('Herdr log above 10 MiB is truncated in place; the existing append descriptor still works', (t) => {
  const home = fixture(t), file = put(home, 'state/herdr-server.log', 365, 'log')
  const fd = fs.openSync(file, 'a'), inode = fs.statSync(file).ino
  t.after(() => fs.closeSync(fd))
  for (const size of [HERDR_LOG_BYTES - 1, HERDR_LOG_BYTES, HERDR_LOG_BYTES + 1]) {
    fs.ftruncateSync(fd, size)
    cleanup({ home, now })
    assert.equal(fs.statSync(file).size, size > HERDR_LOG_BYTES ? 0 : size)
    assert.equal(fs.statSync(file).ino, inode)
  }
  fs.writeSync(fd, 'new line')
  assert.equal(fs.readFileSync(file, 'utf8'), 'new line')
})

test('zero keeps retention files; key expiry and log caps still run with fixed thresholds', (t) => {
  const home = fixture(t)
  for (const name of [...retained, ...temporary]) put(home, name, 365)
  const log = put(home, 'state/herdr-server.log', 365, 'log')
  fs.truncateSync(log, HERDR_LOG_BYTES + 1)
  const prompt = path.join(home, 'spawns/x/api.md')
  fs.chmodSync(prompt, 0o644)
  put(home, 'config.json', 0, JSON.stringify({ local_cleanup_days: 0 }))
  assert.equal(cleanupIfDue({ home, now }), true)
  cleanup({ home, now, days: 0 })
  for (const name of retained) assert.equal(fs.existsSync(path.join(home, name)), true)
  for (const name of temporary) assert.equal(fs.existsSync(path.join(home, name)), false)
  assert.equal(fs.statSync(prompt).mode & 0o777, 0o600)
  assert.equal(fs.statSync(log).size, 0)
  put(home, 'config.json', 0, JSON.stringify({ local_cleanup_days: 400 }))
  assert.equal(cleanupIfDue({ home, now, force: true }), true)
  for (const name of retained) assert.equal(fs.existsSync(path.join(home, name)), true)
  for (const name of temporary) assert.equal(fs.existsSync(path.join(home, name)), false)
  assert.equal(fs.statSync(log).size, 0)
  assert.equal(cleanupDays(undefined), 30)
  for (const value of [-1, 1.5, '10', null]) assert.equal(cleanupDays(value), 30)
})

test('a session read for 31 days survives cleanup; reads within one day do not rewrite mtime', async (t) => {
  const home = fixture(t)
  const claudeSession = process.env.CLAUDE_CODE_SESSION_ID
  const codexSession = process.env.CODEX_SESSION_ID
  delete process.env.CLAUDE_CODE_SESSION_ID
  delete process.env.CODEX_SESSION_ID
  process.env.SCORPIO_HOME = home
  process.env.CODEX_THREAD_ID = 'cleanup-session'
  const { readBinding } = await import('../src/client.mjs')
  const file = put(home, 'sessions/cleanup-session.json', 0, JSON.stringify({ rooms: { x: { role: 'api' } } }))
  const clock = Date.now
  try {
    for (let day = 1; day <= 31; day++) {
      const at = now + day * DAY_MS
      Date.now = () => at
      assert.equal(readBinding().rooms.x.role, 'api')
      const used = fs.statSync(file).mtimeMs
      readBinding()
      assert.equal(fs.statSync(file).mtimeMs, used)
      cleanup({ home, now: at })
      assert.equal(fs.existsSync(file), true)
    }
    assert.ok(fs.statSync(file).mtimeMs >= now + 30 * DAY_MS)
  } finally {
    Date.now = clock
    delete process.env.SCORPIO_HOME
    delete process.env.CODEX_THREAD_ID
    if (claudeSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = claudeSession
    if (codexSession === undefined) delete process.env.CODEX_SESSION_ID
    else process.env.CODEX_SESSION_ID = codexSession
  }
})

test('cleanup logs filesystem errors and continues without throwing', (t) => {
  const home = fixture(t), errors = []
  put(home, 'topics/not-a-directory', 365)
  const file = put(home, 'sessions/api.json', 365)
  assert.doesNotThrow(() => cleanup({ home, now, log: (line) => errors.push(line) }))
  assert.ok(errors.some((line) => line.includes('ENOTDIR')))
  assert.equal(fs.existsSync(file), false)
  assert.doesNotThrow(() => cleanupIfDue({ home, now, log: () => { throw new Error('logger') } }))
})

test('cleanup skips hard links so chmod and truncation cannot mutate an excluded target', (t) => {
  const home = fixture(t), file = put(home, 'topics/x/workspace/f', 365, 'keep')
  fs.mkdirSync(path.join(home, 'spawns/x'), { recursive: true })
  fs.mkdirSync(path.join(home, 'state'), { recursive: true })
  fs.linkSync(file, path.join(home, 'spawns/x/api.md'))
  fs.linkSync(file, path.join(home, 'state/herdr-server.log'))
  fs.truncateSync(file, HERDR_LOG_BYTES + 1)
  fs.utimesSync(file, (now - 365 * DAY_MS) / 1000, (now - 365 * DAY_MS) / 1000)
  const before = snapshot(file)
  cleanup({ home, now })
  assert.deepEqual(snapshot(file), before)
  assert.equal(fs.existsSync(path.join(home, 'spawns/x/api.md')), true)
})

test('join executes cleanup only after success and at most once per 24 hours (local HTTP fixture)', async (t) => {
  const home = fixture(t)
  const topic = 'AbCdEf0123456789_-ghIJ'
  put(home, 'token', 0, 'fixture')
  const stale = put(home, 'files/old.pdf', 365)
  const topicStale = put(home, `topics/${topic}/files/old.pdf`, 365)
  let fail = true
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/join') && fail) { res.statusCode = 403; res.end(JSON.stringify({ error: 'not_member' })) }
    else res.end(JSON.stringify(req.url.endsWith('/join') ? { name: 'api@kai', roomId: topic, role: 'api' } : { account: 'kai' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const cli = new URL('../bin/scorpio.mjs', import.meta.url)
  const run = () => new Promise((resolve, reject) => execFile(process.execPath, [cli.pathname, 'join', `topicId=${topic}`, 'role=api'], {
    env: testEnv(home, { SCORPIO_HOME: home, SCORPIO_SERVER: `http://127.0.0.1:${server.address().port}`, HERDR_PANE_ID: '', PATH: '' }), timeout: 30_000,
  }, (error, stdout) => { try { resolve({ code: error?.code || 0, out: JSON.parse(stdout) }) } catch (e) { reject(e) } }))
  assert.equal((await run()).code, 1)
  assert.equal(fs.existsSync(stale), true)
  assert.equal(fs.existsSync(path.join(home, 'state/cleanup.json')), false)
  fail = false
  const joined = await run()
  assert.equal(joined.code, 0)
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(topicStale), false)
  assert.equal(fs.statSync(joined.out.files).isDirectory(), true)
  assert.equal(fs.statSync(joined.out.workspace).isDirectory(), true)
  const marker = path.join(home, 'state/cleanup.json'), before = snapshot(marker)
  put(home, 'files/old.pdf', 365)
  assert.equal((await run()).code, 0)
  assert.equal(fs.existsSync(stale), true)
  assert.deepEqual(snapshot(marker), before)
  fs.writeFileSync(marker, JSON.stringify({ lastRun: Date.now() - DAY_MS - 1000 }))
  assert.equal((await run()).code, 0)
  assert.equal(fs.existsSync(stale), false)
})
