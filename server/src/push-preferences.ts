// A browser's push endpoint is its device identity for notification settings.
import { ApiError, str } from "./util";

export interface PushPreferences {
  todoAssigned: boolean;
  quotaWarn: boolean;
  sound: boolean;
  mutedRooms: string[];
}

function endpointOf(value: unknown): string {
  const endpoint = str(value, 1000);
  if (!/^https:\/\/[^\s]+$/.test(endpoint)) throw new ApiError("bad_request", "A push subscription endpoint is required.");
  return endpoint;
}

/** A browser may register only a push service we send to, never an arbitrary HTTPS target. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname;
    return host === "fcm.googleapis.com"
      || host === "updates.push.services.mozilla.com"
      || host === "web.push.apple.com"
      || host.endsWith(".web.push.apple.com")
      || (host !== "notify.windows.com" && host.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}

export function pushTestRetryAfter(lastAt: number, at: number): number {
  return Math.max(1, Math.ceil((lastAt + 60_000 - at) / 1000));
}

/** The conditional D1 write reserves one test per person across all their sessions. */
export async function reservePushTest(env: Env, userId: string): Promise<void> {
  const at = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO push_test_limits (user_id, last_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_at = excluded.last_at WHERE last_at <= ?`,
  ).bind(userId, at, at - 60_000).run();
  if (result.meta.changes) return;
  const row = await env.DB.prepare("SELECT last_at FROM push_test_limits WHERE user_id = ?")
    .bind(userId).first<{ last_at: number }>();
  const wait = pushTestRetryAfter(row?.last_at ?? at, at);
  throw new ApiError("rate_limited", `One test notification per minute. Try again in ${wait} s.`, 429, wait);
}

export async function savePushSubscription(env: Env, userId: string, endpoint: string, p256dh: string, auth: string): Promise<void> {
  const clearOtherAccountPreferences = env.DB.prepare(
    "DELETE FROM push_muted_rooms WHERE endpoint = ? AND EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id != ?)",
  ).bind(endpoint, endpoint, userId);
  const upsert = env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0,
         created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.created_at ELSE excluded.created_at END,
         todo_assigned = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.todo_assigned ELSE 1 END,
         quota_warn = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.quota_warn ELSE 1 END,
         sound = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.sound ELSE 1 END`,
  ).bind(endpoint, userId, p256dh, auth, Date.now());
  await env.DB.batch([
    clearOtherAccountPreferences,
    upsert,
    env.DB.prepare("DELETE FROM push_muted_rooms WHERE endpoint IN (SELECT endpoint FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5))").bind(userId, userId),
    env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5)").bind(userId, userId),
  ]);
}

async function owned(env: Env, userId: string, endpoint: string) {
  const row = await env.DB.prepare(
    "SELECT todo_assigned, quota_warn, sound FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
  ).bind(endpoint, userId).first<{ todo_assigned: number; quota_warn: number; sound: number }>();
  if (!row) throw new ApiError("push_subscription_not_found", "Turn on push notifications on this device first.", 404);
  return row;
}

export async function readPushPreferences(env: Env, userId: string, value: unknown): Promise<PushPreferences> {
  const endpoint = endpointOf(value);
  const row = await owned(env, userId, endpoint);
  const { results } = await env.DB.prepare(
    `SELECT m.room_id FROM push_muted_rooms m JOIN rooms r ON r.id = m.room_id
     LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
     WHERE m.endpoint = ? AND r.status IN ('active', 'archived')
       AND (r.owner_id = ? OR rm.active = 1 OR (r.visibility = 'link' AND rm.user_id IS NOT NULL))
     ORDER BY m.room_id`,
  ).bind(userId, endpoint, userId).all<{ room_id: string }>();
  return { todoAssigned: !!row.todo_assigned, quotaWarn: !!row.quota_warn, sound: !!row.sound, mutedRooms: results.map((r) => r.room_id) };
}

/** A partial write: booleans for event/sound switches, or roomId+muted for one room. */
export async function writePushPreferences(env: Env, userId: string, body: Record<string, unknown>): Promise<PushPreferences> {
  const endpoint = endpointOf(body.endpoint);
  await owned(env, userId, endpoint);
  const columns: { field: string; value: number }[] = [];
  for (const [key, field] of [["todoAssigned", "todo_assigned"], ["quotaWarn", "quota_warn"], ["sound", "sound"]] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") throw new ApiError("bad_request", `${key} must be true or false.`);
    columns.push({ field, value: body[key] ? 1 : 0 });
  }
  const hasRoom = body.roomId !== undefined || body.muted !== undefined;
  let roomId = "";
  if (hasRoom) {
    roomId = str(body.roomId, 64);
    if (!/^[A-Za-z0-9_-]{22}$/.test(roomId) || typeof body.muted !== "boolean") {
      throw new ApiError("bad_request", "roomId=<room id> and muted=true|false must be given together.");
    }
    const visible = await env.DB.prepare(
      `SELECT 1 FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
       WHERE r.id = ? AND r.status IN ('active', 'archived')
         AND (r.owner_id = ? OR rm.active = 1 OR (r.visibility = 'link' AND rm.user_id IS NOT NULL))`,
    ).bind(userId, roomId, userId).first();
    if (!visible) throw new ApiError("room_not_found", "This room is not visible to your account.", 404);
  }
  if (!columns.length && !hasRoom) throw new ApiError("bad_request", "Give a preference to change.");
  const stmts = [];
  if (columns.length) stmts.push(env.DB.prepare(
    `UPDATE push_subscriptions SET ${columns.map((c) => `${c.field} = ?`).join(", ")} WHERE endpoint = ? AND user_id = ?`,
  ).bind(...columns.map((c) => c.value), endpoint, userId));
  if (hasRoom) stmts.push(body.muted
    ? env.DB.prepare(
        "INSERT OR IGNORE INTO push_muted_rooms (endpoint, room_id) SELECT endpoint, ? FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
      ).bind(roomId, endpoint, userId)
    : env.DB.prepare(
        "DELETE FROM push_muted_rooms WHERE endpoint = ? AND room_id = ? AND EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?)",
      ).bind(endpoint, roomId, endpoint, userId));
  await env.DB.batch(stmts);
  return readPushPreferences(env, userId, endpoint);
}

/** A dead or removed subscription must not leave a room-preference row behind. */
export async function removePushSubscription(env: Env, endpoint: string, userId?: string): Promise<void> {
  await env.DB.batch(userId ? [
    env.DB.prepare("DELETE FROM push_muted_rooms WHERE endpoint = ? AND EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?)").bind(endpoint, endpoint, userId),
    env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(endpoint, userId),
  ] : [
    env.DB.prepare("DELETE FROM push_muted_rooms WHERE endpoint = ?").bind(endpoint),
    env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint),
  ]);
}
