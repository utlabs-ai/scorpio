/** A topic summary is readable by its creator, a current account, or a public-topic viewer. */
export function mayReadSummary(row: Record<string, unknown>, handle: string | undefined, known: boolean): boolean {
  return !!row.public || (handle !== undefined && (row.owner === handle || known));
}

export function mayEnter(
  row: Record<string, unknown>, member: Record<string, unknown> | undefined, actor: { account: string }, accountKnown: boolean,
): "already" | "owner" | "known" | "needsCode" {
  if (member?.status === "active") return "already";
  if (actor.account === row.owner) return "owner";
  return accountKnown ? "known" : "needsCode";
}

/** New agent names consume a seat; an existing name does not call this rule. */
export function agentSeatsToRemove(total: number, left: number): number | null {
  const needed = Math.max(0, total - 99);
  return left >= needed ? needed : null;
}

export function personSlotAvailable(activePeople: number): boolean {
  return activePeople < 20;
}

export function ownerStays(row: Record<string, unknown>, account: string): boolean {
  return account === row.owner;
}

export function planArchiveChange(row: Record<string, unknown>, archived: boolean, reason: string): boolean {
  return archived ? row.archived_at == null : row.archived_at != null && row.archived_reason === reason;
}

export function requireOwner(row: Record<string, unknown>, actor: { account: string }): boolean {
  return actor.account === row.owner;
}
