import fs from 'node:fs'
import os from 'node:os'
import { command, cli, api } from './services.mjs'
import { currentAccount, authorize } from './auth.mjs'
import { herdrBinary, herdrRunning, existingHerdrWorkspace, ensureHerdr, ensureHerdrWorkspace } from './terminal.mjs'
import { chooseTopic, rememberedTopic } from './topic.mjs'
import { existingAgentPane, ensureAgentPane, registeredPane } from './agent.mjs'
import { hostOnline, waitHostOnline, memberList, localHostName } from './room.mjs'
import { chooseName, onlineNameTaken } from './name.mjs'
import { workspaceFor, ensureDir } from '../workspace.mjs'
import { daemonPid } from '../daemon/pid.mjs'
import { executeSteps } from './steps.mjs'
import { tr } from './screen.mjs'

const label = (screen, en, zh) => tr(screen.language, en, zh)
const done = (value) => ({ done: true, value })

export function agentStepResult({ screen, agent, pane }) {
  return pane.waiting
    ? label(screen, 'Agent started in Herdr: ' + agent.role + '. Its pane is waiting for an answer.',
      'agent 已在 Herdr 中启动：' + agent.role + '，它的窗格在等一个回答')
    : label(screen, 'Agent started in Herdr: ' + agent.role, 'agent 已在 Herdr 中启动：' + agent.role)
}

export async function runSetup(screen, agent) {
  const context = { screen, agent }
  await executeSteps([
    {
      number: 1, key: 'account', label: label(screen, 'Waiting for your approval: scan the QR code above or open the link', '等待你授权：用手机扫上方二维码，或打开链接'),
      result: () => label(screen, 'Computer authorized. Account: ' + context.account.account, '电脑已授权，账号：' + context.account.account),
      check: async () => { const who = await currentAccount(); return who ? done(who) : null },
      run: async () => authorize(screen),
    },
    {
      number: 2, key: 'terminal', label: label(screen, 'Checking Herdr', '正在检查 Herdr'),
      result: () => label(screen, 'Herdr ready. Workspace: Scorpio (~/.scorpio/topics)', 'Herdr 已就绪，工作区：Scorpio（~/.scorpio/topics）'),
      check: async () => {
        const bin = herdrBinary()
        if (!bin || !await herdrRunning(bin)) return null
        const workspaceId = await existingHerdrWorkspace(bin)
        if (!workspaceId) return null
        const version = await command(bin, ['--version'], { json: false })
        return done({ bin, version, workspaceId })
      },
      run: async () => {
        const terminal = await ensureHerdr((phase) => screen.stepLabel(phase === 'download'
          ? label(screen, 'Downloading Herdr', '正在下载 Herdr')
          : label(screen, 'Starting Herdr', '正在启动 Herdr')))
        screen.stepLabel(label(screen, 'Creating the Scorpio workspace in Herdr', '正在创建 Scorpio 工作区'))
        const workspaceId = await ensureHerdrWorkspace(terminal.bin)
        return { ...terminal, workspaceId }
      },
    },
    {
      number: 3, key: 'daemon', label: label(screen, 'Opening the “Scorpio daemon” tab in Herdr and starting the daemon', '正在 Herdr 中新开「Scorpio daemon」标签页并启动 daemon'),
      result: () => label(screen, 'Daemon running. Herdr tab: Scorpio daemon', 'daemon 已启动，Herdr 标签页：Scorpio daemon'),
      check: async () => { const pid = daemonPid(); return pid ? done({ status: 'running', pid }) : null },
      run: async () => {
        const result = await cli('daemon', [], { timeout: 30_000, env: { ...process.env, HERDR_WORKSPACE_ID: context.terminal.workspaceId } })
        if (!['started', 'running'].includes(result.status)) throw new Error(result.next || 'The daemon did not start.')
        return result
      },
    },
    {
      number: 4, key: 'topic', label: label(screen, 'Reading your topics', '正在读取你的主题'),
      result: () => label(screen, 'Topic selected: ' + context.topic.name, '已选定主题：' + context.topic.name),
      check: async () => {
        const id = rememberedTopic()
        if (!id) return null
        const result = await api('GET', '/rooms')
        const room = (result.rooms || []).find((item) => item.roomId === id && item.status === 'active')
        return room ? done(room) : null
      },
      run: async () => chooseTopic(screen),
      after: async () => {
        context.host = await hostOnline(context.topic.roomId, context.account.account) ||
          await waitHostOnline(context.topic.roomId, context.account.account)
        for (;;) {
          const members = await memberList(context.topic.roomId)
          if (!members) throw new Error('Could not check names in this topic.')
          const existing = await existingAgentPane({ agent, account: context.account.account,
            topic: context.topic, herdrBin: context.terminal.bin })
          const fullName = agent.role + '@' + context.account.account
          const ownMember = members.find((member) => member.name === fullName)
          const ownName = existing && registeredPane(context.topic.roomId, fullName) === existing.pane &&
            ownMember?.host === localHostName(context.account.account) ? fullName : null
          if (!onlineNameTaken(members, agent.role, ownName)) break
          screen.pauseStep()
          try {
            screen.error(label(screen, 'That name is already used by someone online in this topic. Choose another.', '这个名字在该主题中已有在线成员，请换一个。'))
            agent.role = chooseName(screen, agent.kind, { force: true })
          } finally { screen.resumeStep() }
        }
      },
    },
  ], context)
  await executeSteps([
    {
      number: 5, key: 'workdir', label: label(screen, 'Creating the work directory', '正在创建工作目录'),
      result: () => label(screen, 'Work directory created: ' + context.workdir.replace(os.homedir(), '~'), '工作目录已创建：' + context.workdir.replace(os.homedir(), '~')),
      check: async () => {
        const directory = workspaceFor(context.topic.roomId)
        try {
          const stat = fs.lstatSync(directory)
          return stat.isDirectory() && !stat.isSymbolicLink() ? done(directory) : null
        } catch { return null }
      },
      run: async () => ensureDir(workspaceFor(context.topic.roomId)),
    },
  ], context)
  await executeSteps([
    {
      number: 6, key: 'pane', label: label(screen,
        'Opening the “' + agent.role + '” tab in Herdr and starting ' + agent.name,
        '正在 Herdr 中新开「' + agent.role + '」标签页并启动 ' + agent.name),
      result: () => agentStepResult(context),
      next: label(screen, 'Run `herdr` to open the workspace and check what is holding up the agent pane; after handling it, run `scorpio up` again.', '运行 `herdr` 打开工作区，查看 agent 窗格停在何处；处理后再次运行 `scorpio up`。'),
      check: async () => {
        const existing = await existingAgentPane({
          agent, account: context.account.account, topic: context.topic, herdrBin: context.terminal.bin,
        })
        return existing ? done(existing) : null
      },
      run: async () => ensureAgentPane({
        agent, account: context.account.account, topic: context.topic, workdir: context.workdir,
        herdrBin: context.terminal.bin, workspaceId: context.terminal.workspaceId,
      }),
    },
  ], context)
  return context
}
