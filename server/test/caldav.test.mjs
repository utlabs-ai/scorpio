// The CalDAV module's pure parts (caldav.ts): the XML reader, the paths, Basic sign-in, the event resources and their ETags and ctag.
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const load = async (file) => {
  const built = await build({ entryPoints: [new URL(`../src/${file}`, import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}
const { parseXml, targetOf, basicAuth, etagOf, ctagOf, davEvents, icsDateMs, BODY_MAX } = await load('caldav.ts')
const { calendarText, calendarEvents, eventText } = await load('calendar.ts')

const NOW = Date.parse('2026-11-02T12:00:00Z')
const DAY = 86_400_000
const item = (over = {}) => ({ id: 'S1', text: '@kai Stand-up', rule: { kind: 'once', at: NOW + DAY }, by: 'coach@kai', updatedAt: Date.parse('2026-11-01T08:00:00Z'), nextAt: NOW + DAY, ...over })
const topics = (items) => [{ roomId: 'room1234567890abcdefgh', name: 'Launch', items }]
const p = { now: NOW, origin: 'https://scorpio.test', host: 'scorpio.test' }
const unfold = (text) => text.replace(/\r\n /g, '')
const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

test('the XML reader: prolog, prefixes resolved to namespaces, a default namespace, attributes, entities, CDATA, comments', () => {
  const doc = parseXml(`<?xml version="1.0" encoding="utf-8"?>
<!-- a client -->
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/><x:unknown xmlns:x="urn:x"/></D:prop></D:propfind>`)
  assert.equal(doc.ns, 'DAV:')
  assert.equal(doc.name, 'propfind')
  assert.deepEqual(doc.children[0].children.map((c) => [c.ns, c.name]), [['DAV:', 'getetag'], ['urn:ietf:params:xml:ns:caldav', 'calendar-data'], ['urn:x', 'unknown']])
  const query = parseXml(`<calendar-query xmlns="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:"><D:prop><D:getetag/></D:prop><filter><comp-filter name="VCALENDAR"><comp-filter name="VEVENT"><time-range start="20261101T000000Z" end='20261201T000000Z'/></comp-filter></comp-filter></filter></calendar-query>`)
  assert.equal(query.ns, 'urn:ietf:params:xml:ns:caldav')
  const range = query.children[1].children[0].children[0].children[0]
  assert.equal(range.name, 'time-range')
  assert.deepEqual(range.attrs, { start: '20261101T000000Z', end: '20261201T000000Z' })
  const multiget = parseXml(`<C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="DAV:"><D:href>/dav/kai/scorpio/a%20b.ics</D:href><D:href> &lt;x&gt; &amp; &#65;&#x42; </D:href><D:href><![CDATA[<raw>]]></D:href></C:calendar-multiget>`)
  assert.deepEqual(multiget.children.map((c) => c.text), ['/dav/kai/scorpio/a%20b.ics', '<x> & AB', '<raw>'])
  // text and children together: the text is the element's own character data
  assert.equal(parseXml('<a> x <b/> y </a>').text, 'x  y')
})

test('the XML reader refuses what is not one well-formed element', () => {
  for (const bad of ['', 'plain text', '<a>', '<a></b>', '<a></a><b/>', '<a><b></a>', '<D:a/>', '<a x="1></a>', '<!DOCTYPE a><a/>', '<a>&unterminated</a><']) assert.equal(parseXml(bad), null, JSON.stringify(bad))
  assert.equal(parseXml('<a>&unknown;</a>').text, '&unknown;') // an entity we do not know is left as written, not refused
  assert.equal(BODY_MAX, 65_536)
})

test('paths: the root, the principal (any case of the handle), the calendar, an event; with or without the trailing slash; anything else is nothing', () => {
  assert.deepEqual(targetOf('/dav/', 'kai'), { kind: 'root' })
  assert.deepEqual(targetOf('/dav', 'kai'), { kind: 'root' })
  assert.deepEqual(targetOf('/dav/kai/', 'kai'), { kind: 'principal' })
  assert.deepEqual(targetOf('/dav/Kai', 'kai'), { kind: 'principal' })
  assert.deepEqual(targetOf('/dav/kai/scorpio/', 'kai'), { kind: 'calendar' })
  assert.deepEqual(targetOf('/dav/kai/scorpio', 'kai'), { kind: 'calendar' })
  assert.deepEqual(targetOf('/dav/kai/scorpio/room1234567890abcdefgh-S1-1762171200000.ics', 'kai'), { kind: 'event', name: 'room1234567890abcdefgh-S1-1762171200000' })
  for (const wrong of ['/dav/ana/', '/dav/kai/other/', '/dav/kai/scorpio/x.ics', '/dav/kai/scorpio/room-S1-1.txt', '/dav/kai/scorpio/room-S1-1.ics/more', '/dav/kai/scorpio/../ana/']) assert.equal(targetOf(wrong, 'kai'), null, wrong)
})

test('Basic sign-in: user and password split at the first colon, UTF-8; anything else is nothing', () => {
  assert.deepEqual(basicAuth(basic('kai', 'tok:en')), { user: 'kai', password: 'tok:en' })
  assert.deepEqual(basicAuth(basic('凯', 'x')), { user: '凯', password: 'x' })
  assert.deepEqual(basicAuth(`basic ${Buffer.from('kai:x').toString('base64')}`), { user: 'kai', password: 'x' })
  for (const bad of [null, '', 'Bearer abc', 'Basic', 'Basic !!!', `Basic ${Buffer.from('nocolon').toString('base64')}`, 'Basic /w==']) assert.equal(basicAuth(bad), null, String(bad))
})

test('an event resource: the feed header without the subscription lines, one VEVENT with the feed UID, DTSTAMP = the modification time', async () => {
  const [event] = calendarEvents(topics([item()]), p)
  assert.equal(event.name, `room1234567890abcdefgh-S1-${NOW + DAY}`)
  assert.equal(event.uid, `room1234567890abcdefgh-S1-${NOW + DAY}@scorpio.test`)
  assert.equal(event.start, NOW + DAY)
  const text = eventText(event)
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Scorpio//Calendar//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Scorpio\r\nBEGIN:VEVENT\r\n'))
  assert.ok(text.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n'))
  for (const line of ['METHOD:', 'REFRESH-INTERVAL', 'X-PUBLISHED-TTL']) assert.ok(!text.includes(line), line)
  assert.equal(text.split('BEGIN:VEVENT').length, 2)
  assert.match(unfold(text), /\r\nDTSTAMP:20261101T080000Z\r\nLAST-MODIFIED:20261101T080000Z\r\n/)
  // the feed's event for the same run is the same lines but for DTSTAMP, which is the fetch time there
  const feedEvent = unfold(calendarText(topics([item()]), p)).split('BEGIN:VEVENT')[1]
  const mine = unfold(text).split('BEGIN:VEVENT')[1]
  assert.equal(feedEvent.replace(/DTSTAMP:\d{8}T\d{6}Z/, ''), mine.replace(/DTSTAMP:\d{8}T\d{6}Z/, ''))
  assert.match(feedEvent, /DTSTAMP:20261102T120000Z/)
  // built a minute later: the same body, so the same ETag
  const later = await davEvents(topics([item()]), { ...p, now: NOW + 60_000 })
  assert.equal(later[0].body, text)
  assert.equal(later[0].etag, await etagOf(text))
})

test('ETag: quoted 32 hex of the body; it and the ctag change with an edit and only then', async () => {
  const a = await davEvents(topics([item(), item({ id: 'S2', text: '@kai Review', rule: { kind: 'once', at: NOW + 2 * DAY }, nextAt: NOW + 2 * DAY })]), p)
  assert.equal(a.length, 2)
  for (const e of a) assert.match(e.etag, /^"[0-9a-f]{32}"$/)
  assert.notEqual(a[0].etag, a[1].etag)
  const again = await davEvents(topics([item(), item({ id: 'S2', text: '@kai Review', rule: { kind: 'once', at: NOW + 2 * DAY }, nextAt: NOW + 2 * DAY })]), { ...p, now: NOW + 1000 })
  assert.equal(await ctagOf(again), await ctagOf(a))
  const edited = await davEvents(topics([item({ text: '@kai Stand-up!', updatedAt: NOW }), item({ id: 'S2', text: '@kai Review', rule: { kind: 'once', at: NOW + 2 * DAY }, nextAt: NOW + 2 * DAY })]), p)
  assert.notEqual(edited[0].etag, a[0].etag)
  assert.equal(edited[1].etag, a[1].etag)
  assert.notEqual(await ctagOf(edited), await ctagOf(a))
  assert.match(await ctagOf(a), /^"[0-9a-f]{32}"$/)
  // the ctag does not depend on the order the events came in
  assert.equal(await ctagOf([a[1], a[0]]), await ctagOf(a))
  assert.equal(await ctagOf([]), await etagOf(''))
})

test('time-range times are UTC stamps', () => {
  assert.equal(icsDateMs('20261102T090000Z'), Date.parse('2026-11-02T09:00:00Z'))
  for (const bad of ['20261102T090000', '2026-11-02T09:00:00Z', '20261102', '']) assert.ok(Number.isNaN(icsDateMs(bad)), bad)
})
