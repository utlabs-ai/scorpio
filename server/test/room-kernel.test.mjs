import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { build } from 'esbuild'

async function load(entry) {
  const out = await build({
    stdin: {
      contents: `export * from '../src/${entry}'; export { ApiError } from '../src/util';`,
      resolveDir: new URL('.', import.meta.url).pathname,
      sourcefile: 'kernel-test-entry.ts', loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
    plugins: [{
      name: 'cloudflare-workers-stub',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
      },
    }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const kernel = await load('room/kernel.ts')

test('kernel imports only its allowed utility module', () => {
  const source = readFileSync(new URL('../src/room/kernel.ts', import.meta.url), 'utf8')
  const imports = source.split('\n').filter((line) => line.startsWith('import '))
  for (const line of imports) {
    const path = line.match(/from ["']([^"']+)["']/)?.[1]
    assert.ok(path, `unknown import: ${line}`)
    if (line.startsWith('import type ')) assert.doesNotMatch(path, /^(?:\.\/|\.\.\/room(?:-do|-|\/))/)
    else assert.equal(path, '../util')
  }
})

test('handoffs has no runtime import of RoomDO or another room domain', () => {
  const source = readFileSync(new URL('../src/room/handoffs.ts', import.meta.url), 'utf8')
  const imports = source.split('\n').filter((line) => line.startsWith('import ') && !line.startsWith('import type '))
  for (const line of imports) {
    const path = line.match(/from ["']([^"']+)["']/)?.[1]
    assert.ok(path, `unknown import: ${line}`)
    assert.ok(['./kernel', '../util', '../handoff'].includes(path), `runtime import: ${path}`)
  }
})

test('schedules has no runtime import of RoomDO or another room domain', () => {
  const source = readFileSync(new URL('../src/room/schedules.ts', import.meta.url), 'utf8')
  const imports = source.split('\n').filter((line) => line.startsWith('import ') && !line.startsWith('import type '))
  for (const line of imports) {
    const path = line.match(/from ["']([^"']+)["']/)?.[1]
    assert.ok(path, `unknown import: ${line}`)
    assert.ok(['./kernel', '../util', '../schedules', '../mentions'].includes(path), `runtime import: ${path}`)
  }
})

for (const [name, allowed] of [
  ['quota', ['./kernel', '../util', '../plans', '../room-quota', '../room-report']],
  ['snapshot', ['./kernel', '../util', '../room-report', '../room-snapshot']],
  ['retention', ['./kernel', '../util', '../room-retention']],
  ['files', ['./kernel', '../util', '../files', '../file-kind', '../room-report', '../room-eviction', '../room-file-ticket', '../search']],
  ['tasks', ['./kernel', '../util', '../room-items', '../item-thread', '../task-brief', '../left-items', '../page-view', '../todo-visibility', '../room-report', '../mentions', '../plans', '../search']],
  ['messages', ['../room-rich-message', '../room-screen', './kernel', '../util', '../member-visibility', '../files', '../plans', '../mentions', '../page-view', '../my-data', '../ops-data', '../takeover', '../host-offline', '../search']],
  ['members', ['./kernel', '../util', '../member-visibility', '../room-membership', '../takeover', '../handoff', '../host-offline', '../member-filters', '../spawn-perm', '../workspace-access']],
  ['presence', ['./kernel', '../util', '../member-visibility', '../room-report', '../page-view', '../spawn-perm']],
  ['lifecycle', ['./kernel', '../util', '../room-membership']],
  ['room', ['./kernel', '../util', '../room-report', '../room-snapshot', '../room-membership', '../retention']],
  ['search', ['./kernel', '../util', '../search']],
  ['memo', ['./kernel', '../util', '../memo-text', '../memo-rules', '../memo-errors', '../room-items', '../search']],
  ['types', []],
]) {
  test(`${name} has no runtime import of RoomDO or another room domain`, () => {
    const source = readFileSync(new URL(`../src/room/${name}.ts`, import.meta.url), 'utf8')
    const imports = source.split('\n').filter((line) => line.startsWith('import '))
    for (const line of imports) {
      const path = line.match(/from ["']([^"']+)["']/)?.[1]
      assert.ok(path, `unknown import: ${line}`)
      if (line.startsWith('import type ')) continue
      assert.ok(allowed.includes(path), `runtime import: ${path}`)
    }
  })
}

test('member visibility is a pure rule with type-only imports', () => {
  const source = readFileSync(new URL('../src/member-visibility.ts', import.meta.url), 'utf8')
  const imports = source.split('\n').filter((line) => line.startsWith('import '))
  for (const line of imports) assert.ok(line.startsWith('import type '), `runtime import: ${line}`)
})

test('Timers run in definition order and report the earliest due time', async () => {
  const timers = new kernel.Timers()
  assert.equal(timers.next(), Infinity)
  const calls = []
  timers.define('later', (t) => { calls.push(['later', t]) }, () => 300)
  timers.define('earlier', async (t) => { calls.push(['earlier', t]) }, () => 100)
  assert.equal(timers.next(), 100)
  await timers.run(75)
  assert.deepEqual(calls, [['later', 75], ['earlier', 75]])
})

test('Timers propagate a failure and skip later handlers', async () => {
  const timers = new kernel.Timers()
  const failure = new Error('alarm failed')
  let laterRan = false
  timers.define('first', () => { throw failure }, () => Infinity)
  timers.define('later', () => { laterRan = true }, () => Infinity)
  await assert.rejects(timers.run(10), (e) => e === failure)
  assert.equal(laterRan, false)
})

test('wrap keeps success and ApiError details, and rethrows other errors', () => {
  const value = { id: 1 }
  assert.deepEqual(kernel.wrap(() => value), { ok: value })
  assert.deepEqual(kernel.wrap(() => { throw new kernel.ApiError('bad', 'try again', 409) }),
    { err: { code: 'bad', next: 'try again', status: 409 } })
  assert.deepEqual(kernel.wrap(() => { throw new kernel.ApiError('limited', 'wait', 429, 8) }),
    { err: { code: 'limited', next: 'wait', status: 429, retryAfter: 8 } })
  const unknown = new Error('unknown')
  assert.throws(() => kernel.wrap(() => { throw unknown }), (e) => e === unknown)
})

test('replay and remember retain nonce SQL and answer semantics', () => {
  const calls = []
  const result = { id: 3 }
  const sql = {
    exec(query, ...args) {
      calls.push([query, ...args])
      if (query.startsWith('SELECT result')) return { toArray: () => [{ result: JSON.stringify(result) }] }
      return { toArray: () => [] }
    },
  }
  assert.equal(kernel.replay(sql, 'ana', undefined), null)
  assert.equal(kernel.remember(sql, 'ana', undefined, result), result)
  assert.equal(calls.length, 0)

  const before = Date.now()
  assert.deepEqual(kernel.replay(sql, 'ana', 'n1'), result)
  assert.equal(calls[0][0], 'DELETE FROM nonces WHERE ts < ?')
  assert.ok(calls[0][1] >= before - 600_000 && calls[0][1] <= Date.now() - 600_000)
  assert.deepEqual(calls[1], ['SELECT result FROM nonces WHERE sender = ? AND nonce = ?', 'ana', 'n1'])
  assert.equal(kernel.remember(sql, 'ana', 'n2', result), result)
  assert.equal(calls[2][0], 'INSERT OR REPLACE INTO nonces (sender, nonce, result, ts) VALUES (?, ?, ?, ?)')
  assert.deepEqual(calls[2].slice(1, 4), ['ana', 'n2', JSON.stringify(result)])
  assert.ok(calls[2][4] >= before && calls[2][4] <= Date.now())
})
