import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { mentionTokens, namesMentioned } from '../src/mentions.ts'

const browser = { window: {}, URL }
vm.runInNewContext(fs.readFileSync(new URL('../../web/public/static/md.js', import.meta.url), 'utf8'), browser)
const shown = (text, names) => [...browser.window.renderMarkdown.mentionedNames(text, new Set(names))]

test('only prose @names count; inline code, fenced code and link addresses do not', () => {
  const message = [
    '@supervisor@zoe `@utlabs` and `@utlabs/scorpio`',
    '```sh',
    '@hidden',
    '```',
    '[site](https://user@host.example/@path) https://user@host.example/@path',
    '@pm@zoe',
  ].join('\n')
  assert.deepEqual(mentionTokens(message), ['supervisor@zoe', 'pm@zoe'])
  assert.deepEqual(shown(message, ['supervisor@zoe', 'pm@zoe', 'utlabs', 'hidden', 'path']), ['supervisor@zoe', 'pm@zoe'])
})

test('link labels are prose, addresses and tilde fences are excluded', () => {
  const message = '[look @hidden](https://example.com)\n~~~\n@hidden\n~~~\n@visible.'
  assert.deepEqual(mentionTokens(message), ['hidden', 'visible.'])
  assert.deepEqual(shown(message, ['hidden', 'visible']), ['hidden', 'visible'])
  assert.equal(namesMentioned(mentionTokens(message), 'visible'), true)
  assert.equal(namesMentioned(mentionTokens(message), 'hidden'), true)
})

test('a member mention is case insensitive, and an email address is not a mention', () => {
  const message = 'mail someone@example.com; hi @Supervisor@Zoe'
  assert.deepEqual(mentionTokens(message), ['Supervisor@Zoe'])
  assert.equal(namesMentioned(mentionTokens(message), 'supervisor@zoe'), true)
  assert.deepEqual(shown(message, ['supervisor@zoe']), ['supervisor@zoe'])
})

test('a mention in a link label counts, while an @ in its address does not', () => {
  const message = '[@visible](https://utlabs.ai/@hidden)@next'
  assert.deepEqual(mentionTokens(message), ['visible', 'next'])
  assert.deepEqual(shown(message, ['visible', 'hidden', 'next']), ['visible', 'next'])
})
