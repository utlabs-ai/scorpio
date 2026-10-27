#!/usr/bin/env node
// `npx -y <server>/dl/latest`: the install command that never changes. npx keeps a tarball by its URL and runs
// that copy again next time, so this fixed address holds only this small starter, which does not change;
// each time it runs it asks the server which package is current and installs that one (its URL is new
// for every version, so npx fetches it). Arguments (--server …) go on to the installer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  console.error('Scorpio runs on macOS, Linux and WSL: start your agent in a WSL terminal and run the install there.')
  process.exit(1)
}

const { server } = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8'))
const base = new URL(server)
if (base.username || base.password || base.search || base.hash || /[\x00-\x20\x7f-\x9f]/.test(server) ||
    !(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
  console.error('Server URL must use https, except localhost or 127.0.0.1.')
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let latest = null
let why = ''
for (let i = 0; i < 5 && !latest; i += 1) {
  if (i) await sleep(2000 * i)
  try {
    const res = await fetch(`${server}/dl/latest.json`, { redirect: 'error', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) })
    if (res.ok) latest = await res.json()
    else why = `HTTP ${res.status}`
  } catch (e) { why = String(e?.cause?.code || e?.message || e) }
}
if (!latest || typeof latest.file !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/.test(latest.file) || !/^[0-9a-f]{64}$/.test(latest.sha256)) {
  console.error(`Could not ask ${server} for the current Scorpio package (${why || 'no answer'}). Check the network and run the same command again.`)
  process.exit(1)
}
console.log(`Scorpio ${latest.version}: installing from ${server}/dl/${latest.file}`)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-latest-'))
try {
  const response = await fetch(`${server}/dl/${latest.file}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Package download HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(archive).digest('hex') !== latest.sha256) throw new Error('Package sha256 mismatch.')
  const file = path.join(temporary, latest.file)
  fs.writeFileSync(file, archive, { mode: 0o600 })
  const run = spawnSync('npx', ['-y', '--package=file:' + file, 'scorpio', ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exitCode = run.status ?? 1
} catch (error) {
  console.error('Could not install Scorpio: ' + error.message)
  process.exitCode = 1
} finally { fs.rmSync(temporary, { recursive: true, force: true }) }
