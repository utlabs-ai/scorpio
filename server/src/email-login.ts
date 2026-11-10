// Email-code sign-in: D1 owns the flow and send ledger.
import { ApiError, escapeHtml, now, randomFrom, randomId } from "./util";
import { hosted } from "./plans";
import { turnstileOn, turnstilePassed, signIn, type User } from "./auth";
import { localNext } from "./safe-next";
import { alert } from "./ops";
import { siteLinks, type Lang } from "./layout";
import { strings } from "./strings";

const CODE_MS = 600_000;
const FLOW_MS = 1_800_000;
const COOL_MS = 60_000;
const WINDOW_MS = 900_000;
const DAY_MS = 86_400_000;
type Challenge = { flow_id: string; email: string; email_key: string; next: string; code_hash: string; code_expires_at: number; flow_expires_at: number; attempts: number; state: string; sent_at: number | null };
type Sender = NonNullable<Env["EMAIL"]>;

export function emailLoginConfigured(env: Env): boolean {
  return !!(env.EMAIL && env.LOGIN_CODE_KEY && env.EMAIL_SENDING_DOMAIN &&
    (turnstileOn(env) || (!hosted(env) && env.EMAIL_LOGIN_NO_TURNSTILE === "true")) &&
    (!hosted(env) || env.EMAIL_LOGIN_DELIVERY_VERIFIED === "true"));
}

function configured(env: Env): asserts env is Env & { EMAIL: Sender; LOGIN_CODE_KEY: string } {
  if (!emailLoginConfigured(env)) throw new ApiError("email_send_failed", "Email sign-in is not configured.", 503);
}

function normalizeEmail(raw: unknown): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ApiError("email_invalid", "Enter a valid email address.", 400);
  return email;
}

async function digest(key: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(value));
  return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function digestEqual(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function seconds(ms: number): number { return Math.max(1, Math.ceil(ms / 1000)); }
function remaining(ms: number): number { return Math.max(0, Math.ceil(ms / 1000)); }

export async function emailFlow(env: Env, flowId: string | undefined): Promise<Challenge | null> {
  if (!flowId || flowId.length !== 32) return null;
  const row = await env.DB.prepare("SELECT * FROM email_login_challenges WHERE flow_id = ? AND state = 'active' AND flow_expires_at > ?")
    .bind(flowId, now()).first<Challenge>();
  return row || null;
}

export function flowView(row: Challenge): { email: string; expiresIn: number; resendIn: number; state: "ready" | "expired" | "attempts" } {
  const t = now();
  return { email: row.email, expiresIn: remaining(row.code_expires_at - t), resendIn: remaining((row.sent_at || t) + COOL_MS - t),
    state: row.attempts >= 5 ? "attempts" : row.code_expires_at <= t ? "expired" : "ready" };
}

async function capOf(env: Env): Promise<number> {
  const cfg = await env.KV.get<{ dailyCap?: number }>("config:email_login", "json");
  const n = cfg?.dailyCap;
  return Number.isInteger(n) && n! >= 1 && n! <= 1000 ? n! : 1000;
}

/** One conditional INSERT is the capacity decision, including other Workers' pending sends. */
async function reserve(env: Env, emailKey: string, ipKey: string, id: string, t: number, cap: number): Promise<void> {
  const day = new Date(t).toISOString().slice(0, 10);
  const active = "(state = 'accepted' OR (state = 'pending' AND sent_at > ?))";
  const sql = `INSERT INTO email_login_sends (id,email_key,ip_key,sent_at,day,state)
    SELECT ?,?,?,?,?,'pending' WHERE
    (SELECT COUNT(*) FROM email_login_sends WHERE email_key = ? AND sent_at > ? AND ${active}) < 3 AND
    (SELECT COUNT(*) FROM email_login_sends WHERE email_key = ? AND day = ? AND ${active}) < 10 AND
    (SELECT COUNT(*) FROM email_login_sends WHERE ip_key = ? AND sent_at > ?) < 20 AND
    (SELECT COUNT(*) FROM email_login_sends WHERE day = ? AND ${active}) < ? AND
    NOT EXISTS (SELECT 1 FROM email_login_sends WHERE email_key = ? AND sent_at > ? AND ${active})`;
  const r = await env.DB.prepare(sql).bind(id, emailKey, ipKey, t, day,
    emailKey, t - WINDOW_MS, t - COOL_MS, emailKey, day, t - COOL_MS, ipKey, t - WINDOW_MS,
    day, t - COOL_MS, cap, emailKey, t - COOL_MS, t - COOL_MS).run();
  if (r.meta.changes) return;
  const [emailRows, emailDayRows, ipRows, dayRows, recent] = await Promise.all([
    env.DB.prepare("SELECT sent_at, state FROM email_login_sends WHERE email_key = ? AND sent_at > ? ORDER BY sent_at").bind(emailKey, t - WINDOW_MS).all<{ sent_at: number; state: string }>(),
    env.DB.prepare("SELECT sent_at, state FROM email_login_sends WHERE email_key = ? AND day = ?").bind(emailKey, day).all<{ sent_at: number; state: string }>(),
    env.DB.prepare("SELECT sent_at FROM email_login_sends WHERE ip_key = ? AND sent_at > ? ORDER BY sent_at").bind(ipKey, t - WINDOW_MS).all<{ sent_at: number }>(),
    env.DB.prepare("SELECT sent_at, state FROM email_login_sends WHERE day = ? ORDER BY sent_at").bind(day).all<{ sent_at: number; state: string }>(),
    env.DB.prepare("SELECT MAX(sent_at) AS sent_at FROM email_login_sends WHERE email_key = ? AND sent_at > ? AND (state = 'accepted' OR state = 'pending')").bind(emailKey, t - COOL_MS).first<{ sent_at: number | null }>(),
  ]);
  const counts = (r: { sent_at: number; state: string }) => r.state === "accepted" || (r.state === "pending" && r.sent_at > t - COOL_MS);
  const e = emailRows.results.filter(counts);
  if (e.length >= 3) throw new ApiError("email_rate_limited", "Too many codes requested for this address.", 429, seconds(e[0].sent_at + WINDOW_MS - t));
  if (emailDayRows.results.filter(counts).length >= 10) throw new ApiError("email_day_limited", "This address has used today's codes. Try again tomorrow, or sign in with Google or GitHub.", 429, seconds((Math.floor(t / DAY_MS) + 1) * DAY_MS - t));
  if (ipRows.results.length >= 20) throw new ApiError("email_send_limited", "Please try again later.", 429, seconds(ipRows.results[0].sent_at + WINDOW_MS - t));
  const d = dayRows.results.filter(counts);
  if (d.length >= cap) throw new ApiError("email_send_limited", "Please try again later.", 429, seconds((Math.floor(t / DAY_MS) + 1) * DAY_MS - t));
  if (recent?.sent_at) throw new ApiError("email_cooldown", "A code was just sent to this address.", 429, seconds(recent.sent_at + COOL_MS - t));
  throw new ApiError("email_send_limited", "Please try again later.", 429, 1);
}

function mail(lang: Lang, code: string): { subject: string; text: string; html: string } {
  const t = strings(lang);
  const subject = t.mailSubject.replace("{code}", code);
  // Our deployment signs with its address and support mail; a self-hosted server has neither of ours.
  const sign = siteLinks() ? "Scorpio · scorpio.utlabs.ai · support@utlabs.ai" : "Scorpio";
  const text = lang === "zh"
    ? `你的 Scorpio 登录验证码：\n\n${code}\n\n10 分钟内有效，请填回刚才要码的那个页面。\n\n如果不是你本人操作，忽略这封邮件即可：没有这个码，谁也登录不了。\n\n${sign}`
    : `Your Scorpio sign-in code:\n\n${code}\n\nIt works for 10 minutes, on the page where you asked for it.\n\nIf you didn't ask for a code, ignore this email. Nobody can sign in without it.\n\n${sign}`;
  const lines = text.split("\n\n");
  const html = `<!doctype html><html lang="${lang}"><meta charset="utf-8"><body style="font:16px/1.5 system-ui,sans-serif"><p>${escapeHtml(lines[0])}</p><p style="font-size:32px;font-weight:700;letter-spacing:.16em">${code}</p>${lines.slice(2).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</body></html>`;
  return { subject, text, html };
}

function category(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "provider_error";
}

async function send(env: Env & { EMAIL: Sender; LOGIN_CODE_KEY: string }, p: { email: string; next: string; lang: Lang; ip: string; oldFlow?: string }): Promise<{ flowId: string; expiresIn: number; resendIn: number }> {
  const t = now();
  const emailKey = await digest(env.LOGIN_CODE_KEY, `email:${p.email}`);
  const ipKey = await digest(env.LOGIN_CODE_KEY, `ip:${p.ip}`);
  const sendId = randomId(32), flowId = randomId(32), code = randomFrom("0123456789", 6);
  const hash = await digest(env.LOGIN_CODE_KEY, `${flowId}${code}`);
  let cap: number;
  try {
    cap = await capOf(env);
    await reserve(env, emailKey, ipKey, sendId, t, cap);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    await alert(env, "email_send_failed", "service", "An email-code send could not reserve capacity.", { category: "storage" }).catch(() => {});
    throw new ApiError("email_send_failed", "The email could not be sent. Try again in a moment.", 503);
  }
  try {
    await env.DB.prepare(`INSERT INTO email_login_challenges
      (flow_id,email,email_key,next,code_hash,code_expires_at,flow_expires_at,attempts,state,sent_at,send_id,created_at)
      VALUES (?,?,?,?,?,?,?,?, 'pending',NULL,?,?)`)
      .bind(flowId, p.email, emailKey, p.next, hash, t + CODE_MS, t + FLOW_MS, 0, sendId, t).run();
  } catch {
    await env.DB.prepare("UPDATE email_login_sends SET state = 'failed', failure_category = 'storage' WHERE id = ?").bind(sendId).run();
    await alert(env, "email_send_failed", "service", "An email-code challenge could not be stored.", { category: "storage" }).catch(() => {});
    throw new ApiError("email_send_failed", "The email could not be sent. Try again in a moment.", 503);
  }
  let providerId: string;
  try {
    const result = await env.EMAIL.send({ to: p.email, from: `Scorpio <no-reply@${env.EMAIL_SENDING_DOMAIN}>`, ...mail(p.lang, code) });
    if (!result?.messageId) throw Object.assign(new Error("No provider message ID"), { code: "missing_message_id" });
    providerId = result.messageId;
  } catch (e) {
    const why = category(e);
    await env.DB.batch([
      env.DB.prepare("UPDATE email_login_sends SET state = 'failed', failure_category = ? WHERE id = ?").bind(why, sendId),
      env.DB.prepare("DELETE FROM email_login_challenges WHERE flow_id = ? AND state = 'pending'").bind(flowId),
    ]);
    console.warn(JSON.stringify({ msg: "email send failed", category: why }));
    await alert(env, "email_send_failed", "service", "An email-code send failed.", { category: why }).catch(() => {});
    throw new ApiError("email_send_failed", "The email could not be sent. Try again in a moment.", 503);
  }
  try {
    const steps = [
      env.DB.prepare(p.oldFlow
        ? "UPDATE email_login_challenges SET state = 'replaced', replaced_by = ? WHERE flow_id = ? AND state = 'active' AND flow_expires_at > ?"
        : "UPDATE email_login_challenges SET state = 'replaced', replaced_by = ? WHERE email_key = ? AND state = 'active'")
        .bind(...(p.oldFlow ? [flowId, p.oldFlow, t] : [flowId, emailKey])),
      env.DB.prepare(p.oldFlow
        ? "UPDATE email_login_challenges SET state = 'active', sent_at = ? WHERE flow_id = ? AND state = 'pending' AND EXISTS (SELECT 1 FROM email_login_challenges WHERE flow_id = ? AND replaced_by = ?)"
        : "UPDATE email_login_challenges SET state = 'active', sent_at = ? WHERE flow_id = ? AND state = 'pending'")
        .bind(...(p.oldFlow ? [t, flowId, p.oldFlow, flowId] : [t, flowId])),
      env.DB.prepare("UPDATE email_login_sends SET state = 'accepted', provider_id = ? WHERE id = ? AND state = 'pending'").bind(providerId, sendId),
    ];
    const result = await env.DB.batch(steps);
    if (!result[1].meta.changes || !result[2].meta.changes) throw new Error("challenge activation lost");
  } catch {
    await alert(env, "email_send_failed", "service", "An accepted email-code send could not be activated.", { category: "activation" }).catch(() => {});
    throw new ApiError("email_send_failed", "The email could not be sent. Try again in a moment.", 503);
  }
  try {
    const dayCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_login_sends WHERE day = ? AND state = 'accepted'")
      .bind(new Date(t).toISOString().slice(0, 10)).first<{ n: number }>();
    if ((dayCount?.n || 0) >= Math.ceil(cap * .8)) await alert(env, "email_send_80", "service", "Email-code sends reached 80% of the daily cap.", { count: dayCount?.n, cap }).catch(() => {});
    if ((dayCount?.n || 0) >= cap) await alert(env, "email_send_100", "service", "Email-code sends reached the daily cap.", { count: dayCount?.n, cap }).catch(() => {});
  } catch { console.error(JSON.stringify({ msg: "email ops count failed" })); }
  return { flowId, expiresIn: 600, resendIn: 60 };
}

export async function startEmail(req: Request, env: Env, raw: unknown, next: unknown, token: unknown, flowId: string | undefined, lang: Lang): Promise<{ flowId: string; expiresIn: number; resendIn: number; reused?: boolean }> {
  configured(env);
  const email = normalizeEmail(raw);
  const current = await emailFlow(env, flowId);
  if (current?.email === email && current.sent_at && now() - current.sent_at < COOL_MS) {
    return { flowId: current.flow_id, expiresIn: remaining(current.code_expires_at - now()), resendIn: remaining(current.sent_at + COOL_MS - now()), reused: true };
  }
  if (turnstileOn(env) && !(await turnstilePassed(env, typeof token === "string" ? token : "", req.headers.get("cf-connecting-ip"))))
    throw new ApiError("email_challenge_failed", "The check did not pass.", 400);
  return send(env, { email, next: localNext(typeof next === "string" ? next : "/app", new URL(req.url).origin), lang, ip: req.headers.get("cf-connecting-ip") || "unknown" });
}

export async function resendEmail(req: Request, env: Env, flowId: string | undefined, lang: Lang): Promise<{ flowId: string; expiresIn: number; resendIn: number }> {
  configured(env);
  const current = await emailFlow(env, flowId);
  if (!current) throw new ApiError("email_session_lost", "Start sign-in again.", 410);
  return send(env, { email: current.email, next: current.next, lang, ip: req.headers.get("cf-connecting-ip") || "unknown", oldFlow: current.flow_id });
}

export async function verifyEmail(env: Env, flowId: string | undefined, raw: unknown, invite: string | null): Promise<{ user: User; next: string }> {
  configured(env);
  const code = typeof raw === "string" ? raw : "";
  for (let i = 0; i < 8; i++) {
    const row = await emailFlow(env, flowId);
    if (!row) throw new ApiError("email_session_lost", "Start sign-in again.", 410);
    if (row.attempts >= 5) throw new ApiError("email_code_attempts", "Request a new code.", 429);
    const t = now();
    if (row.code_expires_at <= t) throw new ApiError("email_code_expired", "Request a new code.", 410);
    if (!/^[0-9]{6}$/.test(code)) throw new ApiError("email_code_wrong", "Enter the six-digit code.", 400);
    const correct = digestEqual(await digest(env.LOGIN_CODE_KEY!, `${row.flow_id}${code}`), row.code_hash);
    const r = await env.DB.prepare(correct
      ? "UPDATE email_login_challenges SET state = 'consumed' WHERE flow_id = ? AND state = 'active' AND attempts = ? AND code_expires_at > ? AND flow_expires_at > ?"
      : "UPDATE email_login_challenges SET attempts = attempts + 1 WHERE flow_id = ? AND state = 'active' AND attempts = ? AND code_expires_at > ? AND flow_expires_at > ?")
      .bind(row.flow_id, row.attempts, t, t).run();
    if (!r.meta.changes) continue;
    if (!correct) throw new ApiError(row.attempts + 1 >= 5 ? "email_code_attempts" : "email_code_wrong", "Check the email and try again.", row.attempts + 1 >= 5 ? 429 : 400);
    const user = await signIn(env, { provider: "email", subject: row.email, email: row.email, suggestedHandle: row.email.split("@")[0], invite });
    return { user, next: row.next };
  }
  throw new ApiError("email_session_lost", "Start sign-in again.", 410);
}

export async function pruneEmailLogin(env: Env): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_login_challenges WHERE flow_expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM email_login_sends WHERE sent_at < ?").bind(t - 2 * DAY_MS),
  ]);
}

export async function emailOps(env: Env): Promise<{ accepted: number; failed: number; cap: number }> {
  const day = new Date(now()).toISOString().slice(0, 10);
  const r = await env.DB.prepare("SELECT SUM(state = 'accepted') AS accepted, SUM(state = 'failed') AS failed FROM email_login_sends WHERE day = ?").bind(day).first<{ accepted: number | null; failed: number | null }>();
  return { accepted: r?.accepted || 0, failed: r?.failed || 0, cap: await capOf(env) };
}
