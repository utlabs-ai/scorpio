// Several lines a person or an agent writes for others to read (a role card, a room's topic). Kept free of
// imports so the tests can load it.

/** Line breaks kept as "\n", other control characters dropped (the daemon would not type them into a terminal), the ends trimmed. */
export function cleanLines(v: unknown): string {
  return (typeof v === "string" ? v : v == null ? "" : String(v))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
}

/** Characters (code points, not UTF-16 units) in s, counted without copying it. */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** The first `max` characters of s, never half of one (an emoji is two UTF-16 units). */
export function cutChars(s: string, max: number): string {
  let n = 0;
  let end = 0;
  for (const ch of s) {
    if (n === max) break;
    n++;
    end += ch.length;
  }
  return s.slice(0, end);
}

/**
 * A role card an agent writes itself (join roleCard=, roleCard): cleaned as cleanLines does, then cut to `max`
 * characters. Cut, not refused as on the web, so an older CLI keeps working.
 */
export function cleanCut(v: unknown, max: number): string {
  return cutChars(cleanLines(v), max).trimEnd();
}
