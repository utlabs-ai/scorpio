import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

test('a failing first step of the daily job does not skip the Pro snapshot at its end', async () => {
  const w = await worker()
  try {
    await w.db.prepare('DROP TABLE device_codes').run()
    const { outcome } = await (await w.mf.getWorker()).scheduled({ cron: '17 3 * * *' })
    assert.equal(outcome, 'ok')
    const today = new Date().toISOString().slice(0, 10)
    assert.ok(await w.db.prepare('SELECT day FROM pro_daily WHERE day = ?').bind(today).first(), `no pro_daily row for ${today}`)
  } finally { await w.dispose() }
})
