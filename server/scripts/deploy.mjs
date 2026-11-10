#!/usr/bin/env node
// `npm run deploy` for a self-hosted Scorpio (the repository root's wrangler.jsonc): migrations first, then the Worker,
// so new code never runs on the old tables. On the very first deploy the D1 database does not exist yet; the
// Worker's deploy creates it (and the KV namespace), so that one time it deploys first and migrates right after.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const wrangler = path.join(root, 'server/node_modules/.bin/wrangler')
const config = process.env.SCORPIO_WRANGLER_CONFIG || path.join(root, 'wrangler.jsonc')

function run(args, { quiet = false } = {}) {
  const r = spawnSync(wrangler, [...args, '-c', config], { cwd: root, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' })
  if (quiet) { process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '') }
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const migrate = (opts) => run(['d1', 'migrations', 'apply', 'DB', '--remote'], opts)
const deploy = () => { if (!run(['deploy']).ok) process.exit(1) }

const first = migrate({ quiet: true })
if (first.ok) deploy()
else if (/couldn'?t find|could not be found|not found|does not exist|7404/i.test(first.out) && /database|d1/i.test(first.out)) {
  console.log('No D1 database yet: deploying first, which creates it, then applying the migrations.')
  deploy()
  if (!migrate().ok) process.exit(1)
} else process.exit(1)
