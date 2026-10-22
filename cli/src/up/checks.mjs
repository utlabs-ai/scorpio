import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const home = () => process.env.SCORPIO_HOME || path.join(os.homedir(), '.scorpio')
export const words = (language, en, zh) => language === 'zh' ? zh : en

function executable(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    try { fs.accessSync(file, fs.constants.X_OK); return file } catch {}
  }
  return null
}

function call(command, args = []) {
  if (!command) return { ok: false, text: '' }
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64_000 })
  return { ok: result.status === 0, text: String(result.stdout || result.stderr || '').trim() }
}

export function systemCheck(language) {
  const arch = os.arch()
  const supportedArch = arch === 'x64' || arch === 'arm64'
  const platform = process.platform
  if (platform === 'darwin') return {
    status: supportedArch ? 'ok' : '--', label: words(language, 'System', '系统'),
    detail: 'macOS ' + arch, usable: supportedArch,
  }
  if (platform === 'linux') {
    const libc = call(executable('getconf'), ['GNU_LIBC_VERSION']).text
    const match = libc.match(/^glibc (\d+)\.(\d+)/)
    const versionOk = !!match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 28))
    return {
      status: supportedArch && versionOk ? 'ok' : '--', label: words(language, 'System', '系统'),
      detail: 'Linux ' + arch + ', ' + (libc || 'glibc unknown'), usable: supportedArch && versionOk,
    }
  }
  return { status: '--', label: words(language, 'System', '系统'), detail: platform + ' ' + arch, usable: false }
}

export function toolsCheck(language) {
  const hash = process.platform === 'darwin' ? 'shasum' : 'sha256sum'
  const names = ['curl', 'tar', hash]
  const missing = names.filter((name) => !executable(name))
  const detail = missing.length
    ? words(language, 'missing: ', '缺少：') + missing.join(', ')
    : language === 'zh' ? names.join('、') : names.join(', ')
  return { status: missing.length ? '--' : 'ok', label: words(language, 'Tools', '工具'), detail, usable: !missing.length }
}

export function agentCheck(kind, language) {
  const name = kind === 'claude' ? 'Claude Code' : 'Codex'
  const command = executable(kind)
  if (!command) return { kind, name, available: false, status: '--', label: name, detail: words(language, 'not installed', '未安装') }
  const versionResult = call(command, ['--version'])
  const version = kind === 'claude'
    ? versionResult.text.split(/\s/)[0]
    : versionResult.text.replace(/^codex-cli\s+/, '').split(/\s/)[0]
  const available = !!(versionResult.ok && version)
  return { kind, name, available, status: available ? 'ok' : '--', label: name,
    detail: available ? version : words(language, 'could not run --version', '无法运行 --version') }
}

export function nodeCheck(language) {
  const node = executable('node')
  const result = call(node, ['-p', 'process.versions.node'])
  const major = Number(result.text.split('.')[0])
  const ready = result.ok && major >= 22
  return { status: ready ? 'ok' : '..', label: 'Node',
    detail: ready ? 'v' + result.text : words(language, '22 missing; goes in ~/.scorpio/node', '需要 22 或更新版本，将安装到 ~/.scorpio/node') }
}

export function herdrCheck(language) {
  const command = executable('herdr')
  const result = call(command, ['--version'])
  const ready = !!(command && result.ok)
  return { status: ready ? 'ok' : '..', label: 'Herdr',
    detail: ready ? result.text : words(language, 'missing; goes in ~/.local/bin', '未安装，将安装到 ~/.local/bin') }
}

export function cliCheck(language) {
  const file = path.join(home(), 'bin', 'scorpio')
  let version = ''
  try { version = JSON.parse(fs.readFileSync(path.join(home(), 'app', 'package.json'), 'utf8')).version || '' } catch {}
  const ready = fs.existsSync(file)
  return { status: ready ? 'ok' : '..', label: 'Scorpio CLI',
    detail: ready ? version + '  ~/.scorpio/bin/scorpio' : words(language, 'missing; installs latest', '未安装，将安装最新版') }
}

export function daemonCheck(language) {
  let running = false
  try {
    const pid = Number(fs.readFileSync(path.join(home(), 'state', 'daemon.pid'), 'utf8'))
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 0)
      running = /src\/daemon\/main\.mjs/.test(call(executable('ps'), ['-o', 'command=', '-p', String(pid)]).text)
    }
  } catch {}
  return { status: running ? 'ok' : '..', label: words(language, 'Daemon', 'daemon'),
    detail: running ? words(language, 'running', '运行中')
      : words(language, 'not running; stays on once set up', '未运行，安装后常驻') }
}

export function approvalCheck(language) {
  const file = path.join(home(), 'bin', 'scorpio')
  let approved = false
  if (fs.existsSync(file)) {
    const response = call(file, ['whoami'])
    try { approved = !!JSON.parse(response.text).account } catch {}
  }
  return { status: approved ? 'ok' : '..', label: words(language, 'This computer', '这台电脑'),
    detail: approved ? words(language, 'approved', '已授权')
      : words(language, 'not approved yet; approve it on the web', '未授权，稍后在网页上授权') }
}
