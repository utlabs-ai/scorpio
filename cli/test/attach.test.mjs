import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ATTACH_MS, createPending, consumePending, matchingPanes } from '../src/actions/attach.mjs'

test('one-time attach code is bound to agent and room, expires, and cannot replay', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-attach-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const at = 1_000_000
  const { code, expiresAt } = createPending({ roomId: 'r1', name: 'api@kai', role: 'api', now: at, dir })
  assert.equal(expiresAt, at + ATTACH_MS)
  assert.deepEqual(consumePending({ roomId: 'r1', name: 'other@kai', code, now: at, dir }), { error: 'missing' })
  assert.deepEqual(consumePending({ roomId: 'r2', name: 'api@kai', code, now: at, dir }), { error: 'missing' })
  assert.deepEqual(consumePending({ roomId: 'r1', name: 'api@kai', code: 'SCORPIO-ATTACH-AAAAAAAAAAAAAAAAAAAAAA', now: at, dir }), { error: 'invalid' })
  assert.deepEqual(consumePending({ roomId: 'r1', name: 'api@kai', code, now: at, dir }), { role: 'api' })
  assert.deepEqual(consumePending({ roomId: 'r1', name: 'api@kai', code, now: at, dir }), { error: 'missing' })
  const expired = createPending({ roomId: 'r1', name: 'api@kai', role: 'api', now: at, dir }).code
  assert.deepEqual(consumePending({ roomId: 'r1', name: 'api@kai', code: expired, now: at + ATTACH_MS, dir }), { error: 'expired' })
})

test('pane scan reads recent then visible and rejects ambiguous matches', async () => {
  const panes = [{ pane_id: 'p1', agent: 'codex' }, { pane_id: 'p2', agent: 'codex' }, { pane_id: 'p3', agent: null }]
  const calls = []
  const code = 'SCORPIO-ATTACH-AAAAAAAAAAAAAAAAAAAAAA'
  const read = async (pane, lines, source) => {
    calls.push([pane, source])
    return pane === 'p2' && source === 'visible' ? `output ${code}` : ''
  }
  assert.deepEqual(await matchingPanes(panes, read, code), ['p2'])
  assert.deepEqual(calls, [['p1', 'recent-unwrapped'], ['p1', 'visible'], ['p2', 'recent-unwrapped'], ['p2', 'visible']])
  assert.deepEqual(await matchingPanes(panes, async () => code, code), ['p1', 'p2'])
})
