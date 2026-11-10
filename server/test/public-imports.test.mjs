import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

// This server and its web app are deployed on their own: a deployment may wrap them (index.ts createWorker), but nothing
// here may load a file from outside server/, web/ and cli/, where a deployment keeps its own pages and config.
const root = path.resolve(new URL('../..', import.meta.url).pathname)
const OPEN = new Set(['server', 'web', 'cli'])
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew URL\(\s*|"(?:main|directory|migrations_dir)"\s*:\s*)(['"`])([^'"`\n]+)\1/g

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return ['node_modules', '.wrangler', 'dl'].includes(e.name) ? [] : files(full)
    return /\.(?:ts|mjs|js|jsonc?|sh|sql)$/.test(e.name) ? [full] : []
  })
}

test('server/ and web/ load nothing from outside the open directories', () => {
  const hits = []
  for (const file of [...files(path.join(root, 'server')), ...files(path.join(root, 'web'))]) {
    const text = fs.readFileSync(file, 'utf8')
    for (const [, , spec] of text.matchAll(SPEC)) {
      if (!spec.startsWith('.')) continue
      const target = path.relative(root, path.resolve(path.dirname(file), spec))
      if (target && (target.startsWith('..') || !OPEN.has(target.split(path.sep)[0]))) hits.push(`${path.relative(root, file)}: ${spec}`)
    }
  }
  assert.deepEqual(hits, [])
})

// Reading a file by path counts too (readFileSync, a script run by name): no quoted path into hosted/, and every
// quoted scripts/<name> is a script this server has.
test('server/ and web/ name no file of a deployment around them', () => {
  const own = new Set(fs.readdirSync(path.join(root, 'server', 'scripts')))
  const hits = []
  for (const file of [...files(path.join(root, 'server')), ...files(path.join(root, 'web'))]) {
    if (file === new URL(import.meta.url).pathname) continue
    for (const [, , text] of fs.readFileSync(file, 'utf8').matchAll(/(['"`])([^'"`\n]*)\1/g)) {
      const script = /(?:^|\/)scripts\/([\w.-]+)/.exec(text)?.[1]
      if (/(?:^|[/\s])hosted\//.test(text) || (script && !own.has(script))) hits.push(`${path.relative(root, file)}: ${text}`)
    }
  }
  assert.deepEqual(hits, [])
})
