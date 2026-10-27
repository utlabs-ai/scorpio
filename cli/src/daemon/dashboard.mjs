import { terminalText } from '../terminal-text.mjs'
import { LISTEN_FRAMES, WAVE_FRAMES, pobi } from '../common/pobi.mjs'

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
export const widthOf = (value) => [...strip(value)].reduce((n, c) => n + (/^[\u0300-\u036f]$/.test(c) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(c) ? 2 : 1), 0)
const fit = (value, width) => {
  const text = String(value ?? '')
  if (widthOf(text) <= width) return text
  let out = ''
  for (const char of text) { if (widthOf(out + char) > width - 1) break; out += char }
  return `${out}…`
}
const pad = (value, width) => fit(value, width) + ' '.repeat(Math.max(0, width - widthOf(fit(value, width))))
const hhmm = (value) => value ? new Date(value).toTimeString().slice(0, 5) : '—'
const number = (n) => Number(n || 0).toLocaleString('en-US')
const zh = (language) => language === 'zh'
const shortName = (name) => String(name || '').split('@')[0]

export function pobiMode({ connected = true, agents = [] } = {}) {
  if (!connected) return 'disconnected'
  if (agents.some((a) => a.status === 'blocked')) return 'blocked'
  if (agents.some((a) => a.status === 'working')) return 'working'
  return 'idle'
}

const animationFrame = (frames, elapsed) => {
  let remaining = elapsed
  for (const frame of frames) {
    if (remaining < frame.ms) return frame.sprite
    remaining -= frame.ms
  }
  return null
}

export function pobiSprite(mode, second = 0, phaseMs = Infinity, event = null) {
  if (mode === 'disconnected') return pobi({ lamp: second % 2 ? '@' : ' ', eye: 'closed' })
  if (event?.kind === 'recovered' && event.elapsed < 2000) return pobi({ eye: 'happy' })
  if (event?.kind === 'delivery' && event.elapsed < 4000) return pobi({ ...(animationFrame(WAVE_FRAMES, event.elapsed) || {}), lamp: '@' })
  if (mode === 'blocked') return pobi({ ...(animationFrame(LISTEN_FRAMES, phaseMs) || { eye: 'right' }), lamp: '!' })
  if (mode === 'idle') return pobi({ eye: 'closed', ant: second % 20 === 0 ? 'R' : 'C' })
  return pobi({ eye: second % 7 === 0 ? 'blink' : 'o', ant: second % 8 === 0 ? 'L' : 'C' })
}

export function createPobiAnimator(now = () => Date.now()) {
  let mode = null, since = 0, event = null
  return {
    current(nextMode) {
      if (nextMode !== mode) { mode = nextMode; since = now(); if (nextMode === 'disconnected') event = null }
      return { phase: now() - since, event: event && { kind: event.kind, elapsed: now() - event.at } }
    },
    note(kind) { event = { kind, at: now() } },
  }
}

export function statusText(agent, language = 'en') {
  const n = Math.max(0, Math.floor(agent.minutes || 0))
  if (agent.status === 'blocked') return zh(language) ? `等待确认 · ${n} 分` : `Needs confirmation · ${n} min`
  if (agent.status === 'starting') return zh(language) ? '启动中' : 'Starting'
  if (agent.status === 'handoff') return zh(language) ? '交接中' : 'Handing off'
  if (agent.status === 'working') return zh(language) ? `运行中 · ${n} 分` : `Running · ${n} min`
  if (agent.idleIn === undefined) return zh(language) ? `空闲 · ${n} 分` : `Idle · ${n} min`
  if (agent.idleIn === null) return zh(language) ? `空闲 · ${n} 分 · 闲置交接已关` : `Idle · ${n} min · idle handoff off`
  const m = Math.max(0, Math.floor(agent.idleIn || 0))
  return zh(language) ? `空闲 · ${n} 分 · ${m} 分后交接` : `Idle · ${n} min · handoff in ${m} min`
}

function connectionText(state, language, now) {
  if (state?.status === 'disconnected') return zh(language) ? '连接断开' : 'Disconnected'
  if (state?.status === 'reconnecting') return zh(language) ? `重新连接中 · 第 ${state.attempt || 1} 次` : `Reconnecting · attempt ${state.attempt || 1}`
  const mins = Math.max(0, Math.floor((now - (state?.since || now)) / 60_000))
  const dur = mins >= 60 ? zh(language) ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${Math.floor(mins / 60)} h ${mins % 60} min` : zh(language) ? `${mins} 分` : `${mins} min`
  const ms = state?.latencyMs
  const latency = ms == null ? '—' : ms > 999 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
  return zh(language) ? `已连接 · ${dur} · 延迟 ${latency}` : `Connected · ${dur} · latency ${latency}`
}

function detectedText(clis, language) {
  if (!Array.isArray(clis)) return zh(language) ? '尚未检测' : 'Not detected yet'
  if (!clis.length) return zh(language) ? '未检测到支持的 agent' : 'No supported agent detected'
  return clis.map((cli) => {
    const label = cli.kind === 'claude' ? 'Claude Code' : cli.kind === 'codex' ? 'Codex' : cli.kind
    return cli.installed ? `${label} ${cli.version || '—'}` : zh(language) ? `${label} 未安装` : `${label} not installed`
  }).join(' · ')
}

function detectedAtText(detectedAt, language) {
  return zh(language) ? `上次检测 ${hhmm(detectedAt)}` : `Last detected ${hhmm(detectedAt)}`
}

function updateText(update, language) {
  if (!update?.at) return ''
  const time = hhmm(update.at)
  if (update.state === 'new') return zh(language) ? `检查更新 ${time} → ${update.version} 下次启动生效` : `Update check ${time}: ${update.version} on next start`
  if (update.state === 'failed') return zh(language) ? `检查更新失败 ${time}` : `Update check ${time}: failed`
  return zh(language) ? `检查更新 ${time} 已是最新` : `Update check ${time}: up to date`
}

function computerValue(computer, max, language) {
  const name = computer.name || '—'
  const note = computer.note ? ` · ${computer.note}` : ''
  const host = computer.hostname ? zh(language) ? `（主机 ${computer.hostname}）` : ` (${computer.hostname})` : ''
  const full = `${name}${host}${note}`
  return fit(widthOf(full) <= max ? full : `${name}${note}`, max)
}

/** Select the product-facing events from the detailed file log. */
export function dashboardLog(record, language = 'en') {
  const raw = String(record.text || '')
  let match
  if ((match = raw.match(/^delivered to (\S+) in .*?, (\d+) up to #(\d+)/))) {
    const who = shortName(match[1])
    return { ...record, text: zh(language) ? `送达 ${who} · ${match[2]} 条 · 至 #${match[3]}` : `Delivered to ${who} · ${match[2]} ${Number(match[2]) === 1 ? 'message' : 'messages'} · up to #${match[3]}` }
  }
  if (raw.startsWith('connection lost:')) return { ...record, text: zh(language) ? '连接断开 · 重新连接中' : 'Disconnected · reconnecting' }
  if ((match = raw.match(/^connection restored: .* after (\d+) s$/))) return { ...record, text: zh(language) ? `连接已恢复 · 断开 ${match[1]} 秒` : `Reconnected · down ${match[1]} s` }
  if ((match = raw.match(/^idle handoff of (\S+) in .*?\(idle (\d+) min\)/))) {
    const who = shortName(match[1])
    return { ...record, text: zh(language) ? `${who} 空闲达 ${match[2]} 分钟 · 已交接并离开` : `${who} idle ${match[2]} min · handed off and left` }
  }
  if ((match = raw.match(/^(\S+) needs confirmation$/))) {
    const who = shortName(match[1])
    return { ...record, text: zh(language) ? `${who} 等待确认 · 查看 /read ${who} · 按键 /keys ${who} …` : `${who} needs confirmation · /read ${who} to view · /keys ${who} to answer` }
  }
  if ((match = raw.match(/^(\S+)'s pane .* shows a dialog/))) {
    const who = shortName(match[1])
    return { ...record, text: zh(language) ? `${who} 启动被对话框阻塞 · 查看 /read ${who}` : `${who} blocked by a startup dialog · /read ${who} to view` }
  }
  if ((match = raw.match(/^update to (\S+) failed: (.+)/))) return { ...record, text: zh(language) ? `更新失败：${match[2]}` : `Update failed: ${match[2]}` }
  if ((match = raw.match(/^updated to (\S+)$/))) return { ...record, text: zh(language) ? `已更新至 ${match[1]} · 下次启动生效` : `Updated to ${match[1]} · takes effect on next start` }
  if ((match = raw.match(/^\/([^ ]+) failed: (.+)/))) return { ...record, text: zh(language) ? `命令执行失败：/${match[1]} · ${match[2]}` : `Command failed: /${match[1]} · ${match[2]}` }
  if ((match = raw.match(/^delivery to .*? failed; (herdr agent prompt exit [^;]+)/))) return { ...record, text: zh(language) ? `命令执行失败：agent prompt · ${match[1]}` : `Command failed: agent prompt · ${match[1]}` }
  if ((match = raw.match(/^\/spawn refused: (.+) not installed$/))) return { ...record, text: zh(language) ? `/spawn 已拒绝：本机未安装 ${match[1]}` : `/spawn refused: ${match[1]} not installed` }
  return null
}

/** Pure screen renderer. Every returned row fits the requested 60–100 columns. */
export function renderDashboard(view = {}) {
  const width = Math.max(60, Math.min(100, view.width || 80))
  const height = Math.max(16, view.height || 24)
  const language = view.language || 'en'
  const unicode = view.utf8 !== false
  const chars = unicode ? { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', tee: '├', end: '┤' } : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', tee: '+', end: '+' }
  const inner = width - 2
  const boxed = (s = '') => `${chars.v}${pad(` ${s}`, inner)}${chars.v}`
  const bar = (title, first = false) => {
    const name = fit(` ${title} `, inner - 2)
    return `${first ? chars.tl : chars.tee}${chars.h}${name}${chars.h.repeat(Math.max(0, inner - 1 - widthOf(name)))}${first ? chars.tr : chars.end}`
  }
  const topics = view.topics || []
  const agents = topics.flatMap((topic) => topic.agents || [])
  const mode = pobiMode({ connected: view.connection?.status !== 'disconnected' && view.connection?.status !== 'reconnecting', agents })
  const now = view.now || Date.now()
  const stats = view.stats || {}
  const labels = zh(language) ? ['席位', '连接', '电脑', '已检测', '已送达'] : ['Seat', 'Connection', 'Computer', 'Detected', 'Delivered']
  const labelWidth = zh(language) ? 8 : 11
  const computerWidth = inner - (width >= 80 ? 26 : 1) - labelWidth
  const today = stats.today?.total ?? 0
  const values = [view.seat || '—', connectionText(view.connection, language, now), computerValue(view.computer || {}, computerWidth, language), detectedText(view.clis, language), zh(language) ? `今日 ${number(today)} 条 · 累计 ${number(stats.total)} 条` : `${number(today)} ${today === 1 ? 'message' : 'messages'} today · ${number(stats.total)} total`]
  const labelLine = (index) => `${pad(labels[index], labelWidth)}${values[index]}`
  const title = `Scorpio daemon ${view.version || '0.0.0'}${view.update?.state === 'new' ? zh(language) ? ` → ${view.update.version} 下次启动生效` : ` → ${view.update.version} on next start` : ''}`
  const lines = [bar(title, true)]
  const head = [labelLine(0), labelLine(1), labelLine(2), labelLine(3), `${' '.repeat(labelWidth)}${detectedAtText(view.detectedAt, language)}`, `${' '.repeat(labelWidth)}${updateText(view.update, language)}`, labelLine(4)]
  if (width >= 80) {
    const sprite = pobiSprite(mode, Math.floor(now / 1000), view.pobi?.phase, view.pobi?.event)
    for (let i = 0; i < 7; i += 1) lines.push(boxed(`${sprite[i].slice(0, 24)} ${head[i]}`))
  } else {
    for (const row of head) lines.push(boxed(row))
  }
  if (view.logout) {
    const label = zh(language) ? '已掉线 · 打开网页重新授权：' : 'Logged out · approve on the web: '
    const url = terminalText(view.logout.url)
    // Put a long link on its own row so its code remains visible and the terminal can recognize it.
    const rows = widthOf(label + url) <= inner - 1 ? [label + url] : [label.trimEnd(), url]
    for (const text of rows) {
      let row = ''
      for (const char of text) {
        if (widthOf(row + char) > inner - 1) { lines.push(boxed(row)); row = '' }
        row += char
      }
      if (row) lines.push(boxed(row))
    }
  }
  lines.push(bar(zh(language) ? `本机参与的主题 · ${topics.length}` : `Topics this computer is in · ${topics.length}`))
  const topicLines = []
  for (const topic of topics) {
    const list = topic.agents || []
    const detail = list.length ? zh(language) ? `${list.length} 个 agent · 今日 ${number(stats.today?.rooms?.[topic.id]?.total)} 条` : `${list.length} agents · ${number(stats.today?.rooms?.[topic.id]?.total)} today` : zh(language) ? '本机无 agent' : 'No agent from this computer'
    topicLines.push(`${pad(terminalText(topic.name || topic.id), Math.max(12, inner - widthOf(detail) - 3))} ${detail}`)
    for (const agent of list) {
      const count = zh(language) ? `${number(stats.today?.rooms?.[topic.id]?.agents?.[agent.name])} 条` : number(stats.today?.rooms?.[topic.id]?.agents?.[agent.name])
      const statusWidth = Math.max(20, inner - 42)
      const status = fit(statusText(agent, language), statusWidth)
      topicLines.push(`   ${pad(shortName(agent.name), 12)}${pad(status, statusWidth)} ${pad(count, 8)} ${agent.pane || '—'}`)
    }
  }
  if (!topicLines.length) topicLines.push(zh(language) ? '本机无 agent' : 'No agent from this computer')
  const logCount = Math.max(2, Math.min(10, height - lines.length - Math.min(topicLines.length, 8) - 4))
  const topicCount = Math.max(1, height - lines.length - logCount - 4)
  const scroll = Math.max(0, Math.min(view.scroll || 0, Math.max(0, topicLines.length - topicCount)))
  for (const row of topicLines.slice(scroll, scroll + topicCount)) lines.push(boxed(row))
  const logRows = (view.logs || []).map((row) => dashboardLog(row, language)).filter(Boolean).slice(-logCount).reverse()
  lines.push(bar(zh(language) ? `日志 · 最近 ${logRows.length} 行` : `Log · last ${logRows.length} lines`))
  for (const row of logRows) {
    const at = row.ts ? new Date(row.ts).toTimeString().slice(0, 8) : ''
    lines.push(boxed(`${at}  ${row.text || row}`))
  }
  for (let i = logRows.length; i < logCount; i += 1) lines.push(boxed())
  lines.push(`${chars.bl}${chars.h.repeat(inner)}${chars.br}`)
  if (view.confirm) {
    lines.push(fit(zh(language) ? '  停止 daemon？本机 agent 继续运行，但不再接收新消息。' : '  Stop the daemon? Agents on this computer keep running but no longer receive messages.', width))
    lines.push(zh(language) ? '  y 停止   其他键取消' : '  y stop   any other key cancel')
  } else lines.push(zh(language) ? '  l 完整日志    u 重新检测    Ctrl-C 停止 daemon' : '  l full log    u redetect    Ctrl-C stop daemon')
  if (!view.color) return lines
  return lines.map((line, index) => {
    if (index === 0 || line.startsWith(chars.tee)) return `\x1b[90m${line}\x1b[0m`
    if (line.includes('连接断开') || line.includes('Disconnected')) return `\x1b[31m${line}\x1b[0m`
    if (line.includes('(!)') || line.includes('等待确认') || line.includes('Needs confirmation') || /(?:延迟|latency) [\d.]+ s/.test(line)) return `\x1b[33m${line}\x1b[0m`
    if (line.includes('(@)')) return line.replace('(@)', `\x1b[${mode === 'disconnected' ? 31 : mode === 'idle' ? 90 : 32}m(@)\x1b[0m`)
    if (line.includes('( )') && mode === 'disconnected') return line.replace('( )', '\x1b[31m( )\x1b[0m')
    return line
  })
}

export function renderLogPage({ rows = [], file = '', language = 'en', width = 80, height = 24, offset = 0, confirm = false } = {}) {
  const size = Math.max(1, height - (confirm ? 3 : 2))
  const start = Math.max(0, rows.length - size - offset)
  const prefix = zh(language) ? '日志 · ' : 'Log · '
  const suffix = zh(language) ? ` · ${number(rows.length)} 行 · l 或 q 返回` : ` · ${number(rows.length)} lines · l/q back`
  const title = prefix + fit(file, width - widthOf(prefix) - widthOf(suffix)) + suffix
  // Rows are the file's lines (ts, level, text joined by tabs). A tab moves the cursor without erasing, so it
  // left the dashboard's text showing in the gaps and made rows wider than fit() counts, wrapping the screen.
  const lines = [title, ...rows.slice(start, start + size).map((row) => fit(String(row).replace(/\t/g, '  '), width))]
  if (confirm) {
    lines.push(fit(zh(language) ? '停止 daemon？本机 agent 继续运行，但不再接收新消息。' : 'Stop the daemon? Agents on this computer keep running but no longer receive messages.', width))
    lines.push(zh(language) ? 'y 停止   其他键取消' : 'y stop   any other key cancel')
  }
  return lines
}
