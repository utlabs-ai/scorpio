import { ApiError } from "./util";
import { roomGone } from "./space";
import { DAY_MS } from "./retention";
import { knownRooms } from "./room-stub";
import { pinsGone } from "./app-topics";
import { deletedDue, markRoomDeleted, ownerAndStatus, roomRowsGone } from "./room-index";
// ---------- permanent room deletion ----------

/**
 * A room gone for good: its object drops its R2 objects and storage, its files' space goes back to their uploaders
 * (by the account index), then its D1 rows go. When the object fails (R2 unreachable) the rows stay, so the next purge tries again.
 */
export async function purgeRoomNow(env: Env, roomId: string): Promise<void> {
  const r = await env.ROOMS.getByName(roomId).purgeRoom();
  if ("err" in r && r.err.code !== "room_not_found")
    throw new ApiError(r.err.code, r.err.next, r.err.status);
  await roomGone(env, roomId); // its uploaders get the space back
  const [membersGone, roomRowGone] = roomRowsGone(env, roomId);
  await env.DB.batch([membersGone, pinsGone(env, roomId), roomRowGone]);
  knownRooms.delete(roomId);
}

/**
 * A topic deleted for good by its creator, as 解散 does it (the "delete" route), for an account being deleted:
 * marked first so the daily job finishes it should the object or R2 fail, then its object and rows go.
 */
export async function deleteTopicForGood(
  env: Env,
  roomId: string,
  owner: { id: string; handle: string },
): Promise<void> {
  const row = await ownerAndStatus(env, roomId);
  if (!row || row.owner_id !== owner.id) return;
  if (row.status !== "deleted")
    await markRoomDeleted(env, roomId);
  const out = await env.ROOMS.getByName(roomId).deleteRoom({
    kind: "human",
    account: owner.handle,
    name: owner.handle,
  });
  if (
    "err" in out &&
    out.err.code !== "room_deleted" &&
    out.err.code !== "room_not_found"
  )
    throw new ApiError(out.err.code, out.err.next, out.err.status);
  await purgeRoomNow(env, roomId);
}

/** Retry failed immediate purges; honor the old 30-day clock for any room deleted while that clock applied. */
export async function purgeExpired(env: Env): Promise<void> {
  const oldConfig = await env.KV.get<{ purgeAfterDays?: number }>(
    "config:retention",
    { type: "json", cacheTtl: 300 },
  ).catch(() => null);
  const configured = Number(oldConfig?.purgeAfterDays);
  const oldDays = Number.isFinite(configured) ? Math.max(30, configured) : 30;
  const before = Date.now() - oldDays * DAY_MS;
  const rooms = await deletedDue(env, before);
  for (const r of rooms) {
    await purgeRoomNow(env, r.id).catch((e) =>
      console.error(
        JSON.stringify({
          msg: "room purge failed",
          room: r.id,
          error: String(e),
        }),
      ),
    );
  }
}
