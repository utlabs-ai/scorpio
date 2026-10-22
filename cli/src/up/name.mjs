import path from 'node:path'
import { homeDir, readJson, writeJson } from './services.mjs'

const file = path.join(homeDir, 'state', 'up.json')
export const NAME = /^[a-z][a-z0-9_-]{0,31}$/

export function rememberedName(kind) {
  const name = readJson(file)?.agentNames?.[kind]
  return NAME.test(name || '') ? name : null
}

export function chooseName(screen, kind, { force = false } = {}) {
  const saved = force ? null : rememberedName(kind)
  if (saved) return saved
  for (;;) {
    const name = screen.askLine(screen.language === 'zh' ? '给 agent 起个名字 [pobi]：' : 'Name it [pobi]: ') || 'pobi'
    if (NAME.test(name)) {
      const state = readJson(file) || {}
      writeJson(file, { ...state, agentNames: { ...(state.agentNames || {}), [kind]: name } })
      return name
    }
    screen.error(screen.language === 'zh'
      ? '名字须以小写字母开头，只能用小写字母、数字、-、_，最多 32 个字符。'
      : 'The name must start with a lowercase letter and contain only lowercase letters, digits, - or _ (up to 32 characters).')
  }
}

export function onlineNameTaken(members, role, ownName = null) {
  return members.some((member) => member.status === 'active' && member.online === true &&
    member.name.split('@')[0] === role && member.name !== ownName)
}
