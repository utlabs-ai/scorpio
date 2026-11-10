// A computer logged out (docs/api/auth.md): why its token stopped working, and when its newest token expired, the
// relogin episode, in which the server speaks for the computer (a push, a line in each topic, the devices row).

import { notifyPerson } from "./push";
import { activeRoomIdsOf, connectedRoomIdsOf } from "./room-index";

export type TokenReason = "revoked" | "replaced" | "plan" | "expired";

/** What the token check reads of a token and its account. */
export type TokenState = { revoked_at: number | null; revoked_reason: string | null; expires_at: number; deleted_at: number | null };

/**
 * Why a token the server knows is refused, or null while it is good. A deleted account's tokens are revoked; a token
 * revoked before the reasons were kept (no reason) counts as revoked; expiry is decided now.
 */
export function tokenRefusal(s: TokenState, t: number): TokenReason | null {
  if (s.revoked_at != null) return s.revoked_reason === "replaced" || s.revoked_reason === "plan" ? s.revoked_reason : "revoked";
  if (s.deleted_at != null) return "revoked";
  return s.expires_at < t ? "expired" : null;
}

/** A relogin code of a device answers again while it is pending and younger than this. */
export const RELOGIN_REPEAT_MS = 10 * 60_000;

/**
 * The account whose computer asks to come back, only when that computer's newest token has expired. Otherwise null and
 * the request is an ordinary device code: no token, an account deleted, a token revoked, or one still good (a computer
 * that lost its token file logs in again on that computer).
 */
export async function reloginAccount(env: Env, deviceId: string, t: number): Promise<{ userId: string; handle: string } | null> {
  const row = await env.DB.prepare(
    `SELECT t.user_id, t.revoked_at, t.revoked_reason, t.expires_at, u.handle, u.deleted_at
       FROM agent_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.device_id = ? ORDER BY t.created_at DESC LIMIT 1`,
  ).bind(deviceId).first<TokenState & { user_id: string; handle: string }>();
  if (!row || tokenRefusal(row, t) !== "expired") return null;
  return { userId: row.user_id, handle: row.handle };
}

/** The device's relogin code still pending from the last 10 minutes, with what the CLI needs to poll it again. */
export async function pendingRelogin(env: Env, deviceId: string, t: number) {
  return env.DB.prepare(
    `SELECT device_code, user_code, expires_at, interval FROM device_codes
      WHERE device_id = ? AND created_at > ? AND relogin = 1 AND status IN ('pending', 'limit') AND expires_at > ? AND device_code IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(deviceId, t - RELOGIN_REPEAT_MS, t).first<{ device_code: string; user_code: string; expires_at: number; interval: number }>();
}

/**
 * The first relogin request of an episode marks the device logged out, and then the person is told: a push to every
 * browser of theirs, and a line in each topic where the computer's daemon seat is active (each topic decides). Later
 * requests of the episode change nothing; a token issued for the device ends it (device.ts deviceToken).
 */
export async function startLogoutEpisode(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, account: { userId: string; handle: string }, deviceId: string, userCode: string, t: number): Promise<void> {
  const first = await env.DB.prepare("UPDATE devices SET logged_out_at = ? WHERE user_id = ? AND device_id = ? AND logged_out_at IS NULL")
    .bind(t, account.userId, deviceId).run();
  if (first.meta.changes !== 1) return;
  const d = await env.DB.prepare("SELECT name, machine, device_name FROM devices WHERE user_id = ? AND device_id = ?")
    .bind(account.userId, deviceId).first<{ name: string | null; machine: string | null; device_name: string }>();
  const computer = d?.name || d?.machine || d?.device_name || "computer"; // name: set from the daemon's first join
  ctx.waitUntil((async () => {
    const rooms = await activeRoomIdsOf(env, account.userId);
    await Promise.allSettled([
      notifyPerson(env, account.handle, { type: "device_logged_out", tag: `logout:${deviceId}`, url: `/activate?code=${userCode}`, name: computer }),
      ...rooms.map((r) => env.ROOMS.getByName(r.id).loggedOutLine(account.handle, deviceId, computer)),
    ]);
  })());
}

/** Topics asked at once to close a token's connections. */
const CLOSE_BATCH = 20;

/**
 * Tokens that just stopped working lose their connections: every topic of the account where it can
 * still be connected (active or archived, however many) closes the ones opened with them with 4011 and the reason, so
 * a revoked computer stops receiving at once and hears why. The topics are asked 20 at a time.
 */
export async function closeTokenSockets(env: Env, userId: string, tokenIds: string[], reason: TokenReason): Promise<void> {
  if (!tokenIds.length) return;
  const rooms = await connectedRoomIdsOf(env, userId);
  for (let i = 0; i < rooms.length; i += CLOSE_BATCH) {
    await Promise.allSettled(rooms.slice(i, i + CLOSE_BATCH).map((r) => env.ROOMS.getByName(r.id).closeTokens(tokenIds, reason)));
  }
}

/** The account's computers logged out unexpectedly: since when, and the relogin code to approve (null when none is pending). */
export async function loggedOutDevices(env: Env, userId: string, t: number): Promise<Map<string, { at: number; code: string | null }>> {
  const { results } = await env.DB.prepare(
    `SELECT d.device_id, d.logged_out_at,
        (SELECT c.user_code FROM device_codes c WHERE c.device_id = d.device_id AND c.relogin = 1 AND c.status IN ('pending', 'limit') AND c.expires_at > ?2
          ORDER BY c.created_at DESC LIMIT 1) AS code
       FROM devices d WHERE d.user_id = ?1 AND d.logged_out_at IS NOT NULL`,
  ).bind(userId, t).all<{ device_id: string; logged_out_at: number; code: string | null }>();
  return new Map(results.map((r) => [r.device_id, { at: r.logged_out_at, code: r.code }]));
}
