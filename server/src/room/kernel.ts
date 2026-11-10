import { ApiError, now } from "../util";

export type ActorKind = "human" | "agent";

/** Who is calling, as established by the Worker from a session cookie or an agent token. */
export interface Actor {
  kind: ActorKind;
  account: string; // users.handle
  name: string; // human: the handle; agent: role@handle
}

export type ErrorFields = Record<string, string | number | boolean | null | Record<string, string | number | boolean | null>>;

/** RPC results carry protocol errors as data: custom error classes do not survive the RPC boundary. */
export type Result<T> = { ok: T } | { err: { code: string; next: string; status: number; retryAfter?: number; extra?: ErrorFields } };

export type Row = Record<string, SqlStorageValue>;

export function refuse(r: { code: string; next: string; status?: number }): never {
  throw new ApiError(r.code, r.next, r.status);
}

export function refuseIf(r: { code: string; next: string; status?: number } | null) {
  if (r) refuse(r);
}

export function wrap<T>(fn: () => T): Result<T> {
  try {
    return { ok: fn() };
  } catch (e) {
    if (e instanceof ApiError) return { err: { code: e.code, next: e.next, status: e.status, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}), ...(e.extra ? { extra: e.extra as ErrorFields } : {}) } };
    throw e;
  }
}

export function safeSend(ws: WebSocket, data: string) {
  try {
    ws.send(data);
  } catch {
    // The socket is closing; its close handler cleans up.
  }
}

export function toBrowsers(ctx: DurableObjectState, frame: string) {
  for (const ws of ctx.getWebSockets("browser")) safeSend(ws, frame);
}

export function toHosts(ctx: DurableObjectState, frame: string) {
  for (const ws of ctx.getWebSockets("host")) safeSend(ws, frame);
}

export function viewing(ctx: DurableObjectState, account: string): boolean {
  return ctx.getWebSockets(`h:${account}`).some((w) => (w.deserializeAttachment() as { visible?: boolean } | null)?.visible !== false);
}

export function replay(sql: SqlStorage, sender: string, nonce: string | undefined): Record<string, unknown> | null {
  if (!nonce) return null;
  sql.exec("DELETE FROM nonces WHERE ts < ?", now() - 600_000);
  const r = sql.exec("SELECT result FROM nonces WHERE sender = ? AND nonce = ?", sender, nonce).toArray()[0];
  return r ? JSON.parse(r.result as string) : null;
}

export function remember<T>(sql: SqlStorage, sender: string, nonce: string | undefined, result: T): T {
  if (nonce) sql.exec("INSERT OR REPLACE INTO nonces (sender, nonce, result, ts) VALUES (?, ?, ?, ?)", sender, nonce, JSON.stringify(result), now());
  return result;
}

export function tx<T>(ctx: DurableObjectState, fn: () => T): T {
  return ctx.storage.transactionSync(fn);
}

export class Timers {
  private list: { name: string; run(t: number): Promise<void> | void; nextDue(): number }[] = [];

  define(name: string, run: (t: number) => Promise<void> | void, nextDue: () => number) {
    this.list.push({ name, run, nextDue });
  }

  async run(t: number) {
    for (const x of this.list) await x.run(t);
  }

  next(): number {
    return Math.min(Infinity, ...this.list.map((x) => x.nextDue()));
  }
}
