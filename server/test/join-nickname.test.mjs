import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

test('join names the authenticated owner, including before the person opens the topic', async () => {
  const w = await worker()
  try {
    const kai = await w.person('kai')
    const made = await w.json(await kai.apiPost('/rooms', { name: 'Nickname topic', code: '' }))
    assert.equal(made.status, 200)
    // Do not open the topic on the web: the join must read the account, not its member row.
    for (const [nickname, role, shown] of [[null, 'api', 'kai'], ['Kai', 'pm', 'kai (nickname: Kai)'], ['Kai|A', 'qa', 'kai (nickname: Kai A)']]) {
      await w.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(nickname, kai.id).run()
      const joined = await w.join(kai, made.roomId, role)
      assert.equal(joined.status, 200)
      assert.equal(joined.ownerDisplayName, nickname)
      assert.ok(joined.next.startsWith(`Your owner is ${shown}. Read recent history`), joined.next)
      assert.ok(joined.next.endsWith('report in to @kai with send.'))
    }
  } finally { await w.dispose() }
})
