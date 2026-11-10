import assert from 'node:assert/strict'
import test from 'node:test'
import { likeTerms, trigramCandidate } from '../src/search-match.ts'

test('short Chinese search keeps the original literal LIKE path', () => {
  assert.equal(trigramCandidate(['珍']), null)
  assert.equal(trigramCandidate(['珍珠']), null)
  assert.equal(trigramCandidate(['珍珠奶']), '珍珠奶')
})

test('trigram prefilter uses a long term while literal wildcard characters stay exact in the final LIKE', () => {
  assert.equal(trigramCandidate(['珍', 'collaboration']), 'collaboration')
  assert.equal(trigramCandidate(['ab%cd']), null)
  assert.equal(trigramCandidate(['literal%abc']), 'literal%abc')
  assert.deepEqual(likeTerms('m.text', ['literal%abc']).args, ['%literal\\%abc%'])
})
