export function quietDecision(
  row: Record<string, unknown>, lastAt: number, cutoff: number, nowMs: number,
): { archivedAt: number | null; archivedReason: string | null; lastAt: number; write: boolean } {
  if (row.archived_at != null) return { archivedAt: row.archived_at as number, archivedReason: (row.archived_reason as string) ?? null, lastAt, write: false };
  if (lastAt >= cutoff) return { archivedAt: null, archivedReason: null, lastAt, write: false };
  return { archivedAt: nowMs, archivedReason: "retention", lastAt, write: true };
}

export function purgeDecision(
  row: Record<string, unknown>, archivedBefore: number, nowMs: number,
): { deletedAt: number | null; write: boolean } {
  if (row.deleted_at != null) return { deletedAt: row.deleted_at as number, write: false };
  if (row.archived_at == null || (row.archived_at as number) >= archivedBefore) return { deletedAt: null, write: false };
  return { deletedAt: nowMs, write: true };
}
