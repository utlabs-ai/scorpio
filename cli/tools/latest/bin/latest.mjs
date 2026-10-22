#!/usr/bin/env node
// `npx -y <server>/dl/latest`: the install command that never changes. npx keeps a tarball by its URL and runs
// that copy again next time, so this fixed address holds only this small starter, which does not change;
// each time it runs it asks the server which package is current and installs that one (its URL is new
// for every version, so npx fetches it). Arguments (--server …) go on to the installer.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  console.error('Scorpio runs on macOS, Linux and WSL: start your agent in a WSL terminal and run the install there.')
  process.exit(1)
}

const { server } = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let latest = null
let why = ''
for (let i = 0; i < 5 && !latest; i += 1) {
  if (i) await sleep(2000 * i)
  try {
    const res = await fetch(`${server}/dl/latest.json`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) })
    if (res.ok) latest = await res.json()
    else why = `HTTP ${res.status}`
  } catch (e) { why = String(e?.cause?.code || e?.message || e) }
}
if (!latest?.file) {
  console.error(`Could not ask ${server} for the current Scorpio package (${why || 'no answer'}). Check the network and run the same command again.`)
  process.exit(1)
}
console.log(`Scorpio ${latest.version}: installing from ${server}/dl/${latest.file}`)
const run = spawnSync('npx', ['-y', `${server}/dl/${latest.file}`, ...process.argv.slice(2)], { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(run.status ?? 1)
