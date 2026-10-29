// Screen text is the menu's authority; hook suggestions are never options.
const OPTION = /^\s*[❯›>]?\s*(\d+)\.\s+(.+)$/
// Keep parser provenance local so cards retain their wire shape.
const codexMenus = new WeakSet()
const HINT = /(?:esc|enter|tab|ctrl[+\-])/i
export function screenTail(screen) {
  return String(screen || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd().split('\n').slice(-30).join('\n')
}
// The wording of Codex's hook-review and folder-trust dialogs.
export const CODEX_DIALOG_WORDS = ['Hooks need review', 'Trust all and continue', 'Trust this folder?', 'Trust and continue']
// This classifies an already-open card's answer path only.
export function codexTrustMenu(screen) {
  const recent = String(screen || '').split('\n').filter(line => line.trim()).slice(-30).join('\n')
  const [hooks, trustAll, folder, trust] = CODEX_DIALOG_WORDS
  return recent.includes(hooks) && recent.includes(trustAll) || recent.includes(folder) && recent.includes(trust)
}

export function columns(text) {
  let width = 0
  for (const c of text) {
    const n = c.codePointAt(0)
    if (/\p{Mark}/u.test(c) || n === 0x200d || n === 0xfe0f) continue
    width += n >= 0x1100 && (n <= 0x115f || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7a3 || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0x1f300) ? 2 : 1
  }
  return width
}
function codexQuestionStart(lines, first) {
  let start = first
  while (start > 0 && !/^(?:[•✔✗■›└]|[─━]+$)/.test(lines[start - 1].trim())) start--
  const question = lines.slice(start, first).findIndex((line) => /[?？]/.test(line))
  if (question >= 0) return start + question
  while (start < first && !lines[start].trim()) start++
  return start
}
function parsedMenu(menu, cli) {
  if (cli === 'codex') codexMenus.add(menu)
  return menu
}
// Cursor menus require aligned options and a confirmation hint, so an input prompt is not a menu.
export function cursorMenu(screen, cli = 'claude') {
  const lines = screenTail(screen).split('\n')
  for (let marked = lines.length - 1; marked >= 0; marked--) {
    const marker = lines[marked].match(/^(\s*)[❯›] (\S.*)$/)
    if (!marker || OPTION.test(lines[marked])) continue
    const indent = marker[1].length + 2
    const optionAt = (i) => i === marked ? marker[2] :
      lines[i]?.match(new RegExp(`^ {${indent}}(\\S.*)$`))?.[1]
    let first = marked, end = marked + 1
    while (first > 0 && optionAt(first - 1)) first--
    while (end < lines.length && optionAt(end)) end++
    let hint = end
    while (hint < lines.length && !lines[hint].trim()) hint++
    if (end - first < 2 || !/enter.*confirm/i.test(lines[hint] || '')) continue
    let q = first
    while (q > 0 && !lines[q - 1].trim()) q--
    let start = q
    while (start > 0 && lines[start - 1].trim()) start--
    const questionAt = lines.slice(0, first).findLastIndex((line) => /[?？]/.test(line))
    if (cli === 'codex') start = codexQuestionStart(lines, first)
    else if (questionAt >= 0) start = questionAt
    return { selected: marked - first + 1, menu: parsedMenu({
      question: lines.slice(start, q).map((line) => line.trim()),
      options: lines.slice(first, end).map((_, i) => ({ n: i + 1, label: optionAt(first + i).trimEnd() })),
      hints: [lines[hint].trim()],
    }, cli) }
  }
  return null
}
export function parseMenu(screen, width = null, cli = 'claude') {
  const lines = screenTail(screen).split('\n')
  const starts = lines.flatMap((l, i) => OPTION.test(l) ? [i] : [])
  if (!starts.length) return cursorMenu(screen, cli)?.menu || null
  // Ignore older numbered lists above the last contiguous menu.
  let first = starts.at(-1)
  for (let j = starts.length - 2; j >= 0; j--) {
    if (Number(lines[starts[j]].match(OPTION)[1]) >= Number(lines[first].match(OPTION)[1])) break
    first = starts[j]
  }
  const options = [], hints = []
  let previous = ''
  for (const line of lines.slice(first)) {
    const m = line.match(OPTION)
    if (m) { options.push({ n: Number(m[1]), label: m[2].trimEnd() }); previous = line; continue }
    if (!line.trim()) continue
    if (HINT.test(line) && /(?:cancel|confirm|amend|explain|continue|quit|skip)/i.test(line)) hints.push(line.trim())
    else if (/^\s+\S/.test(line) && options.length && !hints.length) {
      const option = options.at(-1)
      const firstWord = line.trim().split(/\s+/)[0]
      const wrapped = cli === 'codex' || !width || columns(previous + ' ' + firstWord) > width
      if (wrapped) option.label += '\n' + line.trim()
      else option.note = [option.note, line.trim()].filter(Boolean).join(' ')
      previous = line
    } else break
  }
  let q = first
  while (q > 0 && !lines[q - 1].trim()) q--
  let start = q
  while (start > 0 && lines[start - 1].trim() && !OPTION.test(lines[start - 1])) start--
  const questionAt = lines.slice(0, first).findLastIndex((l) => /[?？]/.test(l) && !OPTION.test(l))
  if (cli === 'codex') start = codexQuestionStart(lines, first)
  else if (questionAt >= 0) start = questionAt
  return parsedMenu({ question: lines.slice(start, q).map((l) => l.trim()), options, hints }, cli)
}
export function visibleMenu(screen, width, cli) {
  const menu = parseMenu(screen, width, cli)
  // Numbered progress output alone is not a prompt for a decision.
  return menu && (menu.hints.length || menu.question.some((line) => /[?？]/.test(line))) ? menu : null
}
const normalize = (text) => String(text).replace(/[\s\u2500-\u257f\u2022\u00b7\u25a0-\u25ff\u2800-\u28ff✻✶✳✢✽]+/g, '')
export function menuIdentity(screen, menu) {
  if (!menu) return null
  const lines = screenTail(screen).split('\n')
  const questionAt = lines.findLastIndex((line) => line.trim() === menu.question[0])
  const context = []
  for (let i = questionAt - 1; !codexMenus.has(menu) && i >= 0 && context.length < 8; i--) {
    const line = lines[i].trim()
    if (/^[─━]+$/.test(line)) break
    if (line) context.unshift(line.replace(/\s+1 of \d+$/, ''))
  }
  return JSON.stringify({ question: normalize(menu.question.join(' ')),
    options: menu.options.map((option) => ({ ...option, label: normalize(option.label), ...(option.note ? { note: normalize(option.note) } : {}) })),
    context: normalize(context.join(' ')) })
}
const values = (event) => {
  const input = event?.tool_input || {}
  return [input.command, input.file_path, input.path, input.url && (() => { try { return new URL(input.url).hostname } catch { return input.url } })()].filter((s) => typeof s === 'string' && s)
}
export function hookMatches(event, screen) {
  const before = String(screen).split('\n').slice(0, String(screen).split('\n').findIndex((l) => OPTION.test(l))).join('\n')
  return values(event).some((value) => normalize(before).includes(normalize(value)))
}
export function detailOf(event) {
  const input = event.tool_input
  return { tool: event.tool_name ?? null, input: (typeof input === 'string' ? input : JSON.stringify(input ?? {})).slice(0, 2000),
    cwd: event.cwd ?? null, description: event.description ?? input?.description ?? null }
}
export function sameMenu(card, screen) {
  const menu = visibleMenu(screen, card.width, card.cli)
  if (menuIdentity(screen, menu) !== card.identity) return false
  if (!menu && screenTail(screen) !== card.screen) return false
  return !card.event || hookMatches(card.event, screen)
}
export const standardApproval = (menu) => menu?.options?.[0]?.n === 1 && menu.options[0].label === 'Yes' && /^No\b/.test(menu.options.at(-1).label)
