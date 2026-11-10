import assert from 'node:assert/strict'
import test from 'node:test'
import { localNext } from '../src/safe-next.ts'

const site = 'https://scorpio.utlabs.ai'

test('anything that leaves the site falls back to /', () => {
  for (const next of [
    '/\\evil.com', // what /lang?next=/%5Cevil.com decodes to; browsers read it as //evil.com
    '/\\\\evil.com',
    '\\\\evil.com',
    '//evil.com',
    '///evil.com',
    'https://evil.com',
    'http://scorpio.utlabs.ai/r/x', // another scheme is another origin
    'https://scorpio.utlabs.ai.evil.com/',
    '/\t/evil.com', // tabs and newlines are dropped by the parser, leaving //evil.com
    '/\n/evil.com',
    '/\r\n/evil.com',
    ' //evil.com',
    '\t//evil.com',
    'javascript:alert(1)',
    'data:text/html,hi',
    'https://user@evil.com',
  ]) {
    assert.equal(localNext(next, site), '/', JSON.stringify(next))
  }
})

test('a path that the parser turns into //host falls back to /', () => {
  // "." and ".." segments are removed after the leading "/" is read, so "/.//evil.com" becomes the path
  // "//evil.com", which a browser given it as a Location reads as another host
  for (const next of [
    '/.//evil.com',
    '/..//evil.com',
    '/%2e//evil.com',
    '/./\\evil.com',
    `${site}//evil.com`,
  ]) {
    assert.equal(localNext(next, site), '/', JSON.stringify(next))
  }
  assert.equal(localNext('/r/abc?x=1#m5', site), '/r/abc?x=1#m5')
})

test('a path on the site is kept, with its query and fragment', () => {
  assert.equal(localNext('/r/abc?file=x1#m5', site), '/r/abc?file=x1#m5')
  assert.equal(localNext('/settings?drive=connected#drive', site), '/settings?drive=connected#drive')
  assert.equal(localNext('/%5Cevil.com', site), '/%5Cevil.com') // still encoded: a path on this site, not a host
  assert.equal(localNext('https://scorpio.utlabs.ai/pricing', site), '/pricing')
  assert.equal(localNext('/a/../b', site), '/b')
})

test('nothing, or something the parser rejects, is /', () => {
  assert.equal(localNext(null, site), '/')
  assert.equal(localNext(undefined, site), '/')
  assert.equal(localNext('', site), '/')
  assert.equal(localNext('http://[::1', site), '/')
})

test('local development keeps its own origin', () => {
  assert.equal(localNext('/r/abc', 'http://127.0.0.1:8788'), '/r/abc')
  assert.equal(localNext('http://127.0.0.1:8787/r/abc', 'http://127.0.0.1:8788'), '/')
})
