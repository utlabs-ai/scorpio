// Pro trial cards: given days share the invites ledger and its entitlement lifecycle.
import { INVITE_ALPHABET, startOrBank } from "./invite";
import { ApiError, now, randomFrom, randomId } from "./util";

export type TrialBatch = { id: string; days: number; count: number; note: string | null; created_by: string; created_at: number; used: number };
export type TrialCode = { code: string; batch_id: string; created_at: number; used_by: string | null; used_at: number | null; handle: string | null };
export function normalizeTrialCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return code.length === 8 && [...code].every((c) => INVITE_ALPHABET.includes(c)) ? code : null;
}

export async function createBatch(env: Env, by: string, input: { count: unknown; days: unknown; note?: unknown }) {
  const { count, days } = input;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 500 ||
      typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365 ||
      (input.note != null && (typeof input.note !== "string" || input.note.length > 1000)))
    throw new ApiError("bad_request", "Use 1–500 codes, 1–365 days, and a note up to 1000 characters.");
  const batch: TrialBatch = { id: randomId(12), days, count, note: typeof input.note === "string" ? input.note.trim() || null : null, created_by: by, created_at: now(), used: 0 };
  // The batch transaction also handles an existing code collision: draw a fresh set and try again.
  for (let attempt = 0; attempt < 12; attempt++) {
    const picked = new Set<string>();
    while (picked.size < count) picked.add(randomFrom(INVITE_ALPHABET, 8));
    const codes = [...picked];
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO trial_batches (id, days, count, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(batch.id, days, count, batch.note, by, batch.created_at),
        ...codes.map((code) => env.DB.prepare("INSERT INTO trial_codes (code, batch_id, created_at) VALUES (?, ?, ?)").bind(code, batch.id, batch.created_at)),
      ]);
      return { batch, codes };
    } catch (error) {
      // Retry only a real code collision, never swallow another database failure.
      if (!/UNIQUE constraint failed: trial_codes.code/.test(String(error))) throw error;
    }
  }
  throw new Error("Could not draw unique trial codes");
}

export async function redeem(env: Env, userId: string, value: unknown): Promise<{ ok: true; days: number; startsNow: boolean; until?: number } | "unknown" | "used" | "batch_used"> {
  const code = normalizeTrialCode(value);
  if (!code) return "unknown";
  const t = now();
  const used = "EXISTS (SELECT 1 FROM trial_codes WHERE code = ?1 AND used_by = ?2 AND used_at = ?3)";
  const days = "(SELECT b.days FROM trial_codes c JOIN trial_batches b ON b.id = c.batch_id WHERE c.code = ?1)";
  const [took, , extended] = await env.DB.batch([
    env.DB.prepare(`UPDATE trial_codes SET used_by = ?2, used_at = ?3 WHERE code = ?1 AND used_by IS NULL
      AND NOT EXISTS (SELECT 1 FROM trial_codes o WHERE o.batch_id = trial_codes.batch_id AND o.used_by = ?2)`).bind(code, userId, t),
    env.DB.prepare(`INSERT INTO invite_ledger (user_id, kind, days, ref, at)
      SELECT ?2, 'grant', b.days, 'trial code ' || c.code, ?3 FROM trial_codes c JOIN trial_batches b ON b.id = c.batch_id
      WHERE c.code = ?1 AND c.used_by = ?2 AND c.used_at = ?3 AND changes() > 0`).bind(code, userId, t),
    env.DB.prepare(`UPDATE entitlements SET period_end = period_end + ${days} * 86400000, updated_at = ?3
      WHERE user_id = ?2 AND provider = 'trial' AND plan = 'pro' AND status = 'active' AND period_end > ?3 AND ${used} AND changes() > 0`).bind(code, userId, t),
    env.DB.prepare(`INSERT INTO invite_ledger (user_id, kind, days, ref, at)
      SELECT ?2, 'use', ${days}, 'trial', ?3 WHERE ${used} AND changes() > 0`).bind(code, userId, t),
  ]);
  if (!took.meta.changes) {
    const row = await env.DB.prepare("SELECT batch_id, used_by FROM trial_codes WHERE code = ?").bind(code).first<{ batch_id: string; used_by: string | null }>();
    if (!row) return "unknown";
    if (row.used_by !== null) return "used";
    return "batch_used";
  }
  if (!extended.meta.changes) await startOrBank(env, userId);
  const batch = await env.DB.prepare(`SELECT b.days FROM trial_codes c JOIN trial_batches b ON b.id = c.batch_id WHERE c.code = ?`).bind(code).first<{ days: number }>();
  const ent = await env.DB.prepare("SELECT provider, period_end, updated_at FROM entitlements WHERE user_id = ?").bind(userId).first<{ provider: string; period_end: number; updated_at: number }>();
  return { ok: true, days: batch!.days, startsNow: !!extended.meta.changes || (ent?.provider === "invite" && ent.updated_at >= t), ...(extended.meta.changes ? { until: ent!.period_end } : {}) };
}

export async function batches(env: Env): Promise<TrialBatch[]> {
  return (await env.DB.prepare(`SELECT b.*, (SELECT COUNT(*) FROM trial_codes c WHERE c.batch_id = b.id AND c.used_by IS NOT NULL) AS used
    FROM trial_batches b ORDER BY b.created_at DESC, b.id`).all<TrialBatch>()).results;
}
export async function codesOf(env: Env, batchId: string): Promise<TrialCode[]> {
  return (await env.DB.prepare(`SELECT c.*, u.handle FROM trial_codes c LEFT JOIN users u ON u.id = c.used_by
    WHERE c.batch_id = ? ORDER BY c.code`).bind(batchId).all<TrialCode>()).results;
}
