import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { ROOM_DAILY_SQL, ROOM_TOTALS_SQL } from '../src/my-data.ts'
import { TAKEOVER_CANDIDATES_SQL } from '../src/takeover.ts'
import { likeTerms } from '../src/search-match.ts'
import { CARRIED_SQL } from '../src/item-thread.ts'

// The 150-message WS hello calls RoomDO.carried(seq) once per message (CARRIED_SQL: the item_messages rows
// of that seq). Measure that path with workerd's SqlStorageCursor.rowsRead, with and without the seq index.
test('the item_messages seq index keeps the WS hello\'s carried() reads to the rows it returns', async () => {
  const script = `import { DurableObject } from 'cloudflare:workers';
    export class Probe extends DurableObject {
      fetch() {
        const sql = this.ctx.storage.sql;
        sql.exec('CREATE TABLE items (n INTEGER PRIMARY KEY, title TEXT, assignee TEXT, status TEXT, round INTEGER, created_by TEXT); CREATE TABLE item_messages (n INTEGER NOT NULL, seq INTEGER NOT NULL, rel TEXT NOT NULL, PRIMARY KEY (n, seq)); CREATE TABLE messages (seq INTEGER PRIMARY KEY)');
        sql.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO items(n,title,status,created_by) SELECT x,'t','todo','a' FROM n");
        sql.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO item_messages(n,seq,rel) SELECT x, 1900+x, 'source' FROM n");
        sql.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<400) INSERT INTO item_messages(n,seq,rel) SELECT 1+(x%100), x*4, 'thread' FROM n");
        sql.exec('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO messages(seq) SELECT x FROM n');
        const measure = () => {
          const recent = sql.exec('SELECT seq FROM messages ORDER BY seq DESC LIMIT 150');
          const messages = recent.toArray();
          let carried = 0, rows = 0;
          for (const message of messages) {
            const cursor = sql.exec(${JSON.stringify(CARRIED_SQL)}, message.seq);
            rows += cursor.toArray().length;
            carried += cursor.rowsRead;
          }
          return { recent: recent.rowsRead, carried, rows };
        };
        const before = measure();
        sql.exec('CREATE INDEX item_messages_seq ON item_messages (seq)');
        return Response.json({ before, after: measure() });
      }
    }
    export default { fetch(req, env) { return env.PROBE.get(env.PROBE.idFromName('room')).fetch(req); } };`
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script,
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
  }))
  try {
    const response = await mf.dispatchFetch('http://localhost/')
    assert.equal(response.status, 200)
    const { before, after } = await response.json()
    console.log(`WS hello carried rowsRead: ${before.carried} without the index, ${after.carried} with it (${after.rows} rows returned)`)
    assert.equal(after.rows, before.rows)
    assert.ok(before.carried >= 150 * 500, 'without it, every call scans the table')
    assert.ok(after.carried <= 150 + after.rows * 3, 'with it, one probe per call and the rows returned (index, row, item)')
  } finally {
    await mf.dispose()
  }
})

test('indexed @me entries preserve history and avoid scanning every message', async () => {
  const seedSql = `CREATE TABLE messages(seq INTEGER PRIMARY KEY, notify TEXT NOT NULL, text TEXT);
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
    INSERT INTO messages(seq, notify, text)
    SELECT x, CASE WHEN x%20=0 THEN json_array('kai') ELSE json_array() END, 'message' FROM n`
  const triggerSql = `CREATE TRIGGER messages_notify_insert AFTER INSERT ON messages BEGIN
    INSERT OR IGNORE INTO message_notifies(name, seq) SELECT value, NEW.seq FROM json_each(NEW.notify);
  END`
  const script = `import { DurableObject } from 'cloudflare:workers';
    export class Probe extends DurableObject {
      fetch() {
        const sql = this.ctx.storage.sql;
        sql.exec(${JSON.stringify(seedSql)});
        const read = (query, ...args) => {
          const cursor = sql.exec(query, ...args);
          const rows = cursor.toArray();
          return { rowsRead: cursor.rowsRead, count: rows.length };
        };
        const before = {
          total: read("SELECT COUNT(*) FROM messages WHERE EXISTS (SELECT 1 FROM json_each(messages.notify) WHERE value = ?)", 'kai').rowsRead,
          list: read("SELECT * FROM messages WHERE seq < ? AND EXISTS (SELECT 1 FROM json_each(messages.notify) WHERE value = ?) ORDER BY seq DESC LIMIT 51", 9999, 'kai').rowsRead,
          unread: read("SELECT COUNT(*) FROM messages WHERE seq > ? AND EXISTS (SELECT 1 FROM json_each(messages.notify) WHERE value = ?)", 1800, 'kai').rowsRead,
        };
        sql.exec('CREATE TABLE message_notifies(name TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(name, seq)) WITHOUT ROWID');
        sql.exec('INSERT OR IGNORE INTO message_notifies(name, seq) SELECT value, messages.seq FROM messages, json_each(messages.notify)');
        sql.exec(${JSON.stringify(triggerSql)});
        const after = {
          total: read('SELECT COUNT(*) FROM message_notifies WHERE name = ?', 'kai').rowsRead,
          list: read('SELECT m.* FROM message_notifies n JOIN messages m ON m.seq = n.seq WHERE n.name = ? AND n.seq < ? ORDER BY n.seq DESC LIMIT 51', 'kai', 9999).rowsRead,
          unread: read('SELECT COUNT(*) FROM message_notifies WHERE name = ? AND seq > ?', 'kai', 1800).rowsRead,
        };
        sql.exec("INSERT INTO messages(seq, notify, text) VALUES (2001, json_array('kai'), 'new')");
        const latest = sql.exec("SELECT m.seq FROM message_notifies n JOIN messages m ON m.seq = n.seq WHERE n.name = 'kai' ORDER BY n.seq DESC LIMIT 1").one().seq;
        return Response.json({ before, after, latest, count: sql.exec("SELECT COUNT(*) AS n FROM message_notifies WHERE name = 'kai'").one().n });
      }
    }
    export default { fetch(req, env) { return env.PROBE.get(env.PROBE.idFromName('room')).fetch(req); } };`
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script,
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
  }))
  try {
    const response = await mf.dispatchFetch('http://localhost/')
    assert.equal(response.status, 200)
    const { before, after, latest, count } = await response.json()
    assert.deepEqual(before, { total: 2000, list: 1001, unread: 200 })
    assert.deepEqual(after, { total: 100, list: 102, unread: 10 })
    assert.equal(latest, 2001, 'a new send enters the @me list through the trigger')
    assert.equal(count, 101, 'old messages were backfilled and the new one was added')
    console.log(`@me rowsRead (total/list/unread): ${before.total}/${before.list}/${before.unread} before, ${after.total}/${after.list}/${after.unread} after`)
  } finally {
    await mf.dispose()
  }
})

test('takeover result and last human timestamp use indexed reads after the first lookup', async () => {
  const seedSql = `CREATE TABLE members(name TEXT PRIMARY KEY, owner TEXT, takeover_checked INTEGER DEFAULT 0, takeover_command TEXT, takeover_seq INTEGER);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY, from_name TEXT, from_kind TEXT, text TEXT, ts INTEGER);
    INSERT INTO members(name, owner) VALUES('impl@kai', 'kai');
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
    INSERT INTO messages SELECT x, 'impl@kai', CASE WHEN x=1 THEN 'human' ELSE 'agent' END,
      CASE WHEN x=1 THEN '/spawn impl' ELSE 'hello' END, x FROM n`
  const script = `import { DurableObject } from 'cloudflare:workers';
    export class Probe extends DurableObject {
      fetch() {
        const sql = this.ctx.storage.sql;
        sql.exec(${JSON.stringify(seedSql)});
        const scan = sql.exec(${JSON.stringify(TAKEOVER_CANDIDATES_SQL)}, 'kai', 'impl', 0); scan.toArray();
        const human = sql.exec("SELECT ts FROM messages WHERE from_kind = 'human' ORDER BY seq DESC LIMIT 1"); human.toArray();
        sql.exec('CREATE INDEX messages_kind_seq_ts ON messages(from_kind, seq, ts)');
        const indexedHuman = sql.exec("SELECT ts FROM messages WHERE from_kind = 'human' ORDER BY seq DESC LIMIT 1"); indexedHuman.toArray();
        sql.exec("UPDATE members SET takeover_checked=1, takeover_command='/spawn impl', takeover_seq=1 WHERE name='impl@kai'");
        const cached = sql.exec("SELECT takeover_checked, takeover_command, takeover_seq FROM members WHERE name='impl@kai'"); cached.toArray();
        return Response.json({ takeoverBefore: scan.rowsRead, takeoverCached: cached.rowsRead,
          lastHumanBefore: human.rowsRead, lastHumanAfter: indexedHuman.rowsRead });
      }
    }
    export default { fetch(req, env) { return env.PROBE.get(env.PROBE.idFromName('room')).fetch(req); } };`
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script,
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } } }))
  try {
    const response = await mf.dispatchFetch('http://localhost/')
    assert.equal(response.status, 200)
    const rows = await response.json()
    assert.deepEqual(rows, { takeoverBefore: 2000, takeoverCached: 1, lastHumanBefore: 2000, lastHumanAfter: 1 })
    console.log(`takeover rowsRead: ${rows.takeoverBefore} before, ${rows.takeoverCached} cached; lastHumanTs: ${rows.lastHumanBefore} before, ${rows.lastHumanAfter} indexed`)
  } finally {
    await mf.dispose()
  }
})

test('my-data cache turns repeated full-room aggregates into one key lookup', async () => {
  const seedSql = `CREATE TABLE messages(seq INTEGER PRIMARY KEY, from_kind TEXT, from_name TEXT, ts INTEGER);
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
    INSERT INTO messages SELECT x, CASE WHEN x%2=0 THEN 'human' ELSE 'agent' END,
      CASE WHEN x%2=0 THEN 'kai' ELSE 'bot@kai' END, 1000000000000+x FROM n;
    CREATE TABLE my_data_cache(account TEXT PRIMARY KEY, since_ms INTEGER, cached_at INTEGER, data_json TEXT)`
  const script = `import { DurableObject } from 'cloudflare:workers';
    export class Probe extends DurableObject {
      fetch() {
        const sql = this.ctx.storage.sql;
        sql.exec(${JSON.stringify(seedSql)});
        const totals = sql.exec(${JSON.stringify(ROOM_TOTALS_SQL)}, 'kai', 'kai'); totals.one();
        const daily = sql.exec(${JSON.stringify(ROOM_DAILY_SQL)}, 0, 'kai', 'kai'); daily.toArray();
        sql.exec("INSERT INTO my_data_cache VALUES('kai', 0, 123, '{}')");
        const cached = sql.exec("SELECT data_json FROM my_data_cache WHERE account='kai'"); cached.one();
        return Response.json({ totals: totals.rowsRead, daily: daily.rowsRead, cached: cached.rowsRead });
      }
    }
    export default { fetch(req, env) { return env.PROBE.get(env.PROBE.idFromName('room')).fetch(req); } };`
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script,
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } } }))
  try {
    const response = await mf.dispatchFetch('http://localhost/')
    assert.equal(response.status, 200)
    const rows = await response.json()
    assert.deepEqual(rows, { totals: 2000, daily: 4000, cached: 1 })
    console.log(`my-data per-room rowsRead: ${rows.totals + rows.daily} uncached, ${rows.cached} cached`)
  } finally {
    await mf.dispose()
  }
})

test('FTS trigram narrows long searches while short Chinese and literal wildcard results stay exact', async () => {
  const seedSql = `CREATE TABLE messages(seq INTEGER PRIMARY KEY, from_name TEXT, ts INTEGER, text TEXT);
    CREATE TABLE members(name TEXT PRIMARY KEY, display_name TEXT);
    INSERT INTO members VALUES('kai', 'Kai');
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
    INSERT INTO messages SELECT x, 'kai', x, CASE WHEN x=1 THEN '珍珠奶茶'
      WHEN x=1000 THEN 'agent collaboration' WHEN x=1500 THEN 'literal%abc'
      WHEN x=1501 THEN 'literalXabc' ELSE 'ordinary message' END FROM n`
  const triggerSql = `CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (NEW.seq, NEW.text);
  END`
  const exact = likeTerms('m.text', ['collab'])
  const wildcard = likeTerms('m.text', ['literal%abc'])
  const select = 'SELECT m.seq FROM messages m LEFT JOIN members h ON h.name = m.from_name WHERE '
  const order = ' ORDER BY m.ts DESC, m.seq DESC LIMIT 21'
  const oldSql = select + exact.sql + order
  const indexedSql = select + exact.sql + ' AND m.seq IN (SELECT rowid FROM messages_fts WHERE text LIKE ?)' + order
  const wildcardSql = select + wildcard.sql + ' AND m.seq IN (SELECT rowid FROM messages_fts WHERE text LIKE ?)' + order
  const script = `import { DurableObject } from 'cloudflare:workers';
    export class Probe extends DurableObject {
      fetch() {
        const sql = this.ctx.storage.sql;
        sql.exec(${JSON.stringify(seedSql)});
        const read = (query, ...args) => {
          const cursor = sql.exec(query, ...args);
          return { hits: cursor.toArray().map((row) => row.seq), rowsRead: cursor.rowsRead };
        };
        const before = read(${JSON.stringify(oldSql)}, ...${JSON.stringify(exact.args)});
        const shortChinese = read("SELECT seq FROM messages WHERE text LIKE '%珍%' ORDER BY seq DESC LIMIT 21");
        sql.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='seq', tokenize='trigram')");
        sql.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
        sql.exec(${JSON.stringify(triggerSql)});
        const after = read(${JSON.stringify(indexedSql)}, ...${JSON.stringify(exact.args)}, '%collab%');
        const literalWildcard = read(${JSON.stringify(wildcardSql)}, ...${JSON.stringify(wildcard.args)}, '%literal%abc%');
        sql.exec("INSERT INTO messages VALUES (2001, 'kai', 2001, 'new collaboration')");
        const afterInsert = read(${JSON.stringify(indexedSql)}, ...${JSON.stringify(exact.args)}, '%collab%');
        return Response.json({ before, after, shortChinese, literalWildcard, afterInsert });
      }
    }
    export default { fetch(req, env) { return env.PROBE.get(env.PROBE.idFromName('room')).fetch(req); } };`
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script,
    durableObjects: { PROBE: { className: 'Probe', useSQLite: true } } }))
  try {
    const response = await mf.dispatchFetch('http://localhost/')
    assert.equal(response.status, 200)
    const { before, after, shortChinese, literalWildcard, afterInsert } = await response.json()
    assert.deepEqual(before.hits, [1000])
    assert.deepEqual(after.hits, before.hits)
    assert.deepEqual(shortChinese.hits, [1])
    assert.deepEqual(literalWildcard.hits, [1500], 'the exact LIKE filters the broader FTS wildcard candidate')
    assert.deepEqual(afterInsert.hits, [2001, 1000], 'new messages enter FTS through the trigger')
    assert.ok(after.rowsRead < before.rowsRead / 10)
    console.log(`message search rowsRead: ${before.rowsRead} full LIKE, ${after.rowsRead} indexed long term; one-Han fallback ${shortChinese.rowsRead}`)
  } finally {
    await mf.dispose()
  }
})
