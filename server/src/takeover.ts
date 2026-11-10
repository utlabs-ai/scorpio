/** Search all matching history, then accept only a fenced command for this exact role and owner. */
export const TAKEOVER_CANDIDATES_SQL = `SELECT m.seq, m.text FROM messages m
  WHERE (m.from_name = ?1 OR substr(m.from_name, -length('@' || ?1)) = '@' || ?1)
    AND instr(m.text, '/spawn') > 0 AND instr(m.text, ?2) > 0 AND m.seq > ?3
  ORDER BY m.seq DESC`;

export function takeoverFromCandidates(
  rows: { seq: number; text: string }[], name: string, owner: string,
  currentHost: (name: string) => string | null,
): { command: string; seq: number } | null {
  const role = name.slice(0, name.lastIndexOf("@"));
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = new RegExp(`^@([A-Za-z0-9_.-]+)@${esc(owner)}(\\s+/spawn\\s+\\S+\\s+${esc(role)}\\s)`);
  for (const r of rows) {
    for (const block of r.text.matchAll(/```[^\n]*\n([\s\S]*?)\n\s*```/g)) {
      for (const candidate of block[1].split("\n")) {
        const command = candidate.trim();
        const match = line.exec(command);
        if (match) {
          const host = currentHost(`${match[1]}@${owner}`);
          if (host) return { command: command.replace(`@${match[1]}@${owner}`, `@${host}`), seq: r.seq };
        }
      }
    }
  }
  return null;
}
