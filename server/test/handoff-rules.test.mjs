import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import {
  HANDOFF_ACCOUNT_MAX, HANDOFF_MAX, HANDOFF_META_VIEW_SQL, HANDOFF_SUM_SQL, computerOf, deleteRefusal, handoffMetaOf, handoffText,
  isSeatName, readCapped, spaceRefusal, writerRefusal,
} from '../src/handoff.ts'

async function load(entry) {
  const out = await build({ entryPoints: [new URL(`../src/${entry}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent', plugins: [{ name: 'workers', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}', loader: 'js' }))
  } }] })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

const { MEMBERS_WITH_HANDOFF_SQL } = await load('room/members.ts')

// Handoffs in the cloud (docs/api/files.md): the rules handoff.ts decides, and the SQL that feeds them run on node:sqlite.

/** A body in chunks, counting how many the reader pulled. */
function stream(chunks) {
  let pulled = 0
  const s = new ReadableStream({
    pull(c) {
      if (pulled >= chunks.length) return c.close()
      c.enqueue(chunks[pulled++])
    },
  }, { highWaterMark: 0 }) // pulled only when read
  return { s, pulled: () => pulled }
}
const bytes = (n, fill = 0x61) => new Uint8Array(n).fill(fill)

test('256 KB exactly is read whole; one byte more stops the read there, with or without a Content-Length', async () => {
  const exact = await readCapped(stream([bytes(200_000), bytes(HANDOFF_MAX - 200_000)]).s, null)
  assert.ok(exact instanceof Uint8Array)
  assert.equal(exact.byteLength, HANDOFF_MAX)

  const over = stream([bytes(200_000), bytes(HANDOFF_MAX - 200_000 + 1), bytes(10), bytes(10)])
  const r = await readCapped(over.s, null)
  assert.equal(r.code, 'handoff_too_large')
  assert.equal(r.status, 413)
  assert.equal(over.pulled(), 2, 'nothing read past the chunk that crossed the limit')

  // A declared length over the limit is refused before the first read.
  const declared = stream([bytes(10)])
  assert.equal((await readCapped(declared.s, String(HANDOFF_MAX + 1))).code, 'handoff_too_large')
  assert.equal(declared.pulled(), 0)
  assert.ok((await readCapped(stream([bytes(10)]).s, String(HANDOFF_MAX))) instanceof Uint8Array)
})

test('a multi-byte character across the cut counts by its bytes', async () => {
  const zh = new TextEncoder().encode('中') // 3 bytes
  const fits = await readCapped(stream([bytes(HANDOFF_MAX - 3), zh]).s, null)
  assert.equal(fits.byteLength, HANDOFF_MAX)
  assert.equal(handoffText(fits).text.slice(-1), '中')
  assert.equal((await readCapped(stream([bytes(HANDOFF_MAX - 2), zh]).s, null)).code, 'handoff_too_large')
})

test('text: valid UTF-8, tab and line breaks only among control characters; empty is bad_request', () => {
  const enc = (s) => new TextEncoder().encode(s)
  assert.deepEqual(handoffText(enc('# arch\n\n- done\tT5\r\n')), { text: '# arch\n\n- done\tT5\r\n' })
  assert.equal(handoffText(enc('')).code, 'bad_request')
  assert.equal(handoffText(enc(' \n\t \r\n')).code, 'bad_request')
  assert.equal(handoffText(new Uint8Array([0x61, 0xff, 0x62])).code, 'handoff_not_text')
  assert.equal(handoffText(new Uint8Array([0xe4, 0xb8])).code, 'handoff_not_text', 'a cut multi-byte character')
  assert.equal(handoffText(enc('a\u0000b')).code, 'handoff_not_text')
  assert.equal(handoffText(enc('a\u001bb')).code, 'handoff_not_text')
  assert.equal(handoffText(enc('a\u007fb')).code, 'handoff_not_text')
  assert.equal(handoffText(enc('a\u0085b')).code, 'handoff_not_text')
  assert.equal(handoffText(enc('a\u000bb')).status, 415)
  assert.equal(handoffText(enc('﻿中文 😀')).text, '﻿中文 😀', 'a BOM and emoji are text, kept as written')
})

test('X-Scorpio-Computer: kept when well formed, else dropped (null), never refused', () => {
  assert.equal(computerOf('my-box'), 'my-box')
  assert.equal(computerOf('a_b-9'), 'a_b-9')
  for (const bad of [null, '', 'My-Box', 'x y', 'a'.repeat(65), 'é']) assert.equal(computerOf(bad), null, String(bad))
})

test('who writes: an active agent; a left or unknown name is not in the topic; a daemon seat or a person is not an agent', () => {
  assert.equal(writerRefusal({ kind: 'agent', status: 'active' }, 'arch@kai', 'R'), null)
  assert.equal(writerRefusal(undefined, 'arch@kai', 'R').code, 'not_member')
  assert.equal(writerRefusal({ kind: 'agent', status: 'left' }, 'arch@kai', 'R').code, 'not_member')
  assert.equal(writerRefusal({ kind: 'host', status: 'active' }, 'daemon@kai', 'R').code, 'forbidden')
  assert.equal(writerRefusal({ kind: 'human', status: 'active' }, 'kai', 'R').code, 'forbidden')
})

test('who deletes: the seat\'s own account only; an unknown seat is seat_not_found', () => {
  assert.equal(deleteRefusal({ owner: 'kai' }, 'arch@kai', 'kai'), null)
  assert.equal(deleteRefusal({ owner: 'kai' }, 'arch@kai', 'zoe').code, 'forbidden')
  assert.equal(deleteRefusal(undefined, 'arch@kai', 'kai').code, 'seat_not_found')
  assert.equal(deleteRefusal(undefined, 'arch@kai', 'kai').next, 'arch@kai is not a member of this topic.')
})

test('seat names and the space rule', () => {
  assert.ok(isSeatName('arch@kai'))
  assert.ok(isSeatName('impl.2@qa-kai'))
  for (const bad of ['', 'arch', 'kai', '@kai', 'arch@', 'a b@kai', 'arch@kai@x']) assert.equal(isSeatName(bad), false, bad)
  assert.equal(spaceRefusal(HANDOFF_ACCOUNT_MAX - 10, 10), null)
  const full = spaceRefusal(HANDOFF_ACCOUNT_MAX - 10, 11)
  assert.equal(full.code, 'handoff_space_full')
  assert.match(full.next, /2\.5 MB/)
})

test('the SQL: an account\'s sum leaves out the writer\'s own row, other accounts and orphans; members carry no text', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE members (name TEXT PRIMARY KEY, kind TEXT, owner TEXT, joined_at INTEGER);
    CREATE TABLE handoffs (name TEXT PRIMARY KEY, body TEXT NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL, computer TEXT);`)
  db.exec(HANDOFF_META_VIEW_SQL)
  // The account's names as members.ofAccount reads them, then handoffs' own sum over them (Handoffs.put).
  const accountSum = (account, writer) => {
    const names = db.prepare('SELECT name FROM members WHERE owner = ?').all(account).map((m) => m.name)
    return db.prepare(HANDOFF_SUM_SQL).get(JSON.stringify(names), writer).total
  }
  const member = db.prepare('INSERT INTO members VALUES (?, ?, ?, ?)')
  const handoff = db.prepare('INSERT INTO handoffs VALUES (?, ?, ?, ?, ?)')
  member.run('kai', 'human', 'kai', 1)
  member.run('arch@kai', 'agent', 'kai', 2)
  member.run('impl@kai', 'agent', 'kai', 3)
  member.run('web@zoe', 'agent', 'zoe', 4)
  handoff.run('arch@kai', 'a', 100, 10, null)
  handoff.run('impl@kai', 'i', 200, 11, 'box')
  handoff.run('web@zoe', 'w', 400, 12, null)
  handoff.run('gone@kai', 'orphan', 800, 13, null) // no member row: never counted, never read
  assert.equal(accountSum('kai', 'arch@kai'), 200)
  assert.equal(accountSum('kai', 'new@kai'), 300)
  assert.equal(accountSum('ann', 'x@ann'), 0)
  const rows = db.prepare(MEMBERS_WITH_HANDOFF_SQL).all()
  assert.deepEqual(rows.map((r) => r.name), ['kai', 'arch@kai', 'impl@kai', 'web@zoe'])
  assert.equal(handoffMetaOf(rows[0]), null)
  assert.deepEqual(handoffMetaOf(rows[2]), { size: 200, updatedAt: 11, computer: 'box' })
  assert.ok(rows.every((r) => !('body' in r)), 'no handoff text beside a member')
})
