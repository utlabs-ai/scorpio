import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

// Invites and trial codes give Pro days, so they exist only on a deployment with plans (PLANS=hosted): elsewhere the
// settings page shows neither and their routes answer 404, as any unknown page does.

test('without plans: settings has no invite card or trial code row, and their routes are not there', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai')
    const page = await (await kai.web('/settings')).text()
    assert.ok(page.includes('id="account"'), 'the settings page itself')
    assert.ok(!page.includes('id="invite"') && !page.includes('id="trial-code"'))
    assert.equal((await kai.web('/settings/invite')).status, 404)
    assert.equal((await kai.post('/settings/invite-code', { code: 'ABCDEF' })).status, 404)
    assert.equal((await kai.post('/settings/trial-code', { code: 'ABCDEFGH' })).status, 404)
    assert.notEqual((await kai.web('/trial/ABCDEFGH')).headers.get('location')?.includes('trial='), true)
  } finally { await w.dispose() }
})

test('with plans: the invite card, the trial code row and their routes are as before', async () => {
  const w = await worker({ PLANS: 'hosted' })
  try {
    const kai = await w.person('kai')
    const page = await (await kai.web('/settings')).text()
    assert.ok(page.includes('id="invite"') && page.includes('id="trial-code"'))
    assert.equal((await kai.web('/settings/invite')).status, 200)
    assert.equal((await w.json(await kai.post('/settings/trial-code', { code: 'ABCDEFGH' }))).error, 'trial_unknown')
    assert.match((await kai.web('/trial/ABCDEFGH')).headers.get('location'), /trial=ABCDEFGH/)
  } finally { await w.dispose() }
})
