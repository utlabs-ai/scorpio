// Permission selection uses the topic's members so a worker gets the same level on every computer.
export const PERMS = ['ask', 'auto', 'all']
export const SETTING_UNREADABLE = '✗ Could not read your permission setting; nothing was started. Send it again, or add perm=ask / auto / all.'

export const permissionLevel = (level) => level === 'default' ? 'ask' : PERMS.includes(level) ? level : null

/** No setting supplied yet: ask the caller to read it only when this start needs it. */
export function spawnPermission({ requested = null, previous = null, sender = null, setting = null }) {
  const parentLevel = sender && (permissionLevel(sender.level) || permissionLevel(setting))
  if (sender && !parentLevel) return { needsSetting: true }
  const level = requested || previous || parentLevel || permissionLevel(setting)
  if (!level) return { needsSetting: true }
  if (sender && PERMS.indexOf(level) > PERMS.indexOf(parentLevel)) {
    return { error: `✗ perm=${level}: ${sender.name} runs with perm=${parentLevel}, so it cannot start an agent with more.` }
  }
  const from = previous && (!requested || requested === previous) ? 'takeover'
    : requested ? 'spawn' : sender && permissionLevel(sender.level) ? 'parent' : 'setting'
  return { level, from, parent: from === 'parent' ? sender.name : null }
}

export function permissionNotice({ perm, permFrom, permParent }) {
  const label = { all: 'allow everything', ask: 'ask me in Scorpio', auto: 'approve for me' }[perm]
  const reason = { setting: 'your setting', spawn: 'chosen in this /spawn', parent: `same as ${permParent}`, takeover: 'takeover, kept' }[permFrom]
  return `perm: ${label} (${reason}).`
}

/** Only a spawn record for the carried pane belongs to this daemon's current start of that seat. */
export function carryPermissions(entries, readRecord) {
  return Object.fromEntries(entries.flatMap((entry) => {
    const record = readRecord(entry)
    const level = permissionLevel(record?.perm)
    if (!level || record.pane !== entry.pane) return []
    return [[entry.name, { level, from: record.permFrom || 'spawn', parent: record.permParent || null }]]
  }))
}
