import assert from 'node:assert/strict'
import test from 'node:test'
import { charCount, cleanCut, cleanLines, cutChars } from '../src/text.ts'

test('line breaks are kept, as \\n', () => {
  assert.equal(cleanLines('one\r\ntwo\rthree\n\n- four'), 'one\ntwo\nthree\n\n- four')
})

test('other control characters go, tabs stay, the ends are trimmed', () => {
  assert.equal(cleanLines('  \u0007a\tb\u001b[31m\u0000c\u007f\u0085  \n'), 'a\tb[31mc')
})

test('nothing is an empty string', () => {
  assert.equal(cleanLines(undefined), '')
  assert.equal(cleanLines(null), '')
  assert.equal(cleanLines(' \n\t '), '')
})

test('the limit counts characters, not UTF-16 units', () => {
  assert.equal(charCount('🦂'.repeat(1000)), 1000) // 2,000 UTF-16 units
  assert.equal(charCount('🦂'.repeat(1000) + 'x'), 1001)
  assert.equal(charCount('字'.repeat(2000)), 2000)
  assert.equal(charCount('x'.repeat(50_000)), 50_000)
})

test("an agent's own role card loses ESC and other control characters before it is stored", () => {
  // The daemon types role cards into other agents' terminals: an escape sequence must not survive.
  assert.equal(cleanCut('bot: \u001b[31mred\u001b[0m\u0007\r\n- line two\u0000', 1000), 'bot: [31mred[0m\n- line two')
})

test("an agent's own role card is cut, not refused, at 1000 characters, never inside an emoji", () => {
  assert.equal(cleanCut('a'.repeat(1500), 1000), 'a'.repeat(1000))
  const cut = cleanCut('x' + '🦂'.repeat(1200), 1000)
  assert.equal(charCount(cut), 1000)
  assert.ok(!/[\ud800-\udbff]$/.test(cut), 'no half surrogate at the end')
  assert.equal(cleanCut('line\n'.repeat(400), 1000).endsWith('line'), true) // no trailing blank after the cut
  assert.equal(cutChars('🦂🦂', 1), '🦂')
  assert.equal(cleanCut(undefined, 1000), '')
})
