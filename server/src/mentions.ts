// Find @names in message prose, excluding the same Markdown code and links the room renders as non-text.
const MENTION_RE = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?)/g;
const HIDDEN_INLINE = /`[^`\n]+`|\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+/g;

/** A message's prose: its text without fenced or inline code and link addresses (what @names and T numbers are read from). */
export function proseOf(text: string): string {
  let fence: string | null = null;
  const prose: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (!fence) prose.push(line.replace(HIDDEN_INLINE, " "));
  }
  return prose.join("\n");
}

export function mentionTokens(text: string): string[] {
  return [...proseOf(text).matchAll(MENTION_RE)].map((m) => m[1]);
}

/** The server accepts a trailing period or hyphen as punctuation when it is not part of a member name. */
export function namesMentioned(tokens: string[], name: string): boolean {
  const target = name.toLowerCase();
  return tokens.some((raw) => {
    let token = raw.toLowerCase();
    for (;;) {
      if (token === target) return true;
      if (!/[.-]$/.test(token)) return false;
      token = token.slice(0, -1);
    }
  });
}
