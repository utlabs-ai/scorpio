#!/usr/bin/env node
// Installer for the Scorpio Skill package: `npx @utlabs/scorpio` (or `npx -y <server>/dl/scorpio.tgz`).
// Puts the package in SCORPIO_HOME/app (default ~/.scorpio/app), writes its launcher,
// records the server, and links the package's skill/ for the default home.
// Any other first argument is handed to the CLI: `npx @utlabs/scorpio whoami`.

import { serverUrl } from '../src/server-url.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { exposeLauncher } from '../src/install-path.mjs'
import { onServerChange } from '../src/install-token.mjs'
import { buildId } from '../src/build-id.mjs'

// Windows itself is not supported (the daemon drives terminals through Herdr, and paths are POSIX): stop before anything is written.
if (process.platform === 'win32') {
  console.error('Scorpio runs on macOS, Linux and WSL: start your agent in a WSL terminal and run the install there.')
  process.exit(1)
}

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const DEFAULT_DIR = path.join(HOME, '.scorpio')
const DIR = path.resolve(process.env.SCORPIO_HOME || DEFAULT_DIR)
const DEFAULT_HOME = DIR === DEFAULT_DIR
const DEST = path.join(DIR, 'app')
const PREV = path.join(DIR, 'app.prev')
const SKILL = path.join(DEST, 'skill')
const OLD_DEST = path.join(DIR, 'skill') // where versions before 0.2 put the package
const LAUNCHER = path.join(DIR, 'bin', 'scorpio')
const CONFIG_FILE = path.join(DIR, 'config.json')

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p)
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`

const argv = process.argv.slice(2)
if (argv.length && argv[0] !== 'install' && !argv[0].startsWith('--')) {
  const r = spawnSync(process.execPath, [path.join(PKG_DIR, 'bin', 'scorpio.mjs'), ...argv], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

function flag(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const pkg = readJson(path.join(PKG_DIR, 'package.json')) || {}
// The server this package was built for (tools/pack.mjs bakes it into defaults.json): the only one shown the token.
const packaged = serverUrl(readJson(path.join(PKG_DIR, 'defaults.json'))?.server || 'https://scorpio.utlabs.ai')
const server = serverUrl(flag('--server') || packaged)

// 1. Copy the package to this home's app: build next to it, then swap.
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
const tmp = `${DEST}.tmp-${process.pid}`
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
for (const f of [...(pkg.files || []), 'package.json']) {
  const src = path.join(PKG_DIR, f)
  if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, f), { recursive: true })
}
fs.chmodSync(path.join(tmp, 'bin', 'scorpio.mjs'), 0o755)
fs.chmodSync(path.join(tmp, 'bin', 'install.mjs'), 0o755)
const build = buildId(tmp)
const skipped = readJson(path.join(DIR, 'state', 'skip.json'))
const rollback = readJson(path.join(DIR, 'state', 'rollback.json'))
if (!argv.includes('--force') && (skipped?.build === build || rollback?.bad?.build === build)) {
  fs.rmSync(tmp, { recursive: true, force: true })
  console.error(`Scorpio ${pkg.version || ''} (${build}) was skipped or rolled back on this computer. Use --force only to retry this build.`)
  process.exit(1)
}
fs.writeFileSync(path.join(tmp, '.build'), build + '\n')
const sameBuild = fs.existsSync(path.join(DEST, '.build')) && fs.readFileSync(path.join(DEST, '.build'), 'utf8').trim() === build
if (!sameBuild) fs.rmSync(PREV, { recursive: true, force: true })
if (fs.existsSync(DEST)) {
  if (sameBuild) fs.rmSync(DEST, { recursive: true, force: true })
  else fs.renameSync(DEST, PREV)
}
fs.renameSync(tmp, DEST)

// 2. Launcher.
fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true })
fs.writeFileSync(LAUNCHER, `#!/bin/sh\nSCORPIO_HOME=\${SCORPIO_HOME:-${shellQuote(DIR)}}\nexport SCORPIO_HOME\nNODE="$SCORPIO_HOME/node/bin/node"\nif [ ! -x "$NODE" ]; then NODE=node; fi\nexec "$NODE" "$SCORPIO_HOME/app/bin/scorpio.mjs" "$@"\n`, { mode: 0o755 })
fs.chmodSync(LAUNCHER, 0o755)
const commandPath = DEFAULT_HOME ? exposeLauncher({ home: HOME, launcher: LAUNCHER, pathEnv: process.env.PATH }) : null

// 3. Server. Another server than before: the token stays only if it is this package's server and it accepts it (install-token.mjs).
const notes = []
const config = readJson(CONFIG_FILE) || {}
if (config.server && config.server !== server) {
  notes.push(await onServerChange({ dir: DIR, from: config.server, to: server, trusted: packaged, version: pkg.version || '' }))
}
// This computer's id: made once, kept across reinstalls; the server ties the daemon's seat number to it.
const device_id = typeof config.device_id === 'string' && config.device_id ? config.device_id : randomUUID()
fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, server, device_id }, null, 2) + '\n', { mode: 0o600 })

// 4. Link into each agent's skill directory (one shared copy, so one token and one CLI).
const linked = []
function link(baseDir, always) {
  if (!always && !fs.existsSync(baseDir)) return
  const skills = path.join(baseDir, 'skills')
  const at = path.join(skills, 'scorpio')
  try {
    fs.mkdirSync(skills, { recursive: true })
    let st = null
    try { st = fs.lstatSync(at) } catch {}
    if (st && !st.isSymbolicLink()) {
      notes.push(`Left ${tilde(at)} alone: it is not a link made by this installer. Remove it and rerun to link Scorpio there.`)
      return
    }
    if (st) fs.unlinkSync(at)
    fs.symlinkSync(SKILL, at)
    linked.push(tilde(at))
  } catch (e) {
    notes.push(`Could not link ${tilde(at)}: ${e.message}`)
  }
}
if (DEFAULT_HOME) {
  link(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), true)
  link(process.env.CODEX_HOME || path.join(HOME, '.codex'), process.env.SCORPIO_AGENT === 'codex')
  // The links now point into app/; the copy older versions kept in ~/.scorpio/skill is no longer used.
  fs.rmSync(OLD_DEST, { recursive: true, force: true })
}

const lines = [
  `Scorpio skill ${pkg.version || ''} installed in ${tilde(DEST)} (server: ${server}).`,
  `CLI: ${tilde(LAUNCHER)}`,
  ...(commandPath ? [commandPath.mode === 'link' ? `Command: scorpio (linked at ${tilde(commandPath.path)}).` : `Added Scorpio to PATH in ${tilde(commandPath.path)}; open a new terminal to use scorpio.`] : []),
  ...(DEFAULT_HOME ? [linked.length ? `Linked into: ${linked.join(', ')}` : 'Not linked into any agent skill directory.'] : []),
  ...notes,
  '',
  `Next: the skill is ${tilde(path.join(SKILL, 'SKILL.md'))}; carry on with what you were following (an invitation, a handoff).`,
  `\`scorpio help\` lists the commands; a topic is joined with ${tilde(LAUNCHER)} join topicId=<topic id> role=<your role> (code=<passcode> for a private one).`,
]
process.stdout.write(lines.join('\n') + '\n')
