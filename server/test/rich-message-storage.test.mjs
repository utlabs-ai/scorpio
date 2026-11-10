import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'
const append = `
class RichProbe extends RoomDO {
  async fetch(req) {
    const { op, seq } = await req.json();
    if (op === 'delete') this.sql.exec('DELETE FROM messages WHERE seq = ?', seq);
    if (op === 'old') {
      this.sql.exec('DROP TRIGGER messages_cards_delete; DROP TRIGGER message_cards_fts_insert; DROP TRIGGER messages_fts_insert; DROP TABLE message_cards; DROP TABLE messages_fts');
      this.sql.exec('ALTER TABLE messages DROP COLUMN buttons');
      this.sql.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='seq', tokenize='trigram')");
      this.sql.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    }
    if (op === 'migrate') this.migrate();
    if (op === 'tables') return Response.json(this.sql.exec("SELECT name FROM sqlite_master WHERE name = 'message_cards'").toArray());
    if (op === 'counts') return Response.json({ cards: this.sql.exec('SELECT count(*) AS n FROM message_cards').one().n, messages: this.sql.exec('SELECT count(*) AS n FROM messages').one().n });
    return Response.json(true);
  }
}
export { RichProbe };`

test('legacy migration preserves messages and FTS, then deleting a message removes its card and search copy', async () => {
  const w = await worker({}, { className: 'RichProbe', append })
  try {
    const p = await w.person('ops'), room = await w.topic(p)
    await w.join(p, room, 'bot')
    const rpc = async (op, seq) => (await (await w.mf.getDurableObjectNamespace('ROOMS')).getByName(room).fetch('https://probe.test', { method: 'POST', body: JSON.stringify({ op, seq }) })).json()
    const old = await w.json(await p.apiPost(`/rooms/${room}/send`, { text: '@ops legacytext' }, 'bot'))
    assert.equal(old.status, 200)
    await rpc('old'); await rpc('migrate'); await rpc('migrate')
    const legacy = await w.json(await p.api(`/rooms/${room}/messages?q=legacytext`, {}, 'bot'))
    assert.equal(legacy.messages[0].seq, old.seq)
    const sent = await w.json(await p.apiPost(`/rooms/${room}/send`, { text: '@ops chart', card: { kind: 'html', summary: 'MigrationSummary', html: '<b>x</b>' } }, 'bot'))
    assert.equal(sent.status, 200)
    assert.equal((await rpc('counts')).cards, 1)
    await rpc('delete', sent.seq)
    assert.equal((await rpc('counts')).cards, 0)
    const search = await w.json(await p.api(`/rooms/${room}/search?in=messages&q=MigrationSummary`, {}, 'bot'))
    assert.deepEqual(search.groups.messages, [])
    const missing = await w.json(await p.api(`/rooms/${room}/messages/${sent.seq}/card`, {}, 'bot'))
    assert.equal(missing.error, 'card_not_found')
    const card2 = await w.json(await p.apiPost(`/rooms/${room}/send`, { text: '@ops another', card: { kind: 'html', summary: 'PurgeSummary', html: '<b>y</b>' } }, 'bot'))
    assert.equal(card2.status, 200)
    const ticket = await w.json(await p.post(`/r/${room}/cards/${card2.seq}/ticket`))
    const deleted = await w.json(await p.post(`/r/${room}/delete`))
    assert.equal(deleted.status, 200)
    assert.deepEqual(await rpc('tables'), [])
    assert.equal((await w.fetch(ticket.url)).status, 404)
  } finally { await w.dispose() }
})
