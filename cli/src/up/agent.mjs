import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHerdr, herdrError } from '../adapters/terminal/herdr.mjs'
import { readRegistry } from '../daemon/registry.mjs'
import { server } from '../daemon/paths.mjs'
import { homeDir, privateFile, readJson, writeJson } from './services.mjs'
import { herdrPane } from './terminal.mjs'
import { setTimeout as sleep } from 'node:timers/promises'

const paneFile = path.join(homeDir, 'state', 'up-panes.json')
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'"
const fullName = (agent, account) => agent.role + '@' + account

export function herdrAgentName(role, number = 1) {
  if (number === 1) return role
  const suffix = '-' + number
  return role.slice(0, 32 - suffix.length) + suffix
}

function tracked(topicId, name) {
  return readJson(paneFile)?.[topicId]?.[name]?.pane ||
    readRegistry()?.[topicId]?.[name]?.pane || null
}
function track(topicId, name, pane) {
  const state = readJson(paneFile) || {}
  state[topicId] = { ...(state[topicId] || {}), [name]: { pane, createdAt: Date.now() } }
  writeJson(paneFile, state)
}

function secretEnv(agent) {
  const result = {}
  const names = agent.kind === 'claude'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
    : ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']
  for (const name of names) if (process.env[name]) result[name] = process.env[name]
  return result
}

async function loadSecrets(terminal, pane, agent) {
  const vars = secretEnv(agent)
  if (!Object.keys(vars).length) return
  const dir = path.join(homeDir, 'state', 'up-secrets')
  const file = path.join(dir, randomUUID() + '.sh')
  const lines = Object.entries(vars).map(([key, value]) => 'export ' + key + '=' + quote(value))
  privateFile(file, lines.join('\n') + '\n')
  try {
    await terminal.run(pane, '. ' + quote(file))
    const ready = await terminal.waitShell(pane)
    if (!ready.ok) throw new Error('Herdr did not return to the shell after loading the selected API key.')
  } finally { fs.rmSync(file, { force: true }) }
}

export function firstPrompt({ agent, topicId, pane, account }) {
  const url = server() + '/r/' + topicId
  return 'Use the scorpio skill. Join this topic now: scorpio join topicId=' + topicId +
    ' role=' + agent.role + ' resume=true pane=' + pane +
    '. Read the response. Only after it says registered:true and daemon:running, send one short new message in the topic mentioning @' +
    account + ', and tell the person the topic page is ' + url +
    '. If join fails, report its exact error in this pane and stop. Do not retry as another role.'
}

export async function ensureAgentPane({ agent, account, topic, workdir, herdrBin, workspaceId,
  terminal: suppliedTerminal = null, inspectPane = herdrPane }) {
  const name = fullName(agent, account)
  const terminal = suppliedTerminal || createHerdr({ bin: herdrBin })
  let pane = tracked(topic.roomId, name)
  let info = pane ? await inspectPane(herdrBin, pane) : null
  let tabId = info?.tab_id || null
  let tabLabel = info ? null : agent.role
  if (!info) {
    const tab = await terminal.newTab({
      label: agent.role, cwd: workdir, workspace: workspaceId,
      env: { PATH: process.env.PATH, ...(process.env.SCORPIO_HOME ? { SCORPIO_HOME: process.env.SCORPIO_HOME } : {}) },
    })
    pane = tab.pane
    tabId = tab.tab
    if (!pane) throw new Error('Herdr did not return the agent pane id.')
    track(topic.roomId, name, pane)
    info = await inspectPane(herdrBin, pane)
  }
  if (info?.agent === agent.kind) return { pane, name, reused: true }
  const ready = await terminal.waitShell(pane)
  if (!ready.ok) throw new Error('The agent pane has not reached its shell prompt.')
  await loadSecrets(terminal, pane, agent)
  const prompt = firstPrompt({ agent, topicId: topic.roomId, pane, account })
  const live = await terminal.agents()
  if (!live) throw new Error('Herdr could not list its agents.')
  const taken = new Set(live.map((item) => item.name))
  for (let number = 1; ; number += 1) {
    const herdrName = herdrAgentName(agent.role, number)
    if (herdrName.length > 32) throw new Error('No Herdr agent name is available.')
    if (taken.has(herdrName)) continue
    if (tabLabel !== herdrName) {
      if (!tabId) throw new Error('Herdr did not return the agent tab id.')
      await terminal.renameTab(tabId, herdrName)
      tabLabel = herdrName
    }
    try {
      await terminal.startAgent({ name: herdrName, kind: agent.kind, pane, argv: [prompt], timeoutMs: 5_000 })
      break
    } catch (error) {
      const reason = herdrError(error)
      if (/timeout/i.test(reason.code) || /timed out waiting for agent startup/i.test(reason.text)) {
        const deadline = Date.now() + 85_000
        let detected = false
        do {
          if ((await inspectPane(herdrBin, pane))?.agent === agent.kind) { detected = true; break }
          await sleep(1000)
        } while (Date.now() < deadline)
        if (detected) break
      }
      const current = await terminal.agents()
      if (current?.some((item) => item.name === herdrName && item.pane_id !== pane)) {
        taken.add(herdrName)
        continue
      }
      throw new Error(reason.code ? reason.text : 'Herdr could not start the agent.')
    }
  }
  return { pane, name, reused: false }
}

export async function existingAgentPane({ agent, account, topic, herdrBin }) {
  const name = fullName(agent, account)
  const pane = tracked(topic.roomId, name)
  const info = pane ? await herdrPane(herdrBin, pane) : null
  return info?.agent === agent.kind ? { pane, name, reused: true } : null
}

export function registeredPane(topicId, name) {
  const entry = readRegistry()?.[topicId]?.[name]
  return entry?.status === 'left' ? null : entry?.pane || null
}
