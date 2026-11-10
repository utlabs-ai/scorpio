/** The permission levels understood by the daemon and account setting (docs/api/daemon.md, Permissions). */
export type SpawnPerm = "ask" | "auto" | "all";
export type MemberPerm = { level: SpawnPerm; from: "setting" | "spawn" | "parent" | "takeover"; parent: string | null };

export const isSpawnPerm = (v: unknown): v is SpawnPerm => v === "ask" || v === "auto" || v === "all";

/** A malformed entry is ignored without rejecting the rest of a carry. */
export function memberPermOf(v: unknown): MemberPerm | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (!isSpawnPerm(p.level) || !["setting", "spawn", "parent", "takeover"].includes(p.from as string)) return null;
  if (p.parent !== null && (typeof p.parent !== "string" || !/^[A-Za-z0-9_.-]{1,62}@[A-Za-z0-9_-]{1,39}$/.test(p.parent))) return null;
  return { level: p.level, from: p.from as MemberPerm["from"], parent: p.parent as string | null };
}
