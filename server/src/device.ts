// OAuth 2.0 device authorization (RFC 8628) for agents: docs/api/auth.md.
// State lives in D1 (strongly consistent, single primary): the UPDATE … WHERE status = 'approved'
// in the token exchange is what makes a code redeemable exactly once.

import { ApiError, json, now, randomFrom, randomId, readBody, sha256Hex, str } from "./util";
import { origin } from "./auth";
import { machineHash } from "./invite";
import { hosted, limitsFor, planOf, type Plan } from "./plans";
import { closeTokenSockets, pendingRelogin, reloginAccount, startLogoutEpisode, type TokenReason } from "./device-logout";

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // RFC 8628 §6.1: no vowels, no digits, nothing easily confused
const CODE_TTL = 15 * 60;
const INTERVAL = 5;
const TOKEN_TTL = 365 * 86400;

/** The random id the package keeps in ~/.scorpio/config.json for this computer. */
export function deviceIdOf(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

export function machineName(v: unknown): string {
  const name = String(v || "").split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");
  return name || "host";
}

export type DeviceName = { name: string; machine: string; hostname: string; note: string | null; seat: string | null; deviceId: string; daemonNo: number | null; oldSeat?: string | null; clis?: CliReport[] | null };

/** One agent CLI as a computer's daemon last detected it (the daemon's join `clis`). */
export type CliReport = { kind: "claude" | "codex"; installed: boolean; version: string | null; at: number };
export const CLI_KINDS = ["claude", "codex"];

/**
 * A daemon's `clis` as it is kept: an entry of the wrong shape is dropped, a repeated kind keeps the first, and more
 * than 8 entries or something that is not a list drops the whole value; null then (the join is never refused for it,
 * and the stored value stays).
 */
export function cleanClis(v: unknown): CliReport[] | null {
  if (!Array.isArray(v) || v.length > 8) return null;
  const out: CliReport[] = [];
  for (const x of v as Record<string, unknown>[]) {
    if (!x || typeof x !== "object" || !CLI_KINDS.includes(x.kind as string) || typeof x.installed !== "boolean") continue;
    if (out.some((o) => o.kind === x.kind)) continue;
    if (typeof x.at !== "number" || !Number.isFinite(x.at) || x.at < 0) continue;
    const version = x.installed && typeof x.version === "string" ? x.version.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40) : "";
    out.push({ kind: x.kind as CliReport["kind"], installed: x.installed, version: version || null, at: Math.floor(x.at) });
  }
  return out.length ? out : null;
}

/** devices.clis (JSON) back to a list; null when none or unreadable. */
export function storedClis(json: unknown): CliReport[] | null {
  try { return typeof json === "string" ? cleanClis(JSON.parse(json)) : null; } catch { return null; }
}

export type RollbackReport = { bad: { version: string; build: string }; at: number };
const versionOf = (v: unknown): string | null => typeof v === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(v) && v.length <= 40 ? v : null;
export function cleanRollback(v: unknown): RollbackReport | null {
  if (!v || typeof v !== "object") return null;
  const report = v as { bad?: { version?: unknown; build?: unknown }; at?: unknown };
  const version = versionOf(report.bad?.version);
  const build = report.bad?.build;
  if (!version || typeof build !== "string" || !/^[a-f0-9]{64}$/i.test(build) || !Number.isSafeInteger(report.at) || (report.at as number) <= 0) return null;
  return { bad: { version, build: build.toLowerCase() }, at: report.at as number };
}

export async function knownSeat(env: Env, userId: string, deviceId: string): Promise<{ seat: string | null; daemon_no: number | null } | null> {
  return env.DB.prepare("SELECT seat, daemon_no FROM devices WHERE user_id = ? AND device_id = ?")
    .bind(userId, deviceId).first<{ seat: string | null; daemon_no: number | null }>();
}

/** The lowest unused default name within an account. */
export function defaultComputerName(names: string[]): string {
  const used = new Set(names);
  let n = 1;
  while (used.has(`computer-${n}`)) n++;
  return `computer-${n}`;
}

/** A handoff's source is the token's device name, never a caller-supplied hostname. */
export async function handoffComputer(env: Env, userId: string, deviceId: string | null): Promise<string | null> {
  if (!deviceId) return null;
  return (await env.DB.prepare("SELECT name FROM devices WHERE user_id = ? AND device_id = ?")
    .bind(userId, deviceId).first<{ name: string | null }>())?.name ?? null;
}

export async function deviceForHost(env: Env, userId: string, deviceId: string, hostname: string, machine: unknown, reported: unknown = null, version: unknown = null, rollback: unknown = null): Promise<DeviceName> {
  await rememberDevice(env, userId, deviceId, hostname).run();
  await env.DB.prepare("UPDATE devices SET logged_out_at = NULL WHERE user_id = ? AND device_id = ? AND logged_out_at IS NOT NULL").bind(userId, deviceId).run();
  const normalized = machineName(machine || hostname);

  // The CLIs the daemon detected: written only when they changed; none (an older daemon, or nothing usable) keeps what is stored.
  const sent = cleanClis(reported);
  if (sent) {
    const json = JSON.stringify(sent);
    await env.DB.prepare("UPDATE devices SET clis = ? WHERE user_id = ? AND device_id = ? AND clis IS NOT ?").bind(json, userId, deviceId, json).run();
  }
  const daemonVersion = versionOf(version);
  if (daemonVersion) {
    const reportedAt = Date.now();
    await env.DB.prepare(`UPDATE devices SET daemon_version = ?1, daemon_joined_at = ?2
      WHERE user_id = ?3 AND device_id = ?4
        AND (daemon_version IS NOT ?1 OR daemon_joined_at IS NULL OR daemon_joined_at < ?5)`)
      .bind(daemonVersion, reportedAt, userId, deviceId, reportedAt - 86_400_000).run();
  }
  const lastRollback = cleanRollback(rollback);
  if (lastRollback) {
    await env.DB.prepare("UPDATE devices SET rollback_bad_version = ?, rollback_bad_build = ?, rollback_at = ? WHERE user_id = ? AND device_id = ? AND (rollback_at IS NULL OR rollback_at <= ?)")
      .bind(lastRollback.bad.version, lastRollback.bad.build, lastRollback.at, userId, deviceId, lastRollback.at).run();
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await env.DB.prepare("SELECT daemon_no, name, machine, note, seat, device_name, clis FROM devices WHERE user_id = ? AND device_id = ?")
      .bind(userId, deviceId).first<{ daemon_no: number | null; name: string | null; machine: string | null; note: string | null; seat: string | null; device_name: string; clis: string | null }>();
    if (!row) throw new ApiError("server_error", "Could not find this computer; retry.", 503);
    if (row.daemon_no == null) {
      await env.DB.prepare(`UPDATE OR IGNORE devices SET daemon_no = (SELECT COALESCE(MAX(daemon_no), 0) + 1 FROM devices WHERE user_id = ?)
        WHERE user_id = ? AND device_id = ? AND daemon_no IS NULL`).bind(userId, userId, deviceId).run();
      continue;
    }
    const clis = sent ?? storedClis(row.clis);
    if (!row.name || row.name === machineName(row.machine || row.device_name)) {
      const { results } = await env.DB.prepare("SELECT name FROM devices WHERE user_id = ? AND device_id != ? AND name IS NOT NULL")
        .bind(userId, deviceId).all<{ name: string }>();
      const name = defaultComputerName(results.map((r) => r.name));
      const seat = await freeDeviceSeat(env, userId, deviceId, name, row.daemon_no);
      // The condition and write are one D1 statement, so concurrent first joins cannot claim the same name.
      const set = await env.DB.prepare(`UPDATE OR IGNORE devices SET name = ?1, machine = ?2, seat = ?3
        WHERE user_id = ?4 AND device_id = ?5 AND name IS ?6
          AND NOT EXISTS (SELECT 1 FROM devices WHERE user_id = ?4 AND device_id != ?5 AND name = ?1)`)
        .bind(name, normalized, seat, userId, deviceId, row.name).run();
      if (!set.meta.changes) continue;
      const oldSeat = row.seat || (row.daemon_no === 1 ? "daemon" : `daemon-${row.daemon_no}`);
      return { name, machine: normalized, hostname: row.device_name, note: row.note, seat, deviceId, daemonNo: row.daemon_no, clis, oldSeat };
    }
    await env.DB.prepare("UPDATE devices SET machine = ? WHERE user_id = ? AND device_id = ? AND machine IS NOT ?")
      .bind(normalized, userId, deviceId, normalized).run();
    if (row.seat) return { name: row.name, machine: normalized, hostname: row.device_name, note: row.note, seat: row.seat, deviceId, daemonNo: row.daemon_no, clis };
    const role = await freeDeviceSeat(env, userId, deviceId, row.name, row.daemon_no);
    const set = await env.DB.prepare("UPDATE OR IGNORE devices SET seat = ? WHERE user_id = ? AND device_id = ? AND seat IS NULL")
      .bind(role, userId, deviceId).run();
    if (set.meta.changes) return { name: row.name, machine: normalized, hostname: row.device_name, note: row.note, seat: role, deviceId, daemonNo: row.daemon_no, clis };
  }
  throw new ApiError("server_error", "Could not assign a daemon seat; retry.", 503);
}

export async function freeDeviceSeat(env: Env, userId: string, deviceId: string, name: string, daemonNo: number): Promise<string> {
  const roots = [`${name}-daemon`, `${name}-${daemonNo}-daemon`];
  for (let i = 0; i < 100; i++) {
    const seat = i < roots.length ? roots[i] : `${name}-${daemonNo}-${i}-daemon`;
    const taken = await env.DB.prepare("SELECT 1 FROM devices WHERE user_id = ? AND seat = ? AND device_id != ?")
      .bind(userId, seat, deviceId).first();
    if (!taken) return seat;
  }
  throw new ApiError("server_error", "Could not assign a daemon seat; retry.", 503);
}

export async function renameDevice(env: Env, userId: string, tokenId: string, body: Record<string, unknown>): Promise<{ device: DeviceName; changed: boolean; oldSeat: string | null }> {
  const token = await env.DB.prepare("SELECT device_id FROM agent_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(tokenId, userId).first<{ device_id: string | null }>();
  if (!token) throw new ApiError("not_found", "No such computer.", 404);
  if (!token.device_id) throw new ApiError("bad_request", "Sign this computer in again with scorpio login to name it.");
  const deviceId = token.device_id;
  const row = await env.DB.prepare("SELECT device_name, machine, name, note, seat, daemon_no FROM devices WHERE user_id = ? AND device_id = ?")
    .bind(userId, deviceId).first<{ device_name: string; machine: string | null; name: string | null; note: string | null; seat: string | null; daemon_no: number | null }>();
  if (!row) throw new ApiError("not_found", "No such computer.", 404);
  const machine = row.machine || machineName(row.device_name);
  let name = row.name || machine;
  let note = row.note;
  if (Object.hasOwn(body, "name")) {
    if (typeof body.name !== "string") throw new ApiError("bad_name", "Use 1–24 lowercase letters, digits or hyphens.");
    const proposed = body.name.trim().toLowerCase();
    if (proposed && !/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(proposed)) {
      throw new ApiError("bad_name", "Use 1–24 lowercase letters, digits or hyphens.");
    }
    name = proposed || machine;
  }
  if (Object.hasOwn(body, "note")) {
    if (typeof body.note !== "string") throw new ApiError("bad_request", "A note must be text.");
    const proposed = body.note.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
    if ([...proposed].length > 60) throw new ApiError("bad_request", "A note can be at most 60 characters.");
    note = proposed || null;
  }
  const changed = name !== (row.name || machine) || note !== row.note;
  let seat = row.seat;
  if (changed && name !== (row.name || machine) && seat && row.daemon_no != null) {
    for (let i = 0; i < 8; i++) {
      const wanted = await freeDeviceSeat(env, userId, deviceId, name, row.daemon_no);
      const result = await env.DB.prepare("UPDATE OR IGNORE devices SET name = ?, note = ?, seat = ? WHERE user_id = ? AND device_id = ?")
        .bind(name, note, wanted, userId, deviceId).run();
      if (result.meta.changes) { seat = wanted; break; }
      if (i === 7) throw new ApiError("server_error", "Could not rename this computer; retry.", 503);
    }
  } else if (changed) {
    await env.DB.prepare("UPDATE devices SET name = ?, note = ? WHERE user_id = ? AND device_id = ?")
      .bind(name, note, userId, deviceId).run();
  }
  return { device: { name, machine, hostname: row.device_name, note, seat, deviceId, daemonNo: row.daemon_no }, changed,
    oldSeat: row.seat || (row.daemon_no ? row.daemon_no === 1 ? "daemon" : `daemon-${row.daemon_no}` : null) };
}

/**
 * Record (or rename) a device of the account; its daemon number, once given, never changes. `machineHash`: the keyed
 * hash of the computer's machine id, kept when a newer sign-in has none.
 */
export function rememberDevice(env: Env, userId: string, deviceId: string, deviceName: string, machineHash: string | null = null): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO devices (user_id, device_id, device_name, created_at, machine_hash) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, device_id) DO UPDATE SET device_name = excluded.device_name, machine_hash = COALESCE(excluded.machine_hash, devices.machine_hash)`,
  ).bind(userId, deviceId, deviceName, Date.now(), machineHash);
}

export function normalizeUserCode(s: string): string | null {
  const c = s.toUpperCase().replace(/[^A-Z]/g, "");
  if (c.length !== 8 || [...c].some((ch) => !USER_CODE_ALPHABET.includes(ch))) return null;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** POST /oauth/device/code; with `relogin: true` a computer logged out asks to come back. */
export async function deviceCode(req: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const { success } = await env.DEVICE_CODE_LIMIT.limit({ key: req.headers.get("cf-connecting-ip") || "unknown" });
  if (!success) return json({ error: "rate_limited", next: "Too many device codes requested. Wait a minute and retry." }, 429, { "retry-after": "60" });
  const body = await readBody(req);
  const deviceName = str(body.device_name, 64).trim() || "unknown computer";
  const deviceId = deviceIdOf(body.device_id);
  const cliVersion = str(body.cli_version, 32);
  // sha256 of the computer's machine id from CLI 0.5.9, stored only as a keyed hash; older CLIs send none.
  const machine = await machineHash(env, body.machine_id);
  const t = now();
  const base = origin(req, env);
  const answer = (deviceCode: string, userCode: string, expiresIn: number, interval: number) => json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${base}/activate`,
    verification_uri_complete: `${base}/activate?code=${userCode}`,
    expires_in: expiresIn,
    interval,
  });
  // A computer whose newest token expired; any other (token still good, revoked, never seen) gets an ordinary code.
  const account = body.relogin === true && deviceId ? await reloginAccount(env, deviceId, t) : null;
  if (account) {
    const again = await pendingRelogin(env, deviceId!, t);
    if (again) {
      await startLogoutEpisode(env, ctx, account, deviceId!, again.user_code, t);
      return answer(again.device_code, again.user_code, Math.ceil((again.expires_at - t) / 1000), again.interval);
    }
  }
  const deviceCode = `dc_${randomId(43)}`;
  const id = await sha256Hex(deviceCode);
  let userCode = "";
  for (let i = 0; i < 5; i++) {
    const raw = randomFrom(USER_CODE_ALPHABET, 8);
    userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO device_codes (id, user_code, status, device_name, cli_version, created_at, expires_at, interval, device_id, machine_hash, relogin, device_code)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, userCode, deviceName, cliVersion, t, t + CODE_TTL * 1000, INTERVAL, deviceId, machine,
        account ? 1 : 0, account ? deviceCode : null)
      .run();
    if (r.meta.changes === 1) break;
    if (i === 4) throw new ApiError("server_error", "Could not allocate a code; retry.", 503);
  }
  if (account) await startLogoutEpisode(env, ctx, account, deviceId!, userCode, t);
  return answer(deviceCode, userCode, CODE_TTL, INTERVAL);
}

const oauthError = (error: string, status = 400) => json({ error }, status);

/** POST /oauth/token */
export async function deviceToken(req: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const body = await readBody(req);
  if (str(body.grant_type) !== "urn:ietf:params:oauth:grant-type:device_code") return oauthError("unsupported_grant_type");
  const deviceCode = str(body.device_code, 200);
  if (!deviceCode) return oauthError("invalid_request");
  const id = await sha256Hex(deviceCode);
  const row = await env.DB.prepare("SELECT status, user_id, expires_at, interval, last_poll_at FROM device_codes WHERE id = ?")
    .bind(id)
    .first<{ status: string; user_id: string | null; expires_at: number; interval: number; last_poll_at: number | null }>();
  const t = now();
  if (!row || row.status === "redeemed") return oauthError("invalid_grant");
  if (row.expires_at < t) return oauthError("expired_token");
  if (row.status === "denied") return oauthError("access_denied");
  if (row.status === "limit") {
    if (!row.user_id) return oauthError("invalid_grant");
    const [plan, computers] = await Promise.all([planOf(env, row.user_id), computersOf(env, row.user_id)]);
    const limit = (await limitsFor(env, plan)).devices;
    const url = `${origin(req, env)}/settings#devices`;
    return json({
      error: "device_limit", current: computers.length, limit, url,
      next: `This code was not approved because the account reached its computer limit. Current: ${computers.length}/${limit ?? "unlimited"}. Open ${url} to revoke an old computer, or ${origin(req, env)}/pricing to upgrade. Then approve the code on the web again and rerun scorpio login.`,
    }, 400);
  }
  if (row.status === "pending") {
    // Polling faster than the interval (with a second of slack for clock and network jitter) is told to slow down.
    const tooFast = row.last_poll_at != null && t - row.last_poll_at < row.interval * 1000 - 1000;
    await env.DB.prepare("UPDATE device_codes SET last_poll_at = ?, interval = ? WHERE id = ?")
      .bind(t, tooFast ? row.interval + 5 : row.interval, id)
      .run();
    return oauthError(tooFast ? "slow_down" : "authorization_pending");
  }
  // approved → redeem exactly once
  const redeemed = await env.DB.prepare("UPDATE device_codes SET status = 'redeemed', device_code = NULL WHERE id = ? AND status = 'approved' RETURNING user_id, device_name, device_id, machine_hash")
    .bind(id)
    .first<{ user_id: string; device_name: string; device_id: string | null; machine_hash: string | null }>();
  if (!redeemed) return oauthError("invalid_grant");
  const token = `sco_${randomId(43)}`;
  const written = await env.DB.batch([
    // One live token per computer: the computer's older ones (same device id, or a device of the
    // account with the same machine hash: a reinstall) go as this one is made, and their connections close.
    // A code with no device id revokes nothing.
    ...(redeemed.device_id ? [env.DB.prepare(
      `UPDATE agent_tokens SET revoked_at = ?3, revoked_reason = 'replaced' WHERE user_id = ?1 AND revoked_at IS NULL
         AND (device_id = ?2 OR (?4 IS NOT NULL AND device_id IN (SELECT device_id FROM devices WHERE user_id = ?1 AND machine_hash = ?4)))
       RETURNING id`,
    ).bind(redeemed.user_id, redeemed.device_id, t, redeemed.machine_hash)] : []),
    env.DB.prepare(
      "INSERT INTO agent_tokens (id, user_id, hash, device_name, scopes, created_at, expires_at, issued_for, device_id) VALUES (?, ?, ?, ?, 'agent', ?, ?, 'local', ?)",
    ).bind(randomId(16), redeemed.user_id, await sha256Hex(token), redeemed.device_name, t, t + TOKEN_TTL * 1000, redeemed.device_id),
    ...(redeemed.device_id ? [rememberDevice(env, redeemed.user_id, redeemed.device_id, redeemed.device_name, redeemed.machine_hash),
      // a token for the computer ends its logout episode
      env.DB.prepare("UPDATE devices SET logged_out_at = NULL WHERE user_id = ? AND device_id = ? AND logged_out_at IS NOT NULL").bind(redeemed.user_id, redeemed.device_id)] : []),
    // The account whose device on this computer is oldest owns it (an invite counts only for that one).
    ...(redeemed.machine_hash ? [env.DB.prepare(
      `INSERT INTO machine_hashes (hash, first_user_id, first_seen) VALUES (?1, ?2, COALESCE((SELECT created_at FROM devices WHERE user_id = ?2 AND device_id = ?3), ?4))
       ON CONFLICT (hash) DO UPDATE SET first_user_id = excluded.first_user_id, first_seen = excluded.first_seen WHERE excluded.first_seen < machine_hashes.first_seen`,
    ).bind(redeemed.machine_hash, redeemed.user_id, redeemed.device_id, t)] : []),
  ]);
  if (redeemed.device_id) ctx.waitUntil(closeTokenSockets(env, redeemed.user_id, (written[0].results as { id: string }[]).map((r) => r.id), "replaced"));
  const user = await env.DB.prepare("SELECT handle FROM users WHERE id = ?").bind(redeemed.user_id).first<{ handle: string }>();
  return json({ access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL, account: user?.handle });
}

/**
 * The computers running agents for an account: its live tokens (not revoked, not expired) and
 * its codes approved but not redeemed yet, one computer per device id or machine hash (two entries with either in
 * common are one computer: a reinstall, or a token from before 0.5.9 with no hash yet). A token with no device id
 * (from before 10-04) is a computer of its own. Newest first by when it was last used (or made).
 */
export type Computer = { name: string; hostname: string; machine: string | null; note: string | null; seat: string | null; lastUsed: number; createdAt: number; tokenIds: string[]; codeIds: string[]; deviceIds: string[]; hashes: string[]; daemonNo: number | null; newestToken: string | null; clis: CliReport[] | null };
export async function computersOf(env: Env, userId: string): Promise<Computer[]> {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT 'token' AS kind, x.id, x.device_id, x.device_name, x.created_at, x.last_used_at, d.machine_hash, d.daemon_no, d.name, d.machine, d.note, d.seat, d.clis,
        COALESCE(d.device_name, x.device_name) AS hostname
       FROM agent_tokens x LEFT JOIN devices d ON d.user_id = x.user_id AND d.device_id = x.device_id
      WHERE x.user_id = ?1 AND x.revoked_at IS NULL AND x.expires_at > ?2
     UNION ALL
     SELECT 'code', c.id, c.device_id, c.device_name, c.created_at, NULL, c.machine_hash, NULL, NULL, NULL, NULL, NULL, NULL, c.device_name
       FROM device_codes c WHERE c.user_id = ?1 AND c.status = 'approved' AND c.expires_at > ?2`,
  ).bind(userId, t).all<{ kind: string; id: string; device_id: string | null; device_name: string; created_at: number; last_used_at: number | null; machine_hash: string | null; daemon_no: number | null; name: string | null; machine: string | null; note: string | null; seat: string | null; clis: string | null; hostname: string }>();
  // One computer per connected group: entries joined by a device id or a machine hash in common.
  const up = results.map((_, i) => i);
  const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])));
  const seen = new Map<string, number>();
  results.forEach((r, i) => {
    for (const k of [r.device_id && `d:${r.device_id}`, r.machine_hash && `h:${r.machine_hash}`]) {
      if (!k) continue;
      if (seen.has(k)) up[find(i)] = find(seen.get(k)!);
      else seen.set(k, i);
    }
  });
  const groups = new Map<number, typeof results>();
  results.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) || []), r]));
  const out: Computer[] = [...groups.values()].map((rows) => {
    const tokens = rows.filter((r) => r.kind === "token").sort((a, b) => b.created_at - a.created_at);
    const newest = [...rows].sort((a, b) => b.created_at - a.created_at)[0];
    return {
      name: rows.find((r) => r.name)?.name || machineName(newest.device_name),
      hostname: rows.find((r) => r.seat)?.hostname || newest.hostname,
      machine: rows.find((r) => r.machine)?.machine || null,
      note: rows.find((r) => r.note)?.note || null,
      seat: rows.find((r) => r.seat)?.seat || null,
      lastUsed: Math.max(...rows.map((r) => Math.max(r.last_used_at ?? 0, r.created_at))),
      createdAt: tokens[0]?.created_at ?? newest.created_at,
      tokenIds: tokens.map((r) => r.id),
      codeIds: rows.filter((r) => r.kind === "code").map((r) => r.id),
      deviceIds: [...new Set(rows.map((r) => r.device_id).filter((x): x is string => !!x))],
      hashes: [...new Set(rows.map((r) => r.machine_hash).filter((x): x is string => !!x))],
      daemonNo: rows.find((r) => r.daemon_no != null)?.daemon_no ?? null,
      newestToken: tokens[0]?.id ?? null,
      clis: storedClis(rows.find((r) => r.clis)?.clis),
    };
  });
  return out.sort((a, b) => b.lastUsed - a.lastUsed);
}

/** A computer's way out: every live token of it revoked, and a code of it approved but not redeemed denied (one batch). */
function revokeStatements(env: Env, userId: string, c: Computer, t: number, reason: TokenReason): D1PreparedStatement[] {
  return [
    ...c.tokenIds.map((id) => env.DB.prepare("UPDATE agent_tokens SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(t, reason, id, userId)),
    ...c.codeIds.map((id) => env.DB.prepare("UPDATE device_codes SET status = 'denied' WHERE id = ? AND user_id = ? AND status = 'approved'").bind(id, userId)),
  ];
}

/**
 * Settings → 设备 → 撤销: the computer the token belongs to goes, all of its live tokens, and
 * their connections close.
 */
export async function revokeComputer(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, userId: string, tokenId: string): Promise<void> {
  const c = (await computersOf(env, userId)).find((x) => x.tokenIds.includes(tokenId));
  if (c) {
    await env.DB.batch(revokeStatements(env, userId, c, now(), "revoked"));
    ctx.waitUntil(closeTokenSockets(env, userId, c.tokenIds, "revoked"));
  }
  // A token no longer live (or someone else's): as before, only that token, only one's own.
  else await env.DB.prepare("UPDATE agent_tokens SET revoked_at = ?, revoked_reason = 'revoked' WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(now(), tokenId, userId).run();
}

/**
 * Back on Free (the downgrade, as rooms are): the most recently used computers within Free's
 * limit stay, the others are revoked now. A new subscription brings none back.
 */
export async function keepRecentComputers(env: Env, userId: string): Promise<number> {
  const limit = (await limitsFor(env, "free")).devices;
  if (limit == null) return 0;
  const gone = (await computersOf(env, userId)).slice(limit);
  if (gone.length) await env.DB.batch(gone.flatMap((c) => revokeStatements(env, userId, c, now(), "plan")));
  // A plan change already runs in the background (billing planMoved), so the connections close in it.
  await closeTokenSockets(env, userId, gone.flatMap((c) => c.tokenIds), "plan");
  return gone.length;
}

export interface PendingDevice {
  code: string;
  device: string;
  createdAt: number;
  /** A relogin code: when the viewer's computer logged out (null when it is not theirs). */
  relogin?: { loggedOutAt: number | null };
}

/** A code that can still be approved, including one blocked at the device limit, as `userId` sees it. */
export async function findPending(env: Env, rawCode: string, userId: string): Promise<PendingDevice | null> {
  const code = normalizeUserCode(rawCode);
  if (!code) return null;
  const row = await env.DB.prepare(
    `SELECT c.user_code, c.device_name, c.created_at, c.relogin, d.logged_out_at
       FROM device_codes c LEFT JOIN devices d ON d.user_id = ? AND d.device_id = c.device_id
      WHERE c.user_code = ? AND c.status IN ('pending', 'limit') AND c.expires_at > ?`,
  )
    .bind(userId, code, now())
    .first<{ user_code: string; device_name: string; created_at: number; relogin: number; logged_out_at: number | null }>();
  if (!row) return null;
  return {
    code: row.user_code, device: row.device_name, createdAt: row.created_at,
    ...(row.relogin ? { relogin: { loggedOutAt: row.logged_out_at } } : {}),
  };
}

/** The page's answer to 「授权」 at the cap: nothing approved, the code remains reusable. */
export type AtLimit = { state: "limit"; n: number; limit: number; plan: Plan; computers: string[]; proLimit: number | null };

/**
 * The person approves or denies a code. Approving a computer the account has no live token or approved code for, with
 * as many computers as its plan allows already (computersOf), is refused: the code stays reusable, so revoking one
 * and approving again works. A computer it has (same device id or machine hash) is approved as before.
 */
export async function decide(env: Env, rawCode: string, userId: string, approve: boolean): Promise<boolean | AtLimit> {
  const code = normalizeUserCode(rawCode);
  if (!code) return false;
  if (approve && hosted(env)) {
    const c = await env.DB.prepare("SELECT device_id, machine_hash FROM device_codes WHERE user_code = ? AND status IN ('pending', 'limit') AND expires_at > ?")
      .bind(code, now())
      .first<{ device_id: string | null; machine_hash: string | null }>();
    if (!c) return false;
    const plan = await planOf(env, userId);
    const limit = (await limitsFor(env, plan)).devices;
    const computers = await computersOf(env, userId);
    const known = computers.some((x) => (c.device_id && x.deviceIds.includes(c.device_id)) || (c.machine_hash && x.hashes.includes(c.machine_hash)));
    if (!known && limit != null && computers.length >= limit) {
      const marked = await env.DB.prepare("UPDATE device_codes SET status = 'limit', user_id = ? WHERE user_code = ? AND status IN ('pending', 'limit') AND expires_at > ?")
        .bind(userId, code, now()).run();
      if (marked.meta.changes !== 1) return false;
      return { state: "limit", n: computers.length, limit, plan, computers: computers.map((x) => x.name), proLimit: (await limitsFor(env, "pro")).devices };
    }
  }
  // Not for a deleted account, whatever session it still holds: no new token comes of it.
  const r = await env.DB.prepare(
    "UPDATE device_codes SET status = ?1, user_id = ?2 WHERE user_code = ?3 AND status IN ('pending', 'limit') AND expires_at > ?4 AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND deleted_at IS NULL)",
  )
    .bind(approve ? "approved" : "denied", userId, code, now())
    .run();
  return r.meta.changes === 1;
}

/** Daily cleanup of expired device codes. */
export async function cleanupDeviceCodes(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now() - 86400_000).run();
}
