// This directory is published as is, so its comments and documentation are public text. A pointer
// to something that is not here (a task or message number, a team role cited as the source, a document
// or repository outside this directory) tells the reader nothing. This test
// scans the comments, test titles and assertion messages in .mjs/.js files and the prose in .md files,
// and names each hit by file and line.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)

const PATTERNS = [
  [/\bT\d{3,}\b/, 'task number'],
  [/S?#\d{3,}/, 'message number'],
  [/\b(?:spec|protocol)\s*§/, 'citation of an absent document'],
  [/docs\/(?:protocol|data|engineering|deploy)\.md/, 'citation of an absent document'],
  [/\.\.\/(?:server|web|docs)\b|server\/src\//, 'path into another repository'],
  [/(?<![\w.-])(?!scorpio\.utlabs\.ai\b)[\w-]+(?:\.[\w-]+)*\.utlabs\.ai\b/, 'internal host name'],
]
// JavaScript only: Markdown here has its own numbered sections, which it may cite.
const JS_ONLY = [
  [/\b20\d\d-\d\d-\d\d\b/, 'date'],
  [/§\s*\d/, 'citation of an absent document'],
]

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : files(p)
    return /\.(?:mjs|js|md)$/.test(e.name) ? [p] : []
  })
}

// Characters after which a `/` starts a regular expression rather than a division.
const REGEX_BEFORE = new Set('(,=:[!&|?{};+-*%<>~^'.split(''))
const REGEX_KEYWORDS = /\b(?:return|typeof|case|do|else|in|of|void|yield|await|throw|delete|new)$/
const TEST_CALL = /^(?:test|it|describe)(?:\.\w+)?$/
// Which argument of an assert call is its message: test titles and messages are prose too, while the
// other arguments are fixture data, which may hold anything.
// The throws family takes its message second or third, after an optional expected error.
const MESSAGE_AT = { assert: 1, ok: 1, fail: 0, throws: 1, rejects: 1, doesNotThrow: 1, doesNotReject: 1 }
const FROM_ON = new Set(['throws', 'rejects', 'doesNotThrow', 'doesNotReject'])

/** Whether the string literal at argument `arg` of a call to `callee` is prose. */
function isProse(callee, arg) {
  if (TEST_CALL.test(callee)) return arg === 0
  const m = callee.match(/^assert(?:\.(\w+))?$/)
  if (!m) return false
  const method = m[1] ?? 'assert'
  const at = MESSAGE_AT[method] ?? 2
  return FROM_ON.has(method) ? arg >= at : arg === at
}

/**
 * The prose of a JavaScript source as [line, text] pairs: its comments, the titles of its tests and
 * the messages of its assertions, one pair per line they touch.
 */
function jsText(src) {
  const out = []
  let line = 1
  let i = 0
  // Open brackets, innermost last: a call {kind: '(', callee, arg, strings}, '[', or '{' (template: it opened a ${).
  const open = []
  const emit = (start, text) => text.split('\n').forEach((t, k) => out.push([start + k, t]))
  const lastSignificant = (pos) => {
    let j = pos - 1
    while (j >= 0 && /\s/.test(src[j])) j -= 1
    return j
  }
  const literal = (start, text) => {
    const call = open.at(-1)
    if (call?.kind === '(') call.strings.push({ arg: call.arg, line: start, text })
  }
  const template = () => {
    // at the character after a ` or after the } closing a ${
    const start = line
    const from = i
    while (i < src.length) {
      const c = src[i]
      if (c === '\\') { if (src[i + 1] === '\n') line += 1; i += 2; continue }
      if (c === '`') { literal(start, src.slice(from, i)); i += 1; return }
      if (c === '$' && src[i + 1] === '{') { literal(start, src.slice(from, i)); open.push({ kind: '{', template: true }); i += 2; return }
      if (c === '\n') line += 1
      i += 1
    }
  }
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '\n') { line += 1; i += 1; continue }
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      emit(line, src.slice(i + 2, stop))
      i = stop
      continue
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end
      const text = src.slice(i + 2, stop)
      emit(line, text)
      line += text.split('\n').length - 1
      i = stop + 2
      continue
    }
    if (c === '\'' || c === '"') {
      const from = i + 1
      i += 1
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1
      literal(line, src.slice(from, i))
      i += 1
      continue
    }
    if (c === '`') { i += 1; template(); continue }
    if (c === '(') {
      const callee = src.slice(Math.max(0, i - 80), i).match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/)?.[1].replace(/\s+/g, '') ?? ''
      open.push({ kind: '(', callee, arg: 0, strings: [] })
      i += 1
      continue
    }
    if (c === ')') {
      const call = open.pop()
      if (call?.kind === '(') for (const s of call.strings) if (isProse(call.callee, s.arg)) emit(s.line, s.text)
      i += 1
      continue
    }
    if (c === ',') { const call = open.at(-1); if (call?.kind === '(') call.arg += 1; i += 1; continue }
    if (c === '[') { open.push({ kind: '[' }); i += 1; continue }
    if (c === ']' || c === '}') { const top = open.pop(); i += 1; if (top?.template) template(); continue }
    if (c === '{') { open.push({ kind: '{' }); i += 1; continue }
    if (c === '/') {
      const j = lastSignificant(i)
      const before = j < 0 ? '' : src[j]
      if (j < 0 || REGEX_BEFORE.has(before) || REGEX_KEYWORDS.test(src.slice(Math.max(0, j - 10), j + 1))) {
        i += 1
        let cls = false
        while (i < src.length && src[i] !== '\n') {
          if (src[i] === '\\') { i += 2; continue }
          if (src[i] === '[') cls = true
          else if (src[i] === ']') cls = false
          else if (src[i] === '/' && !cls) break
          i += 1
        }
        i += 1
        continue
      }
    }
    i += 1
  }
  return out
}

/** The prose of a Markdown document as [line, text] pairs: fenced blocks and `inline code` left out. */
function mdProse(src) {
  const out = []
  let fence = null
  src.split('\n').forEach((text, k) => {
    const open = text.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null
      return
    }
    if (open) { fence = open[1]; return }
    out.push([k + 1, text.replace(/(`+)[^`]*?\1/g, '')])
  })
  return out
}

function hits(file, src) {
  const js = !file.endsWith('.md')
  const patterns = js ? [...PATTERNS, ...JS_ONLY] : PATTERNS
  const found = []
  for (const [line, text] of (js ? jsText(src) : mdProse(src)).sort((x, y) => x[0] - y[0])) {
    const seen = new Set() // one hit per kind and line is enough to find it
    for (const [re, what] of patterns) {
      const m = !seen.has(what) && text.match(re)
      if (m) { seen.add(what); found.push(`${file}:${line}: ${what}: ${m[0]}`) }
    }
  }
  return found
}

test('comments and documentation carry no references to private material', () => {
  const found = files(ROOT).filter((f) => f !== SELF)
    .flatMap((f) => hits(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')))
  assert.deepEqual(found, [], `Write the reason itself instead of the reference (see AGENTS.md):\n${found.join('\n')}`)
})

test('the scanner reads comments, test titles, assertion messages and prose, and catches each kind of reference', () => {
  const js = [
    "const a = '#1234 T480' // T480 and #1234 in a comment",
    'const re = /#\\d{3,}/g /* see protocol §6 */',
    'const t = `${x} // not a comment ${`#999`}` // see S#1234',
    '/* changed in (§8.1)',
    '   2026-01-05 */',
    'const u = "https://x.utlabs.ai/a" // scorpio.utlabs.ai is fine, x.utlabs.ai is not',
    "test('keeps the order (T123)', () => {",
    "  assert.equal(f('#5678'), 'T999', 'see #4321')",
    "  assert.deepEqual(g(), ['T777'], `from ${'x'} #2468`)",
    "  assert.throws(() => h('T555'), /T666/, 'asked in #1357')",
    "  assert.ok(ok(['#8642']), 'T246 again')",
    '})',
  ].join('\n')
  assert.deepEqual(hits('a.mjs', js), [
    'a.mjs:1: task number: T480',
    'a.mjs:1: message number: #1234',
    'a.mjs:2: citation of an absent document: protocol §',
    'a.mjs:3: message number: S#1234',
    'a.mjs:4: citation of an absent document: §8',
    'a.mjs:5: date: 2026-01-05',
    'a.mjs:6: internal host name: x.utlabs.ai',
    'a.mjs:7: task number: T123',
    'a.mjs:8: message number: #4321',
    'a.mjs:9: message number: #2468',
    'a.mjs:10: message number: #1357',
    'a.mjs:11: task number: T246',
  ])
  const md = [
    'Tasks T1 to T99, #8 in examples and SKILL.md §6 are fine.',
    'Run `scorpio task take=T480` or see `#1234`.',
    '```sh',
    'cat ../server/src/util.ts # T123',
    '```',
    'Packs into ../web/public/dl, as docs/protocol.md says.',
    'Asked in #1234 (T567); protocol §6 says so; see x.utlabs.ai.',
  ].join('\n')
  assert.deepEqual(hits('a.md', md), [
    'a.md:6: citation of an absent document: docs/protocol.md',
    'a.md:6: path into another repository: ../web',
    'a.md:7: task number: T567',
    'a.md:7: message number: #1234',
    'a.md:7: citation of an absent document: protocol §',
    'a.md:7: internal host name: x.utlabs.ai',
  ])
})
