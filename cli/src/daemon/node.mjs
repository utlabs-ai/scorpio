// The daemon needs Node 22 or newer: its room connections are Node's built-in WebSocket. The node that
// ran `scorpio daemon` passed that check, but the tab's own shell may put an older one first (nvm's
// default alias), and then the rooms are only read once a minute and the computer shows offline (seen on
// a Mac with nvm's Node 20). So the daemon looks for a newer Node on this computer and runs
// on that one instead.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const MIN_NODE = 22

const parts = (v) => (/^v?(\d+)\.?(\d+)?\.?(\d+)?/.exec(String(v || '').trim()) || []).slice(1).map((x) => Number(x || 0))
const newerFirst = (a, b) => { const x = parts(a), y = parts(b); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]) }

/**
 * A Node binary on this computer whose major is MIN_NODE or more, or null: SCORPIO_NODE (the one that ran
 * `scorpio daemon`), then nvm's versions newest first, then the usual places.
 */
export function newerNode({
  env = process.env, home = os.homedir(), exists = (p) => fs.existsSync(p),
  list = (dir) => { try { return fs.readdirSync(dir) } catch { return [] } },
  versionOf = (bin) => spawnSync(bin, ['-v'], { encoding: 'utf8', timeout: 10_000 }).stdout || '',
} = {}) {
  const nvm = path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node')
  const fromNvm = list(nvm).filter((v) => parts(v)[0] >= MIN_NODE).sort(newerFirst).map((v) => path.join(nvm, v, 'bin', 'node'))
  const candidates = [path.join(env.SCORPIO_HOME || path.join(home, '.scorpio'), 'node', 'bin', 'node'), env.SCORPIO_NODE,
    ...fromNvm, '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', path.join(home, '.volta', 'bin', 'node')]
  for (const bin of new Set(candidates.filter(Boolean))) {
    if (exists(bin) && parts(versionOf(bin))[0] >= MIN_NODE) return bin
  }
  return null
}
