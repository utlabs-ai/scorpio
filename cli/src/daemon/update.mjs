import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildId } from '../build-id.mjs'
import { HOME, readJson, server, version, writeJson } from './paths.mjs'

const execFileP = promisify(execFile)
const SHA256 = /^[0-9a-f]{64}$/

export async function selfUpdate({
  home = HOME, serverUrl = server(), currentVersion = version(), newer, whoami,
  fetchImpl = fetch, execute = execFileP, childEnv = process.env, log = () => {}, checked = () => {},
} = {}) {
  let latest
  try {
    const res = await fetchImpl(`${serverUrl}/dl/latest.json`, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`latest HTTP ${res.status}`)
    latest = await res.json()
  } catch {
    checked({ at: Date.now(), state: 'failed' })
    return
  }
  if (!latest || typeof latest.file !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/.test(latest.file)
      || typeof latest.version !== 'string' || !SHA256.test(latest.sha256) || !SHA256.test(latest.build)) {
    checked({ at: Date.now(), state: 'failed' })
    return
  }
  if (!newer(latest.version, currentVersion)) {
    checked({ at: Date.now(), state: 'current' })
    return
  }
  const skipped = readJson(path.join(home, 'state', 'skip.json'))
  const rollback = readJson(path.join(home, 'state', 'rollback.json'))
  if (skipped?.build === latest.build || rollback?.bad?.build === latest.build) {
    checked({ at: Date.now(), state: 'failed' })
    return
  }

  log(`prechecking ${currentVersion} → ${latest.version}`)
  const stage = path.join(home, 'update', latest.build)
  let reason = 'download'
  try {
    const response = await fetchImpl(`${serverUrl}/dl/${latest.file}`, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`download HTTP ${response.status}`)
    const archive = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(archive).digest('hex') !== latest.sha256) {
      reason = 'sha256'
      throw new Error('tarball sha256 mismatch')
    }
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 })
    const tarball = path.join(stage, 'download.tgz')
    fs.writeFileSync(tarball, archive, { mode: 0o600 })
    reason = 'unpack'
    await execute('tar', ['-xzf', tarball, '-C', stage], { timeout: 60_000 })
    const pkg = path.join(stage, 'package')
    reason = 'build'
    if (buildId(pkg) !== latest.build) throw new Error('package build mismatch')
    reason = 'selftest'
    const test = await execute(process.execPath, [path.join(pkg, 'bin', 'scorpio.mjs'), 'selftest'], {
      env: { ...childEnv, SCORPIO_HOME: home, SCORPIO_SERVER: serverUrl }, timeout: 60_000, maxBuffer: 1024 * 1024,
    })
    const answer = JSON.parse(test.stdout.trim())
    if (answer.ok !== true || answer.version !== latest.version) throw new Error('selftest did not accept this version')
    reason = 'install'
    await execute(process.execPath, [path.join(pkg, 'bin', 'install.mjs'), '--server', serverUrl], {
      env: { ...childEnv, SCORPIO_HOME: home, SCORPIO_SERVER: serverUrl }, timeout: 5 * 60_000, maxBuffer: 1024 * 1024,
    })
  } catch {
    try { fs.rmSync(stage, { recursive: true, force: true }) } catch { log(`update to ${latest.version}: could not remove the precheck copy`) }
    checked({ at: Date.now(), state: 'failed' })
    if (reason !== 'selftest' && reason !== 'install') {
      log(`update to ${latest.version} could not be prechecked (${reason}); retrying at the next check`)
      return
    }
    try { await whoami() } catch {
      log(`update to ${latest.version} could not be judged; retrying at the next check`)
      return
    }
    writeJson(path.join(home, 'state', 'skip.json'), {
      build: latest.build, version: latest.version, at: Date.now(), reason,
    })
    log(`update to ${latest.version} failed ${reason}; this build was skipped`)
    return
  }
  try { fs.rmSync(stage, { recursive: true, force: true }) } catch { log(`updated to ${latest.version}; could not remove the precheck copy`) }
  log(`updated to ${latest.version}`)
  checked({ at: Date.now(), state: 'new', version: latest.version })
}
