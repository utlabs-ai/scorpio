// What an agent is stopped at when herdr sees it blocked: the detection rule that matched,
// in a few words for the topic (Member.workReason) and the owner's push. The words start with approval, question
// or prompt, which the web and the push read. Only the rule id is used, never the screen.

const WORDS = {
  // Claude Code
  bash_permission_prompt: 'approval: a shell command',
  generic_permission_prompt: 'approval',
  mcp_elicitation_prompt: 'question from a tool',
  live_blocked_form: 'question',
  dynamic_workflow_prompt: 'question',
  // Codex
  osc_title_blocked: 'approval',
  live_strong_blocker: 'approval',
  trust_directory: 'prompt: trust this folder',
  startup_update: 'prompt: update notice',
  weak_blocker: 'prompt',
}

/** The words for a herdr rule id; a rule not known here is just "prompt". */
export function blockedWords(rule) {
  return rule ? WORDS[rule] ?? 'prompt' : null
}

/**
 * Reasons per pane, asked of herdr once when a pane turns blocked and again at most every refreshMs while it stays
 * so (it may move on to another dialog); forgotten once it is not blocked.
 */
export function createBlockedReasons({ explain, now = Date.now, refreshMs = 30_000 }) {
  const known = new Map() // pane → { words, at }
  return {
    async of(pane, status) {
      if (status !== 'blocked' || !pane) { known.delete(pane); return null }
      const k = known.get(pane)
      if (k && now() - k.at < refreshMs) return k.words
      const e = await explain(pane)
      const words = e?.state === 'blocked' ? blockedWords(e.rule) : (k?.words ?? null)
      known.set(pane, { words, at: now() })
      return words
    },
  }
}
