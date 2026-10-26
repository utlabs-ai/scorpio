// Read only the user's selected approval settings. Project and inactive profiles do not decide
// whether a default spawn needs permission to ask its owner.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const codexConfigFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')

export function approvalSettings(file = codexConfigFile()) {
  try {
    const root = {}, selected = {}
    let section = ''
    const stringValue = (value) => /^(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)')$/.exec(value)?.slice(1).find((v) => v !== undefined)
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim()
      const header = /^\[(.*?)\]$/.exec(line)
      const profile = root.profile === undefined ? null : `profiles.${root.profile}`
      if (header) {
        section = header[1].replace(/["']/g, '').replace(/\s*\.\s*/g, '.').trim()
        if (/^approval_policy(?:\.|$)/.test(section)) root.policy = true
        if (profile && (section === `${profile}.approval_policy` || section.startsWith(`${profile}.approval_policy.`))) selected.policy = true
        continue
      }
      const pair = /^(approval_policy|sandbox_mode|profile)\s*=\s*(.*)$/.exec(line)
      const target = section === '' ? root : profile && section === profile ? selected : null
      if (!pair || !target) continue
      const value = stringValue(pair[2])
      if (pair[1] === 'approval_policy') target.policy = value ?? true
      else if (pair[1] === 'sandbox_mode') target.sandbox = value
      else if (target === root) root.profile = value
    }
    return { policy: selected.policy ?? root.policy, sandbox: selected.sandbox ?? root.sandbox }
  } catch { return {} }
}

export const addedApprovalNote = 'Added --ask-for-approval on-request, since your Codex settings set no approval policy: it asks you in Scorpio before it runs a command outside its sandbox; nothing is allowed by itself.'

export function codexApprovalNote(args, settings = approvalSettings(), file = codexConfigFile()) {
  if (args.includes('--ask-for-approval') && args[args.indexOf('--ask-for-approval') + 1] === 'on-request') return addedApprovalNote
  if (settings.policy !== 'never' || settings.sandbox === 'danger-full-access') return ''
  const display = file.startsWith(os.homedir() + path.sep) ? '~' + file.slice(os.homedir().length) : file
  return `Your Codex settings (approval_policy = "never" with a sandbox) keep it from asking to leave the sandbox, so it cannot reach the topic. Use perm=all for this session or change approval_policy in ${display}.`
}
