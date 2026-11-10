// The retention clock: a room is kept while it is in use. One clock with
// two stages, free and Pro alike: 90 days without a counted message → archived (archived_reason 'retention');
// archived 90 days without a restore → permanently purged. A restore starts its clock over. Nothing is sent.

// binAfterDays keeps its config name, now the direct-purge deadline. proGraceDays: a lapsed Pro keeps its file space this
// long (privacy §4). accountRestoreDays: a deleted account can be restored this long, then purged (privacy §4).
export type Retention = { archiveAfterDays: number; binAfterDays: number; proGraceDays: number; accountRestoreDays: number };

const DEFAULTS: Retention = { archiveAfterDays: 90, binAfterDays: 90, proGraceDays: 30, accountRestoreDays: 7 };
/** The privacy policy's 30 days run from the person's letter: restoring plus handling it fit in them. */
const RESTORE_MAX_DAYS = 21;
export const DAY_MS = 86400_000;

/**
 * The day this shipped (2026-10-07 UTC): rooms that existed then start their clock on it — active rooms quiet from
 * then, archived ones archived from then (D1 migration 0010; the RoomDO moves its own archived_at once).
 */
export const RETENTION_SINCE = 1791331200000;

/** Rooms one stage takes per run, oldest first; what a run does not reach the next day's does. */
const BATCH = 100;

/**
 * The days of each stage: the defaults, made longer by KV config:retention where it says more (never shorter); the
 * account restore window either way, 1 to 21 days. Change config:retention only once the privacy policy says the same.
 */
export async function retentionDays(env: Env): Promise<Retention> {
  const cfg = await env.KV.get<Partial<Retention>>("config:retention", { type: "json", cacheTtl: 300 }).catch(() => null);
  const out = { ...DEFAULTS };
  for (const k of ["archiveAfterDays", "binAfterDays", "proGraceDays"] as const) {
    const v = Number(cfg?.[k]);
    if (Number.isFinite(v) && v > out[k]) out[k] = v;
  }
  const restore = Number(cfg?.accountRestoreDays);
  if (Number.isInteger(restore) && restore >= 1 && restore <= RESTORE_MAX_DAYS) out.accountRestoreDays = restore;
  // Tests only: short stages (fractions of a day), so a local run sees a room through both.
  if (env.TEST_RETENTION) Object.assign(out, JSON.parse(env.TEST_RETENTION) as Partial<Retention>);
  return out;
}

type Owner = { id: string; handle: string };
type Due = { id: string; owner_id: string; handle: string };

/**
 * Both stages of the clock, oldest first. The room object rechecks whether the deadline still holds, then D1
 * follows it. purgeRoom removes storage and D1 rows; failed purges remain marked for the daily retry.
 */
export async function runRetention(env: Env, days: Retention, purgeRoom: (roomId: string) => Promise<void>): Promise<Owner[]> {
  const owners = new Map<string, Owner>();
  const t = Date.now();

  // 1. Quiet since before the cutoff → archived. D1's active_at is at most a day behind the room's last message;
  // the room checks its own last message, so nothing is archived early.
  const quietBefore = t - days.archiveAfterDays * DAY_MS;
  const quiet = await env.DB.prepare(
    `SELECT r.id, r.owner_id, u.handle FROM rooms r JOIN users u ON u.id = r.owner_id
      WHERE r.status = 'active' AND r.active_at < ? ORDER BY r.active_at LIMIT ?`,
  )
    .bind(quietBefore, BATCH)
    .all<Due>();
  for (const r of quiet.results) {
    try {
      const out = await env.ROOMS.getByName(r.id).quietArchive(quietBefore);
      if ("err" in out) {
        console.error(JSON.stringify({ msg: "retention archive refused", room: r.id, error: out.err.code }));
        continue;
      }
      if (out.ok.archivedAt == null) {
        // Someone spoke after all (D1 missed the day): the clock starts from then.
        await env.DB.prepare("UPDATE rooms SET active_at = MAX(COALESCE(active_at, 0), ?) WHERE id = ?").bind(out.ok.lastAt, r.id).run();
        continue;
      }
      await env.DB.prepare("UPDATE rooms SET status = 'archived', archived_at = ?, archived_reason = ? WHERE id = ? AND status = 'active'")
        .bind(out.ok.archivedAt, out.ok.archivedReason, r.id)
        .run();
      owners.set(r.owner_id, { id: r.owner_id, handle: r.handle });
    } catch (e) {
      console.error(JSON.stringify({ msg: "retention archive failed", room: r.id, error: String(e) }));
    }
  }

  // 2. Archived since before the cutoff (by its owner, a downgrade or stage 1) → permanent purge.
  const archivedBefore = t - days.binAfterDays * DAY_MS;
  const stale = await env.DB.prepare(
    `SELECT r.id, r.owner_id, u.handle FROM rooms r JOIN users u ON u.id = r.owner_id
      WHERE r.status = 'archived' AND r.archived_at < ? ORDER BY r.archived_at LIMIT ?`,
  )
    .bind(archivedBefore, BATCH)
    .all<Due>();
  for (const r of stale.results) {
    try {
      const out = await env.ROOMS.getByName(r.id).retentionPurge(archivedBefore);
      if ("err" in out) {
        console.error(JSON.stringify({ msg: "retention purge refused", room: r.id, error: out.err.code }));
        continue;
      }
      if (out.ok.deletedAt == null) continue; // restored meanwhile
      await env.DB.prepare("UPDATE rooms SET status = 'deleted', deleted_at = ?, purge_pending = 1 WHERE id = ? AND status = 'archived'").bind(out.ok.deletedAt, r.id).run();
      owners.set(r.owner_id, { id: r.owner_id, handle: r.handle });
      await purgeRoom(r.id);
    } catch (e) {
      console.error(JSON.stringify({ msg: "retention purge failed", room: r.id, error: String(e) }));
    }
  }
  if (quiet.results.length || stale.results.length) {
    console.log(JSON.stringify({ msg: "retention", quiet: quiet.results.length, stale: stale.results.length, owners: owners.size }));
  }
  return [...owners.values()];
}

/** How many whole days are left until `from + days` (at least 1: a stage that is due lands at the next run). */
export function daysLeft(from: number, days: number, t = Date.now()): number {
  return Math.max(1, Math.ceil((from + days * DAY_MS - t) / DAY_MS));
}
