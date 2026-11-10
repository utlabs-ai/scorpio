// The CalDAV account over HTTP: sign-in, discovery, reads, the refused writes, the 5-minute copy, and the settings answer that hands out the three items.
import assert from 'node:assert/strict'
import test from 'node:test'
import { worker } from './helpers/worker.mjs'

const basic = (user, password) => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` })
const DAV = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"'
const propfind = (props) => `<?xml version="1.0"?><d:propfind ${DAV}><d:prop>${props}</d:prop></d:propfind>`
const responses = (xml) => [...xml.matchAll(/<d:response><d:href>([^<]*)<\/d:href>([\s\S]*?)<\/d:response>/g)].map((m) => ({ href: m[1], body: m[2] }))
const propstat = (body, status) => new RegExp(`<d:propstat><d:prop>((?:(?!</d:prop>)[\\s\\S])*)</d:prop><d:status>HTTP/1.1 ${status}</d:status>`).exec(body)?.[1] ?? ''
const okProps = (body) => propstat(body, '200 OK')
const missingProps = (body) => propstat(body, '404 Not Found')
const etags = (xml) => Object.fromEntries(responses(xml).map((r) => [r.href, /<d:getetag>([^<]*)<\/d:getetag>/.exec(r.body)?.[1]]))
const unfold = (text) => text.replace(/\r\n /g, '')
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

async function setUp(w) {
  const kai = await w.person('kai'), ana = await w.person('ana')
  const settings = await w.json(await kai.post('/settings/calendar'))
  assert.equal(settings.status, 200, JSON.stringify(settings))
  const token = /\/cal\/([A-Za-z0-9_-]{32})\.ics$/.exec(settings.url)[1]
  const own = await w.topic(kai), second = await w.topic(kai)
  await w.join(kai, own, 'coach'); await w.join(kai, second, 'coach')
  const now = Math.ceil(Date.now() / 1000) * 1000 // whole seconds: time-range stamps have none
  const at = now + 3_600_000, at2 = now + 2 * 86_400_000
  const add = async (room, text, rule) => w.json(await kai.apiPost(`/rooms/${room}/schedules`, { op: 'add', text, rule, calendar: true }, 'coach'))
  const standup = await add(own, '@kai Stand-up, bring numbers', { kind: 'once', at })
  assert.equal(standup.status, 200, JSON.stringify(standup))
  const review = await add(second, '@kai Review', { kind: 'once', at: at2 })
  assert.equal(review.status, 200, JSON.stringify(review))
  const dav = (path, init = {}) => w.fetch(path, { ...init, headers: { ...basic('kai', token), ...(init.headers || {}) } })
  return { kai, ana, settings, token, own, second, at, at2, standup, review, dav }
}

test('the settings answer carries the address and the three CalDAV items; a reset changes the address and the password together', async () => {
  const w = await worker()
  try {
    const { kai, settings, token } = await setUp(w)
    assert.deepEqual(settings.caldav, { server: 'https://scorpio.test/dav/', account: 'kai', password: token }, 'the server item is the account itself, so a calendar that asks there directly finds it')
    assert.equal(settings.url, `https://scorpio.test/cal/${token}.ics`)
    const again = await w.json(await kai.post('/settings/calendar'))
    assert.deepEqual(again.caldav, settings.caldav)
    const reset = await w.json(await kai.post('/settings/calendar/reset'))
    assert.notEqual(reset.caldav.password, token)
    assert.equal(reset.url, `https://scorpio.test/cal/${reset.caldav.password}.ics`)
    assert.deepEqual({ server: reset.caldav.server, account: reset.caldav.account }, { server: 'https://scorpio.test/dav/', account: 'kai' })
  } finally { await w.dispose() }
})

test('sign-in: Basic with the handle and the token on every request but OPTIONS; the wrong password, another account, or none is 401 with a challenge; a reset turns the old password off', async () => {
  const w = await worker()
  try {
    const { kai, ana, token, dav } = await setUp(w)
    const anaToken = (await w.json(await ana.post('/settings/calendar'))).caldav.password
    for (const [name, headers] of [['no header', {}], ['wrong password', basic('kai', 'x'.repeat(32))], ["ana's token", basic('kai', anaToken)], ["kai's token as ana", basic('ana', token)], ['not Basic', { authorization: `Bearer ${token}` }]]) {
      const res = await w.fetch('/dav/', { method: 'PROPFIND', headers: { depth: '0', ...headers } })
      assert.equal(res.status, 401, name)
      assert.equal(res.headers.get('www-authenticate'), 'Basic realm="Scorpio", charset="UTF-8"', name)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.match(res.headers.get('content-type'), /^text\/plain/)
    }
    assert.equal((await dav('/dav/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 207)
    assert.equal((await w.fetch('/dav/', { method: 'PROPFIND', headers: { depth: '0', ...basic('KAI', token) } })).status, 207, 'the handle is compared without case')
    const options = await w.fetch('/dav/kai/scorpio/', { method: 'OPTIONS' })
    assert.equal(options.status, 200)
    assert.equal(options.headers.get('dav'), '1, calendar-access')
    assert.equal(options.headers.get('allow'), 'OPTIONS, GET, HEAD, PROPFIND, REPORT')
    const reset = await w.json(await kai.post('/settings/calendar/reset'))
    assert.equal((await dav('/dav/', { method: 'PROPFIND', headers: { depth: '0' } })).status, 401)
    assert.equal((await w.fetch('/dav/', { method: 'PROPFIND', headers: { depth: '0', ...basic('kai', reset.caldav.password) } })).status, 207)
  } finally { await w.dispose() }
})

test('discovery: well-known → /dav/ → principal → home → the one calendar, Scorpio, with VEVENT, a ctag, the reports and read-only privileges; unknown properties come back 404', async () => {
  const w = await worker()
  try {
    const { dav } = await setUp(w)
    for (const method of ['GET', 'PROPFIND', 'OPTIONS']) {
      const wk = await w.fetch('/.well-known/caldav', { method })
      assert.equal(wk.status, 301, method)
      assert.equal(wk.headers.get('location'), '/dav/')
    }
    const root = await dav('/dav/', { method: 'PROPFIND', headers: { depth: '0', 'content-type': 'application/xml' }, body: propfind('<d:current-user-principal/><d:resourcetype/><d:displayname/>') })
    assert.equal(root.status, 207)
    assert.match(root.headers.get('content-type'), /^application\/xml/)
    const rootXml = await root.text()
    assert.ok(rootXml.startsWith('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"'))
    const [rootRes] = responses(rootXml)
    assert.equal(rootRes.href, '/dav/')
    assert.equal(okProps(rootRes.body), '<d:current-user-principal><d:href>/dav/kai/</d:href></d:current-user-principal><d:resourcetype><d:collection/></d:resourcetype>', 'in the order asked')
    assert.equal(missingProps(rootRes.body), '<d:displayname/>')

    const principal = await dav('/dav/kai/', { method: 'PROPFIND', headers: { depth: '0' }, body: propfind('<d:resourcetype/><d:displayname/><d:principal-URL/><c:calendar-home-set/><d:current-user-privilege-set/><x:colour xmlns:x="urn:x"/>') })
    const [pr] = responses(await principal.text())
    assert.equal(pr.href, '/dav/kai/')
    assert.equal(okProps(pr.body), '<d:resourcetype><d:collection/><d:principal/></d:resourcetype><d:displayname>kai</d:displayname><d:principal-URL><d:href>/dav/kai/</d:href></d:principal-URL><c:calendar-home-set><d:href>/dav/kai/</d:href></c:calendar-home-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege></d:current-user-privilege-set>')
    assert.equal(missingProps(pr.body), '<x:colour xmlns:x="urn:x"/>')

    // the home at Depth 1 (no body = every property): the principal and its calendar
    const home = await dav('/dav/kai/', { method: 'PROPFIND', headers: { depth: '1' } })
    const homeRes = responses(await home.text())
    assert.deepEqual(homeRes.map((r) => r.href), ['/dav/kai/', '/dav/kai/scorpio/'])
    const cal = okProps(homeRes[1].body)
    assert.ok(cal.includes('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'))
    assert.ok(cal.includes('<d:displayname>Scorpio</d:displayname>'))
    assert.ok(cal.includes('<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'))
    assert.match(cal, /<cs:getctag>&quot;[0-9a-f]{32}&quot;<\/cs:getctag>/)
    assert.equal(/<cs:getctag>([^<]*)<\/cs:getctag>/.exec(cal)[1], /<d:getetag>([^<]*)<\/d:getetag>/.exec(cal)[1])
    assert.ok(cal.includes('<d:supported-report-set><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set>'))
    assert.ok(cal.includes('<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege></d:current-user-privilege-set>'))
    assert.ok(!cal.includes('sync-token'), 'no sync-token: clients fall back to the ctag')
    assert.ok(!homeRes[1].body.includes('404'))

    // asked for sync-token: 404 for it, like any property we do not have
    const sync = await dav('/dav/kai/scorpio/', { method: 'PROPFIND', headers: { depth: '0' }, body: propfind('<d:sync-token/><cs:getctag/>') })
    const [sr] = responses(await sync.text())
    assert.equal(missingProps(sr.body), '<d:sync-token/>')
    assert.match(okProps(sr.body), /^<cs:getctag>/)

    for (const wrong of ['/dav/ana/', '/dav/kai/other/', '/dav/kai/scorpio/nope.ics', '/dav/kai/scorpio/room1234567890abcdefgh-S9-1.ics']) assert.equal((await dav(wrong, { method: 'PROPFIND', headers: { depth: '0' } })).status, 404, wrong)
    assert.equal((await dav('/dav/', { method: 'PROPFIND', headers: { depth: '0' }, body: '<not xml' })).status, 400)
    assert.equal((await dav('/dav/', { method: 'PROPFIND', headers: { depth: '0' }, body: propfind('<d:resourcetype/>').padEnd(70_000, ' ') })).status, 413)
  } finally { await w.dispose() }
})

test('reads: the calendar at Depth 1 lists one resource per run across the topics with ETags; GET one is exactly one VEVENT with the feed UID; multiget and a time-range query', async () => {
  const w = await worker()
  try {
    const { own, second, at, at2, standup, review, dav, token } = await setUp(w)
    const list = await dav('/dav/kai/scorpio/', { method: 'PROPFIND', headers: { depth: '1' }, body: propfind('<d:getetag/><d:getcontenttype/><d:resourcetype/>') })
    assert.equal(list.status, 207)
    const listed = responses(await list.text())
    const names = [`${own}-${standup.item.id}-${at}`, `${second}-${review.item.id}-${at2}`]
    assert.deepEqual(listed.map((r) => r.href).sort(), ['/dav/kai/scorpio/', ...names.map((n) => `/dav/kai/scorpio/${n}.ics`)].sort())
    const eventRes = listed.find((r) => r.href.endsWith(`${names[0]}.ics`))
    assert.match(okProps(eventRes.body), /^<d:getetag>&quot;[0-9a-f]{32}&quot;<\/d:getetag><d:getcontenttype>text\/calendar; charset=utf-8; component=VEVENT<\/d:getcontenttype><d:resourcetype\/>$/)
    const etag = unescape(/<d:getetag>([^<]*)<\/d:getetag>/.exec(eventRes.body)[1])

    const one = await dav(`/dav/kai/scorpio/${names[0]}.ics`)
    assert.equal(one.status, 200)
    assert.equal(one.headers.get('content-type'), 'text/calendar; charset=utf-8')
    assert.equal(one.headers.get('etag'), etag)
    const text = await one.text()
    assert.equal(text.split('BEGIN:VEVENT').length, 2)
    assert.ok(unfold(text).includes(`\r\nUID:${names[0]}@scorpio.test\r\n`))
    assert.ok(unfold(text).includes('\r\nSUMMARY:Stand-up\\, bring numbers\r\n'))
    assert.ok(!text.includes('METHOD:PUBLISH'))
    const head = await dav(`/dav/kai/scorpio/${names[0]}.ics`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('etag'), etag)
    assert.equal(await head.text(), '')
    // the same run in the feed: the same UID
    const feed = await (await w.fetch(`/cal/${token}.ics`)).text()
    assert.ok(unfold(feed).includes(`\r\nUID:${names[0]}@scorpio.test\r\n`))
    // GET on the calendar is the feed
    assert.equal(await (await dav('/dav/kai/scorpio/')).text(), feed)

    const multiget = await dav('/dav/kai/scorpio/', { method: 'REPORT', headers: { depth: '1' }, body: `<?xml version="1.0"?><c:calendar-multiget ${DAV}><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>/dav/kai/scorpio/${names[1]}.ics</d:href><d:href>/dav/kai/scorpio/gone-S1-1.ics</d:href><d:href>https://scorpio.test/dav/kai/scorpio/${names[0]}.ics</d:href></c:calendar-multiget>` })
    assert.equal(multiget.status, 207)
    const mg = responses(await multiget.text())
    assert.deepEqual(mg.map((r) => r.href), [`/dav/kai/scorpio/${names[1]}.ics`, '/dav/kai/scorpio/gone-S1-1.ics', `/dav/kai/scorpio/${names[0]}.ics`], 'a found event answers under its path, an absolute href included; an unknown one echoes the href asked')
    assert.equal(mg[1].body, '<d:status>HTTP/1.1 404 Not Found</d:status>')
    assert.match(mg[0].body, /<d:getetag>&quot;[0-9a-f]{32}&quot;<\/d:getetag><c:calendar-data>BEGIN:VCALENDAR&#13;|<d:getetag>&quot;[0-9a-f]{32}&quot;<\/d:getetag><c:calendar-data>BEGIN:VCALENDAR\r\n/)
    const data = unescape(/<c:calendar-data>([\s\S]*?)<\/c:calendar-data>/.exec(mg[2].body)[1])
    assert.equal(data, text)
    assert.ok(!mg[0].body.includes('404 Not Found'), 'a found event has no not-found status')

    const query = (filter) => dav('/dav/kai/scorpio/', { method: 'REPORT', body: `<?xml version="1.0"?><c:calendar-query ${DAV}><d:prop><d:getetag/></d:prop><c:filter>${filter}</c:filter></c:calendar-query>` })
    const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const all = await query('<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter>')
    assert.equal(all.status, 207)
    assert.deepEqual(responses(await all.text()).map((r) => r.href).sort(), names.map((n) => `/dav/kai/scorpio/${n}.ics`).sort())
    const soon = await query(`<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(at - 60_000)}" end="${stamp(at + 60_000)}"/></c:comp-filter></c:comp-filter>`)
    assert.deepEqual(responses(await soon.text()).map((r) => r.href), [`/dav/kai/scorpio/${names[0]}.ics`])
    const overlapping = await query(`<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(at + 10 * 60_000)}"/></c:comp-filter></c:comp-filter>`) // 10 minutes in: still running, and the later one
    assert.deepEqual(responses(await overlapping.text()).map((r) => r.href).sort(), names.map((n) => `/dav/kai/scorpio/${n}.ics`).sort())
    const none = await query(`<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(at + 15 * 60_000)}" end="${stamp(at2 - 1000)}"/></c:comp-filter></c:comp-filter>`)
    assert.deepEqual(responses(await none.text()), [])
    const bare = await dav('/dav/kai/scorpio/', { method: 'REPORT', body: `<c:calendar-query ${DAV}><d:prop><d:getetag/></d:prop></c:calendar-query>` })
    assert.equal(responses(await bare.text()).length, 2)
    // what we do not filter on: 403 supported-filter; what we do not report: 403 supported-report
    const textMatch = await query('<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="SUMMARY"><c:text-match>Stand</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter>')
    assert.equal(textMatch.status, 403)
    assert.equal(await textMatch.text(), '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:supported-filter/></d:error>')
    const sync = await dav('/dav/kai/scorpio/', { method: 'REPORT', body: `<d:sync-collection ${DAV}><d:sync-token/><d:prop><d:getetag/></d:prop></d:sync-collection>` })
    assert.equal(sync.status, 403)
    assert.match(await sync.text(), /<d:supported-report\/>/)
    assert.equal((await dav('/dav/kai/', { method: 'REPORT', body: `<c:calendar-query ${DAV}><d:prop><d:getetag/></d:prop></c:calendar-query>` })).status, 403, 'a report on the principal')
  } finally { await w.dispose() }
})

// MKCALENDAR is not in the test runtime's list of HTTP methods (501 before the Worker runs), so it is not sent here; every method that reaches the Worker is refused the same way.
test('read only: PUT, DELETE, MKCOL, PROPPATCH, MOVE, COPY, LOCK, POST are 403 need-privileges and change nothing; GET on the root is refused too', async () => {
  const w = await worker()
  try {
    const { own, at, standup, dav } = await setUp(w)
    const path = `/dav/kai/scorpio/${own}-${standup.item.id}-${at}.ics`
    const before = await (await dav(path)).text()
    const writes = [
      ['PUT', path, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'], ['PUT', '/dav/kai/scorpio/new-S1-1.ics', 'x'], ['DELETE', path], ['MKCOL', '/dav/kai/other/'],
      ['PROPPATCH', '/dav/kai/scorpio/', propfind('<d:displayname>Mine</d:displayname>')], ['MOVE', path], ['COPY', path], ['LOCK', path], ['UNLOCK', path], ['PATCH', path],
    ]
    for (const [method, p, body] of writes) {
      const res = await dav(p, { method, body, headers: { destination: 'https://scorpio.test/dav/kai/scorpio/moved.ics', 'content-type': 'text/calendar' } })
      assert.equal(res.status, 403, `${method} ${p}`)
      assert.equal(await res.text(), '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:need-privileges/></d:error>', method)
    }
    assert.equal((await dav(path, { method: 'POST', body: '{}' })).status, 403) // POST is turned back by the cross-site check before the route
    assert.equal(await (await dav(path)).text(), before)
    assert.equal((await dav('/dav/kai/scorpio/new-S1-1.ics')).status, 404)
    assert.equal((await dav('/dav/')).status, 403)
    assert.equal((await dav('/dav/kai/')).status, 403)
    // a write without sign-in is a 401, not a 403: the challenge comes first
    assert.equal((await w.fetch(path, { method: 'PUT', body: 'x' })).status, 401)
  } finally { await w.dispose() }
})

test('the 5-minute copy: a second request after an edit still sees the first list; once the copy is gone the ctag and the event change', async () => {
  const w = await worker()
  try {
    const { kai, own, at, standup, dav } = await setUp(w)
    const ctagOf = async () => /<cs:getctag>([^<]*)<\/cs:getctag>/.exec(await (await dav('/dav/kai/scorpio/', { method: 'PROPFIND', headers: { depth: '1' }, body: propfind('<cs:getctag/><d:getetag/>') })).text())[1]
    const etagsOf = async () => etags(await (await dav('/dav/kai/scorpio/', { method: 'PROPFIND', headers: { depth: '1' }, body: propfind('<d:getetag/>') })).text())
    const first = await ctagOf(), firstEtags = await etagsOf()
    assert.equal(await ctagOf(), first, 'a plain refetch keeps the ctag')
    const edit = await w.json(await kai.apiPost(`/rooms/${own}/schedules`, { op: 'edit', id: standup.item.id, text: '@kai Stand-up, bring the numbers' }, 'coach'))
    assert.equal(edit.status, 200, JSON.stringify(edit))
    assert.equal(await ctagOf(), first, 'within 5 minutes the copy answers')
    const caches = await w.mf.getCaches()
    assert.ok(await caches.default.match(new Request('https://cal-cache.invalid/dav/u-kai')), 'the copy sits under the account key, not the token')
    await caches.default.delete(new Request('https://cal-cache.invalid/dav/u-kai'))
    const second = await ctagOf(), secondEtags = await etagsOf()
    assert.notEqual(second, first)
    const changed = Object.keys(firstEtags).filter((href) => href !== '/dav/kai/scorpio/' && firstEtags[href] !== secondEtags[href]) // the calendar's own getetag is the ctag
    assert.deepEqual(changed, [`/dav/kai/scorpio/${own}-${standup.item.id}-${at}.ics`])
    // turned off: gone from the list
    await w.json(await kai.apiPost(`/rooms/${own}/schedules`, { op: 'off', id: standup.item.id }, 'coach'))
    await caches.default.delete(new Request('https://cal-cache.invalid/dav/u-kai'))
    assert.equal(Object.keys(await etagsOf()).length, 2) // the calendar and the one event left
  } finally { await w.dispose() }
})
