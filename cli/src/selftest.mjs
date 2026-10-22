import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { HOME, PKG_DIR, server } from './daemon/paths.mjs'

const execFileP = promisify(execFile)

function modules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? modules(file) : entry.isFile() && entry.name.endsWith('.mjs') ? [file] : []
  }).sort()
}

export async function selftest({ root = PKG_DIR, home = HOME, serverUrl = server(), fetchImpl = fetch } = {}) {
  // bin/scorpio.mjs has already loaded and dispatched this action. Importing bin/install.mjs
  // would perform an installation, so syntax-check that one entrypoint instead.
  await execFileP(process.execPath, ['--check', path.join(root, 'bin', 'install.mjs')], { timeout: 60_000 })
  for (const file of modules(path.join(root, 'src'))) await import(pathToFileURL(file).href)

  const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim()
  if (!token) throw new Error('No device token')
  const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const res = await fetchImpl(`${serverUrl}/api/v1/whoami`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Scorpio-Cli': currentVersion, 'User-Agent': `scorpio-selftest/${currentVersion}` },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`whoami HTTP ${res.status}`)
  const identity = await res.json()
  if (typeof identity?.account !== 'string' || !identity.account) throw new Error('whoami returned no account')
  return { ok: true, version: currentVersion }
}
