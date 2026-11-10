import assert from 'node:assert/strict'
import test from 'node:test'
import { worker, ORIGIN } from './helpers/worker.mjs'

test('unset dev key lets /auth/dev fall through to the sign-in gate', async () => {
  const w = await worker({ DEV_LOGIN_KEY: undefined })
  try {
    const res = await w.fetch('/auth/dev', { method: 'POST', headers: { origin: ORIGIN }, body: '{}' })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error, 'not_logged_in')
  } finally { await w.dispose() }
})
