import assert from 'node:assert/strict'
import test from 'node:test'
import { compressed } from '../src/seo.ts'

// The pages' HTML is compressed by the Worker itself.
const page = (headers = {}) => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-transform', 'content-length': '9', ...headers } })
const req = (ae) => new Request('https://scorpio.utlabs.ai/', ae == null ? {} : { headers: { 'accept-encoding': ae } })

test('HTML is compressed by the Worker: gzip, which the edge passes to every client that takes it', () => {
  // the edge asks with "br, gzip" whatever the visitor sent: br would reach a gzip-only client unpacked (no-transform)
  const gz = compressed(req('br, gzip'), page())
  assert.equal(gz.headers.get('content-encoding'), 'gzip')
  assert.equal(gz.headers.get('content-length'), null)
  assert.match(gz.headers.get('vary'), /Accept-Encoding/)
  assert.equal(gz.headers.get('cache-control'), 'no-store, no-transform')
  assert.equal(compressed(req('gzip'), page()).headers.get('content-encoding'), 'gzip')
  assert.equal(compressed(req('br'), page()).headers.get('content-encoding'), null)
  const none = compressed(req(null), page())
  assert.equal(none.headers.get('content-encoding'), null)
  assert.match(none.headers.get('vary'), /Accept-Encoding/)
})

test('only HTML with a body that is not encoded yet', () => {
  const j = new Response('{}', { headers: { 'content-type': 'application/json' } })
  assert.equal(compressed(req('br'), j), j)
  const done = page({ 'content-encoding': 'gzip' })
  assert.equal(compressed(req('br'), done), done)
  const moved = new Response(null, { status: 303, headers: { location: '/login' } })
  assert.equal(compressed(req('br'), moved), moved)
  // a page that already varies keeps what it varies on
  assert.equal(compressed(req('br'), page({ vary: 'Cookie, Accept-Language' })).headers.get('vary'), 'Cookie, Accept-Language, Accept-Encoding')
})
