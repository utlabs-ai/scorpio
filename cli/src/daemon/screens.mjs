const KEY = String.raw`(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|Bearer[ \t]+[A-Za-z0-9._~+/-]{12,}=*)`
// What a wrapped key continues with at the start of the next row.
const WRAPPED = /^[A-Za-z0-9._~+/=_-]+/
// A row that ends where a key may go on: in Bearer, or in a key prefix and what fitted after it.
const ROW_END = /(?<![A-Za-z0-9_-])(?:(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9._~+/=_-]*|Bearer)$/

/** Hide key-like strings, including their continuation on wrapped pane lines. */
export function hideKeys(text) {
  let hidden = 0
  const pattern = new RegExp(KEY, 'g')
  const source = String(text)
  let out = '', end = 0
  for (let match; (match = pattern.exec(source));) {
    let until = pattern.lastIndex
    while (source[until] === '\n') {
      const wrapped = WRAPPED.exec(source.slice(until + 1))
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
  const split = hideSplitKeys(out + source.slice(end))
  return { text: split.text, hidden: hidden + split.hidden }
}

// Keys the pane wrapped right after Bearer or a prefix: match them with the row ends joined, then hide each
// piece on its own row.
function hideSplitKeys(text) {
  const rows = text.split('\n')
  let hidden = 0
  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i].replace(/[ \t]+$/, '')
    const tail = ROW_END.exec(row)
    if (!tail) continue
    let joined = row + (tail[0] === 'Bearer' ? ' ' : '')
    const parts = [] // the next rows' leading pieces: {row, at (in joined), length}
    for (let j = i + 1; j < rows.length; j++) {
      const piece = WRAPPED.exec(rows[j])?.[0]
      if (!piece) break
      parts.push({ row: j, at: joined.length, length: piece.length })
      joined += piece
      if (piece.length < rows[j].replace(/[ \t]+$/, '').length) break
    }
    if (!parts.length) continue
    // Only a key that goes on past this row was missed above.
    const key = new RegExp(KEY, 'g')
    key.lastIndex = tail.index
    let hit
    do hit = key.exec(joined); while (hit && hit.index + hit[0].length <= parts[0].at)
    if (!hit) continue
    // A key that reaches the end of a row goes on into the rows after it, as above.
    let until = hit.index + hit[0].length
    if (parts.some((p) => p.at + p.length === until)) until = parts.at(-1).at + parts.at(-1).length
    if (tail[0] !== 'Bearer') rows[i] = rows[i].slice(0, hit.index) + '[hidden]' + rows[i].slice(row.length)
    for (const p of parts.filter((p) => p.at < until)) rows[p.row] = '[hidden]' + rows[p.row].slice(Math.min(until, p.at + p.length) - p.at)
    hidden++
  }
  return { text: rows.join('\n'), hidden }
}

export function fence(text) {
  const runs = String(text).match(/`+/g) || []
  const edge = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  return `${edge}\n${text}\n${edge}`
}

export const screenLine = (short, waiting = true) => `${short} · its screen is with its owner, as a card only they can see${waiting ? '; waiting for them.' : '.'}`
