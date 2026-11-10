import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

// The read paths of messages (split by domain, S8a): history, around, message, mentions, listen and pending, my data,
// activitySince, countSince and lastCountedAt, recorded once on the code from before messages left RoomDO. Moving
// messages out (S8a) changes neither this file nor its golden; RECORD_READ_GOLDEN=1 is only for that first recording.
const golden = new URL('./messages-read.golden.json', import.meta.url)

const built = await build({
  entryPoints: [new URL('../src/room-do.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  external: ['cloudflare:workers'],
})
// countSince, lastCountedAt and pending are private: the probe calls them under names of its own, so it overrides none.
// Message times are set after the sends, so the reads that count by time answer the same on any day.
const script = `${built.outputFiles[0].text}
export class Probe extends RoomDO {
  setScheduled(seq, by) {
    this.sql.exec('UPDATE messages SET scheduled = ? WHERE seq = ?', JSON.stringify({ id: 's1', by, at: 1 }), seq);
    return true;
  }
  setFiles(seq, files) {
    this.sql.exec('UPDATE messages SET files = ? WHERE seq = ?', JSON.stringify(files), seq);
    return true;
  }
  setTimes(base, step) {
    this.sql.exec('UPDATE messages SET ts = ? + seq * ?', base, step);
    return true;
  }
  probeCountSince(ts, afterSeq) { return afterSeq == null ? this.countSince(ts) : this.countSince(ts, afterSeq); }
  probeLastCountedAt(r) { return this.lastCountedAt(r); }
  probePending(name, cursor) { return this.pending(name, cursor); }
}
export default { async fetch(req, env) {
  const { name, method, args = [] } = await req.json();
  return Response.json(await env.ROOMS.getByName(name)[method](...args));
} };`

const kai = { kind: 'human', account: 'kai', name: 'kai' }
const lee = { kind: 'human', account: 'lee', name: 'lee' }
const guest = { kind: 'human', account: 'guest', name: 'guest' }
const api = { kind: 'agent', account: 'kai', name: 'api@kai' }
const helper = { kind: 'agent', account: 'lee', name: 'helper@lee' }
const stranger = { kind: 'agent', account: 'zed', name: 'bot@zed' }
const BASE = Date.UTC(2026, 8, 30, 8) // seq n is written at BASE + n * STEP: 119 messages run past midnight UTC
const STEP = 10 * 60_000
const at = (seq) => BASE + seq * STEP

// Times the reads take from now (members, items): the message times are fixed above.
const timeKeys = new Set(['lastActive', 'roleCardAt', 'workSince', 'createdMs', 'updatedMs', 'doneMs', 'openedMs', 'ms'])
const norm = (value) => {
  if (Array.isArray(value)) return value.map(norm)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, timeKeys.has(k) && typeof v === 'number' ? 0 : norm(v)]))
  }
  return value
}

// One line per message (and per small object) in the golden file, so a diff points at the message.
function pretty(v, depth = 0) {
  const flat = (x) => x === null || typeof x !== 'object' || (!Array.isArray(x) && (typeof x.seq === 'number' && 'from' in x || Object.values(x).every((y) => y === null || typeof y !== 'object')))
  if (flat(v) || (Array.isArray(v) && !v.length)) return JSON.stringify(v)
  const pad = '  '.repeat(depth + 1)
  const end = '  '.repeat(depth)
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + pretty(x, depth + 1)).join(',\n')}\n${end}]`
  return `{\n${Object.entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${pretty(x, depth + 1)}`).join(',\n')}\n${end}}`
}

test('the message read paths answer as recorded', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script,
    compatibilityDate: '2026-10-03', compatibilityFlags: ['nodejs_compat'],
    bindings: { PUBLIC_URL: 'https://scorpio.test', TEST_LIMITS: JSON.stringify({ self: { msgsPerRoomMinute: 1000 } }) },
    durableObjects: { ROOMS: { className: 'Probe', useSQLite: true } },
    d1Databases: { DB: 'db' }, kvNamespaces: ['KV'], r2Buckets: ['FILES'],
  }))
  async function on(name, method, ...args) {
    const response = await mf.dispatchFetch('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, method, args }),
    })
    const body = await response.text()
    assert.equal(response.status, 200, `${method}: ${body}`)
    return JSON.parse(body)
  }
  const call = (method, ...args) => on('reads', method, ...args)
  const send = async (actor, p) => {
    const r = await call('send', actor, p)
    assert.ok(r.ok, `send: ${JSON.stringify(r)}`)
    return r.ok.seq
  }
  try {
    // A public topic (no passcode): kai owns it, lee is in it, guest reads it without joining. Each line is a
    // system line (seq 1 to 3).
    await call('init', { id: 'reads', name: 'Reads', topic: 'The read paths', owner: 'kai', code: null })
    await call('enterHuman', lee, undefined, 'Lee')
    await call('join', api, { role: 'api' })
    await call('join', helper, { role: 'helper' })

    // People, agents, a reply, a task and its T number, files, a scheduled message, a command, @ in code (seq 4 to 14).
    await send(kai, { text: 'Morning, everyone.' })
    const ask = await send(api, { text: '@lee Please review the draft.', add: 'Review the draft', to: 'lee' })
    await send(lee, { text: '@api@kai Reviewed, two notes on page 3.', replyTo: ask })
    await send(helper, { text: '@kai @lee The logs are clean.' })
    await send(kai, { text: '@api@kai @helper@lee Please check T1 before noon.' })
    const report = await send(api, { text: '@kai Here is the report.' })
    await call('setFiles', report, [
      { id: 'f-report', name: 'report.pdf', type: 'application/pdf', size: 2048, url: '/f/reads/f-report' },
      { id: 'f-old', name: 'old.png', type: 'image/png', size: 512, url: '/f/reads/f-old', deleted: at(9) },
    ])
    const reminder = await send(api, { text: '@lee Reminder: standup at ten.' })
    await call('setScheduled', reminder, 'kai')
    await send(kai, { text: '@api@kai /spawn claude worker ~/work check the logs' })
    await send(lee, { text: 'Thanks, all.' })
    await send(helper, { text: '@lee see `@kai` in the log; @lee in prose.' })
    await send(lee, { text: '@api@kai What about T1?' })
    // Filler past one page (seq 15 to 114): lee's and kai's broadcasts in turn; kai's wake api@kai.
    for (let i = 15; i <= 114; i++) await send(i % 2 ? kai : lee, { text: `note ${i}` })
    // The newest page: kai asks its agent, a reply, @ in code, and lee's late reply to the task's source (seq 115 to 119).
    await send(kai, { text: '@api@kai Please write the summary.' })
    const summary = await send(api, { text: '@kai @lee Summary: T1 is open.' })
    await send(lee, { text: '@api@kai Agreed.', replyTo: summary })
    await send(kai, { text: '@lee see `@api@kai` in code, @lee in prose.' })
    const last = await send(lee, { text: '@kai One more question.', replyTo: ask })
    await call('setTimes', BASE, STEP)
    // Cursors: api@kai in the middle, lee before its last mentions, kai at the top.
    assert.ok((await call('mark', api, 60)).ok)
    assert.ok((await call('mark', lee, 100)).ok)
    assert.ok((await call('mark', kai, last)).ok)

    const records = []
    const record = (step, result, normalise = true) => records.push({ step, result: normalise ? norm(result) : result })

    // messages: the newest page, a page from a seq, and the agent's view.
    record('messages kai default', await call('messages', kai, {}))
    record('messages api from 1 limit 20', await call('messages', api, { from: 1, limit: 20 }))
    record('messages stranger', await call('messages', stranger, {}))

    // history: the default page, then before= from its first message back to the start.
    const first = await call('history', kai, last + 1)
    record('history kai default', first)
    record('history kai before page start', await call('history', kai, first.ok.messages[0].seq))
    for (const [label, viewer] of [['api', api], ['lee', lee], ['guest', guest]]) {
      record(`history ${label} before 19`, await call('history', viewer, 19))
    }
    record('history api latest limit 10', await call('history', api, last + 1, 10))
    record('history stranger', await call('history', stranger, last + 1))

    // around: the middle of the topic, near its start, a missing seq.
    record('around kai 60', await call('around', kai, 60))
    record('around lee 5', await call('around', lee, 5))
    record('around api 117', await call('around', api, 117))
    record('around kai missing', await call('around', kai, 999))

    // message: one of each kind, as each viewer reads it; a missing one.
    for (const seq of [1, 4, 5, 6, 9, 10, 11, 13, 115, 117, 118, last]) {
      for (const [label, viewer] of [['kai', kai], ['api', api], ['lee', lee], ['guest', guest]]) {
        record(`message ${seq} ${label}`, await call('message', viewer, seq))
      }
    }
    record('message missing', await call('message', kai, 999))
    record('message stranger', await call('message', stranger, 4))

    // mentions: the default list, then before= in pages of two.
    record('mentions kai default', await call('mentions', kai, 0))
    record('mentions lee default', await call('mentions', lee, 0))
    let page = await call('mentions', lee, 0, 2)
    record('mentions lee limit 2', page)
    while (page.ok.hasMore) {
      const before = page.ok.mentions.at(-1).seq
      page = await call('mentions', lee, before, 2)
      record(`mentions lee before ${before} limit 2`, page)
    }
    record('mentions guest', await call('mentions', guest, 0))

    // listen and pending: api@kai with its cursor at 60; helper@lee's own pending.
    record('listen api', await call('listen', api))
    record('listen stranger', await call('listen', stranger))
    record('pending api 60', await call('probePending', 'api@kai', 60))
    record('pending helper 100', await call('probePending', 'helper@lee', 100))
    record('pending kai 0', await call('probePending', 'kai', 0))

    // myData: from the start, the cache hit for the same since, a later since; lee; refusals.
    record('myData kai since base', await call('myData', kai, BASE), false)
    record('myData kai since base cached', await call('myData', kai, BASE), false)
    record('myData kai since next day', await call('myData', kai, Date.UTC(2026, 9, 1)), false)
    record('myData lee since base', await call('myData', lee, BASE), false)
    record('myData api', await call('myData', api, BASE), false)
    record('myData guest', await call('myData', guest, BASE), false)

    // activitySince: everything, then from the next day.
    record('activitySince base', await call('activitySince', BASE), false)
    record('activitySince next day', await call('activitySince', Date.UTC(2026, 9, 1)), false)

    // countSince and lastCountedAt, here and in a topic with no messages.
    for (const [ts, afterSeq] of [[0, undefined], [at(3), undefined], [at(3) + 1, undefined], [at(60), undefined], [at(60), 100], [at(last), undefined], [at(last) + 1, undefined], [at(200), 0]]) {
      record(`countSince ${ts} ${afterSeq ?? '-'}`, await call('probeCountSince', ts, afterSeq), false)
    }
    record('lastCountedAt', await call('probeLastCountedAt', { created_at: 1 }), false)
    record('countSince empty', await on('empty', 'probeCountSince', 0), false)
    record('lastCountedAt empty', await on('empty', 'probeLastCountedAt', { created_at: 7 }), false)

    if (process.env.RECORD_READ_GOLDEN === '1') writeFileSync(golden, `${pretty(records)}\n`)
    assert.deepEqual(records, JSON.parse(readFileSync(golden, 'utf8')))
  } finally {
    await mf.dispose()
  }
})
