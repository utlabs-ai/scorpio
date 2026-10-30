// Every relative link in docs/api/*.md points at a file of the repository, and every #anchor at a heading of its page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f))

/** The page's lines outside fenced code blocks. */
const prose = (file) => {
  let fence = null
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (m && (!fence || m[1][0] === fence[0] && m[1].length >= fence.length)) { fence = fence ? null : m[1]; return false }
    return !fence
  })
}

/** GitHub's heading anchors: inline markup dropped, lowercased, punctuation removed, spaces to hyphens, repeats numbered. */
export function anchors(file) {
  const seen = new Map()
  return new Set(prose(file).flatMap((line) => {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (!h) return []
    const text = h[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '')
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return [n ? `${base}-${n}` : base]
  }))
}

test('every relative link and anchor in docs/api resolves', () => {
  const broken = []
  for (const page of pages) {
    for (const line of prose(page)) {
      for (const [, target] of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target)) continue
        const [file, anchor] = target.split('#')
        const to = file ? path.resolve(path.dirname(page), file) : page
        if (!fs.existsSync(to)) broken.push(`${path.basename(page)}: ${target} (no such file)`)
        else if (anchor !== undefined && (!to.endsWith('.md') || !anchors(to).has(anchor))) broken.push(`${path.basename(page)}: ${target} (no such heading)`)
      }
    }
  }
  assert.deepEqual(broken, [])
})

test('anchors follow GitHub', () => {
  const file = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'anchors-')), 'a.md')
  fs.writeFileSync(file, '# Calling the API\n## `POST /rooms` and [joins](x.md)\n```\n# not a heading\n```\n## Errors\n## Errors\n## What 401 means: `reason`\n')
  assert.deepEqual([...anchors(file)], ['calling-the-api', 'post-rooms-and-joins', 'errors', 'errors-1', 'what-401-means-reason'])
})
