import assert from 'node:assert/strict'
import test from 'node:test'
import { framed, PREVIEW_MAX, viewKind } from '../src/file-kind.ts'
import { contentLabel, readTicket, signTicket, ticketKey, TICKET_SECONDS } from '../src/view-ticket.ts'

test('a file is shown by its extension, else by its type; images only by their bytes', () => {
  const cases = [
    ['report.html', 'application/octet-stream', 'html'],
    ['Report.HTM', 'text/plain', 'html'],
    ['notes.md', 'application/octet-stream', 'markdown'],
    ['README.markdown', 'text/plain', 'markdown'],
    ['run.log', 'application/octet-stream', 'text'],
    ['data.json', 'application/json', 'text'],
    ['main.py', 'text/x-python', 'text'],
    ['Dockerfile', 'application/octet-stream', 'text'],
    ['.gitignore', 'application/octet-stream', 'text'],
    ['icon.svg', 'application/octet-stream', 'svg'], // a picture, shown only as an <img> on the content domain
    ['Icon.SVG', 'image/svg+xml', 'svg'],
    ['notes.txt', 'text/html', 'text'], // the name decides, not a declared type
    ['Q3 report.pdf', 'application/pdf', 'other'],
    ['archive.zip', 'text/plain', 'other'],
    ['page', 'text/html', 'html'],
    ['doc', 'text/markdown', 'markdown'],
    ['blob', 'text/csv', 'text'],
    ['blob', 'application/octet-stream', 'other'],
    ['photo.png', 'image/png', 'image'],
    ['fake.png', 'application/octet-stream', 'other'], // a .png whose bytes are not an image
  ]
  for (const [name, type, kind] of cases) assert.equal(viewKind(name, type), kind, `${name} ${type}`)
})

test('Markdown and plain text are framed up to 2 MB, HTML at any size, nothing else', () => {
  assert.equal(framed('html', 25 * 1024 * 1024), true)
  assert.equal(framed('markdown', PREVIEW_MAX), true)
  assert.equal(framed('markdown', PREVIEW_MAX + 1), false)
  assert.equal(framed('text', 10), true)
  assert.equal(framed('svg', PREVIEW_MAX), true)
  assert.equal(framed('svg', PREVIEW_MAX + 1), false)
  assert.equal(framed('image', 10), false)
  assert.equal(framed('other', 10), false)
})

const KEY = 'test-key-0123456789abcdef0123456789abcdef'
const T = { u: 'user-1', r: 'R'.repeat(22), f: 'F'.repeat(22), h: 'a'.repeat(64), k: 'html', t: 'dark', o: 'https://scorpio.utlabs.ai' }

test('a ticket opens on its own host until it expires', async () => {
  const now = Date.UTC(2026, 9, 9, 12)
  const { label, token } = await signTicket(KEY, T, now)
  assert.match(label, /^[0-9a-f]{32}$/)
  const t = await readTicket(KEY, label, token, now + 1000)
  assert.deepEqual({ ...t, e: undefined, n: undefined }, { ...T, e: undefined, n: undefined })
  assert.equal(t.e, Math.floor(now / 1000) + TICKET_SECONDS)
  assert.equal(await readTicket(KEY, label, token, now + TICKET_SECONDS * 1000 + 1), null, 'expired')
})

test('every opening gets a host of its own', async () => {
  const a = await signTicket(KEY, T)
  const b = await signTicket(KEY, T)
  assert.notEqual(a.label, b.label)
})

test('a ticket does not open another host, a changed ticket, or with another key', async () => {
  const { label, token } = await signTicket(KEY, T)
  const other = await signTicket(KEY, T)
  assert.equal(await readTicket(KEY, other.label, token), null, 'another ticket\'s host')
  assert.equal(await readTicket('another-key-0123456789abcdef0123456789', label, token), null, 'another key')
  // A byte of the sealed ticket changed: its label no longer matches, and it would not open either.
  const bytes = Buffer.from(token, 'base64url')
  bytes[20] ^= 1
  const forged = bytes.toString('base64url')
  assert.equal(await readTicket(KEY, label, forged), null, 'changed ticket')
  assert.equal(await readTicket(KEY, label.toUpperCase(), token), null, 'labels are lowercase')
  assert.equal(await readTicket(KEY, label, token + '/x'), null)
  assert.equal(await readTicket(KEY, 'a'.repeat(32), 'not.base64'), null)
})

test('a ticket says nothing to whoever holds it: no room, file or bytes in it to read', async () => {
  const { token } = await signTicket(KEY, T)
  const raw = Buffer.from(token, 'base64url').toString('latin1')
  for (const v of [T.r, T.f, T.h, T.u, T.o, '"r"']) assert.ok(!raw.includes(v), v)
})

test('a ticket key shorter than 32 characters counts as none', () => {
  assert.equal(ticketKey(undefined), null)
  assert.equal(ticketKey(''), null)
  assert.equal(ticketKey('x'.repeat(31)), null)
  assert.equal(ticketKey('x'.repeat(32)), 'x'.repeat(32))
})

test('only hosts under the content domain are content hosts; any other there is answered with nothing', () => {
  const d = 'example-content.com'
  const l = '0123456789abcdef0123456789abcdef'
  assert.equal(contentLabel(d, `${l}.example-content.com`), l)
  assert.equal(contentLabel(d, `${l.toUpperCase()}.EXAMPLE-CONTENT.COM`), l, 'hosts are case-insensitive')
  assert.equal(contentLabel(d, 'example-content.com'), '')
  assert.equal(contentLabel(d, 'www.example-content.com'), '')
  assert.equal(contentLabel(d, `a.${l}.example-content.com`), '')
  assert.equal(contentLabel(d, 'scorpio.example.com'), null)
  assert.equal(contentLabel(d, `${l}.example-content.com.evil.com`), null)
  assert.equal(contentLabel(d, `x-example-content.com`), null)
  assert.equal(contentLabel(undefined, `${l}.example-content.com`), null, 'not configured: no content host')
  assert.equal(contentLabel('localhost', `${l}.localhost`), l, 'local')
  assert.equal(contentLabel('localhost', '127.0.0.1'), null)
})
