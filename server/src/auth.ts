// People: sessions, Google / GitHub sign-in, account creation and identities.
// Agents: bearer tokens issued by device authorization (device.ts).

import { ApiError, cookie, now, parseCookies, randomId, safeEqual, sha256Hex } from "./util";
import { DRIVE_SCOPE, google } from "./drive";
import { hosted } from "./plans";
import { TRIAL_DAY_MS, trialForSignup } from "./trial";
import { baseHandle } from "./handle-base";
import { localNext } from "./safe-next";
import { newAccount } from "./invite";
import { retentionDays } from "./retention";
import { tokenRefusal, type TokenState } from "./device-logout";
import { siteLinks } from "./layout";

export interface User {
  id: string;
  handle: string;
  email: string;
}

const SESSION_COOKIE = "sid";
const SESSION_TTL = 30 * 86400;
export const RESERVED = new Set(["system", "scheduled", "daemon", "admin", "root", "scorpio", "utlabs", "support", "help", "api", "www", "null", "undefined"]);

export function origin(req: Request, env: Env): string {
  return (env.PUBLIC_URL as string) || new URL(req.url).origin;
}

const isSecure = (req: Request) => new URL(req.url).protocol === "https:";

// ---------- sessions (KV) ----------

export async function getSession(req: Request, env: Env): Promise<User | null> {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid || sid.length < 20) return null;
  const user = await env.KV.get<User>(`s:${sid}`, "json");
  return user && (await live(env, user.id)) ? user : null;
}

// A session of a deleted account is refused, even one that its deletion missed or that KV still serves for a
// while. D1 is asked at most every 30 s per account in this isolate: it sits on another
// continent from most edges, and the deletion takes the account out of every topic anyway.
const liveUntil = new Map<string, number>();
const LIVE_MS = 30_000;
async function live(env: Env, userId: string): Promise<boolean> {
  const t = Date.now();
  if ((liveUntil.get(userId) ?? 0) > t) return true;
  const row = await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?").bind(userId).first<{ deleted_at: number | null }>();
  if (!row || row.deleted_at) {
    liveUntil.delete(userId);
    return false;
  }
  if (liveUntil.size >= 10_000) liveUntil.clear();
  liveUntil.set(userId, t + LIVE_MS);
  return true;
}

export async function createSession(req: Request, env: Env, user: User): Promise<string> {
  const sid = randomId(32);
  // The user id as metadata: deleting an account finds its sessions by listing keys, without reading each one.
  await env.KV.put(`s:${sid}`, JSON.stringify(user), { expirationTtl: SESSION_TTL, metadata: { uid: user.id } });
  return cookie(SESSION_COOKIE, sid, SESSION_TTL, isSecure(req));
}

/**
 * Every browser session of an account goes (it was deleted). KV cannot be asked by user, so the session keys are
 * listed: those with the user id as metadata are matched at once, older ones (made before it) are read once.
 */
export async function revokeSessions(env: Env, userId: string): Promise<number> {
  let cursor: string | undefined;
  let gone = 0;
  do {
    const page: KVNamespaceListResult<{ uid?: string }> = await env.KV.list<{ uid?: string }>({ prefix: "s:", cursor });
    for (const k of page.keys) {
      const uid = k.metadata?.uid ?? (await env.KV.get<User>(k.name, "json").catch(() => null))?.id;
      if (uid !== userId) continue;
      await env.KV.delete(k.name);
      gone++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return gone;
}

export async function destroySession(req: Request, env: Env): Promise<string> {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) await env.KV.delete(`s:${sid}`);
  return cookie(SESSION_COOKIE, "", 0, isSecure(req));
}

/** Cookie-authenticated writes must come from our own pages. */
export function sameOrigin(req: Request, env: Env): boolean {
  const o = req.headers.get("origin");
  if (o) return o === origin(req, env) || o === new URL(req.url).origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

// ---------- accounts ----------

/** Reserve qa- for test accounts; keep the existing seven test handles unchanged in migration 0016. */
function* handleCandidates(suggested: string, isTest: boolean): Generator<string> {
  let base = baseHandle(suggested, isTest);
  if (RESERVED.has(base) || base.startsWith("daemon")) base = `${base}-user`.slice(0, 39);
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? "" : String(i);
    yield base.slice(0, 39 - suffix.length) + suffix;
  }
  for (;;) yield `${base.slice(0, 30)}-${randomId(6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

/**
 * Create the account for a first sign-in. Taking a name is one statement (insert, or nothing when the
 * name or the e-mail is already there), so two people with the same name signing in at the same moment
 * get alice and alice2 instead of one of them hitting the UNIQUE constraint. When the e-mail is what is
 * taken, the same person signed in twice at once: both get that one account.
 */
async function createUser(env: Env, email: string, suggested: string, t: number, isTest: boolean, invite: string | null = null, identity: { provider: string; subject: string } | null = null): Promise<User> {
  const id = randomId(16);
  const trial = hosted(env) ? await trialForSignup(env) : null;
  if (trial?.invalid) {
    const detail = JSON.stringify({ text: "config:trial is invalid or unavailable; new signups remain Free until it is fixed." });
    await env.DB.prepare("INSERT OR IGNORE INTO alerts (kind, subject, day, detail, created_at) VALUES ('trial_config', 'config:trial', ?, ?, ?)")
      .bind(new Date(t).toISOString().slice(0, 10), detail, t)
      .run()
      .catch((e) => console.error(JSON.stringify({ msg: "trial config alert failed", error: String(e) })));
    console.warn(JSON.stringify({ msg: "trial config invalid or unavailable; signup continues on Free" }));
  }
  let tries = 0;
  for (const handle of handleCandidates(suggested, isTest)) {
    // Not someone's handle, nor a display name someone shows as: the two are kept apart (docs/api/concepts.md).
    const taken = await env.DB.prepare("SELECT 1 FROM users WHERE handle = ?1 OR lower(display_name) = ?1 LIMIT 1").bind(handle).first();
    if (taken) continue;
    // New accounts start at ask; existing accounts got all from migration 0037.
    const statements = [env.DB.prepare("INSERT OR IGNORE INTO users (id, handle, primary_email, created_at, is_test, spawn_perm) VALUES (?, ?, ?, ?, ?, 'ask')").bind(id, handle, email, t, isTest ? 1 : 0)];
    if (trial?.enabled) {
      statements.push(env.DB.prepare(
        `INSERT INTO entitlements (user_id, plan, status, period_end, provider, updated_at)
         SELECT id, 'pro', 'active', ?, 'trial', ? FROM users WHERE id = ?`,
      ).bind(t + trial.days * TRIAL_DAY_MS, t, id));
    }
    const [created] = await env.DB.batch(statements);
    if (created.meta.changes) {
      // Invites: the e-mail is noted as seen; a new one that came by an invite code records who invited it.
      await newAccount(env, { id, email, createdAt: t }, invite, identity).catch((e) => console.error(JSON.stringify({ msg: "invite on signup failed", error: String(e) })));
      return { id, handle, email };
    }
    const same = await env.DB.prepare("SELECT id, handle, primary_email AS email FROM users WHERE primary_email = ?").bind(email).first<User>();
    if (same) return same;
    // Someone else took this name between the look and the insert: next name.
    if (++tries > 50) break;
  }
  throw new ApiError("server_busy", "Could not create the account; try signing in again.", 503);
}

/**
 * Find or create the account behind a verified sign-in. One verified e-mail is one account:
 * a second provider with the same e-mail is linked to it.
 */
export async function signIn(
  env: Env,
  p: { provider: string; subject: string; email: string; suggestedHandle: string; invite?: string | null },
): Promise<User> {
  const email = p.email.trim().toLowerCase();
  if (p.provider === "email") {
    // Deletion rewrites primary_email; the restore window still owns this address.
    const tombstone = await env.DB.prepare("SELECT deleted_at FROM users WHERE deleted_email = ? AND deleted_at IS NOT NULL AND purged_at IS NULL ORDER BY deleted_at DESC LIMIT 1")
      .bind(email).first<{ deleted_at: number }>();
    if (tombstone) {
      const override = (env as Env & { ACCOUNT_RESTORE_MS?: string }).ACCOUNT_RESTORE_MS;
      const restore = override && /^\d+$/.test(override) ? Number(override) : (await retentionDays(env)).accountRestoreDays * 86_400_000;
      if (tombstone.deleted_at + restore > now()) throw new ApiError("account_deleted", accountDeletedText(), 403);
      await env.DB.prepare(`DELETE FROM identities WHERE provider = 'email' AND subject = ? AND user_id IN
        (SELECT id FROM users WHERE deleted_email = ? AND deleted_at <= ? AND purged_at IS NULL)`)
        .bind(email, email, now() - restore).run();
    }
  }
  const byIdentity = await env.DB.prepare(
    "SELECT u.id, u.handle, u.primary_email AS email, u.deleted_at FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?",
  )
    .bind(p.provider, p.subject)
    .first<User & { deleted_at: number | null }>();
  // A deleted account does not sign in; within 7 days ops can still undo it.
  if (byIdentity?.deleted_at) throw new ApiError("account_deleted", accountDeletedText(), 403);
  if (byIdentity && p.provider === "dev") await refuseDevTakeover(env, byIdentity.id);
  if (byIdentity) return { id: byIdentity.id, handle: byIdentity.handle, email: byIdentity.email };

  const t = now();
  let user = await env.DB.prepare("SELECT id, handle, primary_email AS email FROM users WHERE primary_email = ?").bind(email).first<User>();
  if (user && p.provider === "dev") await refuseDevTakeover(env, user.id);
  if (!user) user = await createUser(env, email, p.suggestedHandle || email.split("@")[0], t, p.provider === "dev", p.invite ?? null, { provider: p.provider, subject: p.subject });
  await env.DB.prepare("INSERT OR IGNORE INTO identities (provider, subject, email, user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(p.provider, p.subject, email, user.id, t)
    .run();
  // Two first sign-ins with one identity at the same moment: the identity names the account both use.
  const linked = await env.DB.prepare(
    "SELECT u.id, u.handle, u.primary_email AS email FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?",
  )
    .bind(p.provider, p.subject)
    .first<User>();
  return linked || user;
}

/** A test identity is no longer a sign-in once its account has any real sign-in method. */
async function refuseDevTakeover(env: Env, userId: string): Promise<void> {
  const real = await env.DB.prepare("SELECT 1 FROM identities WHERE user_id = ? AND provider != 'dev' LIMIT 1").bind(userId).first();
  if (real) throw new ApiError("forbidden", "That e-mail belongs to a real account; the test sign-in cannot use it.", 403);
}

/**
 * Why a deleted account cannot sign in, while it can still be restored. Our deployment (it has the website) names its
 * support address; a self-hosted server has no address of ours to give, so it points to whoever runs it.
 */
export function accountDeletedText(): string {
  return siteLinks()
    ? "This account was deleted. Within 7 days of that it can still be restored: write to support@utlabs.ai."
    : "This account was deleted. Within 7 days of that, whoever runs this server can still restore it.";
}

/** A sign-in that would make a new account: held until the person passes Turnstile. */
export interface SignupClaim {
  provider: string;
  subject: string;
  email: string;
  suggestedHandle: string;
  /** The invite code the browser came with (cookie inv), for a new account. */
  invite?: string | null;
}

export async function providersOf(env: Env, userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT DISTINCT provider FROM identities WHERE user_id = ?")
    .bind(userId)
    .all<{ provider: string }>();
  return results.map((x) => x.provider);
}

export function holdSignupClaim(env: Env, sid: string, value: SignupClaim & { next: string }) {
  return env.KV.put(`signup:${sid}`, JSON.stringify(value), { expirationTtl: 900 });
}

export function heldSignup(env: Env, sid: string) {
  return env.KV.get<SignupClaim & { next: string }>(`signup:${sid}`, "json");
}

export function dropSignup(env: Env, sid: string) {
  return env.KV.delete(`signup:${sid}`);
}

export const turnstileOn = (env: Env) => !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);

/** Is there an account for this sign-in already (by the identity, or by its e-mail)? */
async function knownSignIn(env: Env, c: SignupClaim): Promise<boolean> {
  const r = await env.DB.prepare(
    "SELECT 1 FROM identities WHERE provider = ? AND subject = ? UNION ALL SELECT 1 FROM users WHERE primary_email = ? LIMIT 1",
  )
    .bind(c.provider, c.subject, c.email.trim().toLowerCase())
    .first();
  return !!r;
}

/** Sign in an existing account; a new one is held for the sign-up check (when Turnstile is set up). */
export async function signInOrHold(env: Env, c: SignupClaim): Promise<{ user?: User; signup?: SignupClaim }> {
  if (turnstileOn(env) && !(await knownSignIn(env, c))) return { signup: c };
  return { user: await signIn(env, c) };
}

/** Cloudflare's answer on a Turnstile token from our sign-up page. */
export async function turnstilePassed(env: Env, token: string, ip: string | null): Promise<boolean> {
  if (!token) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: token });
  if (ip) body.set("remoteip", ip);
  let out: { success?: boolean; "error-codes"?: string[] } = {};
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
      out = (await r.json().catch(() => ({}))) as typeof out;
      break;
    } catch (e) {
      // Not reached: the person is asked to try again (a token is good for one check, so the widget gives a new one).
      out = { "error-codes": [`fetch: ${String(e)}`] };
    }
  }
  if (!out.success) console.warn(JSON.stringify({ msg: "turnstile refused", codes: out["error-codes"] }));
  return !!out.success;
}

// ---------- OAuth: Google and GitHub ----------

export type Provider = "google" | "github";

export function providerConfigured(env: Env, p: Provider): boolean {
  return p === "google" ? !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) : !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Start sign-in: redirect to the provider with state (and PKCE for Google) in a short-lived cookie. `drive`: not a
 * sign-in but a signed-in person connecting their Google Drive — drive.file and offline access,
 * through the same callback, which then hands back the tokens instead of signing anyone in.
 */
export async function startOAuth(req: Request, env: Env, p: Provider, drive?: { userId: string; next: string }): Promise<Response> {
  const url = new URL(req.url);
  const state = randomId(24);
  const verifier = randomId(48);
  const redirectUri = `${origin(req, env)}/auth/${p}/callback`;
  let target: string;
  if (p === "google") {
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      // Sign-in reads only sub and a verified e-mail (finishOAuth), so it asks for nothing more.
      scope: drive ? `openid email ${DRIVE_SCOPE}` : "openid email",
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      // Drive: a refresh token comes only with offline access, and again only when the consent page is shown.
      ...(drive ? { access_type: "offline", prompt: "consent select_account" } : { prompt: "select_account" }),
    });
    target = google(env, `https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  } else {
    const q = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: redirectUri, scope: "read:user user:email", state });
    target = `https://github.com/login/oauth/authorize?${q}`;
  }
  const flow = JSON.stringify({ p, state, verifier, next: localNext(drive ? drive.next : url.searchParams.get("next"), url.origin), ...(drive ? { drive: drive.userId } : {}) });
  return new Response(null, { status: 302, headers: { location: target, "set-cookie": cookie("oauth", flow, 600, isSecure(req)) } });
}

/** What connecting a Drive brings back: the tokens, and whose Drive it is. `scoped`: the person left drive.file ticked. */
export interface DriveGrant {
  userId: string;
  refreshToken: string | null;
  accessToken: string;
  email: string;
  scoped: boolean;
}

/**
 * Finish sign-in. Returns the user (or, for a new account, the sign-up to check first) and where to go next; for a
 * Drive connection, the grant instead, for the signed-in person who started it.
 */
export async function finishOAuth(
  req: Request,
  env: Env,
  p: Provider,
): Promise<{ user?: User; signup?: SignupClaim; drive?: DriveGrant; next: string; clear: string }> {
  const url = new URL(req.url);
  const clear = cookie("oauth", "", 0, isSecure(req));
  let flow: { p: string; state: string; verifier: string; next: string; drive?: string };
  try {
    flow = JSON.parse(parseCookies(req).oauth || "");
  } catch {
    throw new ApiError("oauth_state", "The sign-in took too long or was started in another browser. Try again.", 400);
  }
  const state = url.searchParams.get("state") || "";
  if (flow.p !== p || !safeEqual(state, flow.state)) throw new ApiError("oauth_state", "Sign-in state did not match. Try again.", 400);
  const code = url.searchParams.get("code");
  if (!code) throw new ApiError("oauth_denied", "Sign-in was cancelled.", 400);
  const redirectUri = `${origin(req, env)}/auth/${p}/callback`;

  if (p === "google") {
    const tr = await fetch(google(env, "https://oauth2.googleapis.com/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: flow.verifier,
      }),
    });
    const tok = (await tr.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
    if (!tok.access_token) throw new ApiError("oauth_failed", `Google sign-in failed (${tok.error || tr.status}).`, 502);
    const ur = await fetch(google(env, "https://openidconnect.googleapis.com/v1/userinfo"), { headers: { authorization: `Bearer ${tok.access_token}` } });
    const info = (await ur.json()) as { sub?: string; email?: string; email_verified?: boolean };
    if (!info.sub || !info.email || !info.email_verified) throw new ApiError("oauth_failed", "Google did not return a verified e-mail.", 400);
    if (flow.drive) {
      const drive = {
        userId: flow.drive,
        refreshToken: tok.refresh_token || null,
        accessToken: tok.access_token,
        email: info.email.toLowerCase(),
        scoped: (tok.scope || "").split(" ").includes(DRIVE_SCOPE),
      };
      return { drive, next: flow.next, clear };
    }
    const r = await signInOrHold(env, { provider: "google", subject: info.sub, email: info.email, suggestedHandle: info.email.split("@")[0], invite: parseCookies(req).inv || null });
    return { ...r, next: flow.next, clear };
  }

  const tr = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const tok = (await tr.json()) as { access_token?: string; error?: string };
  if (!tok.access_token) throw new ApiError("oauth_failed", `GitHub sign-in failed (${tok.error || tr.status}).`, 502);
  const gh = { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "scorpio" };
  const [ur, er] = await Promise.all([fetch("https://api.github.com/user", { headers: gh }), fetch("https://api.github.com/user/emails", { headers: gh })]);
  const ghUser = (await ur.json()) as { id?: number; login?: string };
  const emails = (await er.json()) as { email: string; primary: boolean; verified: boolean }[];
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) : undefined;
  if (!ghUser.id || !primary) throw new ApiError("oauth_failed", "GitHub did not return a verified e-mail.", 400);
  const r = await signInOrHold(env, { provider: "github", subject: String(ghUser.id), email: primary.email, suggestedHandle: ghUser.login || "", invite: parseCookies(req).inv || null });
  return { ...r, next: flow.next, clear };
}

// ---------- agent tokens ----------

export interface AgentAuth {
  user: User;
  displayName: string | null; // the account's display name, null when none is set
  tokenId: string;
  device: string;
  deviceId: string | null;
  expiresAt: number;
  handoffLocal: boolean; // the account keeps handoffs on its agents' computers
}

export async function agentFromRequest(req: Request, env: Env, ctx: ExecutionContext, touchLastUsed = true): Promise<AgentAuth> {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) throw new ApiError("not_logged_in", "No agent token. Run: scorpio login", 401);
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT t.id, t.device_name, t.device_id, t.expires_at, t.last_used_at, t.revoked_at, t.revoked_reason, u.deleted_at,
        u.id AS uid, u.handle, u.primary_email, u.display_name, u.handoff_local
       FROM agent_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.hash = ?`,
  )
    .bind(hash)
    .first<TokenState & {
      id: string;
      device_name: string;
      device_id: string | null;
      last_used_at: number | null;
      uid: string;
      handle: string;
      primary_email: string;
      display_name: string | null;
      handoff_local: number | null;
    }>();
  const t = now();
  // A token the server knows says why it stopped working (docs/api/auth.md); an unknown one has no reason.
  const reason = row ? tokenRefusal(row, t) : null;
  if (!row || reason) {
    throw new ApiError("unauthorized", "This computer's token was revoked or has expired. Run: scorpio login (your person approves the new code on the web).", 401, undefined, reason ? { reason } : undefined);
  }
  if (touchLastUsed && (!row.last_used_at || t - row.last_used_at > 3600_000)) {
    ctx.waitUntil(env.DB.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").bind(t, row.id).run());
  }
  return {
    user: { id: row.uid, handle: row.handle, email: row.primary_email },
    displayName: row.display_name ?? null,
    handoffLocal: !!row.handoff_local, // 「交接只存在 agent 的电脑上」: read with the token, not in a query of its own
    tokenId: row.id,
    device: row.device_name,
    deviceId: row.device_id,
    expiresAt: row.expires_at,
  };
}
