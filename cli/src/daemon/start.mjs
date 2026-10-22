// `scorpio daemon`: start this computer's daemon in its own Herdr tab, or say it already runs.
// No arguments; one daemon serves every room on the computer, and /spawn says where each agent works.
// Idempotent. The tab does not take focus; an empty "Scorpio daemon" tab (Herdr restores tabs as
// bare shells after a restart) is reused. Whether it runs is decided by the pid, not by the tab.
// It always runs from the installed copy (~/.scorpio/app), never from a checkout that may be deleted.

import fs from 'node:fs'
import path from 'node:path'
import { HOME, PKG_DIR, TOKEN_FILE, isDefaultHome, server } from './paths.mjs'
import { daemonPid } from './pid.mjs'
import { createHerdr, LABEL as DEFAULT_LABEL, shellIdle } from '../adapters/terminal/herdr.mjs'

const LABEL = isDefaultHome()
  ? DEFAULT_LABEL : `${DEFAULT_LABEL} · ${new URL(server()).hostname}`

// Carried into the daemon's tab: which home and server, and staging's faster update checks (main.mjs updateIntervals).
const TAB_ENV = ['SCORPIO_HOME', 'SCORPIO_SERVER', 'SCORPIO_UPDATE_CHECK_MS']
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const runningPid = () => daemonPid()

export async function startDaemon({ terminal = createHerdr() } = {}) {
  const pid = runningPid()
  if (pid) return { status: 'running', pid, note: 'The Scorpio daemon already runs on this computer; nothing to do.' }
  const [major] = process.versions.node.split('.').map(Number)
  if (major < 22) return { error: 'node_too_old', next: `The daemon needs Node 22 or newer (this is ${process.versions.node}). Install a newer Node, then run scorpio daemon again.` }
  if (!fs.existsSync(TOKEN_FILE)) return { error: 'not_logged_in', next: 'No token on this computer yet. Run `scorpio login` (or join a topic first), then run scorpio daemon again.' }
  if (!await terminal.panes()) return { error: 'no_herdr', next: 'Herdr is not installed or not running on this computer, so there is no daemon here: agents run `scorpio wait` in the foreground instead. Install Herdr (https://herdr.dev) to have messages delivered.' }

  const installed = path.join(HOME, 'app', 'src', 'daemon', 'run-daemon.sh')
  const local = path.join(PKG_DIR, 'src', 'daemon', 'run-daemon.sh')
  const script = fs.existsSync(installed) ? installed : local
  const note = script === local && path.resolve(PKG_DIR) !== path.resolve(HOME, 'app')
    ? `Not installed in ${path.join(HOME, 'app')}; running from ${PKG_DIR}, so it stops if that directory goes away.` : undefined

  // An empty tab of ours: right label, nothing but an interactive shell in front. A tab running the loop
  // has sh and node in front and is never typed into.
  let pane = null
  for (const tab of (await terminal.tabs() || []).filter((t) => t.label === LABEL)) {
    for (const p of (await terminal.panes() || []).filter((x) => x.tab_id === tab.tab_id)) {
      if (shellIdle(await terminal.processInfo(p.pane_id))) { pane = p.pane_id; break }
    }
    if (pane) break
  }
  if (!pane) {
    const workspace = process.env.HERDR_WORKSPACE_ID || (await terminal.workspaces() || [])[0]?.workspace_id
    const env = Object.fromEntries(TAB_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]))
    try { pane = (await terminal.newTab({ label: LABEL, cwd: HOME, env, workspace })).pane } catch (e) {
      return { error: 'no_tab', next: `Could not open the "${LABEL}" Herdr tab: ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}` }
    }
    if (!pane) return { error: 'no_tab', next: `Herdr opened a tab but did not say which pane; look for a "${LABEL}" tab.` }
  }
  // exec: when the loop ends (another daemon runs, or the code is gone) the shell exits and the tab closes.
  // SCORPIO_NODE: this Node passed the version check; the tab's shell may put an older one first (node.mjs).
  const envPrefix = [...TAB_ENV.filter((k) => process.env[k]).map((k) => `${k}=${quote(process.env[k])}`), `SCORPIO_NODE=${quote(process.execPath)}`].join(' ')
  try { await terminal.run(pane, `exec ${envPrefix ? `env ${envPrefix} ` : ''}sh ${quote(script)}`) } catch (e) {
    return { error: 'no_loop', next: `The tab is there (pane ${pane}) but the loop did not start: ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}` }
  }
  for (let i = 0; i < 10; i += 1) {
    await sleep(1000)
    const now = runningPid()
    if (now) return { status: 'started', pid: now, pane, tab: LABEL, ...(note ? { note } : {}) }
  }
  return { error: 'not_started', next: `The "${LABEL}" tab is open (pane ${pane}) but no daemon showed up within 10 seconds; read that tab's output.` }
}
