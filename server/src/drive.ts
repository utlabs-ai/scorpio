// Copies into the person's own Google Drive of the files a full space is about to clear:
// personal, not storage — the files stay in R2 and nothing changes for anyone else. A person
// connects their Drive on /settings (the Google sign-in once more, with drive.file and offline access); from then on,
// when their oldest files are about to be evicted, each is first copied into a Scorpio folder there
// (Scorpio/<room name>/<file name>, once per distinct file), one account at a time. Nothing else is copied: no daily
// backup, no export of the rooms (「我的数据」 has that). Token revoked, Drive full, the folder gone: copying stops until
// the person reconnects, and meanwhile files go without a copy.

import { fileKey, storedObject } from "./files";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
/** Up to this size a file goes in one multipart request; bigger ones by resumable upload (Drive's advice). */
const SIMPLE_MAX = 5 * 1024 * 1024;
/** One copy at a time per account: how long one holds the account before another may take over. */
const LOCK_MS = 12 * 60_000;
/** A copy that fails (network, Google busy, a rate limit) is tried this many times, then its file goes uncopied. */
const COPY_TRIES = 3;

/** Google's endpoints; tests point them at a fake (GOOGLE_API_BASE: <base>/<host>/<path>). */
export function google(env: Env, url: string): string {
  return env.GOOGLE_API_BASE ? url.replace(/^https:\/\//, `${env.GOOGLE_API_BASE}/`) : url;
}

/** Copying to Drive needs the Google sign-in and the key the refresh tokens are sealed with. */
export const driveConfigured = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.DRIVE_TOKEN_KEY);

// ---------- the refresh token, sealed (AES-GCM, Worker secret DRIVE_TOKEN_KEY: 32 bytes, base64) ----------

const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const tokenKey = (env: Env) => crypto.subtle.importKey("raw", unb64(env.DRIVE_TOKEN_KEY!), "AES-GCM", false, ["encrypt", "decrypt"]);

async function seal(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(env), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

async function unseal(env: Env, sealed: string): Promise<string> {
  const b = unb64(sealed);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await tokenKey(env), b.slice(12)));
}

// ---------- talking to Google ----------

export type StopReason = "revoked" | "full" | "folder_gone";

/** Copying stops for this until the person reconnects. */
class Stop extends Error {
  constructor(
    readonly reason: StopReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

/** Not now (network, Google busy, a rate limit, the budget): the files wait for the next eviction run. */
class Later extends Error {}

/** What one copy may spend: wall time and subrequests. */
export interface Budget {
  until: number;
  calls: number;
}

export const budget = (ms: number, calls: number): Budget => ({ until: Date.now() + ms, calls });

interface Run {
  env: Env;
  userId: string;
  handle: string;
  token: string;
  budget: Budget;
}

/** One more subrequest out of the budget, or stop here (the next eviction run carries on). */
function charge(b: Budget, n = 1) {
  if (Date.now() > b.until || b.calls < n) throw new Later("budget");
  b.calls -= n;
}
const spend = (run: Run, n = 1) => charge(run.budget, n);

/** An access token for the stored refresh token. invalid_grant: the person revoked Scorpio's access. */
async function accessToken(env: Env, refreshToken: string): Promise<string> {
  let r: Response;
  try {
    r = await fetch(google(env, "https://oauth2.googleapis.com/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
  } catch (e) {
    throw new Later(`token: ${String(e)}`);
  }
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (j.access_token) return j.access_token;
  if (j.error === "invalid_grant" || j.error === "unauthorized_client") throw new Stop("revoked", j.error);
  throw new Later(`token: ${r.status} ${j.error || ""}`);
}

/** A Drive call. 404 comes back to the caller (a file or folder the person deleted); errors that stop backups throw Stop. */
async function call(run: Run, method: string, url: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  spend(run);
  let r: Response;
  try {
    r = await fetch(google(run.env, url), { method, body, headers: { authorization: `Bearer ${run.token}`, ...headers } });
  } catch (e) {
    throw new Later(`${method} drive: ${String(e)}`);
  }
  if (r.ok || r.status === 404) return r;
  const text = await r.text().catch(() => "");
  if (r.status === 401) throw new Stop("revoked", text.slice(0, 200)); // just refreshed: access was taken back meanwhile
  if (r.status === 403 && /storageQuotaExceeded/.test(text)) throw new Stop("full", text.slice(0, 200));
  throw new Later(`${method} drive: ${r.status} ${text.slice(0, 200)}`);
}

const idOf = async (r: Response) => ((await r.json()) as { id: string }).id;

/** A folder in Drive, under `parent` (the Drive's root when none). The parent gone: null. */
async function makeFolder(run: Run, name: string, parent?: string): Promise<string | null> {
  const r = await call(run, "POST", `${FILES}?fields=id`, JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }), {
    "content-type": "application/json; charset=UTF-8",
  });
  return r.status === 404 ? null : idOf(r);
}

/** Is it still there (not deleted, not in Drive's trash)? */
async function alive(run: Run, id: string): Promise<boolean> {
  const r = await call(run, "GET", `${FILES}/${encodeURIComponent(id)}?fields=id,trashed`);
  return r.status !== 404 && !((await r.json()) as { trashed?: boolean }).trashed;
}

/** Rename a file or folder; false when it is gone. */
async function rename(run: Run, id: string, name: string): Promise<boolean> {
  const r = await call(run, "PATCH", `${FILES}/${encodeURIComponent(id)}?fields=id`, JSON.stringify({ name }), { "content-type": "application/json; charset=UTF-8" });
  return r.status !== 404;
}

/**
 * Bytes from R2 into Drive, a new file in `parent`. Up to 5 MB in one multipart request, bigger by resumable upload.
 * Answers the file's id, or null when `parent` is gone.
 */
async function put(run: Run, p: { name: string; parent: string; type: string; size: number; body: ReadableStream }): Promise<string | null> {
  const meta = JSON.stringify({ name: p.name, parents: [p.parent] });
  if (p.size <= SIMPLE_MAX) {
    const bytes = new Uint8Array(await new Response(p.body).arrayBuffer());
    const boundary = `scorpio-${crypto.randomUUID()}`;
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${p.type}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    const r = await call(run, "POST", `${UPLOAD}?uploadType=multipart&fields=id`, body, { "content-type": `multipart/related; boundary=${boundary}` });
    return r.status === 404 ? null : idOf(r);
  }
  const start = await call(run, "POST", `${UPLOAD}?uploadType=resumable&fields=id`, meta, {
    "content-type": "application/json; charset=UTF-8",
    "x-upload-content-type": p.type,
    "x-upload-content-length": String(p.size),
  });
  if (start.status === 404) return null;
  const session = start.headers.get("location");
  if (!session) throw new Later("resumable upload: no session");
  // The bytes stream from R2 straight to Google; a known length lets the one PUT carry them all.
  const fixed = new FixedLengthStream(p.size);
  p.body.pipeTo(fixed.writable).catch(() => {});
  const r = await call(run, "PUT", session, fixed.readable, { "content-type": p.type });
  return r.status === 404 ? null : idOf(r);
}

// ---------- connecting and disconnecting ----------

export interface DriveState {
  connected: boolean;
  email: string | null;
  folderUrl: string | null;
  lastCopyAt: number | null; // the last time files were copied before they went (null: none yet)
  lastCopyCount: number | null; // how many that time
  error: StopReason | null;
}

/** GET /settings/drive. */
export async function driveState(env: Env, userId: string): Promise<DriveState> {
  const r = await env.DB.prepare("SELECT email, token_enc IS NOT NULL AS on_, folder_id, last_copy_at, last_copy_count, error FROM drive_links WHERE user_id = ?")
    .bind(userId)
    .first<{ email: string; on_: number; folder_id: string | null; last_copy_at: number | null; last_copy_count: number | null; error: StopReason | null }>();
  if (!r?.on_) return { connected: false, email: null, folderUrl: null, lastCopyAt: null, lastCopyCount: null, error: null };
  return {
    connected: true,
    email: r.email,
    folderUrl: r.folder_id ? `https://drive.google.com/drive/folders/${encodeURIComponent(r.folder_id)}` : null,
    lastCopyAt: r.last_copy_at,
    lastCopyCount: r.last_copy_count,
    error: r.error,
  };
}

/**
 * Back from Google's consent page with a refresh token: sealed into D1. Reconnecting the same Drive whose Scorpio
 * folder is still there carries on where it was; another Drive (or the folder gone) starts over in a new folder.
 */
export async function driveConnected(env: Env, user: { id: string; handle: string }, g: { refreshToken: string; accessToken: string; email: string }): Promise<void> {
  const prev = await env.DB.prepare("SELECT email, folder_id FROM drive_links WHERE user_id = ?").bind(user.id).first<{ email: string; folder_id: string | null }>();
  let keep = false;
  if (prev?.folder_id && prev.email === g.email) {
    const run: Run = { env, userId: user.id, handle: user.handle, token: g.accessToken, budget: budget(10_000, 2) };
    keep = await alive(run, prev.folder_id).catch(() => false);
  }
  const t = Date.now();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO drive_links (user_id, email, token_enc, folder_id, connected_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (user_id) DO UPDATE SET email = ?2, token_enc = ?3, folder_id = ?4, connected_at = ?5,
         error = NULL, error_at = NULL, running_until = NULL,
         last_copy_at = CASE WHEN ?4 IS NULL THEN NULL ELSE last_copy_at END, last_copy_count = CASE WHEN ?4 IS NULL THEN NULL ELSE last_copy_count END`,
    ).bind(user.id, g.email, await seal(env, g.refreshToken), keep ? prev!.folder_id : null, t),
  ];
  if (!keep) {
    stmts.push(env.DB.prepare("DELETE FROM drive_files WHERE user_id = ?").bind(user.id), env.DB.prepare("DELETE FROM drive_rooms WHERE user_id = ?").bind(user.id));
  }
  await env.DB.batch(stmts);
}

/** The person disconnects: the token goes at once (and Google is told); what was copied stays in their Drive. */
export async function driveDisconnect(env: Env, userId: string): Promise<void> {
  const r = await env.DB.prepare("SELECT token_enc FROM drive_links WHERE user_id = ?").bind(userId).first<{ token_enc: string | null }>();
  await env.DB.prepare("UPDATE drive_links SET token_enc = NULL, error = NULL, error_at = NULL, running_until = NULL WHERE user_id = ?").bind(userId).run();
  if (!r?.token_enc) return;
  try {
    const token = await unseal(env, r.token_enc);
    await fetch(google(env, "https://oauth2.googleapis.com/revoke"), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
  } catch (e) {
    console.warn(JSON.stringify({ msg: "drive revoke failed", error: String(e) }));
  }
}

// ---------- a copy ----------

type Link = { user_id: string; handle: string; email: string; token_enc: string; folder_id: string | null; error: string | null };

/** Take the account for a copy (one at a time), and its link as it is now; null when someone else has it or it is off. */
async function take(env: Env, userId: string): Promise<Link | null> {
  const t = Date.now();
  const got = await env.DB.prepare(
    // Not for a deleted account: its authorization is about to be revoked.
    "UPDATE drive_links SET running_until = ?1 WHERE user_id = ?2 AND token_enc IS NOT NULL AND error IS NULL AND (running_until IS NULL OR running_until < ?3) " +
      "AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND deleted_at IS NULL)",
  )
    .bind(t + LOCK_MS, userId, t)
    .run();
  if (!got.meta.changes) return null;
  return env.DB.prepare("SELECT l.user_id, u.handle, l.email, l.token_enc, l.folder_id, l.error FROM drive_links l JOIN users u ON u.id = l.user_id WHERE l.user_id = ?")
    .bind(userId)
    .first<Link>();
}

const release = (env: Env, userId: string) => env.DB.prepare("UPDATE drive_links SET running_until = NULL WHERE user_id = ?").bind(userId).run();

async function stopped(env: Env, userId: string, e: Stop) {
  console.warn(JSON.stringify({ msg: "drive copying stopped", user: userId, reason: e.reason, detail: e.message }));
  await env.DB.prepare("UPDATE drive_links SET error = ?, error_at = ? WHERE user_id = ?").bind(e.reason, Date.now(), userId).run();
}

/** A copy's start: an access token and the Scorpio folder (made the first time; gone since: copying stops). */
async function begin(env: Env, link: Link, b: Budget): Promise<{ run: Run; root: string }> {
  charge(b);
  // A token sealed with another key (DRIVE_TOKEN_KEY changed) cannot be read: only reconnecting helps.
  const refresh = await unseal(env, link.token_enc).catch(() => {
    throw new Stop("revoked", "sealed token unreadable");
  });
  const run: Run = { env, userId: link.user_id, handle: link.handle, token: await accessToken(env, refresh), budget: b };
  let root = link.folder_id;
  if (root && !(await alive(run, root))) throw new Stop("folder_gone", root);
  if (!root) {
    root = (await makeFolder(run, "Scorpio"))!;
    await env.DB.prepare("UPDATE drive_links SET folder_id = ? WHERE user_id = ?").bind(root, link.user_id).run();
  }
  return { run, root };
}

/** Index rows from before Drive copies existed have no hash or name yet: their rooms say (only the rooms that have such rows of theirs). */
async function fillIndex(env: Env, userId: string, roomId?: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT room_id FROM account_files WHERE user_id = ?1 AND hash IS NULL ${roomId ? "AND room_id = ?2" : ""} LIMIT 50`,
  )
    .bind(...(roomId ? [userId, roomId] : [userId]))
    .all<{ room_id: string }>();
  for (const { room_id } of results) {
    const r = await env.ROOMS.getByName(room_id).fileIndex();
    if ("err" in r) continue;
    const stmts = r.ok.map((f) => env.DB.prepare("UPDATE account_files SET hash = ?, name = ? WHERE room_id = ? AND file_id = ? AND hash IS NULL").bind(f.hash, f.name, room_id, f.id));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  }
}

type Pending = { room_id: string; file_id: string; hash: string; name: string | null; room_name: string };

/** The room's folder in Drive (Scorpio/<room name>/): made the first time, renamed with the room, made again if deleted. */
async function roomFolder(run: Run, root: string, roomId: string, roomName: string): Promise<string> {
  const row = await run.env.DB.prepare("SELECT folder_id, folder_name FROM drive_rooms WHERE user_id = ? AND room_id = ?")
    .bind(run.userId, roomId)
    .first<{ folder_id: string | null; folder_name: string | null }>();
  if (row?.folder_id && (row.folder_name === roomName || (await rename(run, row.folder_id, roomName)))) {
    if (row.folder_name !== roomName) await run.env.DB.prepare("UPDATE drive_rooms SET folder_name = ? WHERE user_id = ? AND room_id = ?").bind(roomName, run.userId, roomId).run();
    return row.folder_id;
  }
  const id = await makeFolder(run, roomName, root);
  if (!id) throw new Stop("folder_gone", root);
  await run.env.DB.prepare(
    `INSERT INTO drive_rooms (user_id, room_id, folder_id, folder_name) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, room_id) DO UPDATE SET folder_id = excluded.folder_id, folder_name = excluded.folder_name`,
  )
    .bind(run.userId, roomId, id, roomName)
    .run();
  return id;
}

/** One file into the uploader's Drive (its bytes straight from R2); false when R2 no longer has them (done all the same). */
async function copyOne(run: Run, root: string, f: Pending): Promise<boolean> {
  spend(run);
  const obj = await storedObject(run.env, fileKey(f.room_id, f.hash));
  let driveId = "";
  if (obj) {
    const p = { name: f.name || f.file_id, type: obj.httpMetadata?.contentType || "application/octet-stream", size: obj.size, body: obj.body };
    let id = await put(run, { ...p, parent: await roomFolder(run, root, f.room_id, f.room_name) });
    if (!id) {
      // The room's folder was deleted in Drive: a new one, once.
      await run.env.DB.prepare("UPDATE drive_rooms SET folder_id = NULL WHERE user_id = ? AND room_id = ?").bind(run.userId, f.room_id).run();
      const again = await storedObject(run.env, fileKey(f.room_id, f.hash));
      if (!again) return false;
      id = await put(run, { ...p, body: again.body, parent: await roomFolder(run, root, f.room_id, f.room_name) });
      if (!id) throw new Stop("folder_gone", root);
    }
    driveId = id;
  }
  await run.env.DB.prepare("INSERT OR REPLACE INTO drive_files (user_id, hash, drive_id, room_id, copied_at) VALUES (?, ?, ?, ?, ?)")
    .bind(run.userId, f.hash, driveId, f.room_id, Date.now())
    .run();
  return !!driveId;
}

/** The same step again when Google fails it for now, up to COPY_TRIES in all; never when the time is up. */
async function tried<T>(fn: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof Later) || e.message === "budget" || n >= COPY_TRIES) throw e;
    }
  }
}

/**
 * Right before an eviction takes these files of theirs: each goes to their Drive first when they connected one.
 * Answers the ids that may go — copied already or now; all of them when copying is stopped or off (an eviction does
 * not wait for a Drive that fails). A copy Google fails is tried three times, then that file goes uncopied, so a
 * space is never left over its limit for a Drive that keeps failing. Only the files this run had no
 * time left for are held back, for the next eviction run. What was copied, and when, is what the settings page shows.
 */
export async function copyBeforeEvict(env: Env, user: { id: string; handle: string }, roomId: string, ids: string[], ms: number): Promise<string[]> {
  if (!driveConfigured(env) || !ids.length) return ids;
  const link = await env.DB.prepare("SELECT token_enc IS NOT NULL AS on_, error FROM drive_links WHERE user_id = ?").bind(user.id).first<{ on_: number; error: string | null }>();
  if (!link?.on_ || link.error) return ids;
  await fillIndex(env, user.id, roomId);
  const marks = ids.map(() => "?").join(",");
  const { results: rows } = await env.DB.prepare(
    `SELECT a.room_id, a.file_id, a.hash, a.name, r.name AS room_name, EXISTS (SELECT 1 FROM drive_files d WHERE d.user_id = a.user_id AND d.hash = a.hash) AS copied
       FROM account_files a JOIN rooms r ON r.id = a.room_id WHERE a.user_id = ? AND a.room_id = ? AND a.file_id IN (${marks})`,
  )
    .bind(user.id, roomId, ...ids)
    .all<Pending & { copied: number }>();
  const pending = rows.filter((f) => !f.copied && f.hash);
  if (!pending.length) return ids;
  const held = new Set(pending.map((f) => f.file_id));
  const owned = await take(env, user.id);
  if (!owned) return ids.filter((id) => !held.has(id)); // a run is copying meanwhile; these go next time
  let copied = 0;
  try {
    const b = budget(ms, 100);
    const { run, root } = await tried(() => begin(env, owned, b));
    for (const f of pending) {
      try {
        if (await tried(() => copyOne(run, root, f))) copied++;
      } catch (e) {
        if (!(e instanceof Later) || e.message === "budget") throw e;
        console.warn(JSON.stringify({ msg: "drive copy failed, the file goes uncopied", user: user.id, file: f.file_id, error: e.message }));
      }
      held.delete(f.file_id);
    }
  } catch (e) {
    if (e instanceof Stop) {
      await stopped(env, user.id, e);
      return ids;
    }
    if (!(e instanceof Later)) console.error(JSON.stringify({ msg: "drive copy before evict failed", user: user.id, error: String(e) }));
    else if (e.message !== "budget") {
      // Google failing even to start (the access token, the folder) three times running: they go uncopied.
      console.warn(JSON.stringify({ msg: "drive copy failed, the files go uncopied", user: user.id, error: e.message }));
      return ids;
    }
  } finally {
    if (copied) await env.DB.prepare("UPDATE drive_links SET last_copy_at = ?, last_copy_count = ? WHERE user_id = ?").bind(Date.now(), copied, user.id).run();
    await release(env, user.id);
  }
  return ids.filter((id) => !held.has(id));
}
