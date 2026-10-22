import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { command, herdr, onPath, privateFile, startDetached, homeDir, readJson, writeJson } from './services.mjs'
import { ensureDir } from '../workspace.mjs'

const localBin = path.join(os.homedir(), '.local', 'bin')
const installedBin = path.join(localBin, 'herdr')
const workspaceFile = path.join(homeDir, 'state', 'up-herdr.json')

export function herdrBinary() {
  for (const file of [installedBin, onPath('herdr')].filter(Boolean)) {
    try { fs.accessSync(file, fs.constants.X_OK); return file } catch {}
  }
  return null
}

async function installHerdr() {
  const response = await fetch('https://herdr.dev/install.sh', { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error('Herdr installer HTTP ' + response.status)
  const script = await response.text()
  const file = path.join(homeDir, 'tmp', 'herdr-install-' + process.pid + '.sh')
  privateFile(file, script)
  try {
    await command('sh', [file], {
      json: false, timeout: 180_000,
      env: { ...process.env, HERDR_INSTALL_DIR: localBin },
    })
  } finally { fs.rmSync(file, { force: true }) }
  process.env.PATH = localBin + path.delimiter + process.env.PATH
  if (!herdrBinary()) throw new Error('Herdr installer did not create a runnable command.')
  return installedBin
}

export async function herdrRunning(bin) {
  try {
    const status = await herdr(bin, ['status', 'server', '--json'])
    return status.running === true || status.result?.running === true
  } catch { return false }
}

export async function ensureHerdr(onPhase = () => {}) {
  let bin = herdrBinary()
  if (bin) {
    try { await command(bin, ['--version'], { json: false }) }
    catch { bin = null }
  }
  if (!bin) onPhase('download')
  bin = bin || await installHerdr()
  onPhase('start')
  if (!await herdrRunning(bin)) {
    startDetached(bin, ['server'], path.join(homeDir, 'state', 'herdr-server.log'))
    let ready = false
    for (let i = 0; i < 30; i += 1) {
      if (await herdrRunning(bin)) { ready = true; break }
      await sleep(1000)
    }
    if (!ready) throw new Error('Herdr server did not start; see ~/.scorpio/state/herdr-server.log.')
  }
  const version = await command(bin, ['--version'], { json: false })
  return { bin, version, running: true }
}

export async function existingHerdrWorkspace(bin) {
  const saved = readJson(workspaceFile)?.workspaceId
  if (!saved) return null
  const listed = await herdr(bin, ['workspace', 'list'])
  const workspaces = listed.result?.workspaces || []
  const existing = workspaces.find((item) => item.workspace_id === saved && item.label === 'Scorpio')
  return existing?.workspace_id || null
}

export async function ensureHerdrWorkspace(bin) {
  const existing = await existingHerdrWorkspace(bin)
  if (existing) return existing
  const root = ensureDir(path.join(homeDir, 'topics'))
  const created = await herdr(bin, ['workspace', 'create', '--cwd', root, '--label', 'Scorpio', '--no-focus'])
  const id = created.result?.workspace?.workspace_id
  if (!id) throw new Error('Herdr did not return a workspace id.')
  writeJson(workspaceFile, { workspaceId: id })
  return id
}

export async function herdrPane(bin, pane) {
  try { return (await herdr(bin, ['pane', 'get', pane])).result?.pane || null }
  catch { return null }
}
