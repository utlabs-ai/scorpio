// What a blocked agent is stopped at, from herdr's detection rule.
import assert from 'node:assert/strict'
import test from 'node:test'
import { blockedWords, createBlockedReasons } from '../src/daemon/blocked.mjs'

test('rule ids become a few words that start with approval, question or prompt', () => {
  assert.equal(blockedWords('bash_permission_prompt'), 'approval: a shell command')
  assert.equal(blockedWords('live_strong_blocker'), 'approval')
  assert.equal(blockedWords('live_blocked_form'), 'question')
  assert.equal(blockedWords('startup_update'), 'prompt: update notice')
  assert.equal(blockedWords('something_new'), 'prompt')
  assert.equal(blockedWords(null), null)
})

test('herdr is asked once when a pane turns blocked, again only after a while, and forgets once it moves on', async () => {
  let t = 0
  const asked = []
  let rule = 'bash_permission_prompt'
  const r = createBlockedReasons({ explain: async (pane) => { asked.push(pane); return { state: 'blocked', rule } }, now: () => t, refreshMs: 30_000 })
  assert.equal(await r.of('p1', 'blocked'), 'approval: a shell command')
  t = 10_000
  rule = 'live_blocked_form'
  assert.equal(await r.of('p1', 'blocked'), 'approval: a shell command', 'cached')
  t = 40_000
  assert.equal(await r.of('p1', 'blocked'), 'question', 'asked again: another dialog')
  assert.equal(await r.of('p1', 'working'), null)
  assert.equal(await r.of('p1', 'blocked'), 'question', 'a new stop asks again')
  assert.deepEqual(asked, ['p1', 'p1', 'p1'])
  // herdr no longer sees it blocked by the time it is asked: no words rather than a guess.
  const r2 = createBlockedReasons({ explain: async () => ({ state: 'idle', rule: 'live_prompt_box' }) })
  assert.equal(await r2.of('p2', 'blocked'), null)
  const r3 = createBlockedReasons({ explain: async () => null })
  assert.equal(await r3.of('p3', 'blocked'), null, 'herdr could not be asked')
})
