// Reminder heads have one list here. Never store terminal key presses.
export const MEMO_MARKERS = ['Scorpio topic "', 'Topic reminder (', 'Topic changes:', 'Your tasks changed:', 'Memo (', 'Memo changes:', 'Mark them read first:', 'Then do the work', 'Still unmarked:', '<system', '</system', 'Human:', 'Assistant:'];
export function markerLine(line: string): boolean {
  const s = line.trimStart();
  return MEMO_MARKERS.some(head => s.startsWith(head)) || /^#\d+ from /.test(s) || /^\+-{10,}\+/.test(s);
}
export function memoText(value: unknown, short: boolean): { text: string; removed: number; length: number; invalid: boolean } {
  if (typeof value !== 'string') return { text: '', removed: 0, length: 0, invalid: true };
  const normalized = value.replace(/\r\n/g, '\n');
  const invalid = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(normalized);
  let removed = 0;
  const lines = normalized.split('\n').filter(line => { if (!markerLine(line)) return true; removed++; return false; });
  const text = short ? lines.join('\n').replace(/\s+/gu, ' ').trim() : lines.join('\n');
  return { text, removed, length: Array.from(text).length, invalid };
}
