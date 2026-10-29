// CLI adapters: one per agent CLI the daemon can start. Each says how to start it with the user approval settings and with an explicit model and effort, which dialogs must never be touched, and
// whether it needs keep-alives. The daemon answers no dialog itself.
// Defaults can be overridden per computer in ~/.scorpio/config.json: {"spawn": {"claude": [args…]}}.

import path from 'node:path'
import { CONFIG_FILE, LAUNCHER, STATE_DIR, readJson } from '../../daemon/paths.mjs'

import { approvalSettings } from './codex-settings.mjs'
import { CODEX_DIALOG_WORDS, cursorMenu, visibleMenu } from '../../daemon/approval-menu.mjs'

export const CLIS = {
  claude: {
    label: 'Claude Code',
    args: ['--model', 'claude-opus-5-5', '--effort', 'medium'],
    // Its prompt cache lives an hour; a quiet agent loses it unless touched.
    keepalive: true,
    usage: 'quota-api', // its login asks the API behind its /usage panel (usage.mjs)
  },
  codex: {
    label: 'Codex',
    // Don't let Codex open with "update now?": one Enter in that dialog runs npm install -g on someone's computer.
    args: ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium', '-c', 'check_for_update_on_startup=false'],
    // OpenAI does not say how long its cache lives under a ChatGPT login; keep-alives are the traffic most
    // like "a program using the account", so none.
    keepalive: false,
    usage: 'app-server', // asked through its app-server (usage.mjs)
  },
}
export const KINDS = Object.keys(CLIS)

// Keep the whole Codex definition stable: its trust is keyed by the definition hash.
export const codexHookDefinition = (launcher = LAUNCHER) => `hooks.PermissionRequest=[{matcher=".*",hooks=[{type="command",command=${JSON.stringify(`${launcher} approval-hook codex`)},timeout=10}]}]`
export function fullPermission(kind, args = []) {
  const is = (flags, value) => args.some((arg, i) => flags.includes(arg) && args[i + 1] === value || flags.some((flag) => arg === `${flag}=${value}`))
  return kind === 'claude'
    ? args.includes('--dangerously-skip-permissions') || is(['--permission-mode'], 'bypassPermissions')
    : args.includes('--dangerously-bypass-approvals-and-sandbox') || args.includes('--yolo') || is(['--ask-for-approval', '-a'], 'never')
}

export function autoPermission(kind, args = []) {
  const is = (flags, value) => args.some((arg, i) => flags.includes(arg) && args[i + 1] === value || flags.some((flag) => arg === `${flag}=${value}`))
  return kind === 'claude' ? is(['--permission-mode'], 'auto') : args.includes('--approve-for-me') || args.includes('--not-so-yolo')
}

export const permOf = (kind, args = []) => fullPermission(kind, args) ? 'all' : autoPermission(kind, args) ? 'auto' : 'ask'

export function argsFor(kind, config = readJson(CONFIG_FILE), perm = 'ask') {
  const custom = config?.spawn?.[kind]
  const own = Array.isArray(custom) && custom.every((a) => typeof a === 'string')
  const args = [...(own ? custom : CLIS[kind].args)]
  if (!own && perm === 'all') args.push(...(kind === 'claude' ? ['--dangerously-skip-permissions'] : ['--ask-for-approval', 'never', '--sandbox', 'danger-full-access']))
  if (!own && perm === 'auto') args.push(...(kind === 'claude' ? ['--permission-mode', 'auto'] : ['--approve-for-me']))
  if (kind === 'codex' && !own && perm === 'ask' && approvalSettings().policy === undefined) args.push('--ask-for-approval', 'on-request')
  if (!fullPermission(kind, args) && !(kind === 'codex' && autoPermission(kind, args))) args.push(...(kind === 'claude' ? ['--settings', path.join(STATE_DIR, 'hooks', 'claude.json')] : ['-c', codexHookDefinition()]))
  return args
}

/** Model and effort in a CLI's arguments (the defaults, or a running agent's command line). */
export function modelOf(kind, args = []) {
  const after = (...flags) => { for (const f of flags) { const i = args.indexOf(f); if (i >= 0 && args[i + 1]) return args[i + 1] } return null }
  const eq = (flag) => args.map((a) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : null)).find(Boolean) || null
  if (kind === 'claude') return { model: after('--model') || eq('--model'), effort: after('--effort') || eq('--effort') }
  return { model: after('-m', '--model') || eq('--model'), effort: args.map((a) => /^model_reasoning_effort=(.+)$/.exec(a)?.[1]).find(Boolean) || null }
}

/** The arguments with model and/or effort replaced (or added). */
export function withModel(kind, args, { model = null, effort = null } = {}) {
  const out = [...args]
  const set = (flags, value) => {
    const i = out.findIndex((a) => flags.includes(a))
    if (i >= 0) out[i + 1] = value
    else out.push(flags[0], value)
  }
  if (kind === 'claude') {
    if (model) set(['--model'], model)
    if (effort) set(['--effort'], effort)
  } else {
    if (model) set(['-m', '--model'], model)
    if (effort) {
      const i = out.findIndex((a) => /^model_reasoning_effort=/.test(a))
      if (i >= 0) out[i] = `model_reasoning_effort=${effort}`
      else out.push('-c', `model_reasoning_effort=${effort}`)
    }
  }
  return out
}

/** Model and effort as the room should hear them, read off the arguments actually used. */
export function modelText(kind, args) {
  const { model, effort } = modelOf(kind, args)
  return [model, effort && (kind === 'claude' ? `effort ${effort}` : `reasoning ${effort}`)].filter(Boolean).join(', ') || 'default model'
}

// Dialogs a CLI opens by itself that must never be answered: Enter selects the first option, which
// here is "update now". Seen on screen, the daemon types nothing.
export const NEVER_ANSWER = /Update available|Update now|Skip until next version/i

// Herdr's blocked status is the only source of dialog state: no screen text makes a pane blocked. One case
// lifts it: Herdr 0.9.5 also says blocked for an idle Codex whose screen only quotes Codex's folder-trust or
// hook-review dialog (a message's lines start with │). Such a pane is not blocked when every line with that
// wording is quoted, no menu is on screen (Codex's own input is at the bottom) and no approval hook waits for it.
// Without the screen a Herdr-blocked pane stays blocked. Herdr does not report Codex's "Hooks need review" at all;
// a /spawn stopped there gets its card from the stall (seat.mjs).
export function dialogBlocked(status, { kind = null, screen = null, hookWaiting = false } = {}) {
  if (status !== 'blocked') return false
  if (kind !== 'codex' || screen == null || hookWaiting) return true
  const worded = String(screen).split('\n').filter((line) => CODEX_DIALOG_WORDS.some((words) => line.includes(words)))
  return !worded.length || worded.some((line) => !line.trimStart().startsWith('│')) || Boolean(cursorMenu(screen, 'codex') || visibleMenu(screen, null, 'codex'))
}

// Every other dialog (trust this folder, CLAUDE.md imports from outside it, the no-approval mode's warning) is
// the person's to answer, never the daemon's: herdr reports the pane blocked, the daemon types
// nothing into it; the owner answers the menu on their phone or computer.

/** Is the CLI of this kind in the pane's foreground (herdr's process info), not a shell it exited to? */
export function runsCli(info, kind) {
  const base = (a) => String(a || '').split('/').pop()
  // An npm-installed CLI can show as node running its launcher (node …/bin/codex).
  return (info?.foreground_processes || []).some((p) => p.name === kind || base(p.argv?.[0]) === kind ||
    (/^node(js)?$/.test(base(p.argv?.[0])) && base(p.argv?.[1]) === kind))
}

// Claude Code gives up on an API call after its own ten retries and stops at its prompt, the error the
// last thing in the conversation ("● API Error: Connection dropped (ECONNRESET)", wrapped to the pane's
// width). Only network failures count: told to carry on, it tries again; a usage limit or a refused
// request would only fail again.
const NETWORK_ERROR = /Connection (dropped|error|closed|reset|refused)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|timed out/i
const RULE = /^\s*─{8,}/ // the lines above and below Claude Code's input box

/**
 * Did this agent's last turn end on a network API error? Only the conversation is read: what is above
 * the input box (the status line under it may say [API Error] about something else), and only its last
 * block (a prompt or a reply after the error means it went on). Claude Code only; false for the rest.
 */
export function stoppedOnNetworkError(kind, screen) {
  if (kind !== 'claude') return false
  const lines = String(screen || '').split('\n')
  const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []))
  if (rules.length < 2) return false
  const above = lines.slice(0, rules.at(-2))
  const start = above.findLastIndex((l) => /^\s*[●⏺⎿❯]/.test(l))
  if (start < 0) return false
  const block = above.slice(start).join(' ').replace(/\s+/g, ' ').trim()
  return /^[●⏺⎿]\s*API Error:/.test(block) && NETWORK_ERROR.test(block)
}
