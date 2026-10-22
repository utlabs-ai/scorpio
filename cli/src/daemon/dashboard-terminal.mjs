import readline from 'node:readline'
import { renderDashboard, renderLogPage } from './dashboard.mjs'

export const terminalFrame = (lines) => `\x1b[H${lines.map((line) => `${line}\x1b[K`).join('\r\n')}\x1b[J`

export function createExitConfirmation({ now = () => Date.now(), windowMs = 3000 } = {}) {
  let until = 0
  return {
    key(value) {
      if (until && now() > until) until = 0
      if (value === 'ctrl-c') {
        if (until) return 'stop'
        until = now() + windowMs
        return 'confirm'
      }
      if (until && value === 'y') return 'stop'
      if (until) { until = 0; return 'cancel' }
      return 'none'
    },
    pending() { if (until && now() > until) until = 0; return Boolean(until) },
  }
}

export function createDashboardTerminal({ input = process.stdin, output = process.stdout, env = process.env, state, log, onDetect = () => {}, onStop = () => process.exit(3) } = {}) {
  const enabled = Boolean(input.isTTY && output.isTTY && output.columns >= 60 && !env.CI && env.TERM !== 'dumb')
  if (!enabled) return { enabled: false, paint() {}, close() {} }
  const confirmation = createExitConfirmation()
  let page = 'dashboard', offset = 0, scroll = 0, timer = null, painted = false, closed = false
  const language = /^zh/i.test([env.LC_ALL, env.LC_MESSAGES, env.LANG].find(Boolean) || '') ? 'zh' : 'en'
  const utf8 = /utf-?8/i.test([env.LC_ALL, env.LC_CTYPE, env.LANG].find(Boolean) || '')
  const size = () => ({ width: Math.max(60, Math.min(100, output.columns || 80)), height: output.rows || 24 })
  const paint = () => {
    const view = { ...state(), ...size(), language, utf8, color: !('NO_COLOR' in env), scroll, confirm: confirmation.pending(), logs: log.recent() }
    const recent = log.recent().map((row) => `${row.ts}\t${row.level}\t${row.text}`)
    const rows = offset < recent.length ? recent : log.all()
    const lines = page === 'log' ? renderLogPage({ rows, file: log.file, language, ...size(), offset, confirm: view.confirm }) : renderDashboard(view)
    output.write(terminalFrame(lines))
    painted = true
  }
  const onKey = (text, key = {}) => {
    const value = key.ctrl && key.name === 'c' ? 'ctrl-c' : text
    const action = confirmation.key(value)
    if (action === 'stop') {
      close()
      log(language === 'zh' ? 'Scorpio daemon 已停止。本机 agent 继续运行，但不再接收新消息。' : 'Scorpio daemon stopped. Agents on this computer keep running but no longer receive messages.')
      onStop()
      return
    }
    if (action === 'confirm' || action === 'cancel') { paint(); return }
    if (page === 'log') {
      if (value === 'l' || value === 'q') { page = 'dashboard'; offset = 0 }
      else if (key.name === 'up') offset += 1
      else if (key.name === 'down') offset = Math.max(0, offset - 1)
    } else if (value === 'l') page = 'log'
    else if (value === 'u') onDetect()
    else if (key.name === 'up') scroll = Math.max(0, scroll - 1)
    else if (key.name === 'down') scroll += 1
    paint()
  }
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    input.off('keypress', onKey)
    process.off('SIGWINCH', paint)
    try { input.setRawMode(false) } catch {}
    if (painted) output.write('\x1b[?25h\n')
  }
  readline.emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  input.on('keypress', onKey)
  process.on('SIGWINCH', paint)
  output.write('\x1b[?25l')
  timer = setInterval(paint, 1000)
  timer.unref?.()
  paint()
  return { enabled, paint, close }
}
