import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createScreen, tr } from './screen.mjs'
import { runSetup } from './flow.mjs'
import { UpStepError } from './steps.mjs'
import { herdrPane } from './terminal.mjs'
import { herdr } from './services.mjs'
import { chooseName } from './name.mjs'
import {
  systemCheck, toolsCheck, agentCheck, nodeCheck, herdrCheck,
  cliCheck, daemonCheck, approvalCheck,
} from './checks.mjs'

function promoteBootstrap(screen) {
  const packageDir = process.env.SCORPIO_BOOTSTRAP_PKG_DIR
  if (!packageDir) return
  const root = path.join(os.homedir(), '.scorpio')
  const sourceNode = process.env.SCORPIO_BOOTSTRAP_NODE_DIR
  if (sourceNode) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const target = path.join(root, 'node')
    const candidate = path.join(root, '.node-' + process.pid)
    fs.rmSync(candidate, { recursive: true, force: true })
    fs.cpSync(sourceNode, candidate, { recursive: true })
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(candidate, target)
    process.env.PATH = path.join(target, 'bin') + path.delimiter + process.env.PATH
    screen.write('  [ok] Node ' + process.versions.node + '  ~/.scorpio/node\n')
  }
  const installer = path.join(packageDir, 'bin', 'install.mjs')
  const version = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version
  let installedVersion = null
  try { installedVersion = JSON.parse(fs.readFileSync(path.join(root, 'app', 'package.json'), 'utf8')).version } catch {}
  const launcher = path.join(root, 'bin', 'scorpio')
  const healthy = fs.existsSync(launcher) && spawnSync(launcher, ['help'], { encoding: 'utf8', timeout: 10_000 }).status === 0
  if (installedVersion === version && healthy) return
  const result = spawnSync(process.execPath, [installer, 'install'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  })
  if (result.status !== 0) throw new Error('Scorpio CLI installation failed: ' + String(result.stderr || result.stdout || '').trim())
  screen.write('  [ok] Scorpio CLI ' + version + '  ~/.scorpio/bin/scorpio\n')
  const output = String(result.stdout || '')
  const links = output.match(/^Linked into: (.+)$/m)?.[1]
  const command = output.match(/^(Command: .+|Added Scorpio to PATH .+)$/m)?.[1]
  if (links) screen.write('  ' + tr(screen.language, '[Install skill] ', '[安装 skill] ') + links + '\n')
  if (command) {
    const linkedAt = command.match(/^Command: scorpio \(linked at (.+)\)\.$/)?.[1]
    const rc = command.match(/^Added Scorpio to PATH in (.+);/)?.[1]
    screen.write('  ' + (screen.language === 'zh'
      ? linkedAt ? 'scorpio 已加入 PATH（' + linkedAt + '）'
        : rc ? 'scorpio 的 PATH 已写入 ' + rc + '，新终端生效' : command
      : command) + '\n')
  }
}

export async function runUp({ screen = createScreen() } = {}) {
  try {
    await screen.intro()
    screen.top()
    const system = systemCheck(screen.language)
    await screen.row(system)
    const tools = toolsCheck(screen.language)
    await screen.row(tools)
    await screen.pending('Claude Code')
    const claude = agentCheck('claude', screen.language)
    await screen.row(claude)
    await screen.pending('Codex')
    const codex = agentCheck('codex', screen.language)
    await screen.row(codex)
    await screen.row(nodeCheck(screen.language))
    await screen.row(herdrCheck(screen.language))
    await screen.row(cliCheck(screen.language))
    await screen.row(daemonCheck(screen.language))
    await screen.row(approvalCheck(screen.language))
    await screen.bottom()
    if (!system.usable || !tools.usable) {
      screen.error(tr(screen.language, 'Fix the [--] system or tools items, then run this again.', '先处理标为 [--] 的系统或工具项，再重新运行。'))
      return 1
    }
    if (!claude.available && !codex.available) { screen.noAgent(); return 1 }
    const agent = await screen.choose([claude, codex], process.env.SCORPIO_AGENT || '')
    if (!agent) return 1
    agent.role = chooseName(screen, agent.kind)
    process.env.SCORPIO_AGENT = agent.kind
    promoteBootstrap(screen)
    const result = await runSetup(screen, agent)
    const pane = await herdrPane(result.terminal.bin, result.pane.pane)
    if (!pane?.tab_id) throw new Error('The agent tab could not be found before opening Herdr.')
    await herdr(result.terminal.bin, ['tab', 'focus', pane.tab_id])
    await screen.finish({
      agent, topic: result.topic, workdir: result.workdir,
      herdrBin: result.terminal.bin,
    })
    return 0
  } catch (error) {
    if (error instanceof UpStepError) {
      screen.error(tr(screen.language, 'Step ', '第 ') + error.number + ' (' + error.label + ') ' +
        tr(screen.language, 'stopped: ', '停止：') + error.message)
      screen.error(tr(screen.language, 'Next: ', '下一步：') + error.next)
    } else {
      screen.error(error.message === 'cancelled'
        ? tr(screen.language, 'Setup cancelled.', '安装已取消')
        : tr(screen.language, 'Setup stopped: ', '安装停止：') + error.message)
    }
    return 1
  } finally {
    screen.close()
  }
}
