// Terminal adapter for Herdr (the terminal layer; the CLI layer is in ../cli). Everything the daemon does to a
// terminal goes through here: find a process's pane, list panes and the agent in each, open a tab,
// wait for its shell, type text, read the screen, close a pane. A tmux adapter would offer the same
// functions. Side effects come in through `exec`, so tests can replace the whole terminal.

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// Herdr puts HERDR_BIN_PATH into every pane it runs; use the same binary it does.
export const HERDR_BIN = process.env.HERDR_BIN_PATH || 'herdr'
// Text goes to herdr as one command-line argument, and Linux caps one argument at 128 KiB
// (MAX_ARG_STRLEN). Over that the whole injection fails, every round. Leave room for the rest.
export const MAX_PROMPT_BYTES = 120 * 1024
// A spawned agent's name is also its herdr agent name: herdr's rule.
export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/
// A fresh tab's shell has to finish its own startup before herdr can start an agent in it. On a busy
// Mac that can take more than 30 seconds; keep a bound while waiting for the actual shell prompt.
export const SHELL_READY_SECONDS = 120
export const LABEL = 'Scorpio daemon'

/** The reason herdr gave: it prints {"error":{"code","message"}} on stderr (sometimes stdout), maybe among other lines. */
export function herdrError(error) {
  const lines = String(error?.message || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const rest = (/^Command failed/.test(lines[0] || '') && lines.length > 1 ? lines.slice(1) : lines).join('\n')
  const sources = [error?.stderr, error?.stdout, rest || String(error || '')].map((s) => String(s || '').trim()).filter(Boolean)
  for (const text of sources) {
    for (const piece of [text, ...text.split('\n')]) {
      try {
        const e = JSON.parse(piece.trim()).error
        if (e && (e.code || e.message)) return { code: e.code || '', text: [e.code, e.message].filter(Boolean).join(': ') }
      } catch { /* not JSON */ }
    }
  }
  return { code: '', text: sources.length ? sources[0].replace(/\s+/g, ' ').slice(0, 200) : '' }
}

/** The foreground of a pane is one interactive shell with no arguments: nothing is running there. */
export function shellIdle(info) {
  const fg = info?.foreground_processes || []
  return fg.length === 1 && (fg[0].argv || []).length === 1 && /^-?(sh|bash|zsh|fish|dash|ksh)$/.test(String(fg[0].argv[0]).split('/').pop())
}

/** Last lines of a screen, trailing blanks dropped: what gets quoted back to the room when something is stuck. */
export function tail(screen, lines = 12) {
  return String(screen || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-lines).join('\n')
}

/** Pids from pid up to 1. */
export function ancestry(pid, exec) {
  const chain = []
  for (let p = pid; p > 1 && chain.length < 64 && !chain.includes(p);) {
    chain.push(p)
    try { p = Number(exec('ps', ['-o', 'ppid=', '-p', String(p)]).trim()) } catch { break }
  }
  return chain
}

const syncExec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })

/**
 * Resolve a live agent pane without ever using Herdr's focused-pane fallback. /spawn and an explicit
 * pane= take precedence; then Herdr's caller context, then the process ancestry for direct CLI calls.
 */
export function findOwnPane({ pid = process.pid, exec = syncExec, bin = HERDR_BIN, env = process.env, spawnPane = null, explicitPane = null } = {}) {
  let panes
  try { panes = JSON.parse(exec(bin, ['pane', 'list'])).result.panes || [] } catch { return { reason: 'no-herdr' } }
  const live = (id) => panes.find((p) => p.pane_id === id && p.agent)
  if (spawnPane) {
    if (explicitPane && explicitPane !== spawnPane) return { reason: 'pane-mismatch' }
    return live(spawnPane) ? { pane: spawnPane, via: 'spawn' } : { reason: 'invalid-pane' }
  }
  if (explicitPane) return live(explicitPane) ? { pane: explicitPane, via: 'explicit' } : { reason: 'invalid-pane' }
  if (env.HERDR_ENV === '1' && env.HERDR_PANE_ID && !env.TMUX) {
    try {
      const current = JSON.parse(exec(bin, ['pane', 'current', '--current'])).result.pane
      if (current?.pane_id === env.HERDR_PANE_ID && current.tab_id === env.HERDR_TAB_ID &&
          current.workspace_id === env.HERDR_WORKSPACE_ID && live(current.pane_id)) {
        return { pane: current.pane_id, via: 'environment' }
      }
    } catch { /* no caller context: check the actual process chain */ }
  }
  const mine = new Set(ancestry(pid, exec))
  for (const p of panes) {
    if (!p.agent) continue
    let info
    try { info = JSON.parse(exec(bin, ['pane', 'process-info', '--pane', p.pane_id])).result.process_info } catch { continue }
    const pids = [info.shell_pid, ...(info.foreground_processes || []).map((f) => f.pid)]
    if (pids.some((x) => mine.has(x))) return { pane: p.pane_id, via: 'ancestry' }
  }
  return { reason: 'detached' }
}

export function createHerdr({ bin = HERDR_BIN, exec = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = () => Date.now() } = {}) {
  const run = exec || (async (argv) => (await execFileP(bin, argv, { maxBuffer: 16 * 1024 * 1024 })).stdout)
  const call = async (argv, { text = false } = {}) => {
    const out = await run(argv)
    if (text) return String(out)
    try { return JSON.parse(out) } catch { return out }
  }

  /** Panes with the agent herdr sees in each. null when herdr cannot be asked (then nothing gets pruned). */
  async function panes() {
    try {
      return ((await call(['pane', 'list']))?.result?.panes || []).filter((p) => p.pane_id)
    } catch { return null }
  }
  /** Fresh status of this pane, immediately before typing; null when Herdr cannot confirm an agent. */
  async function paneStatus(pane) {
    try {
      const p = (await call(['pane', 'get', pane]))?.result?.pane
      return p?.pane_id === pane && p.agent ? p.agent_status ?? null : null
    } catch { return null }
  }
  /** Live herdr agents and their names (pane list has no names). */
  async function agents() {
    try { return (await call(['agent', 'list']))?.result?.agents || [] } catch { return null }
  }
  async function read(pane, lines = 200, source = 'recent-unwrapped') {
    try { return await call(['pane', 'read', pane, '--source', source, '--lines', String(lines)], { text: true }) } catch { return '' }
  }
  async function paneWidth(pane) {
    try {
      const layout = (await call(['pane', 'layout', '--pane', pane]))?.result?.layout
      const width = layout?.panes?.find((p) => p.pane_id === pane)?.rect?.width
      // Herdr layout reserves the final column; stty in the same pane reports one fewer.
      return Number.isInteger(width) && width > 1 ? width - 1 : null
    } catch { return null }
  }
  async function processInfo(pane) {
    try { return (await call(['pane', 'process-info', '--pane', pane]))?.result?.process_info || null } catch { return null }
  }
  /** Type text into an agent's input and submit it. herdr refuses when no agent is detected in the pane. */
  async function inject(pane, text) {
    await call(['agent', 'prompt', pane, '--', text])
  }
  /** Same, then wait until the agent is seen working (or blocked). For commands, where we need to know it moved. */
  async function injectAndWatch(pane, text, timeoutMs = 30_000) {
    await call(['agent', 'prompt', pane, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(timeoutMs), '--', text])
  }
  const sendKeys = (pane, ...keys) => call(['pane', 'send-keys', pane, ...keys])
  const sendText = (pane, text) => call(['pane', 'send-text', pane, '--', text])
  const runIn = (pane, command) => call(['pane', 'run', pane, '--', command])
  async function newTab({ label, cwd, env = {}, workspace = process.env.HERDR_WORKSPACE_ID }) {
    const out = await call(['tab', 'create', ...(workspace ? ['--workspace', workspace] : []), '--cwd', cwd, '--label', label,
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--no-focus'])
    return { tab: out?.result?.tab?.tab_id, pane: out?.result?.root_pane?.pane_id }
  }
  async function renameTab(tab, label) { await call(['tab', 'rename', tab, label]) }
  async function closeTab(tab) { await call(['tab', 'close', tab]) }
  /** Close a pane; the whole tab when it is the tab's only pane, so no empty tab is left behind. */
  async function closePane(pane, list = null) {
    const all = list || await panes() || []
    const me = all.find((p) => p.pane_id === pane)
    if (!me) return false
    try {
      if (all.filter((p) => p.tab_id === me.tab_id).length <= 1) await call(['tab', 'close', me.tab_id])
      else await call(['pane', 'close', pane])
      return true
    } catch { return false }
  }
  /**
   * Wait for a new pane's shell: the foreground is just an interactive shell and the prompt is on screen.
   * {ok} / {ok:false} on timeout / {gone} when the pane disappeared / {cancelled} when cancelled() turns true.
   */
  async function waitShell(pane, cancelled = () => false) {
    const deadline = clock() + SHELL_READY_SECONDS * 1000
    for (;;) {
      if (cancelled()) return { ok: false, cancelled: true }
      const info = await processInfo(pane)
      if (shellIdle(info) && (await read(pane, 40)).trim()) return { ok: true }
      if (!info) {
        const list = await panes()
        if (list && !list.some((p) => p.pane_id === pane)) return { ok: false, gone: true }
      }
      if (clock() >= deadline) return { ok: false }
      await sleep(1000)
    }
  }
  /** Start an agent CLI in a pane that sits at its shell prompt. Resolves when herdr detects it ready; rejects with herdr's reason. */
  async function startAgent({ name, kind, pane, argv, timeoutMs = 60_000 }) {
    await call(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', String(timeoutMs), ...(argv.length ? ['--', ...argv] : [])])
  }
  async function tabs() {
    try { return (await call(['tab', 'list']))?.result?.tabs || [] } catch { return null }
  }
  async function workspaces() {
    try { return (await call(['workspace', 'list']))?.result?.workspaces || [] } catch { return null }
  }
  /** Which of herdr's detection rules decided the pane's state (only the rule id: no screen text leaves here). */
  async function explain(pane) {
    try {
      const out = await call(['agent', 'explain', pane, '--json'])
      return out && typeof out === 'object' ? { state: out.state ?? null, rule: out.matched_rule?.id ?? null } : null
    } catch { return null }
  }

  return {
    // Its column in the key table (keys.mjs): how /keys names a key to this terminal.
    adapter: 'herdr',
    bin, panes, paneStatus, paneWidth, agents, read, processInfo, inject, injectAndWatch, sendKeys, sendText, run: runIn, explain,
    newTab, renameTab, closeTab, closePane, waitShell, startAgent, tabs, workspaces, sleep,
    maxPromptBytes: MAX_PROMPT_BYTES, nameOk: (n) => AGENT_NAME.test(n),
  }
}
