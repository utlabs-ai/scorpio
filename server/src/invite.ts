// Inviting friends. A code is used once: a new account that signs up with it (or enters it within 7 days) uses it up
// and is the inviter's friend, and gets days of Pro itself; an account has one current code at a time, the next one drawn when it is needed,
// up to a capped number used a calendar month (UTC). When the friend's agent first joins a topic from a computer no
// other account had first (within the window after signing up), the inviter gets days of Pro. The numbers are KV
// config:invite. Given days are a ledger: banked while the account is on Pro, started when it is not (and when what it
// had ends).
import { planMoved } from "./billing";
import { now, randomFrom } from "./util";

export const INVITE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0 O 1 I
const DAY = 86400_000;
export const ENTER_WINDOW = 7 * DAY; // a code can be entered in settings within this of signing up
export const INVITE_COOKIE_DAYS = 30;
const SHARED_MACHINE = 3; // accounts with tokens on one computer from which a friend is not judged (a shared image)
const FAST_MS = 15 * 60_000; // a friend rewarded this soon after signing up looks scripted: an alert

export type InviteConfig = { monthCap: number; rewardDays: number; windowDays: number };
export const INVITE_DEFAULTS: InviteConfig = { monthCap: 3, rewardDays: 7, windowDays: 30 };

/** KV config:invite {monthCap, rewardDays, windowDays}; what is missing or out of range uses the defaults (changes need no release). */
export async function inviteConfig(env: Env): Promise<InviteConfig> {
  const raw = await env.KV.get<Partial<InviteConfig>>("config:invite", { type: "json", cacheTtl: 60 }).catch(() => null);
  const pick = (k: keyof InviteConfig, max: number) => {
    const v = Number(raw?.[k]);
    return Number.isInteger(v) && v >= 0 && v <= max ? v : INVITE_DEFAULTS[k];
  };
  return { monthCap: pick("monthCap", 100), rewardDays: pick("rewardDays", 366), windowDays: pick("windowDays", 366) };
}

/** A code as typed or linked: 6 characters of the alphabet, any case; null when it is not one. */
export function normalizeInviteCode(v: unknown): string | null {
  const c = typeof v === "string" ? v.trim().toUpperCase() : "";
  return c.length === 6 && [...c].every((ch) => INVITE_ALPHABET.includes(ch)) ? c : null;
}

/** The address one inbox receives: lower case, no +tag; Gmail without dots (googlemail is gmail). */
export function canonicalEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split(/@(?=[^@]*$)/);
  const d = domain === "googlemail.com" ? "gmail.com" : domain;
  let l = local.split("+")[0];
  if (d === "gmail.com") l = l.replace(/\./g, "");
  return `${l}@${d}`;
}

/** HMAC-SHA256 with INVITE_SALT, hex; null without the secret (then nothing about invites is recorded). */
async function keyed(env: Env, value: string): Promise<string | null> {
  if (!env.INVITE_SALT) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INVITE_SALT), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The address as given and its canonical form, both kept as seen. */
export async function emailHashes(env: Env, email: string): Promise<string[]> {
  const a = email.trim().toLowerCase();
  const out = [await keyed(env, `email:${a}`), await keyed(env, `email2:${canonicalEmail(a)}`)];
  return out.filter((h): h is string => !!h);
}
/** The CLI sends sha256(machine id) in hex; the raw id never leaves the computer. */
export const machineHash = (env: Env, machineId: unknown) => (typeof machineId === "string" && /^[0-9a-f]{64}$/.test(machineId) ? keyed(env, `machine:${machineId}`) : Promise.resolve(null));

/** An alert for the ops page (one per kind, subject and day). */
export async function inviteAlert(env: Env, kind: string, subject: string, text: string): Promise<void> {
  const t = now();
  await env.DB.prepare("INSERT OR IGNORE INTO alerts (kind, subject, day, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(kind, subject, new Date(t).toISOString().slice(0, 10), JSON.stringify({ text }), t)
    .run()
    .catch((e) => console.error(JSON.stringify({ msg: "invite alert failed", kind, error: String(e) })));
}

/** This month's used invites (UTC): the accounts that signed up with the inviter's codes since the 1st. */
const MONTH_USED = "(SELECT COUNT(*) FROM users WHERE invited_by = ?1 AND invited_at >= ?2)";
export async function monthUsed(env: Env, userId: string, t = now()): Promise<number> {
  return (await env.DB.prepare(`SELECT ${MONTH_USED} AS n`).bind(userId, monthStart(t)).first<{ n: number }>())?.n ?? 0;
}

/**
 * An account's fixed code from before codes were single-use (users.invite_code) becomes one of its codes, once, as it was: links sent
 * out still work once. by: 'user' (the account's own, before its current invite is looked for) or 'code' (a code being
 * opened or used). Ignored when it is in invites already, or when the account has a current code of its own then
 * (only a fixed code an old Worker gave during the deploy gap, after this one had drawn a code: it does not count).
 */
async function collectFixed(env: Env, by: "user" | "code", value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO invites (code, inviter_id, created_at)
     SELECT invite_code, id, ?2 FROM users WHERE ${by === "user" ? "id" : "invite_code"} = ?1 AND invite_code IS NOT NULL AND deleted_at IS NULL`,
  ).bind(value, now()).run();
}

/**
 * The account's current invite: its code not used yet, drawn the first time it is needed — or null when this month's
 * invites are all used (even if a code sent out earlier is still unused: it waits for next month). One statement draws
 * it, so two at once give one code (the partial unique index), and a code is never one some account's fixed code is.
 */
export async function currentInvite(env: Env, userId: string): Promise<string | null> {
  const cfg = await inviteConfig(env);
  await collectFixed(env, "user", userId);
  for (let i = 0; i < 12; i++) {
    const t = now();
    if ((await monthUsed(env, userId, t)) >= cfg.monthCap) return null;
    const open = await env.DB.prepare("SELECT code FROM invites WHERE inviter_id = ? AND used_at IS NULL").bind(userId).first<{ code: string }>();
    if (open) return open.code;
    // A code alike (here or as a fixed code) is not taken: draw again.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO invites (code, inviter_id, created_at)
       SELECT ?3, ?1, ?4 FROM users u WHERE u.id = ?1 AND u.deleted_at IS NULL AND ${MONTH_USED} < ?5 AND NOT EXISTS (SELECT 1 FROM users WHERE invite_code = ?3)`,
    ).bind(userId, monthStart(t), randomFrom(INVITE_ALPHABET, 6), t, cfg.monthCap).run();
  }
  throw new Error("could not give an invite code");
}

type Inviter = { id: string; handle: string; displayName: string | null; email: string };

/**
 * A code as opened or used: its inviter (an account not deleted) and its state — ok (it can be used now), used, or
 * full (not used, but the inviter's invites this month are all used; it works again from the 1st). null: no such code.
 */
export async function inviteOf(env: Env, code: unknown): Promise<{ inviter: Inviter; state: "ok" | "used" | "full" } | null> {
  const c = normalizeInviteCode(code);
  if (!c) return null;
  const read = () => env.DB.prepare(
    `SELECT u.id, u.handle, u.display_name, u.primary_email, i.used_at FROM invites i JOIN users u ON u.id = i.inviter_id
      WHERE i.code = ? AND u.deleted_at IS NULL`,
  ).bind(c).first<{ id: string; handle: string; display_name: string | null; primary_email: string; used_at: number | null }>();
  let r = await read();
  if (!r) {
    await collectFixed(env, "code", c);
    r = await read();
  }
  if (!r) return null;
  const inviter = { id: r.id, handle: r.handle, displayName: r.display_name, email: r.primary_email };
  if (r.used_at != null) return { inviter, state: "used" };
  return { inviter, state: (await monthUsed(env, r.id)) >= (await inviteConfig(env)).monthCap ? "full" : "ok" };
}

/**
 * A new account (createUser): its addresses (as given and canonical) and its sign-in identity are noted as seen. Only
 * when none was seen before does it count as new (invite_eligible) and may take an invite: the link's code now, or one
 * entered in settings later. Accounts from before this release are never checked and never take one.
 */
export async function newAccount(env: Env, user: { id: string; email: string; createdAt: number }, code: string | null, identity: { provider: string; subject: string } | null = null): Promise<void> {
  const emails = await emailHashes(env, user.email);
  if (!emails.length) return;
  const ident = identity ? await keyed(env, `identity:${identity.provider}:${identity.subject}`) : null;
  let seen = false;
  for (const h of emails) if (await env.DB.prepare("SELECT 1 FROM seen_emails WHERE hash = ?").bind(h).first()) seen = true;
  if (ident && (await env.DB.prepare("SELECT 1 FROM seen_identities WHERE hash = ?").bind(ident).first())) seen = true;
  const t = now();
  await env.DB.batch([
    ...emails.map((h) => env.DB.prepare("INSERT OR IGNORE INTO seen_emails (hash, first_seen) VALUES (?, ?)").bind(h, t)),
    ...(ident ? [env.DB.prepare("INSERT OR IGNORE INTO seen_identities (hash, first_seen) VALUES (?, ?)").bind(ident, t)] : []),
    seen
      ? env.DB.prepare("UPDATE users SET invite_reward = 'none', invite_rewarded_at = ? WHERE id = ?").bind(t, user.id)
      : env.DB.prepare("UPDATE users SET invite_eligible = 1 WHERE id = ?").bind(user.id),
  ]);
  if (!seen && code) await recordInvite(env, { id: user.id, email: user.email }, code);
}

type Recorded = "ok" | "unknown" | "self" | "already" | "late" | "used" | "full";

/**
 * Use up the code for the account (once, an eligible account only) and write who invited it. One inbox for both (the
 * canonical addresses match) does not count and uses nothing. Then one batch, no rollback to write: the first statement
 * takes the code — still unused, the inviter there and under this month's cap, the friend still eligible — and every
 * other one holds only when this code was just used by this friend (USED). The friend gets days of Pro: on its trial,
 * the trial runs that much longer (granted and used in the ledger at once); otherwise granted, and started now unless
 * it is on Pro (then banked). Two accounts at once with one code: one is invited; the other is made as usual, uninvited.
 */
async function recordInvite(env: Env, friend: { id: string; email: string }, code: string): Promise<Recorded> {
  const inv = await inviteOf(env, code);
  if (!inv) return "unknown";
  const { inviter } = inv;
  if (inviter.id === friend.id) return "self";
  const t = now();
  if (canonicalEmail(inviter.email) === canonicalEmail(friend.email)) {
    await env.DB.prepare("UPDATE users SET invite_reward = 'none', invite_rewarded_at = ? WHERE id = ? AND invite_rewarded_at IS NULL").bind(t, friend.id).run();
    await inviteAlert(env, "invite_same_inbox", inviter.handle, `${inviter.handle} invited an account with the same inbox; it does not count.`);
    return "already";
  }
  const cfg = await inviteConfig(env);
  const c = normalizeInviteCode(code)!;
  const ELIGIBLE = "EXISTS (SELECT 1 FROM users WHERE id = ?2 AND invite_eligible = 1 AND invited_by IS NULL AND invite_rewarded_at IS NULL)";
  const USED = "EXISTS (SELECT 1 FROM invites WHERE code = ?1 AND used_by = ?2 AND used_at = ?3)";
  const [took, , , extended] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE invites SET used_by = ?2, used_at = ?3 WHERE code = ?1 AND used_at IS NULL AND inviter_id != ?2
         AND EXISTS (SELECT 1 FROM users WHERE id = invites.inviter_id AND deleted_at IS NULL)
         AND (SELECT COUNT(*) FROM users WHERE invited_by = invites.inviter_id AND invited_at >= ?4) < ?5 AND ${ELIGIBLE}`,
    ).bind(c, friend.id, t, monthStart(t), cfg.monthCap),
    env.DB.prepare(`UPDATE users SET invited_by = (SELECT inviter_id FROM invites WHERE code = ?1), invited_at = ?3 WHERE id = ?2 AND ${USED}`).bind(c, friend.id, t),
    env.DB.prepare(`INSERT INTO invite_ledger (user_id, kind, days, ref, at) SELECT ?2, 'grant', ?4, 'invited by ' || inviter_id, ?3 FROM invites WHERE code = ?1 AND used_by = ?2 AND used_at = ?3`).bind(c, friend.id, t, cfg.rewardDays),
    env.DB.prepare(
      `UPDATE entitlements SET period_end = period_end + ?4 * ${DAY}, updated_at = ?3
        WHERE user_id = ?2 AND provider = 'trial' AND plan = 'pro' AND status = 'active' AND period_end > ?3 AND ${USED}`,
    ).bind(c, friend.id, t, cfg.rewardDays),
    // the trial's extra days are the grant, used at once (changes(): the trial was extended just now)
    env.DB.prepare(`INSERT INTO invite_ledger (user_id, kind, days, ref, at) SELECT ?2, 'use', ?4, 'trial', ?3 WHERE ${USED} AND changes() > 0`).bind(c, friend.id, t, cfg.rewardDays),
  ]);
  if (!took.meta.changes) {
    const now2 = await inviteOf(env, c);
    const still = await env.DB.prepare(`SELECT 1 AS x WHERE ${ELIGIBLE}`).bind(c, friend.id).first();
    if (!still) return "already";
    return !now2 ? "unknown" : now2.state === "used" ? "used" : now2.state === "full" ? "full" : "already";
  }
  if (!extended.meta.changes) await startOrBank(env, friend.id);
  if ((await monthUsed(env, inviter.id, t)) >= cfg.monthCap) await inviteAlert(env, "invite_cap", inviter.handle, `${inviter.handle} used all ${cfg.monthCap} invites this month.`);
  return "ok";
}

/** POST /settings/invite-code: a code entered within 7 days of signing up counts as the link would have (eligible accounts only). */
export async function enterInviteCode(env: Env, userId: string, code: unknown): Promise<Recorded> {
  if (!env.INVITE_SALT) return "already";
  const u = await env.DB.prepare("SELECT primary_email, created_at, invited_by, invite_rewarded_at, invite_eligible FROM users WHERE id = ?").bind(userId).first<{ primary_email: string; created_at: number; invited_by: string | null; invite_rewarded_at: number | null; invite_eligible: number | null }>();
  if (!u || u.invited_by || u.invite_rewarded_at || u.invite_eligible !== 1) return "already";
  if (now() - u.created_at > ENTER_WINDOW) return "late";
  const c = normalizeInviteCode(code);
  if (!c) return "unknown";
  return recordInvite(env, { id: userId, email: u.primary_email }, c);
}

const BALANCE = "(SELECT COALESCE(SUM(CASE kind WHEN 'grant' THEN days WHEN 'use' THEN -days WHEN 'revoke' THEN -days ELSE 0 END), 0) FROM invite_ledger WHERE user_id = ?1)";

/** Days of given Pro not used yet: grants − uses − revokes (never below 0 as shown). */
export async function bankedDays(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT ${BALANCE} AS d`).bind(userId).first<{ d: number }>();
  return Math.max(0, r?.d ?? 0);
}

/**
 * Start what is banked, unless the account is on Pro now (then it waits for that to end) or deleted. One batch, so two
 * calls at once start it once: the entitlement is written only over one that is not active, and the use row only when
 * that write happened (changes() of the statement before it in the same transaction).
 */
export async function startOrBank(env: Env, userId: string): Promise<void> {
  const t = now();
  const [started] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at)
       SELECT ?1, 'pro', 'active', ?2 + b.d * ${DAY}, 'invite', ?2 FROM (SELECT ${BALANCE} AS d) b, users u
        WHERE u.id = ?1 AND u.deleted_at IS NULL AND b.d > 0
       ON CONFLICT (user_id) DO UPDATE SET plan = 'pro', status = 'active', period_end = excluded.period_end, provider = 'invite',
         updated_at = excluded.updated_at, downgraded_at = NULL, canceled_at = NULL, grace_until = NULL, carry_ms = NULL
       WHERE NOT (entitlements.plan = 'pro' AND entitlements.status = 'active' AND (entitlements.period_end IS NULL OR entitlements.period_end > ?2))`,
    ).bind(userId, t),
    env.DB.prepare(
      `INSERT INTO invite_ledger (user_id, kind, days, ref, at)
       SELECT ?1, 'use', (period_end - ?2) / ${DAY}, 'started', ?2 FROM entitlements WHERE user_id = ?1 AND provider = 'invite' AND updated_at = ?2 AND changes() > 0`,
    ).bind(userId, t),
  ]);
  if (!started.meta.changes) return;
  const u = await env.DB.prepare("SELECT handle FROM users WHERE id = ?").bind(userId).first<{ handle: string }>();
  if (u) await planMoved(env, { id: userId, handle: u.handle }, "pro");
}

/** The first day of this calendar month, UTC. */
export function monthStart(t = now()): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * The computer's machine hash, sent on join by CLI 0.5.9 (agents and the daemon), recorded on its device; the account
 * whose device there is older owns the computer, so computers used before invites belong to their first account.
 */
export async function recordMachine(env: Env, userId: string, deviceId: string | null, machineId: unknown): Promise<void> {
  const hash = await machineHash(env, machineId);
  if (!hash || !deviceId) return;
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET machine_hash = ?3 WHERE user_id = ?1 AND device_id = ?2 AND machine_hash IS NULL").bind(userId, deviceId, hash),
    env.DB.prepare(
      `INSERT INTO machine_hashes (hash, first_user_id, first_seen) SELECT ?3, ?1, created_at FROM devices WHERE user_id = ?1 AND device_id = ?2 AND machine_hash = ?3
       ON CONFLICT (hash) DO UPDATE SET first_user_id = excluded.first_user_id, first_seen = excluded.first_seen WHERE excluded.first_seen < machine_hashes.first_seen`,
    ).bind(userId, deviceId, hash),
  ]);
}

/**
 * After an agent of the account joins a topic (index.ts): the first join from a computer with a machine hash decides,
 * once, whether the inviter gets days — granted when the computer's first account is the friend, none when the computer
 * was another account's or the inviter is gone. No monthly cap here since codes became single-use: the cap is on codes used, and each
 * friend is granted at most once (invite_ledger_one_grant), in whatever month it is judged. ('capped' rows from before
 * stay and read as connected.) A computer with 3+ accounts is not judged (a shared image): an alert.
 */
export async function rewardOnJoin(env: Env, userId: string, deviceId: string | null): Promise<void> {
  const u = await env.DB.prepare("SELECT invited_by, invite_rewarded_at, created_at FROM users WHERE id = ?").bind(userId).first<{ invited_by: string | null; invite_rewarded_at: number | null; created_at: number }>();
  if (!u?.invited_by || u.invite_rewarded_at || !deviceId) return;
  const cfg = await inviteConfig(env);
  if (now() - u.created_at > cfg.windowDays * DAY) return;
  const d = await env.DB.prepare("SELECT machine_hash FROM devices WHERE user_id = ? AND device_id = ?").bind(userId, deviceId).first<{ machine_hash: string | null }>();
  if (!d?.machine_hash) return;
  const shared = await env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM devices WHERE machine_hash = ?").bind(d.machine_hash).first<{ n: number }>();
  if ((shared?.n ?? 0) >= SHARED_MACHINE) {
    await inviteAlert(env, "invite_shared_machine", d.machine_hash.slice(0, 12), `${shared!.n} accounts have tokens on one computer; invites from it are not judged.`);
    return;
  }
  const t = now();
  const claim = await env.DB.prepare("UPDATE users SET invite_reward = 'pending', invite_rewarded_at = ? WHERE id = ? AND invite_rewarded_at IS NULL").bind(t, userId).run();
  if (!claim.meta.changes) return;
  const settle = (reward: string) => env.DB.prepare("UPDATE users SET invite_reward = ? WHERE id = ?").bind(reward, userId).run();
  const m = await env.DB.prepare("SELECT first_user_id FROM machine_hashes WHERE hash = ?").bind(d.machine_hash).first<{ first_user_id: string }>();
  const inviter = await env.DB.prepare("SELECT id, handle FROM users WHERE id = ? AND deleted_at IS NULL").bind(u.invited_by).first<{ id: string; handle: string }>();
  // The same CLI home (device id) as an older account's: someone else's computer, whatever its daemon reported so far.
  const borrowed = await env.DB.prepare(
    "SELECT 1 AS x FROM devices o WHERE o.device_id = ?2 AND o.user_id != ?1 AND o.created_at < (SELECT created_at FROM devices WHERE user_id = ?1 AND device_id = ?2)",
  ).bind(userId, deviceId).first();
  if (!m || m.first_user_id !== userId || !inviter || borrowed) {
    await settle("none");
    return;
  }
  try {
    // One grant per friend: an earlier, interrupted call may have written it already.
    await env.DB.prepare("INSERT OR IGNORE INTO invite_ledger (user_id, kind, days, ref, at) VALUES (?, 'grant', ?, ?, ?)").bind(inviter.id, cfg.rewardDays, userId, t).run();
    await settle("granted");
  } catch (e) {
    // Not decided after all: the next join tries again.
    await env.DB.prepare("UPDATE users SET invite_reward = NULL, invite_rewarded_at = NULL WHERE id = ? AND invite_reward = 'pending'").bind(userId).run().catch(() => {});
    throw e;
  }
  if (t - u.created_at < FAST_MS) await inviteAlert(env, "invite_fast", inviter.handle, `A friend of ${inviter.handle} counted ${Math.round((t - u.created_at) / 60_000)} min after signing up.`);
  await startOrBank(env, inviter.id);
}

/**
 * The daily self-check (cron): a balance below 0, more invites used in a month than the cap (only a bug, or the cap
 * lowered in KV meanwhile), given Pro on a deleted account (ended at once), computers shared by many accounts. Each
 * finding is an alert for the ops page.
 */
export async function inviteDaily(env: Env): Promise<void> {
  const t = now();
  const cfg = await inviteConfig(env);
  const neg = await env.DB.prepare(
    "SELECT u.handle FROM invite_ledger l JOIN users u ON u.id = l.user_id GROUP BY l.user_id HAVING SUM(CASE l.kind WHEN 'grant' THEN l.days WHEN 'use' THEN -l.days WHEN 'revoke' THEN -l.days ELSE 0 END) < 0 LIMIT 20",
  ).all<{ handle: string }>();
  for (const r of neg.results) await inviteAlert(env, "invite_negative", r.handle, `${r.handle}'s given days are below zero.`);
  const over = await env.DB.prepare(
    "SELECT u.handle, COUNT(*) AS n FROM users f JOIN users u ON u.id = f.invited_by WHERE f.invited_at >= ? GROUP BY f.invited_by HAVING COUNT(*) > ? LIMIT 20",
  ).bind(monthStart(t), cfg.monthCap).all<{ handle: string; n: number }>();
  for (const r of over.results) await inviteAlert(env, "invite_over_cap", r.handle, `${r.handle} has ${r.n} invites used this month (cap ${cfg.monthCap}).`);
  const gone = await env.DB.prepare(
    "SELECT u.id, u.handle FROM entitlements e JOIN users u ON u.id = e.user_id WHERE e.provider = 'invite' AND e.status = 'active' AND e.period_end > ? AND u.deleted_at IS NOT NULL LIMIT 20",
  ).bind(t).all<{ id: string; handle: string }>();
  for (const r of gone.results) {
    await env.DB.prepare("UPDATE entitlements SET status = 'canceled', period_end = ?, updated_at = ? WHERE user_id = ? AND provider = 'invite'").bind(t, t, r.id).run();
    await inviteAlert(env, "invite_deleted_pro", r.handle, `${r.handle} is deleted but had given Pro; ended.`);
  }
  // A judgment cut short (pending for over an hour): granted if its grant row was written (and the days started), else
  // undecided again, so the friend's next join decides it.
  const stuck = await env.DB.prepare("SELECT id, invited_by FROM users WHERE invite_reward = 'pending' AND invite_rewarded_at < ? LIMIT 50").bind(t - 3600_000).all<{ id: string; invited_by: string }>();
  for (const s of stuck.results) {
    const grant = await env.DB.prepare("SELECT 1 AS x FROM invite_ledger WHERE user_id = ? AND kind = 'grant' AND ref = ?").bind(s.invited_by, s.id).first();
    if (grant) {
      await env.DB.prepare("UPDATE users SET invite_reward = 'granted' WHERE id = ? AND invite_reward = 'pending'").bind(s.id).run();
      await startOrBank(env, s.invited_by);
    } else await env.DB.prepare("UPDATE users SET invite_reward = NULL, invite_rewarded_at = NULL WHERE id = ? AND invite_reward = 'pending'").bind(s.id).run();
  }
  const shared = await env.DB.prepare(
    "SELECT machine_hash AS h, COUNT(DISTINCT user_id) AS n FROM devices WHERE machine_hash IS NOT NULL GROUP BY machine_hash HAVING COUNT(DISTINCT user_id) >= ? LIMIT 20",
  ).bind(SHARED_MACHINE).all<{ h: string; n: number }>();
  for (const r of shared.results) await inviteAlert(env, "invite_shared_machine", r.h.slice(0, 12), `${r.n} accounts have tokens on one computer.`);
}

/**
 * The settings page's invite block: the current code and its link, or both null when this
 * month's invites are all used; this month's used n / cap. A friend judged "none" (or still pending) shows as registered.
 */
export async function inviteView(env: Env, user: { id: string }, origin: string): Promise<Record<string, unknown>> {
  const code = await currentInvite(env, user.id);
  const cfg = await inviteConfig(env);
  const t = now();
  const me = await env.DB.prepare("SELECT created_at, invited_by, invite_rewarded_at, invite_eligible FROM users WHERE id = ?").bind(user.id).first<{ created_at: number; invited_by: string | null; invite_rewarded_at: number | null; invite_eligible: number | null }>();
  const ent = await env.DB.prepare("SELECT provider, status, period_end FROM entitlements WHERE user_id = ?").bind(user.id).first<{ provider: string; status: string; period_end: number | null }>();
  const { results } = await env.DB.prepare("SELECT handle, display_name, invite_reward, invited_at FROM users WHERE invited_by = ? ORDER BY invited_at DESC LIMIT 50").bind(user.id).all<{ handle: string; display_name: string | null; invite_reward: string | null; invited_at: number }>();
  return {
    code,
    url: code ? `${origin}/i/${code}` : null,
    monthCount: await monthUsed(env, user.id, t),
    monthCap: cfg.monthCap,
    rewardDays: cfg.rewardDays,
    bankedDays: await bankedDays(env, user.id),
    activeUntil: ent?.provider === "invite" && ent.status === "active" && ent.period_end != null && ent.period_end > t ? ent.period_end : null,
    // granted: given days; capped (before codes were single-use: used, past that month's cap): connected; anything else (not yet, or not
    // counted) reads as registered.
    invitees: results.map((r) => ({ name: r.display_name || r.handle, status: r.invite_reward === "granted" ? "rewarded" : r.invite_reward === "capped" ? "connected" : "registered", at: r.invited_at })),
    canEnterCode: !!env.INVITE_SALT && !!me && me.invite_eligible === 1 && !me.invited_by && !me.invite_rewarded_at && t - me.created_at <= ENTER_WINDOW,
    // who invited this account, by display name or handle, for settings' 「邀请你的人 · …」
    invitedBy: me?.invited_by ? await env.DB.prepare("SELECT COALESCE(display_name, handle) AS name FROM users WHERE id = ?").bind(me.invited_by).first<{ name: string }>().then((r) => r?.name ?? null) : null,
  };
}

/** For the ops page: whoever invited anyone, with this month's invites used (n / cap) and the given days left; and computers with more than one account. */
export const OPS_INVITERS_SQL = `SELECT u.handle,
  SUM(CASE WHEN f.invited_at >= ?1 THEN 1 ELSE 0 END) AS month,
  (SELECT COALESCE(SUM(CASE l.kind WHEN 'grant' THEN l.days WHEN 'use' THEN -l.days WHEN 'revoke' THEN -l.days ELSE 0 END), 0) FROM invite_ledger l WHERE l.user_id = u.id) AS balance
  FROM users f JOIN users u ON u.id = f.invited_by GROUP BY f.invited_by ORDER BY month DESC, u.handle LIMIT 50`;
export const OPS_MACHINES_SQL = "SELECT substr(machine_hash, 1, 12) AS h, COUNT(DISTINCT user_id) AS n FROM devices WHERE machine_hash IS NOT NULL GROUP BY machine_hash HAVING COUNT(DISTINCT user_id) >= 2 ORDER BY n DESC LIMIT 20";
export const OPS_ALERTS_SQL = "SELECT kind, subject, day, detail FROM alerts WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT 50";
