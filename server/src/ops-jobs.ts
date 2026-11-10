// Cron work for the ops page /admin: fill activity_daily from what rooms said before it existed, and write the
// day's Pro accounts by source.

import { ACTIVITY_INSERT_SQL, BACKFILL_DAYS, DAY_MS, PRO_SNAPSHOT_SQL, dayOf } from "./ops-data";

/** Rooms read per 10-minute tick; each is one room call and a batch of D1 inserts. */
const BACKFILL_ROOMS = 20;

/** Every 10 minutes: a few rooms not yet read put their senders of the last 30 days into activity_daily, once each. */
export async function activityBackfillTick(env: Env, at = Date.now()): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM rooms WHERE activity_backfilled_at IS NULL AND status IN ('active', 'archived') LIMIT ?")
    .bind(BACKFILL_ROOMS)
    .all<{ id: string }>();
  for (const r of results) {
    try {
      const out = await env.ROOMS.getByName(r.id).activitySince(at - BACKFILL_DAYS * DAY_MS);
      if ("err" in out && out.err.code !== "room_not_found" && out.err.code !== "room_deleted") throw new Error(out.err.code);
      const rows = "ok" in out ? out.ok : [];
      const writes = rows.map((a) => env.DB.prepare(ACTIVITY_INSERT_SQL).bind(a.day, a.kind, a.account));
      for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
      await env.DB.prepare("UPDATE rooms SET activity_backfilled_at = ? WHERE id = ?").bind(at, r.id).run();
    } catch (e) {
      console.error(JSON.stringify({ msg: "activity backfill failed", room: r.id, error: String(e) }));
    }
  }
}

/** Daily: today's Pro accounts by source (the chart's earlier days come from these rows). */
export async function proSnapshot(env: Env, at = Date.now()): Promise<void> {
  await env.DB.prepare(PRO_SNAPSHOT_SQL).bind(dayOf(at), at).run();
}
