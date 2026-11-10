// The room object is the truth; this pure comparison says what its D1 index needs repaired.
export type IndexAccount = { account: string; active: boolean; human: boolean };
export type IndexState = { topic: string; public: boolean; archivedAt: number | null; archivedReason: string | null; deletedAt: number | null; accounts: IndexAccount[] };
export type IndexRow = { status: string; topic: string; visibility: string; archived_at: number | null; archived_reason: string | null };
export type IndexMember = { user_id: string; handle: string; active: number };
export type IndexFix = { skip: "deleted" | "status" } | {
  room: Partial<{ topic: string; visibility: string; status: string; archived_at: number | null; archived_reason: string | null; active_at: number }>;
  activate: string[];
  deactivate: string[];
  remove: string[];
};

export function indexFix(row: IndexRow, members: IndexMember[], state: IndexState, nowMs: number): IndexFix {
  if (state.deletedAt != null || row.status === "deleted") return { skip: "deleted" };
  if (row.status !== "active" && row.status !== "archived") return { skip: "status" };

  const room: Exclude<IndexFix, { skip: "deleted" | "status" }>["room"] = {};
  if (row.topic !== state.topic) room.topic = state.topic;
  const visibility = state.public ? "link" : "private";
  if (row.visibility !== visibility) room.visibility = visibility;
  if (state.archivedAt != null) {
    if (row.status !== "archived") {
      room.status = "archived";
      room.archived_at = state.archivedAt;
      room.archived_reason = state.archivedReason;
    } else if (row.archived_reason !== state.archivedReason) {
      room.archived_reason = state.archivedReason;
    }
  } else if (row.status === "archived") {
    room.status = "active";
    room.archived_at = null;
    room.archived_reason = null;
    room.active_at = nowMs;
  }

  const activate: string[] = [], deactivate: string[] = [], remove: string[] = [];
  const byAccount = new Map(state.accounts.map((a) => [a.account, a]));
  const byHandle = new Map(members.map((m) => [m.handle, m]));
  for (const a of state.accounts) {
    if (a.active && byHandle.get(a.account)?.active !== 1) activate.push(a.account);
  }
  for (const m of members) {
    if (m.active !== 1) continue;
    const a = byAccount.get(m.handle);
    if (a?.active) continue;
    if (!a || (a.human && !state.public)) remove.push(m.user_id);
    else deactivate.push(m.user_id);
  }
  return { room, activate, deactivate, remove };
}
