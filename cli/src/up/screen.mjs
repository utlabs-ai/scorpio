import { terminalText } from '../terminal-text.mjs'
import fs from 'node:fs'
import os from 'node:os'
import tty from 'node:tty'
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { OPEN_FRAMES, WAVE_FRAMES, WAVE_END, pobi } from './pobi.mjs'
import { qrLines } from './qr.mjs'
import { server } from '../daemon/paths.mjs'

const LOGO = [
  '          (@)',
  '           |                                       _',
  '      .---------.         ___  ___ ___  _ __ _ __ (_) ___',
  "     /  .-----.  \\       / __|/ __/ _ \\| '__| '_ \\| |/ _ \\",
  '    |  |  o o  |  |      \\__ \\ (_| (_) | |  | |_) | | (_) |',
  "     \\  '-----'  /       |___/\\___\\___/|_|  | .__/|_|\\___/",
  "   ()  '-------'  ()                        |_|",
]
export const localeOf = (env = process.env) => {
  const value = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((item) => item)
  return /^zh/i.test(value || '') ? 'zh' : 'en'
}
export const displayWidth = (s) => [...String(s)].reduce((width, ch) => width + (ch.codePointAt(0) > 127 ? 2 : 1), 0)
export const tr = (language, en, zh) => language === 'zh' ? zh : en
export function parseChoiceKey({ text, info }, { two, arrow = 0, arrowUsed = false }) {
  if (info?.ctrl && info?.name === 'c') return { cancel: true }
  if (two && (info?.name === 'up' || info?.name === 'down')) {
    return { arrow: info.name === 'up' ? 0 : 1, arrowUsed: true }
  }
  if (two && (text === '1' || text === '2')) return { index: Number(text) - 1 }
  if (two && info?.name === 'return' && arrowUsed) return { index: arrow }
  if (!two && (text === 'y' || text === 'Y')) return { index: 0 }
  return {}
}

function fit(text, max) {
  if (displayWidth(text) <= max) return String(text)
  let result = ''
  for (const ch of String(text)) {
    if (displayWidth(result + ch) > max - 3) break
    result += ch
  }
  return result + '...'
}

export function frameRow(mark, label, detail, { language = 'en', columns = 80, color = false } = {}) {
  const left = fit(label, 15)
  const body = mark + ' ' + left + ' '.repeat(Math.max(0, 15 - displayWidth(left))) + ' ' + fit(detail, 51)
  const shaded = color && ['[ok]', '[..]', '[--]'].includes(mark)
    ? ({ '[ok]': '\x1b[32m', '[..]': '\x1b[36m', '[--]': '\x1b[31m' })[mark] + mark + '\x1b[0m' + body.slice(mark.length)
    : body
  if (columns < 80) return '  ' + shaded + '\n'
  return '  | ' + shaded + ' '.repeat(Math.max(0, 72 - displayWidth(body))) + ' |\n'
}

function frameLine(title, columns) {
  const total = columns >= 80 ? 76 : Math.max(60, columns - 2)
  const prefix = '+-- ' + fit(title, total - 6) + ' '
  const end = columns >= 80 ? '+' : ''
  return '  ' + prefix + '-'.repeat(Math.max(0, total - displayWidth(prefix) - end.length)) + end + '\n'
}

export async function herdrChoice(input) {
  readline.emitKeypressEvents(input)
  let onKey
  try {
    input.setRawMode(true)
    input.resume()
    return await new Promise((resolve) => {
      onKey = (_, key) => {
        if (key?.name === 'return' || key?.name === 'y') resolve(true)
        else if (key?.name === 'n' || key?.name === 'q' || key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) resolve(false)
      }
      input.on('keypress', onKey)
    })
  } finally {
    if (onKey) input.off('keypress', onKey)
    try { input.setRawMode(false) } finally {
      input.pause()
      input.destroy()
    }
  }
}

export function createScreen({ output = process.stdout, env = process.env, columns = output.columns || 80, now = () => Date.now() } = {}) {
  const language = localeOf(env)
  let fd = null
  try { fd = fs.openSync('/dev/tty', 'r+') } catch {}
  const interactive = fd !== null
  const fast = !interactive || !!env.CI || env.SCORPIO_FAST === '1'
  const color = interactive && output.isTTY && env.TERM !== 'dumb' && !env.NO_COLOR
  const animateOpen = interactive && output.isTTY && !fast && env.SCORPIO_NO_ANIM !== '1' && env.TERM !== 'dumb' && (output.rows || 24) >= 9
  let currentStep = null
  const write = (s) => {
    if (currentStep?.shown) { output.write('\r\x1b[2K'); currentStep.shown = false }
    output.write(s)
    if (currentStep?.running) currentStep.paint()
  }
  const pause = (ms) => fast ? Promise.resolve() : sleep(ms)
  const style = (s, code) => color ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s
  const composeLogo = (sprite) => sprite.map((line, index) => {
    const mark = line.replace('(@)', style('(@)', '1;32'))
    return mark + (columns >= 60 ? style(LOGO[index].slice(24), '1') : '')
  })
  return {
    language, columns, interactive, fast, write, pause,
    startStep(number, label) {
      const animated = !!(output.isTTY && !fast && env.TERM !== 'dumb')
      const frames = ['◐', '◓', '◑', '◒']
      let elapsed = 0
      let started = now()
      let frame = 0
      let finished = false
      let currentLabel = label
      const step = {
        number, running: true, shown: false,
        setLabel(value) { currentLabel = value; step.paint() },
        paint() {
          if (!animated || !step.running) return
          const seconds = Math.floor((elapsed + now() - started) / 1000)
          output.write('\r\x1b[2K  ' + frames[frame++ % frames.length] + ' ' + number + '/6 ' + currentLabel + '  ' + seconds + tr(language, 's', ' 秒'))
          step.shown = true
        },
        pause() {
          if (!step.running) return
          elapsed += now() - started
          step.running = false
          if (step.shown) { output.write('\r\x1b[2K'); step.shown = false }
        },
        resume() { if (!step.running) { started = now(); step.running = true; step.paint() } },
        finish(ok = true, result = currentLabel) {
          if (finished) return
          finished = true
          step.pause()
          clearInterval(timer)
          currentStep = null
          const seconds = Math.max(1, Math.round(elapsed / 1000))
          output.write('  [' + (ok ? 'ok' : '--') + '] ' + number + '/6 ' + result + '  ' + seconds + tr(language, 's', ' 秒') + '\n')
        },
      }
      currentStep = step
      step.paint()
      const timer = animated ? setInterval(() => step.paint(), 180) : null
      timer?.unref()
      return step
    },
    pauseStep() { currentStep?.pause() },
    resumeStep() { currentStep?.resume() },
    stepLabel(value) { currentStep?.setLabel(value) },
    async intro() {
      for (const line of composeLogo(pobi())) {
        write(line.trimEnd() + '\n')
        await pause(45)
      }
      if (animateOpen) {
        let resized = false
        const onResize = () => { resized = true }
        const restore = () => write('\x1b[?25h')
        const onInterrupt = () => { restore(); process.exit(130) }
        process.on('SIGWINCH', onResize)
        process.once('SIGINT', onInterrupt)
        process.once('exit', restore)
        write('\x1b[?25l')
        try {
          for (let index = 0; index < OPEN_FRAMES.length; index += 1) {
            if (resized) break
            if (index > 0) {
              const lines = composeLogo(pobi(OPEN_FRAMES[index].sprite))
              write('\x1b[7A\r' + lines.map((line) => line.trimEnd() + '\x1b[K\n').join(''))
            }
            await pause(OPEN_FRAMES[index].ms)
          }
        } finally {
          restore()
          process.off('SIGWINCH', onResize)
          process.off('SIGINT', onInterrupt)
          process.off('exit', restore)
        }
      } else await pause(250)
      write('\n  ' + style(tr(language, 'An online office connecting you and your agents.', '连接你和 agent 的云端办公室。'), '1') + '\n\n')
      if (language === 'zh') {
        write('  接下来把这台电脑上的 agent 加入主题「Hello Scorpio」，\n  之后就能在手机上和它对话。\n\n')
      } else {
        write('  This brings an agent on this computer into the topic Hello Scorpio,\n  so you can talk to it from your phone.\n\n')
      }
    },
    top() { write(frameLine(tr(language, 'Checking this computer', '检查这台电脑'), columns)) },
    async row(result) {
      write(frameRow('[' + result.status + ']', result.label, result.detail, { language, columns, color }))
      await pause(110)
    },
    async pending(label) {
      if (fast) return
      write(frameRow('[  ]', label, tr(language, 'checking', '检查中'), { language, columns, color }))
      await pause(110)
      write('\x1b[1A\x1b[2K')
    },
    async bottom() {
      write(frameLine(tr(language, '[ok] have it   [..] next up   [--] needs you', '[ok] 已就绪   [..] 接下来安装   [--] 需要你处理'), columns) + '\n')
      await pause(350)
    },
    noAgent() {
      write('  ' + tr(language, 'No agent installed yet. Install one, then run this again:', '尚未安装 agent。安装一个后，再运行一次这条命令：') + '\n\n')
      write('    Claude Code   curl -fsSL https://claude.ai/install.sh | bash\n')
      write('    Codex         curl -fsSL https://chatgpt.com/codex/install.sh | sh\n\n')
      write('  ' + tr(language, 'Nothing was changed.', '这台电脑没有任何改动。') + '\n')
    },
    noTTY() {
      write('  ' + tr(language, 'Use an interactive terminal to choose an agent. Nothing was changed.', '请在交互终端选择 agent。这台电脑没有任何改动。') + '\n')
    },
    error(message) { write('  ' + message + '\n') },
    startApproval(link, code, expiresAt = Date.now() + 15 * 60_000) {
      link = terminalText(link); code = terminalText(code)
      currentStep?.pause()
      write('\n' + frameLine(tr(language, 'Approve this computer', '授权这台电脑'), columns) + '\n')
      let qr = []
      if (interactive && columns >= 60 && env.TERM !== 'dumb') {
        try { qr = qrLines(link, { colors: String(env.TERM).includes('256color') ? 256 : 16 }) } catch { qr = [] }
      }
      const canAnimate = qr.length && interactive && output.isTTY && !fast && env.SCORPIO_NO_ANIM !== '1' &&
        env.TERM !== 'dumb' && (output.rows || 24) >= 15
      const status = (approved, account = '', expired = false) => expired
        ? '  [--] ' + tr(language, 'Approval stopped', '授权已停止')
        : approved ? '  [ok] ' + tr(language, 'Approved. Account: ', '已授权，账号：') + account
          : '  [..] ' + tr(language, 'Waiting for your approval', '等待你授权') + '  ' +
            Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) + 's'
      if (!qr.length) {
        write('  ' + link + '\n  ' + tr(language, 'Code  ', '授权码  ') + code + '\n' + status(false) + '\n')
        return { stop: (account, expired = false) => { write(status(!expired, account, expired) + '\n'); currentStep?.resume() } }
      }
      const captions = language === 'zh'
        ? ['用手机扫码，或打开下面的链接。', '', '授权码  ' + code, '', '页面上显示的码一致，即点「授权」。']
        : ['Scan with your phone, or open the', 'link below.', '', 'Code  ' + code, '', 'Same code on the page? Approve it.']
      for (let index = 0; index < 8; index += 1) write('  ' + qr[index] + '    ' + (captions[index] || '') + '\n')
      const spriteLine = (line) => line.replace('(@)', style('(@)', '1;32')).trimEnd()
      const liveLines = (sprite, approved = false, account = '', expired = false) => [
        ...qr.slice(8).map((line, index) => '  ' + line + '   ' + (index < 7 ? spriteLine(sprite[index]) : '')),
        '', '  ' + link, '', status(approved, account, expired),
      ]
      let region = 13
      let frame = 0
      let timer = null
      let tick = null
      let resized = false
      const restoreCursor = () => write('\x1b[?25h')
      const onInterrupt = () => { process.off('exit', restoreCursor); restoreCursor(); process.exit(130) }
      const paint = (lines) => {
        if (resized) return
        write('\x1b[' + region + 'A\r' + lines.map((line) => line + '\x1b[K\n').join(''))
        region = lines.length
      }
      write(liveLines(pobi(WAVE_END.still)).join('\n') + '\n')
      const onResize = () => { resized = true; if (timer) clearTimeout(timer); if (tick) clearInterval(tick); restoreCursor() }
      if (canAnimate) {
        write('\x1b[?25l')
        process.on('SIGWINCH', onResize)
        process.once('SIGINT', onInterrupt)
        process.once('exit', restoreCursor)
        const advance = () => {
          if (resized) return
          frame = (frame + 1) % WAVE_FRAMES.length
          paint(liveLines(pobi(WAVE_FRAMES[frame].sprite)))
          timer = setTimeout(advance, WAVE_FRAMES[frame].ms)
        }
        timer = setTimeout(advance, WAVE_FRAMES[0].ms)
        tick = setInterval(() => paint(liveLines(pobi(WAVE_FRAMES[frame].sprite))), 1000)
      }
      return {
        stop(account, expired = false) {
          if (timer) clearTimeout(timer)
          if (tick) clearInterval(tick)
          process.off('SIGWINCH', onResize)
          if (canAnimate) {
            process.off('SIGINT', onInterrupt)
            process.off('exit', restoreCursor)
            restoreCursor()
          }
          if (canAnimate && !resized) paint(liveLines(pobi(expired ? WAVE_END.expired : WAVE_END.approved), !expired, account, expired))
          else write(status(!expired, account, expired) + '\n')
          region = 0
          currentStep?.resume()
        },
      }
    },
    async choose(agents, override = '') {
      if (!interactive) { this.noTTY(); return null }
      const available = agents.filter((agent) => agent.available)
      if (override && !available.some((agent) => agent.kind === override)) {
        this.error(tr(language, 'SCORPIO_AGENT is not available.', 'SCORPIO_AGENT 不可用。'))
        return null
      }
      if (available.length === 0) { this.noAgent(); return null }
      const two = available.length === 2 && !override
      const selected = override ? available.find((agent) => agent.kind === override) : available[0]
      if (two) {
        write('  ' + style(tr(language, 'Which agent?', '用哪个 agent？'), '1') + '\n\n')
        write('    [1] Claude Code\n    [2] Codex\n\n')
      } else {
        write('  ' + tr(language, 'Using ', '使用 ') + selected.name + (language === 'zh' ? '。\n\n' : '.\n\n'))
      }
      const prompt = two ? tr(language, 'Type 1 or 2 to start: ', '输入 1 或 2 开始：') : tr(language, 'Type y to start: ', '输入 y 开始：')
      const input = new tty.ReadStream(fd)
      readline.emitKeypressEvents(input)
      input.setRawMode(true)
      input.resume()
      let arrow = 0
      let arrowUsed = false
      try {
        while (true) {
          fs.writeSync(fd, '  ' + prompt)
          const key = await new Promise((resolve) => input.once('keypress', (text, info) => resolve({ text, info })))
          const parsed = parseChoiceKey(key, { two, arrow, arrowUsed })
          if (parsed.cancel) { fs.writeSync(fd, '\n'); throw new Error('cancelled') }
          if (parsed.arrowUsed) {
            arrow = parsed.arrow
            arrowUsed = parsed.arrowUsed
            fs.writeSync(fd, '\n  ' + (arrow === 0 ? 'Claude Code' : 'Codex') + '\n')
            continue
          }
          if (parsed.index !== undefined) {
            fs.writeSync(fd, (key.text || '') + '\n')
            return two ? available[parsed.index] : selected
          }
          fs.writeSync(fd, '\n')
        }
      } finally {
        input.setRawMode(false)
        input.pause()
        input.destroy()
        fd = null
      }
    },
    askLine(prompt) {
      if (!interactive) throw new Error('An interactive terminal is required.')
      if (fd === null) fd = fs.openSync('/dev/tty', 'r+')
      fs.writeSync(fd, prompt)
      const byte = Buffer.alloc(1)
      let answer = ''
      while (answer.length < 100) {
        if (fs.readSync(fd, byte, 0, 1, null) !== 1) break
        const char = byte.toString('utf8')
        if (char === '\n' || char === '\r') break
        answer += char
      }
      return answer.trim()
    },
    async finish({ agent, topic, workdir, herdrBin }) {
      await pause(500)
      write(frameLine(tr(language, 'Done', '完成'), columns) + '\n')
      const url = server() + '/r/' + topic.roomId
      let qr = []
      if (interactive && columns >= 60 && env.TERM !== 'dumb') {
        try { qr = qrLines(url, { colors: String(env.TERM).includes('256color') ? 256 : 16 }) } catch { qr = [] }
      }
      if (qr.length && columns >= 80) {
        for (let i = 0; i < qr.length; i += 1) write('  ' + qr[i] + (i === 0 ? '    ' + tr(language, 'Topic ', '主题 ') + terminalText(topic.name) : '') + '\n')
      } else {
        for (const line of qr) write('  ' + line + '\n')
        write('  ' + tr(language, 'Topic ', '主题 ') + terminalText(topic.name) + '\n')
      }
      write('  ' + url + '\n')
      write('  ' + tr(language,
        'Scan to open the topic on your phone. ' + agent.role + ' will say hello after joining.',
        '手机扫码打开主题；' + agent.role + ' 加入后会向你报到') + '\n\n')
      await pause(450)
      const compact = workdir.replace(os.homedir(), '~')
      write('  ' + tr(language, 'Work dir      ', '工作目录    ') + compact + '\n')
      write('  ' + tr(language, 'After reboot  run scorpio up again', '重启电脑后  再次运行 scorpio up') + '\n')
      write('\n  ' + tr(language,
        'Herdr is running. The daemon and agent run there, and you will keep working in Herdr. If this is your first time using Herdr, complete its onboarding there. Also watch for your agent asking to trust the new work directory.',
        'Herdr 已启动，daemon 和 agent 都在其中运行，之后也一直在 Herdr 中工作。第一次使用 Herdr，请先完成它的新手引导；并留意 agent 是否弹出新工作目录的信任提示。') + '\n\n')
      const later = () => write('  ' + tr(language,
        'Run herdr later to open ' + agent.role + "'s pane.",
        '之后运行 herdr 即可打开 ' + agent.role + ' 的窗格。') + '\n')
      if (!interactive || !output.isTTY) { later(); return }
      write('  ' + tr(language,
        'Jump to Herdr? y yes · n no, I will open it later (Enter = y)',
        '现在打开 Herdr？y 是 · n 否，稍后自行打开（回车 = y）') + '\n')
      if (fd === null) fd = fs.openSync('/dev/tty', 'r+')
      const input = new tty.ReadStream(fd)
      let open
      try { open = await herdrChoice(input) } finally { fd = null }
      if (!open) { later(); return }
      if (fd === null) fd = fs.openSync('/dev/tty', 'r+')
      const result = spawnSync(herdrBin, [], { stdio: [fd, fd, fd], env: process.env })
      if (result.status !== 0) throw new Error('Herdr exited with status ' + result.status)
    },
    close() { if (fd !== null) { try { fs.closeSync(fd) } catch {} } },
  }
}
