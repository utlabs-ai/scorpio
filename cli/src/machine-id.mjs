// The computer's machine id, hashed: an invite counts once per computer, so the server keeps a keyed hash of
// sha256(machine id). The raw id never leaves the computer. macOS: IOPlatformUUID; Linux and WSL: /etc/machine-id, else
// /var/lib/dbus/machine-id. null when none can be read (the server then just does not judge that computer).
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export function rawMachineId({
  platform = process.platform,
  read = (f) => fs.readFileSync(f, 'utf8'),
  run = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }),
} = {}) {
  if (platform === 'darwin') {
    try {
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))?.[1].trim() || null
    } catch {
      return null
    }
  }
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const v = read(f).trim()
      if (v) return v
    } catch {}
  }
  return null
}

let memo
/** sha256 hex of the machine id, or null; read once per process (the daemon joins often; ioreg is slow on macOS). */
export function machineId(opts) {
  if (!opts && memo !== undefined) return memo
  const raw = rawMachineId(opts)
  const out = raw ? createHash('sha256').update(raw).digest('hex') : null
  if (!opts) memo = out
  return out
}
