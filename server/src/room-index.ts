// D1's room index and the room code used by the HTTP routes and room actions.
import { ApiError, randomFrom } from "./util";
import { limitsFor, planOf } from "./plans";
import { alert } from "./ops";
import { indexFix, type IndexMember, type IndexRow } from "./room-index-fix";

// Passcodes the server suggests: easy to read aloud and type on a phone.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const suggestCode = () => {
  const r = randomFrom(CODE_ALPHABET, 9);
  return `${r.slice(0, 3)}-${r.slice(3, 6)}-${r.slice(6)}`;
};

/** One-off passcode expiry sweep: keyset pages include archived topics and pending purges. */
export async function passcodeSweepPage(env: Env, after: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM rooms WHERE id > ? AND (status != 'deleted' OR purge_pending = 1) ORDER BY id LIMIT 20",
  ).bind(after).all<{ id: string }>();
  return results.map((row) => row.id);
}

export async function ownerRoomList(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, topic, status, created_at, archived_at, archived_reason, deleted_at FROM rooms WHERE owner_id = ? ORDER BY created_at DESC LIMIT 500",
  ).bind(userId).all<{
    id: string;
    name: string;
    topic: string;
    status: string;
    created_at: number;
    archived_at: number | null;
    archived_reason: string | null;
    deleted_at: number | null;
  }>();
  return results;
}

export async function activeRoomCount(env: Env, userId: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE owner_id = ? AND status = 'active'").bind(userId).first<{ n: number }>())?.n ?? 0;
}

export async function activeRoomIdsOf(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT r.id FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
        WHERE (r.owner_id = ? OR rm.active = 1) AND r.status = 'active' LIMIT 50`,
  ).bind(userId, userId).all<{ id: string }>();
  return results;
}

/**
 * Every topic where the account can still hold a connection (owned, or an active member; active or archived), with no
 * cap: a token that stops working has its sockets closed in all of them, where activeRoomIdsOf stops at 50.
 */
export async function connectedRoomIdsOf(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT r.id FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?1
        WHERE (r.owner_id = ?1 OR rm.active = 1) AND r.status IN ('active', 'archived')`,
  ).bind(userId).all<{ id: string }>();
  return results;
}

export async function searchableRooms(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.name FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?1
       WHERE (r.owner_id = ?1 OR rm.user_id IS NOT NULL) AND r.status = 'active'
         AND (r.owner_id = ?1 OR rm.active = 1 OR r.visibility = 'link')
       ORDER BY r.created_at DESC LIMIT 200`,
  ).bind(userId).all<{ id: string; name: string }>();
  return results;
}

export async function ownedRoomStatuses(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, status FROM rooms WHERE owner_id = ? AND status IN ('active', 'archived')",
  ).bind(userId).all<{ id: string; status: string }>();
  return results;
}

export async function memberRoomNames(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT r.id, r.name FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ? WHERE (r.owner_id = ? OR rm.active = 1) AND r.status IN ('active', 'archived')",
  ).bind(userId, userId).all<{ id: string; name: string }>();
  return results;
}

export async function listedRoomIds(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.id FROM rooms r LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?1
       WHERE (r.owner_id = ?1 OR rm.user_id IS NOT NULL) AND r.status IN ('active', 'archived')`,
  ).bind(userId).all<{ id: string }>();
  return results;
}

export function createAnswer(env: Env, userId: string, nonce: string) {
  return env.KV.get(`create:${userId}:${nonce}`, "json");
}

export function keepCreateAnswer(env: Env, userId: string, nonce: string, out: unknown) {
  return env.KV.put(`create:${userId}:${nonce}`, JSON.stringify(out), { expirationTtl: 600 });
}

export async function roomExists(env: Env, roomId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 AS x FROM rooms WHERE id = ?").bind(roomId).first();
  return !!r;
}

/** Anonymous snapshots use the index, never waking a topic object. Do not cache this permission check. */
export async function snapshotIsPublic(env: Env, roomId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM rooms WHERE id = ? AND visibility = 'link' AND status IN ('active', 'archived')")
    .bind(roomId).first());
}

export function ownerAndStatus(env: Env, roomId: string) {
  return env.DB.prepare("SELECT owner_id, status FROM rooms WHERE id = ?").bind(roomId).first<{ owner_id: string; status: string }>();
}

export function deleteState(env: Env, roomId: string) {
  return env.DB.prepare("SELECT owner_id, status, purge_pending FROM rooms WHERE id = ?").bind(roomId).first<{ owner_id: string; status: string; purge_pending: number }>();
}

export function createRow(env: Env, row: { id: string; ownerId: string; name: string; topic: string; visibility: string; createdAt: number }) {
  return env.DB.prepare("INSERT OR IGNORE INTO rooms (id, owner_id, name, topic, visibility, status, created_at, active_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
    .bind(row.id, row.ownerId, row.name, row.topic, row.visibility, row.createdAt, row.createdAt).run();
}

export function setTopicRow(env: Env, roomId: string, topic: string) {
  return env.DB.prepare("UPDATE rooms SET topic = ? WHERE id = ?").bind(topic, roomId).run();
}

export function setNameRow(env: Env, roomId: string, name: string) {
  return env.DB.prepare("UPDATE rooms SET name = ? WHERE id = ?").bind(name, roomId).run();
}

export function setVisibilityRow(env: Env, roomId: string, visibility: string) {
  return env.DB.prepare("UPDATE rooms SET visibility = ? WHERE id = ?").bind(visibility, roomId).run();
}

export function archiveRow(env: Env, roomId: string, archivedAt: number) {
  return env.DB.prepare("UPDATE rooms SET status = 'archived', archived_at = ?, archived_reason = NULL WHERE id = ?").bind(archivedAt, roomId).run();
}

export function restoreRow(env: Env, roomId: string, activeAt: number) {
  return env.DB.prepare("UPDATE rooms SET status = 'active', archived_at = NULL, archived_reason = NULL, active_at = ? WHERE id = ?").bind(activeAt, roomId).run();
}

export function markRoomDeleted(env: Env, roomId: string) {
  return env.DB.prepare("UPDATE rooms SET status = 'deleted', deleted_at = ?, purge_pending = 1 WHERE id = ?").bind(Date.now(), roomId).run();
}

export function dropMember(env: Env, roomId: string, userId: string) {
  return env.DB.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").bind(roomId, userId).run();
}

export function dropMemberByHandle(env: Env, roomId: string, handle: string) {
  return env.DB.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = (SELECT id FROM users WHERE handle = ?)").bind(roomId, handle).run();
}

export async function deletedDue(env: Env, before: number) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM rooms WHERE status = 'deleted' AND (purge_pending = 1 OR deleted_at < ?) LIMIT 25",
  ).bind(before).all<{ id: string }>();
  return results;
}

export function roomRowsGone(env: Env, roomId: string) {
  return [
    env.DB.prepare("DELETE FROM room_members WHERE room_id = ?").bind(roomId),
    env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(roomId),
  ] as const;
}

/** A room of this account was created, archived or restored: tell its daemon seats now. */
export async function roomsChanged(env: Env, user: { id: string; handle: string }, except: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM rooms WHERE owner_id = ? AND status = 'active' AND id != ? ORDER BY created_at DESC LIMIT 50")
    .bind(user.id, except)
    .all<{ id: string }>();
  const told: string[] = [];
  for (const r of results) {
    try {
      told.push(...(await env.ROOMS.getByName(r.id).roomsChanged(user.handle, told)));
    } catch (e) {
      console.error(JSON.stringify({ msg: "rooms_changed failed", room: r.id, error: String(e) }));
    }
  }
}

/** May this account have one more active room? The daily making limit is checked only for create. */
export async function checkRoomQuota(env: Env, userId: string, making: boolean) {
  const lim = await limitsFor(env, await planOf(env, userId));
  if (lim.activeRooms != null) {
    const n = await activeRoomCount(env, userId);
    if (n >= lim.activeRooms) {
      throw new ApiError(
        "room_limit",
        `The free plan has ${lim.activeRooms} active topic and this account already has ${n}. Archive a topic you no longer need (on the web, in the topic's menu), or upgrade to Pro for any number of topics.`,
        429,
      );
    }
  }
  if (making) {
    const k = (await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE owner_id = ? AND created_at > ?").bind(userId, Date.now() - 86400_000).first<{ n: number }>())?.n ?? 0;
    if (k >= lim.roomsPerDay) {
      throw new ApiError("rate_limited", `This account has made ${k} topics in the last 24 hours, the most a day. Try again tomorrow.`, 429, 3600);
    }
  }
}

/** Keep the home page's index of who is in which room (the room object is the truth). */
export async function inRoom(env: Env, roomId: string, userId: string, active: boolean) {
  await env.DB.prepare(
    `INSERT INTO room_members (room_id, user_id, active, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (room_id, user_id) DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at WHERE active != excluded.active`,
  )
    .bind(roomId, userId, active ? 1 : 0, Date.now())
    .run();
}

/** A viewer opened a public topic: count it as seen without making them a member. */
export async function visited(env: Env, roomId: string, userId: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id, active, updated_at) VALUES (?, ?, 0, ?)").bind(roomId, userId, Date.now()).run();
}

/** A write to D1's room index failed after the room object changed: try again at 200 / 800 / 2000 ms; true when one landed, else indexWriteFailed and false. Never throws. */
export async function retryIndexWrite(env: Env, roomId: string, action: string, expected: string,
  write: () => Promise<unknown>, after?: () => Promise<void>): Promise<boolean> {
  let error: unknown = undefined;
  for (const delay of [200, 800, 2000]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try { await write(); } catch (e) { error = e; continue; }
    if (after) await after();
    return true;
  }
  await indexWriteFailed(env, roomId, action, expected, error);
  return false;
}

/** Give up on an index write: the log line and the room_index alert. Never throws. */
export async function indexWriteFailed(env: Env, roomId: string, action: string, expected: string, error: unknown): Promise<void> {
  console.error(JSON.stringify({ msg: "room index write failed", room: roomId, action, error: String(error) }));
  try {
    await alert(env, "room_index", roomId, `Room ${roomId}: ${action} left D1 behind; expected ${expected}.`, { action, expected, error: String(error) });
  } catch (e) {
    console.error(JSON.stringify({ msg: "room index alert failed", room: roomId, action, error: String(e) }));
  }
}

/** Repair only rooms named by recent room_index alerts, using their room objects as the truth. */
export async function repairRoomIndex(env: Env, nowMs = Date.now()): Promise<void> {
  try {
    const { results } = await env.DB.prepare("SELECT DISTINCT subject FROM alerts WHERE kind = 'room_index' AND created_at >= ? LIMIT 100")
      .bind(nowMs - 2 * 86400_000).all<{ subject: string }>();
    for (const { subject: id } of results) {
      try {
        const row = await env.DB.prepare("SELECT r.status, r.topic, r.visibility, r.archived_at, r.archived_reason, r.owner_id, u.handle FROM rooms r JOIN users u ON u.id = r.owner_id WHERE r.id = ?")
          .bind(id).first<IndexRow & { owner_id: string; handle: string }>();
        if (!row) continue;
        const { results: members } = await env.DB.prepare("SELECT rm.user_id, u.handle, rm.active FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ?")
          .bind(id).all<IndexMember>();
        const out = await env.ROOMS.getByName(id).indexState();
        if ("err" in out) {
          console.error(JSON.stringify({ msg: "room index check refused", room: id, error: out.err.code }));
          continue;
        }
        const fix = indexFix(row, members, out.ok, nowMs);
        if ("skip" in fix) continue;

        const fixed: string[] = [];
        let statusChanged = false;
        const fields = (["topic", "visibility", "status", "archived_at", "archived_reason", "active_at"] as const)
          .filter((field) => Object.hasOwn(fix.room, field));
        if (fields.length) {
          const result = await env.DB.prepare(`UPDATE rooms SET ${fields.map((field) => `${field} = ?`).join(", ")} WHERE id = ? AND status = ?`)
            .bind(...fields.map((field) => fix.room[field]), id, row.status).run();
          if (result.meta.changes) {
            fixed.push(...fields);
            statusChanged = fields.includes("status");
          }
        }
        let activated = 0, deactivated = 0, removed = 0;
        for (const handle of fix.activate) {
          const user = await env.DB.prepare("SELECT id FROM users WHERE handle = ?").bind(handle).first<{ id: string }>();
          if (user) { await inRoom(env, id, user.id, true); activated++; }
        }
        for (const userId of fix.deactivate) {
          const result = await env.DB.prepare("UPDATE room_members SET active = 0, updated_at = ? WHERE room_id = ? AND user_id = ? AND active = 1")
            .bind(nowMs, id, userId).run();
          deactivated += result.meta.changes;
        }
        for (const userId of fix.remove) {
          const result = await env.DB.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ? AND active = 1")
            .bind(id, userId).run();
          removed += result.meta.changes;
        }
        if (activated) fixed.push(`members+${activated}`);
        if (deactivated) fixed.push(`members0${deactivated}`);
        if (removed) fixed.push(`members-${removed}`);
        if (statusChanged) await roomsChanged(env, { id: row.owner_id, handle: row.handle }, id);
        if (fixed.length) console.log(JSON.stringify({ msg: "room index repaired", room: id, fixed }));
      } catch (e) {
        console.error(JSON.stringify({ msg: "room index repair failed", room: id, error: String(e) }));
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ msg: "room index repair failed", error: String(e) }));
  }
}
