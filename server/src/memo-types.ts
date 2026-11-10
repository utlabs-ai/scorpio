export type Memo = {
  id: string; text: string; by: string; byKind: string; from: string; score: number; rounds: number; misled: number;
  promotable: boolean; lastUsedMs: number; createdMs: number; replaces: string | null;
  votes: { good: string[]; bad: string[] }; state?: string; leftMs?: number | null; leftBy?: string | null; leftTo?: string | null;
};
export type LongSlot = { slot: string; version: number; text: string; by: string | null; byKind: string | null; ms: number | null; refs: string[]; merged: string[]; big: boolean; restoredFrom: number | null; lost: string[]; shorter: number | null };
export type MemoLog = { id: number; ms: number; by: string; byKind: string; op: string; m: string | null; slot: string | null; version: number | null; [key: string]: unknown };
export type MemoState = { nextId: string; long: LongSlot[]; short: Memo[]; retired: number; pending: string[]; round: number; cites: number; log: MemoLog[]; logLast: number };
export type MemoQuery = { retired?: string; show?: string; versions?: string; limit?: string; before?: string };
export type MemoOp = { op: unknown; text?: unknown; from?: unknown; replaces?: unknown; id?: unknown; slot?: unknown; version?: unknown; merged?: unknown; vote?: unknown; nonce?: string };
export type MemoIds = { cite: number[]; misled: number[] };
export type MemoReceipt = { cite: { id: string; counted: boolean; score?: number; reason?: string }[]; misled: { id: string; counted: boolean; score?: number; reason?: string }[] };
