// Deleting an account from the ops page. The operator sees what will go, retypes the
// handle and confirms; agents cannot (no /api/v1 route). At once: a live Creem subscription is cancelled; the row
// becomes a tombstone keeping the handle for good and its sign-ins, tokens, devices and push go (before anything is
// deleted); then the topics the account created are deleted the way 解散 deletes them, it leaves
// everyone else's topics (its messages and name stay) and its Drive link goes. A step that fails stays to do: the ops
// page shows it and the daily job tries it again. Seven days later the daily job deletes its files in other people's
// topics, its identities and usage rows; until then ops can undo it. Payments, billing events and the (cancelled)
// entitlement stay (accounting: a refund still finds the account).

import { ApiError, now } from "./util";
import { cancelSubscription } from "./billing";
import { driveDisconnect } from "./drive";
import { revokeSessions } from "./auth";
import { retentionDays } from "./retention";
import { ACCESS_SQL, CLAIM_SQL, DRIVE_ROWS_SQL, LEFTOVER_SQL, PREVIEW_SQL, PURGE_DUE_SQL, PURGE_FILES_SQL, PURGE_SQL, RESTORE_SQL, TRIED_SQL, UNCLAIM_SQL, UNFINISHED_SQL, bindFor, purgeChunkSql } from "./account-delete-sql";

const DAY_MS = 86_400_000;

export type DeletionPreview = {
  id: string;
  handle: string;
  email: string;
  createdAt: number;
  deletedAt: number | null;
  purgedAt: number | null;
  topics: { id: string; name: string }[];
  files: { n: number; bytes: number; elsewhere: number };
  tokens: number;
  devices: number;
  push: number;
  drive: { email: string; connected: boolean } | null;
  creem: { subscriptionId: string | null; periodEnd: number | null; canceledAt: number | null } | null;
  joined: string[];
  /** A deleted account: what its deletion still has to do (null when nothing). */
  left: Leftovers | null;
};

/** What a deletion has not done yet: topics it created, topics it is still listed in, a Drive link. */
export type Leftovers = { topics: string[]; joined: string[]; drive: boolean };

/**
 * How long a deleted account can be restored: config:retention.accountRestoreDays (7 by default, 1–21), or the
 * test knob ACCOUNT_RESTORE_MS (a whole number of ms) as retention has one.
 */
export async function restoreMs(env: Env): Promise<number> {
  const v = String((env as { ACCOUNT_RESTORE_MS?: string }).ACCOUNT_RESTORE_MS ?? "").trim();
  return /^\d+$/.test(v) ? Number(v) : (await retentionDays(env)).accountRestoreDays * DAY_MS;
}

/** What the ops page lists for a handle; null when there is no such account. */
export async function deletionPreview(env: Env, handle: string): Promise<DeletionPreview | null> {
  const u = await env.DB.prepare(PREVIEW_SQL.user).bind(handle).first<{ id: string; handle: string; email: string; created_at: number; deleted_at: number | null; deleted_email: string | null; purged_at: number | null }>();
  if (!u) return null;
  const id = u.id;
  const [topics, files, tokens, devices, push, drive, creem, joined] = await Promise.all([
    env.DB.prepare(PREVIEW_SQL.topics).bind(id).all<{ id: string; name: string }>(),
    env.DB.prepare(PREVIEW_SQL.files).bind(id).first<{ n: number; bytes: number; elsewhere: number }>(),
    env.DB.prepare(PREVIEW_SQL.tokens).bind(id).first<{ n: number }>(),
    env.DB.prepare(PREVIEW_SQL.devices).bind(id).first<{ n: number }>(),
    env.DB.prepare(PREVIEW_SQL.push).bind(id).first<{ n: number }>(),
    env.DB.prepare(PREVIEW_SQL.drive).bind(id).first<{ email: string; connected: number }>(),
    env.DB.prepare(PREVIEW_SQL.creem).bind(id).first<{ subscription_id: string | null; period_end: number | null; canceled_at: number | null }>(),
    env.DB.prepare(PREVIEW_SQL.joined).bind(id).all<{ room_id: string }>(),
  ]);
  return {
    id,
    handle: u.handle,
    email: u.deleted_at ? (u.deleted_email ?? "") : u.email,
    createdAt: u.created_at,
    deletedAt: u.deleted_at,
    purgedAt: u.purged_at,
    topics: topics.results.map((t) => ({ id: t.id, name: t.name })),
    files: { n: files?.n ?? 0, bytes: files?.bytes ?? 0, elsewhere: files?.elsewhere ?? 0 },
    tokens: tokens?.n ?? 0,
    devices: devices?.n ?? 0,
    push: push?.n ?? 0,
    drive: drive ? { email: drive.email, connected: !!drive.connected } : null,
    creem: creem ? { subscriptionId: creem.subscription_id, periodEnd: creem.period_end, canceledAt: creem.canceled_at } : null,
    joined: joined.results.map((j) => j.room_id),
    left: u.deleted_at && !u.purged_at ? await leftovers(env, id) : null,
  };
}

async function leftovers(env: Env, id: string): Promise<Leftovers | null> {
  const [topics, joined, drive] = await Promise.all([
    env.DB.prepare(LEFTOVER_SQL.topics).bind(id).all<{ id: string }>(),
    env.DB.prepare(LEFTOVER_SQL.joined).bind(id).all<{ room_id: string }>(),
    env.DB.prepare(LEFTOVER_SQL.drive).bind(id).first(),
  ]);
  const left = { topics: topics.results.map((t) => t.id), joined: joined.results.map((j) => j.room_id), drive: !!drive };
  return left.topics.length || left.joined.length || left.drive ? left : null;
}

/** How the Worker deletes one topic for good (index.ts: the same steps as 解散). */
export type DeleteTopic = (roomId: string, owner: { id: string; handle: string }) => Promise<void>;

/**
 * Where the slow steps run: ctx.waitUntil in the Worker, so a tab that goes away (a second tap, a reload) does not cut
 * them short as it cut the first live deletion. They are the daily job's own steps, so whatever a
 * cut leaves is done the next day.
 */
export type Background = (work: Promise<unknown>) => void;

/** What the confirm button did: deleted now, deleted already (a second request), or another request is deleting it. */
export type DeleteOutcome = "deleted" | "already" | "in_progress";

/**
 * Delete now (the confirm button). The order matters: Creem first, so a failure there stops everything with nothing
 * changed; then access goes (the tombstone, which every sign-in, session and token check refuses, and the tokens,
 * devices and push), before anything is deleted; then the rest, each step safe to run again. What failed is in the
 * answer's `left`; 「把剩下的做完」 (finishAccount) or the daily job does it.
 */
export async function deleteAccount(env: Env, handle: string, deleteTopic: DeleteTopic, isOps: (h: string) => boolean, background: Background): Promise<DeleteOutcome> {
  const p = await deletionPreview(env, handle);
  if (!p) throw new ApiError("not_found", `There is no account ${handle}.`, 404);
  if (isOps(p.handle)) throw new ApiError("forbidden", "An ops account cannot be deleted here.", 403);
  if (p.deletedAt) return "already";
  if (!(await env.DB.prepare(CLAIM_SQL).bind(p.id, now(), now() - CLAIM_MS).run()).meta.changes) return "in_progress";
  // 1. A live subscription stops charging, at once (the account will not use the rest of the period).
  if (p.creem && !p.creem.canceledAt) {
    const sub = p.creem.subscriptionId;
    const refused = !sub
      ? new ApiError("bad_request", `${handle} has a live Creem subscription with no subscription id here; cancel it in Creem's dashboard first. Nothing was deleted.`, 409)
      : await cancelSubscription(env, p.id, sub).then(
          () => null,
          (e) => new ApiError("payment_unavailable", `Creem did not cancel ${sub} (${e instanceof ApiError ? e.next : String(e)}). Nothing was deleted; try again, or cancel it in Creem's dashboard first.`, 502),
        );
    if (refused) {
      await env.DB.prepare(UNCLAIM_SQL).bind(p.id).run();
      throw refused;
    }
  }
  // 2. Access goes before anything is deleted (should a session survive, sessions refuse a tombstone).
  await env.DB.batch(ACCESS_SQL.map((sql) => env.DB.prepare(sql).bind(...bindFor(sql, p.id, now()))));
  console.log(JSON.stringify({ msg: "account deleted", account: p.handle, topics: p.topics.length, joined: p.joined.length, files: p.files.n }));
  // 3. The rest, in the background: browser sessions, its topics, the others' topics, Drive.
  const u = { id: p.id, handle: p.handle };
  background(
    revokeSessions(env, p.id)
      .catch((e) => console.error(JSON.stringify({ msg: "session revoke failed", account: p.handle, error: String(e) })))
      .then(() => finishDeletion(env, u, deleteTopic))
      .catch((e) => console.error(JSON.stringify({ msg: "account deletion steps failed", account: p.handle, error: String(e) }))),
  );
  return "deleted";
}

/** How long one request holds an account it is deleting before another may try (it gets the state meanwhile). */
const CLAIM_MS = 60_000;

/** 「把剩下的做完」: only for an account that is deleted now (not one restored meanwhile); in the background. */
export async function finishAccount(env: Env, handle: string, deleteTopic: DeleteTopic, background: Background): Promise<void> {
  const p = await deletionPreview(env, handle);
  if (!p?.deletedAt || p.purgedAt) throw new ApiError("bad_request", `${handle} is not a deleted account (it was restored, or purged already); nothing was done.`, 409);
  const u = { id: p.id, handle: p.handle };
  background(finishDeletion(env, u, deleteTopic).catch((e) => console.error(JSON.stringify({ msg: "account deletion steps failed", account: p.handle, error: String(e) }))));
}

/** Asked again before each step: an undo in another tab, or during the daily job, stops what is left. */
async function stillDeleted(env: Env, id: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL").bind(id).first());
}

/**
 * After access went: the topics it created go, as their creator deleting them would; it leaves everyone else's (taken
 * off their member lists, its messages and name stay: the row goes once the topic took it off); Drive's authorization
 * is revoked at Google before its rows go. A step that fails is logged and left for the next run.
 */
async function finishDeletion(env: Env, u: { id: string; handle: string }, deleteTopic: DeleteTopic): Promise<Leftovers | null> {
  const fail = (step: string, e: unknown) => console.error(JSON.stringify({ msg: "account deletion step failed", account: u.handle, step, error: String(e) }));
  const topics = await env.DB.prepare(LEFTOVER_SQL.topics).bind(u.id).all<{ id: string }>();
  for (const t of topics.results) {
    if (!(await stillDeleted(env, u.id))) return null;
    await deleteTopic(t.id, u).catch((e) => fail(`topic ${t.id}`, e));
  }
  const joined = await env.DB.prepare(LEFTOVER_SQL.joined).bind(u.id).all<{ room_id: string; gone: number }>();
  for (const j of joined.results) {
    if (!(await stillDeleted(env, u.id))) return null;
    try {
      if (!j.gone) await env.ROOMS.getByName(j.room_id).accountGone(u.handle);
      await env.DB.prepare("DELETE FROM room_members WHERE user_id = ? AND room_id = ?").bind(u.id, j.room_id).run();
    } catch (e) {
      fail(`leave ${j.room_id}`, e);
    }
  }
  if (!(await stillDeleted(env, u.id))) return null;
  try {
    await driveDisconnect(env, u.id);
    await env.DB.batch(DRIVE_ROWS_SQL.map((sql) => env.DB.prepare(sql).bind(u.id)));
  } catch (e) {
    fail("drive", e);
  }
  return leftovers(env, u.id);
}

/** Undo within the 7 days. */
export async function restoreAccount(env: Env, handle: string): Promise<boolean> {
  const u = await env.DB.prepare(PREVIEW_SQL.user).bind(handle).first<{ id: string; deleted_at: number | null; purged_at: number | null }>();
  if (!u?.deleted_at || u.purged_at) return false;
  if (now() - u.deleted_at > (await restoreMs(env))) return false;
  const r = await env.DB.prepare(RESTORE_SQL).bind(u.id).run();
  return r.meta.changes > 0;
}

/**
 * The daily job: a deletion that left something to do is finished first. Then accounts whose 7 days are over lose
 * their files in other people's topics (each stays in its message marked deleted, as when a full space evicts it),
 * then their identities, file index and usage rows. A topic that fails keeps its files for the next day's run, and so
 * does the account.
 */
export async function purgeDeletedAccounts(env: Env, deleteTopic: DeleteTopic): Promise<void> {
  const tried = (id: string) => env.DB.prepare(TRIED_SQL).bind(id, now()).run();
  const unfinished = await env.DB.prepare(UNFINISHED_SQL).all<{ id: string; handle: string }>();
  for (const u of unfinished.results) {
    await tried(u.id);
    await finishDeletion(env, u, deleteTopic);
  }
  const due = await env.DB.prepare(PURGE_DUE_SQL).bind(now() - (await restoreMs(env))).all<{ id: string; handle: string }>();
  for (const u of due.results) {
    await tried(u.id);
    const files = await env.DB.prepare(PURGE_FILES_SQL).bind(u.id).all<{ room_id: string; file_id: string }>();
    const byRoom = new Map<string, string[]>();
    for (const f of files.results) byRoom.set(f.room_id, [...(byRoom.get(f.room_id) || []), f.file_id]);
    let failed = false;
    for (const [roomId, ids] of byRoom) {
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const r = await env.ROOMS.getByName(roomId).evictFiles(u.handle, chunk).catch((e) => ({ err: { code: String(e), next: "", status: 500 } }));
        if ("err" in r && r.err.code !== "room_not_found") {
          failed = true;
          console.error(JSON.stringify({ msg: "deleted account's files failed", account: u.handle, room: roomId, error: r.err.code }));
          continue;
        }
        await env.DB.batch(purgeChunkSql(chunk.length).map((sql) => env.DB.prepare(sql).bind(...bindFor(sql, u.id, roomId, ...chunk))));
      }
    }
    if (failed || files.results.length >= 2000) continue; // again tomorrow (or the rest of a long list)
    await env.DB.batch(PURGE_SQL.map((sql) => env.DB.prepare(sql).bind(...bindFor(sql, u.id, now()))));
    console.log(JSON.stringify({ msg: "deleted account purged", account: u.handle, files: files.results.length }));
  }
}
