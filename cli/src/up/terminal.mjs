import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { command, herdr, onPath, startDetached, homeDir, readJson, writeJson } from './services.mjs'
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

export const HERDR_VERSION = '0.9.5'
const HERDR_SHA256 = {
  'linux-x86_64': '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d',
  'linux-aarch64': '17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c',
  'macos-x86_64': '5fb0a908ec7f6745e3e245738b06bfad56c46391c391ab3c0955fbead01f1369',
  'macos-aarch64': 'fb77c2232a05a8035421382c894392f4174e4e38a18e48af3dd0290157c3a7e2',
}

export async function installHerdr({ platform = process.platform, arch = process.arch, fetchImpl = fetch,
  installDir = process.env.HERDR_INSTALL_DIR || localBin, hashes = HERDR_SHA256 } = {}) {
  const system = { darwin: 'macos', linux: 'linux' }[platform]
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch]
  const target = `${system}-${cpu}`
  if (!system || !cpu || !hashes[target]) throw new Error('Herdr does not support this platform.')
  const response = await fetchImpl(`https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-${target}`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error('Herdr download HTTP ' + response.status)
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Herdr download must use https.')
  const binary = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(binary).digest('hex') !== hashes[target]) throw new Error('Herdr sha256 mismatch.')
  fs.mkdirSync(installDir, { recursive: true })
  const destination = path.join(installDir, 'herdr')
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, binary, { mode: 0o755 })
    fs.chmodSync(temporary, 0o755)
    fs.renameSync(temporary, destination)
  } finally { fs.rmSync(temporary, { force: true }) }
  process.env.PATH = installDir + path.delimiter + process.env.PATH
  return destination
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
