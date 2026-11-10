// An account's file space: every upload is stored, and when the uploader's space is
// over its limit their oldest files go — by upload time, over all their rooms — right after the upload's answer
// (waitUntil) and in the daily job. The rooms own the files; D1 account_files is the index across rooms that finds
// the oldest, and storage_usage the running total of what is charged to each account.

import { limitsFor, hosted, spaceOf, type Plan } from "./plans";
import { accountOf } from "./files";
import { copyBeforeEvict } from "./drive";

/** The uploads of the last minutes made the space full: they are never the ones to go. */
const RECENT_MS = 10 * 60_000;
/** One eviction run per account: how long its lock holds before another run may take over. */
const LOCK_MS = 2 * 60_000;
/** Files one run looks at per account; the next upload or the next day's job carries on. */
const RUN_FILES = 2000;
/** Files one call to a room's object evicts. */
const ROOM_BATCH = 400;
/** How long one room's batch may spend copying files to the uploader's Drive before they go. */
const COPY_MS = 20_000;
/** The KV key saying the index was built from the rooms (until then nothing is evicted). */
const INDEXED_KEY = "files:indexed";
const INDEXING_KEY = "files:indexing";

const today = () => new Date().toISOString().slice(0, 10);

export async function roomOfFile(env: Env, fileId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT room_id FROM file_rooms WHERE file_id = ?",
  )
    .bind(fileId)
    .first<{ room_id: string }>();
  return row?.room_id ?? null;
}

/** An upload was recorded in its room: the day's upload count, the space it takes, and the index entry, together. */
export async function recordUpload(
  env: Env,
  f: { userId: string; roomId: string; fileId: string; size: number; charged: number; at: number; hash: string; name: string },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO upload_usage (user_id, day, count, bytes) VALUES (?, ?, 1, ?)
       ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1, bytes = bytes + excluded.bytes`,
    ).bind(f.userId, today(), f.charged),
    env.DB.prepare(
      `INSERT INTO storage_usage (user_id, bytes) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET bytes = bytes + excluded.bytes`,
    ).bind(f.userId, f.charged),
    env.DB.prepare("INSERT OR REPLACE INTO account_files (room_id, file_id, user_id, size, charged, uploaded_at, hash, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      f.roomId,
      f.fileId,
      f.userId,
      f.size,
      f.charged,
      f.at,
      f.hash,
      f.name,
    ),
    env.DB.prepare("INSERT OR IGNORE INTO file_rooms (file_id, room_id) VALUES (?, ?)").bind(f.fileId, f.roomId), // its /v/ link
  ]);
}

/**
 * A file went from its room (swept unsent, purged from the bin, evicted). Its charge, as the index has it, goes
 * back to its uploader; when another copy in the room (heir) still holds the bytes, the charge moves to that one's
 * uploader. Keyed on the index row, so doing it twice releases nothing the second time.
 */
export async function fileGone(env: Env, roomId: string, fileId: string, heirId: string | null): Promise<void> {
  const charged = "COALESCE((SELECT charged FROM account_files WHERE room_id = ?1 AND file_id = ?2), 0)";
  const stmts = [];
  if (heirId) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO storage_usage (user_id, bytes)
           SELECT h.user_id, d.charged FROM account_files h, account_files d
            WHERE h.room_id = ?1 AND h.file_id = ?3 AND d.room_id = ?1 AND d.file_id = ?2
         ON CONFLICT (user_id) DO UPDATE SET bytes = bytes + excluded.bytes`,
      ).bind(roomId, fileId, heirId),
      env.DB.prepare(`UPDATE account_files SET charged = charged + ${charged} WHERE room_id = ?1 AND file_id = ?3`).bind(roomId, fileId, heirId),
    );
  }
  stmts.push(
    env.DB.prepare(
      `UPDATE storage_usage SET bytes = MAX(0, bytes - ${charged})
        WHERE user_id = (SELECT user_id FROM account_files WHERE room_id = ?1 AND file_id = ?2)`,
    ).bind(roomId, fileId),
    env.DB.prepare("DELETE FROM account_files WHERE room_id = ?1 AND file_id = ?2").bind(roomId, fileId),
  );
  await env.DB.batch(stmts);
}

/** Index entries whose files are not in their room any more (or whose room is gone): forgotten, their charge released. */
async function forget(env: Env, roomId: string, fileIds: string[]): Promise<void> {
  for (const id of fileIds) await fileGone(env, roomId, id, null);
}

/** A room gone for good (purged): its uploaders get back what its files took, and its index entries go. */
export async function roomGone(env: Env, roomId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE storage_usage SET bytes = MAX(0, bytes - COALESCE((SELECT SUM(a.charged) FROM account_files a WHERE a.room_id = ?1 AND a.user_id = storage_usage.user_id), 0))
        WHERE user_id IN (SELECT user_id FROM account_files WHERE room_id = ?1)`,
    ).bind(roomId),
    env.DB.prepare("DELETE FROM account_files WHERE room_id = ?1").bind(roomId),
    env.DB.prepare("DELETE FROM file_rooms WHERE room_id = ?1").bind(roomId),
  ]);
}

export interface Space {
  plan: Plan;
  used: number;
  limit: number;
  /** Upload time (ms) of the file that would go first; null when nothing of theirs can go. */
  oldest: number | null;
  /** A lapsed Pro: until then the space is still Pro's. */
  graceUntil: number | null;
}

/** Where an account's file space stands. `oldest` is looked up only from 80%, where it is shown. */
export async function spaceNow(env: Env, userId: string): Promise<Space> {
  const [row, s] = await Promise.all([
    env.DB.prepare("SELECT bytes FROM storage_usage WHERE user_id = ?").bind(userId).first<{ bytes: number }>(),
    spaceOf(env, userId),
  ]);
  const used = row?.bytes ?? 0;
  let oldest: number | null = null;
  if (used >= s.limit * 0.8) {
    oldest =
      (
        await env.DB.prepare("SELECT MIN(uploaded_at) AS t FROM account_files WHERE user_id = ? AND charged > 0")
          .bind(userId)
          .first<{ t: number | null }>()
      )?.t ?? null;
  }
  return { plan: s.plan, used, limit: s.limit, oldest, graceUntil: s.graceUntil };
}

/** The `space` of an upload or send answer: from 80% of the space on, else nothing. */
export function spaceField(s: Space): { space?: { used: number; limit: number; oldest: number | null; graceUntil?: number } } {
  if (s.used < s.limit * 0.8) return {};
  return { space: { used: s.used, limit: s.limit, oldest: s.oldest, ...(s.graceUntil ? { graceUntil: s.graceUntil } : {}) } };
}

/** Whether the index has been built from the rooms; eviction waits for it (an empty index would pick the newest). */
export async function indexed(env: Env): Promise<boolean> {
  return (await env.KV.get(INDEXED_KEY, { cacheTtl: 300 }).catch(() => null)) != null;
}

/**
 * Build the index from every room's files (once, after the index arrived; again is harmless), then set each
 * account's total to what the index says it is charged.
 */
export async function indexFiles(env: Env): Promise<{ rooms: number; files: number; failed: string[] }> {
  // Uploads arriving together each ask for it: one build at a time, and after a failed one a few minutes' pause.
  if (await env.KV.get(INDEXING_KEY)) return { rooms: 0, files: 0, failed: ["busy"] };
  await env.KV.put(INDEXING_KEY, "1", { expirationTtl: 300 });
  const { results: rooms } = await env.DB.prepare("SELECT id FROM rooms").all<{ id: string }>();
  let files = 0;
  const failed: string[] = [];
  for (const { id } of rooms) {
    try {
      const r = await env.ROOMS.getByName(id).fileIndex();
      if ("err" in r) {
        if (r.err.code !== "room_not_found") failed.push(id);
        continue;
      }
      const stmts = r.ok.map((f) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO account_files (room_id, file_id, user_id, size, charged, uploaded_at, hash, name) SELECT ?, ?, id, ?, ?, ?, ?, ? FROM users WHERE handle = ?",
        ).bind(id, f.id, f.size, f.charged, f.ts, f.hash, f.name, accountOf(f.uploadedBy)),
      );
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      files += stmts.length;
    } catch (e) {
      failed.push(id);
      console.error(JSON.stringify({ msg: "file index failed", room: id, error: String(e) }));
    }
  }
  // A room that could not be read keeps the old totals: better a total too low (nothing evicted) than too high.
  if (failed.length) return { rooms: rooms.length, files, failed };
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO storage_usage (user_id, bytes) SELECT DISTINCT user_id, 0 FROM account_files"),
    env.DB.prepare("UPDATE storage_usage SET bytes = COALESCE((SELECT SUM(a.charged) FROM account_files a WHERE a.user_id = storage_usage.user_id), 0)"),
  ]);
  await env.KV.put(INDEXED_KEY, JSON.stringify({ at: Date.now(), rooms: rooms.length, files }));
  await env.KV.delete(INDEXING_KEY);
  console.log(JSON.stringify({ msg: "file index built", rooms: rooms.length, files }));
  return { rooms: rooms.length, files, failed };
}

/**
 * The account's space is over its limit: its oldest files go until it is not. One run per account
 * at a time (a lock in its storage_usage row); each room concerned gets one system line for the run.
 */
export async function evictOldest(env: Env, user: { id: string; handle: string }): Promise<{ files: number; rooms: number }> {
  const out = { files: 0, rooms: 0 };
  if (!(await indexed(env))) return out;
  const over = async () => {
    const [row, s] = await Promise.all([
      env.DB.prepare("SELECT bytes FROM storage_usage WHERE user_id = ?").bind(user.id).first<{ bytes: number }>(),
      spaceOf(env, user.id),
    ]);
    return (row?.bytes ?? 0) - s.limit;
  };
  if ((await over()) <= 0) return out;
  const start = Date.now();
  const lock = await env.DB.prepare("UPDATE storage_usage SET evicting_until = ?1 WHERE user_id = ?2 AND (evicting_until IS NULL OR evicting_until < ?3)")
    .bind(start + LOCK_MS, user.id, start)
    .run();
  if (!lock.meta.changes) return out;
  // Per room, what went in this run, for its one line at the end.
  const shown = new Map<string, { name: string; size: number }[]>();
  // Files whose copy to the uploader's Drive did not go through this run: they stay, the next run tries again.
  const held = new Set<string>();
  try {
    let looked = 0;
    for (let round = 0; round < 10 && looked < RUN_FILES; round++) {
      let need = await over();
      if (need <= 0) break;
      // The oldest files charged to them, enough to come back within the limit.
      const { results } = await env.DB.prepare(
        "SELECT room_id, file_id, charged FROM account_files WHERE user_id = ? AND charged > 0 AND uploaded_at < ? ORDER BY uploaded_at, file_id LIMIT ?",
      )
        .bind(user.id, start - (env.EVICT_RECENT_MS != null ? Number(env.EVICT_RECENT_MS) : RECENT_MS), Math.min(500, RUN_FILES - looked))
        .all<{ room_id: string; file_id: string; charged: number }>();
      const left = results.filter((f) => !held.has(`${f.room_id}/${f.file_id}`));
      if (!left.length) break;
      const byRoom = new Map<string, string[]>();
      for (const f of left) {
        byRoom.set(f.room_id, [...(byRoom.get(f.room_id) || []), f.file_id]);
        looked++;
        need -= f.charged;
        if (need <= 0) break;
      }
      let progressed = false;
      for (const [roomId, ids] of byRoom) {
        for (let i = 0; i < ids.length; i += ROOM_BATCH) {
          // Into their Drive first when they connected one; what could not be copied now stays for a later run.
          const all = ids.slice(i, i + ROOM_BATCH);
          const chunk = await copyBeforeEvict(env, user, roomId, all, COPY_MS);
          for (const id of all) if (!chunk.includes(id)) held.add(`${roomId}/${id}`);
          if (!chunk.length) continue;
          const r = await env.ROOMS.getByName(roomId).evictFiles(user.handle, chunk);
          if ("err" in r) {
            // Purged meanwhile: what the index still has of it is stale.
            if (r.err.code === "room_not_found") {
              await forget(env, roomId, chunk);
              progressed = true;
            } else console.error(JSON.stringify({ msg: "evict failed", room: roomId, error: r.err.code }));
            continue;
          }
          if (r.ok.missing.length) await forget(env, roomId, r.ok.missing);
          out.files += r.ok.gone.length + r.ok.trashed.length;
          if (r.ok.gone.length || r.ok.trashed.length || r.ok.missing.length) progressed = true;
          if (r.ok.shown.length) shown.set(roomId, [...(shown.get(roomId) || []), ...r.ok.shown]);
        }
      }
      if (!progressed) break;
      await env.DB.prepare("UPDATE storage_usage SET evicting_until = ? WHERE user_id = ?").bind(Date.now() + LOCK_MS, user.id).run();
    }
  } finally {
    for (const [roomId, files] of shown) {
      await env.ROOMS.getByName(roomId)
        .evictedLine(user.handle, files)
        .catch((e) => console.error(JSON.stringify({ msg: "evicted line failed", room: roomId, error: String(e) })));
    }
    out.rooms = shown.size;
    await env.DB.prepare("UPDATE storage_usage SET evicting_until = NULL WHERE user_id = ?").bind(user.id).run();
  }
  if (out.files) console.log(JSON.stringify({ msg: "evicted", account: user.handle, files: out.files, rooms: out.rooms }));
  return out;
}

/**
 * The daily job: every account over its space — a run that was missed or cut short, a lapsed Pro whose 30 days
 * are over, a charge that moved to someone — comes back within it. Builds the index first if it was never built.
 */
export async function evictAll(env: Env): Promise<void> {
  if (!(await indexed(env))) {
    const r = await indexFiles(env);
    if (r.failed.length) return;
  }
  const smallest = (await limitsFor(env, hosted(env) ? "free" : "self")).storageBytes;
  const { results } = await env.DB.prepare(
    // Not a deleted account: its files wait out the 7 days in which it can be undone.
    "SELECT s.user_id, u.handle FROM storage_usage s JOIN users u ON u.id = s.user_id WHERE s.bytes > ? AND u.deleted_at IS NULL ORDER BY s.bytes DESC LIMIT 1000",
  )
    .bind(smallest)
    .all<{ user_id: string; handle: string }>();
  for (const r of results) {
    await evictOldest(env, { id: r.user_id, handle: r.handle }).catch((e) =>
      console.error(JSON.stringify({ msg: "evict run failed", account: r.handle, error: String(e) })),
    );
  }
}
