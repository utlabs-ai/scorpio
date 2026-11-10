/** Literal substring terms for SQLite LIKE; %, _ and backslash are search text. */
export function likeTerms(column: string, terms: string[]): { sql: string; args: string[] } {
  return {
    sql: terms.length ? terms.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND ") : "1",
    args: terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`),
  };
}

/** FTS5's trigram LIKE can narrow a term only when it has three consecutive non-wildcard characters. */
export function trigramCandidate(terms: string[]): string | null {
  return [...terms].sort((a, b) => [...b].length - [...a].length).find((term) => /[^%_]{3}/u.test(term)) ?? null;
}
