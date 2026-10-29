/** Hide key-like strings, including their continuation on wrapped pane lines. */
export function hideKeys(text) {
  let hidden = 0
  const pattern = /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|Bearer[ \t]+[A-Za-z0-9._~+/-]{12,}=*)/g
  const source = String(text)
  let out = '', end = 0
  for (let match; (match = pattern.exec(source));) {
    let until = pattern.lastIndex
    while (source[until] === '\n') {
      const wrapped = /^[A-Za-z0-9._~+/=_-]+/.exec(source.slice(until + 1))
      if (!wrapped) break
      until += 1 + wrapped[0].length
    }
    const bearer = /^Bearer[ \t]+/.exec(match[0])?.[0] || ''
    out += source.slice(end, match.index) + bearer + '[hidden]'
    out += source.slice(pattern.lastIndex, until).replace(/\n[^\n]+/g, '\n[hidden]')
    hidden++
    end = until
    pattern.lastIndex = until
  }
  return { text: out + source.slice(end), hidden }
}

export function fence(text) {
  const runs = String(text).match(/`+/g) || []
  const edge = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  return `${edge}\n${text}\n${edge}`
}

export const screenLine = (short, waiting = true) => `${short} · its screen is with its owner, as a card only they can see${waiting ? '; waiting for them.' : '.'}`
