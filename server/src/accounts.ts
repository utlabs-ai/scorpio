// Account settings: the person's displayed name, local-only handoff choice and calendar token.

import { RESERVED, type User } from "./auth";
import { ApiError, randomId } from "./util";
import { isSpawnPerm, type SpawnPerm } from "./spawn-perm";

// ---------- display names (docs/api/concepts.md) ----------

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
/** Invisible or direction-flipping characters a name could hide behind (the joiners emoji need stay allowed). */
const HIDDEN = /[\p{Cc}\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

/**
 * The person's display name, checked: 1–20 characters of any script, no '@' (it would read as an agent's name), and
 * not any account's handle or a reserved name, compared without case. Empty, or the person's own handle, clears it.
 * Returns what is stored: the name, or null for none.
 */
export async function setDisplayName(env: Env, user: User, raw: unknown): Promise<string | null> {
  if (raw != null && typeof raw !== "string") throw new ApiError("bad_request", "displayName is a string (or empty to go back to your account name).");
  const name = (raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  const low = name.toLowerCase();
  let stored: string | null = name || null;
  if (low === user.handle) stored = null;
  if (stored) {
    const n = [...graphemes.segment(name)].length;
    if (n > 20) throw new ApiError("bad_request", `A display name is at most 20 characters; this one has ${n}. Shorten it.`);
    if (name.length > 256) throw new ApiError("bad_request", "The display name is built from too many combining marks. Use fewer.");
    if (HIDDEN.test(name)) throw new ApiError("bad_request", "The display name has invisible or control characters. Type it again without them.");
    if (name.includes("@")) throw new ApiError("bad_request", "A display name cannot contain @: names with @ are agents (role@account). Leave it out.");
    const handle = RESERVED.has(low) || /^daemon(-\d+)?$/.test(low) || (await env.DB.prepare("SELECT 1 FROM users WHERE handle = ? AND id != ?").bind(low, user.id).first());
    if (handle) throw new ApiError("bad_request", `「${name}」 is an account name, so it cannot be a display name: people would mistake you for that account. Pick another.`);
  }
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(stored, user.id).run();
  return stored;
}

/** The person's display name as stored (null: none set; they are shown by their handle). */
export async function displayNameOf(env: Env, userId: string): Promise<string | null> {
  return ((await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(userId).first<{ display_name: string | null }>())?.display_name as string | null) ?? null;
}

export async function handoffLocalOf(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT handoff_local FROM users WHERE id = ?")
    .bind(userId)
    .first<{ handoff_local: number }>();
  return !!row?.handoff_local;
}

export async function setHandoffLocal(env: Env, userId: string, local: boolean): Promise<void> {
  await env.DB.prepare("UPDATE users SET handoff_local = ? WHERE id = ?")
    .bind(local ? 1 : 0, userId)
    .run();
}

// ---------- the calendar subscription token (docs/api/schedules.md, Into a calendar; D1 calendar_tokens) ----------

/** The account's calendar token, made on the first call (the settings row opened), the same on every call after. */
export async function calendarTokenOf(env: Env, userId: string): Promise<string> {
  // Two first calls at once: one row wins the primary key, both read it back.
  await env.DB.prepare("INSERT OR IGNORE INTO calendar_tokens (user_id, token, created_at) VALUES (?, ?, ?)").bind(userId, randomId(32), Date.now()).run();
  const row = await env.DB.prepare("SELECT token FROM calendar_tokens WHERE user_id = ?").bind(userId).first<{ token: string }>();
  if (!row) throw new ApiError("server_error", "The calendar address could not be made; try again.", 500);
  return row.token;
}

/** A new token; the old address answers 404 from the next request. */
export async function resetCalendarToken(env: Env, userId: string): Promise<string> {
  const token = randomId(32);
  await env.DB.prepare("INSERT INTO calendar_tokens (user_id, token, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET token = ?2, created_at = ?3").bind(userId, token, Date.now()).run();
  return token;
}

/** The live account a calendar token belongs to, or null (unknown token, or an account that is deleted). */
export async function userByCalendarToken(env: Env, token: string): Promise<{ id: string; handle: string } | null> {
  const row = await env.DB.prepare("SELECT u.id, u.handle FROM calendar_tokens c JOIN users u ON u.id = c.user_id WHERE c.token = ? AND u.deleted_at IS NULL")
    .bind(token).first<{ id: string; handle: string }>();
  return row ?? null;
}

/** Read afresh for each account request; a change applies from the next spawn. */
export async function spawnPermOf(env: Env, userId: string): Promise<SpawnPerm> {
  const row = await env.DB.prepare("SELECT spawn_perm FROM users WHERE id = ?")
    .bind(userId).first<{ spawn_perm: SpawnPerm }>();
  return row?.spawn_perm ?? "all";
}

export async function setSpawnPerm(env: Env, userId: string, perm: unknown): Promise<SpawnPerm> {
  if (!isSpawnPerm(perm)) throw new ApiError("bad_request", "perm must be ask, auto or all.");
  await env.DB.prepare("UPDATE users SET spawn_perm = ? WHERE id = ?").bind(perm, userId).run();
  return perm;
}

/** Account preference; the topic page reads it on opening, not while sending. */
export async function autoCallBackOf(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT auto_call_back FROM users WHERE id = ?")
    .bind(userId).first<{ auto_call_back: number }>();
  return row?.auto_call_back !== 0;
}

export async function setAutoCallBack(env: Env, userId: string, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE users SET auto_call_back = ? WHERE id = ?")
    .bind(on ? 1 : 0, userId).run();
}
