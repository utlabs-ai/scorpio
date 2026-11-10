// Paying for Pro through Creem: a hosted checkout for the person, a webhook
// that writes `entitlements`, the customer portal to manage the subscription, and the downgrade when Pro lapses.
//
// Keys (Worker secrets): CREEM_API_KEY — a test key (creem_test_…) talks to Creem's sandbox, and
// while it is in place only OPS_ACCOUNTS and the testers in config:creem may pay; CREEM_WEBHOOK_SECRET — signs the
// webhook. The two products are KV config:creem {"monthly": "prod_…", "yearly": "prod_…", "testers": ["handle"]}:
// test and live products differ, so switching keys means switching these, with no deploy.

import { ApiError, now, safeEqual } from "./util";
import { planOf } from "./plans";
import { accessFrom, carryOf, ENTITLEMENT_UPSERT_SQL, fullRefund, REFUND_END_SQL, type PrevEntitlement } from "./billing-state";
import { bankedDays, startOrBank } from "./invite";
import { keepRecentComputers } from "./device";
import { retryIndexWrite, indexWriteFailed } from "./room-index";
import type { User } from "./auth";

export type Period = "monthly" | "yearly";
type Config = { monthly?: string; yearly?: string; testers?: string[] };

function apiBase(env: Env): string {
  const e = env as { CREEM_API_BASE?: string };
  if (e.CREEM_API_BASE) return e.CREEM_API_BASE; // tests only: a stand-in for Creem
  return (env.CREEM_API_KEY || "").startsWith("creem_test_") ? "https://test-api.creem.io" : "https://api.creem.io";
}
const testMode = (env: Env) => (env.CREEM_API_KEY || "").startsWith("creem_test_");

async function config(env: Env): Promise<Config> {
  return (await env.KV.get<Config>("config:creem", { type: "json", cacheTtl: 60 }).catch(() => null)) || {};
}

/** Whether paying is set up here at all: both keys and both products in place (until then no page offers it). */
export async function payOpen(env: Env): Promise<boolean> {
  if (!env.CREEM_API_KEY || !env.CREEM_WEBHOOK_SECRET) return false;
  const c = await config(env);
  return !!(c.monthly && c.yearly);
}

/** Whether this person can pay here: paying is set up, and with a test key only the people testing it. */
export async function canPay(env: Env, user: User | null): Promise<boolean> {
  if (!user || !(await payOpen(env))) return false;
  if (!testMode(env)) return true;
  const c = await config(env);
  const ops = String((env as { OPS_ACCOUNTS?: string }).OPS_ACCOUNTS || "").split(",").map((x) => x.trim());
  return ops.includes(user.handle) || (c.testers || []).includes(user.handle);
}

/** Creem answered with an error status; `httpStatus` tells a refusal (4xx) from Creem being down. */
class CreemFailed extends ApiError {
  constructor(readonly httpStatus: number) {
    super("payment_unavailable", "The payment service did not answer as expected. Try again in a minute.", 502);
  }
}

/** A POST to Creem's API with `body`, a GET without. */
async function creem<T>(env: Env, path: string, body?: unknown): Promise<T> {
  const r = await fetch(apiBase(env) + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-api-key": env.CREEM_API_KEY!, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(JSON.stringify({ msg: "creem call failed", path, status: r.status, body: text.slice(0, 500) }));
    throw new CreemFailed(r.status);
  }
  return JSON.parse(text) as T;
}

/** POST /billing/checkout {period}: a Creem checkout for this person, and the page goes there. */
export async function startCheckout(env: Env, user: User, period: Period, origin: string): Promise<string> {
  if (!(await canPay(env, user))) throw new ApiError("forbidden", "Paying for Pro is not open here yet.", 403);
  if ((await planOf(env, user.id)) === "pro") {
    const grant = await env.DB.prepare("SELECT provider FROM entitlements WHERE user_id = ?").bind(user.id).first<{ provider: string }>();
    // A trial or given days can be bought over: what is left of them comes after the paid time.
    if (grant?.provider !== "trial" && grant?.provider !== "invite") throw new ApiError("already_pro", "You are on Pro already; manage it from the pricing page.", 409);
  }
  const product = (await config(env))[period];
  const out = await creem<{ checkout_url: string }>(env, "/v1/checkouts", {
    product_id: product,
    request_id: `${user.id}:${period}:${now()}`,
    success_url: `${origin}/billing/done`,
    customer: user.email ? { email: user.email } : undefined,
    metadata: { userId: user.id, handle: user.handle },
  });
  if (!/^https:\/\//.test(out.checkout_url || "")) throw new ApiError("payment_unavailable", "The payment service gave no checkout link. Try again in a minute.", 502);
  return out.checkout_url;
}

/**
 * A subscription stops at once (an account being deleted): POST /v1/subscriptions/{id}/cancel, mode immediate.
 * A refusal (4xx) is often Creem having cancelled it already — a retry, or the person did it on Creem's page — so the
 * subscription is read before giving up. Then the entitlement here says cancelled, so a retry does not ask again and
 * the cancel webhook moves no plan.
 */
export async function cancelSubscription(env: Env, userId: string, subscriptionId: string): Promise<void> {
  await creemCancel(env, subscriptionId);
  await env.DB.prepare("UPDATE entitlements SET status = 'canceled', canceled_at = COALESCE(canceled_at, ?2), updated_at = ?2 WHERE user_id = ?1 AND subscription_id = ?3")
    .bind(userId, now(), subscriptionId)
    .run();
}

/** Creem stops the subscription now; one it already has as canceled or expired counts as done. Throws otherwise. */
async function creemCancel(env: Env, subscriptionId: string): Promise<void> {
  const id = encodeURIComponent(subscriptionId);
  try {
    await creem(env, `/v1/subscriptions/${id}/cancel`, { mode: "immediate" });
  } catch (e) {
    if (!(e instanceof CreemFailed) || e.httpStatus >= 500) throw e;
    const s = await creem<{ status?: string }>(env, `/v1/subscriptions?subscription_id=${id}`).catch(() => null);
    if (s?.status !== "canceled" && s?.status !== "expired") throw e;
  }
}

/** GET /billing/portal: Creem's own page to change the card, see invoices or cancel. */
export async function portalLink(env: Env, user: User): Promise<string> {
  const e = await env.DB.prepare("SELECT customer_id FROM entitlements WHERE user_id = ? AND provider = 'creem'").bind(user.id).first<{ customer_id: string | null }>();
  if (!e?.customer_id) throw new ApiError("not_found", "There is no Creem subscription on this account.", 404);
  const out = await creem<{ customer_portal_link: string }>(env, "/v1/customers/billing", { customer_id: e.customer_id });
  return out.customer_portal_link;
}

// ---------- the webhook ----------

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

type Sub = {
  id?: string;
  status?: string;
  customer?: string | { id?: string; email?: string };
  current_period_end_date?: string | null;
  metadata?: Record<string, unknown> | null;
};
type Event = { id?: string; eventType?: string; created_at?: number; object?: Record<string, unknown> };

/** POST /billing/creem/webhook: Creem tells us about a payment or a subscription (signed, maybe retried, maybe out of order). */
export async function creemWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.CREEM_WEBHOOK_SECRET) return new Response("not configured", { status: 404 });
  const body = await req.text();
  const sig = req.headers.get("creem-signature") || "";
  if (!safeEqual(sig, await signature(env.CREEM_WEBHOOK_SECRET, body))) return new Response("bad signature", { status: 401 });
  let ev: Event;
  try {
    ev = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!ev.id || !ev.eventType || !ev.object) return new Response("ok", { status: 200 });
  if (await env.DB.prepare("SELECT 1 FROM billing_events WHERE id = ?").bind(ev.id).first()) return new Response("seen", { status: 200 });
  const at = Number(ev.created_at) || now();

  // The subscription, wherever this event keeps it: checkout.completed carries it inside, subscription.* is it.
  const o = ev.object;
  const sub: Sub | null = ev.eventType === "checkout.completed" ? ((o.subscription as Sub) ?? null) : ev.eventType.startsWith("subscription.") ? (o as Sub) : null;
  const meta = { ...((sub?.metadata as Record<string, unknown>) || {}), ...((o.metadata as Record<string, unknown>) || {}) };
  const customerId = typeof sub?.customer === "string" ? sub.customer : sub?.customer?.id ?? (typeof o.customer === "object" ? (o.customer as { id?: string })?.id : (o.customer as string)) ?? null;
  let userId = typeof meta.userId === "string" ? meta.userId : null;
  if (!userId && (sub?.id || customerId)) {
    const row = await env.DB.prepare("SELECT user_id FROM entitlements WHERE (subscription_id = ? AND ? IS NOT NULL) OR (customer_id = ? AND ? IS NOT NULL) LIMIT 1")
      .bind(sub?.id ?? null, sub?.id ?? null, customerId, customerId)
      .first<{ user_id: string }>();
    userId = row?.user_id ?? null;
  }
  // Bookkeeping for the ops page: it never stands in the way of granting what was paid for.
  await recordPayment(env, ev, userId, at).catch((e) => console.error(JSON.stringify({ msg: "payment record failed", event: ev.id, error: String(e) })));
  if (ev.eventType === "refund.created") await refundTakesBack(env, ctx, ev, at).catch((e) => console.error(JSON.stringify({ msg: "refund handling failed", event: ev.id, error: String(e) })));
  if (!sub || !userId) {
    await env.DB.prepare("INSERT OR IGNORE INTO billing_events (id, type, user_id, created_at) VALUES (?, ?, ?, ?)").bind(ev.id, ev.eventType, userId, at).run();
    if (!userId && sub) console.error(JSON.stringify({ msg: "creem event for nobody", event: ev.id, type: ev.eventType, sub: sub.id }));
    return new Response("ok", { status: 200 });
  }
  const user = await env.DB.prepare("SELECT id, handle, deleted_at FROM users WHERE id = ?").bind(userId).first<{ id: string; handle: string; deleted_at: number | null }>();
  if (!user) return new Response("ok", { status: 200 });
  // A deleted account gets no entitlement back; its payment was recorded above and the event is kept.
  if (user.deleted_at) {
    await env.DB.prepare("INSERT OR IGNORE INTO billing_events (id, type, user_id, created_at) VALUES (?, ?, ?, ?)").bind(ev.id, ev.eventType, userId, at).run();
    return new Response("ok", { status: 200 });
  }

  const prev = await env.DB.prepare("SELECT provider, status, period_end, subscription_id, carry_ms, refunded_at, updated_at FROM entitlements WHERE user_id = ?").bind(user.id).first<NonNullable<PrevEntitlement> & { updated_at: number }>();
  // A purchase during the trial keeps the rest of the trial after the paid time.
  const carry = carryOf(prev, sub.id ?? null, at);
  const end = sub.current_period_end_date ? Date.parse(sub.current_period_end_date) : NaN;
  const st = String(sub.status || (ev.eventType === "checkout.completed" ? "active" : ""));
  const access = accessFrom(st, Number.isFinite(end) ? end : null, now(), carry);
  if (!access) {
    await env.DB.prepare("INSERT OR IGNORE INTO billing_events (id, type, user_id, created_at) VALUES (?, ?, ?, ?)").bind(ev.id, ev.eventType, userId, at).run();
    return new Response("ok", { status: 200 });
  }
  let { status, periodEnd } = access;
  // A refunded subscription stays ended: a later cancel or expiry of it does not give the paid time back.
  if (prev?.refunded_at != null && prev.subscription_id === (sub.id ?? null) && access.canceled && prev.period_end != null) {
    periodEnd = periodEnd == null ? prev.period_end : Math.min(periodEnd, prev.period_end);
    status = periodEnd > now() ? "active" : "canceled";
  }

  const before = await planOf(env, user.id);
  // A trial or comp grant is not cut short by an inactive subscription; an active purchase replaces the trial.
  // Older than what the row holds: a creem row, or any row of this same subscription (given days that started after its
  // refund).
  const stale = prev && (prev.provider === "creem" || prev.subscription_id === (sub.id ?? null)) && prev.updated_at > at;
  // A trial, comp or given days are not cut short or taken over by an event that only ends a subscription (canceled,
  // expired: access.canceled), even one that leaves it active a while; a paying one replaces them.
  const protectedGrant = prev && (prev.provider === "comp" || prev.provider === "trial" || prev.provider === "invite") && (status !== "active" || access.canceled);
  if (!stale && !protectedGrant) {
    await env.DB.prepare(ENTITLEMENT_UPSERT_SQL).bind(user.id, status, periodEnd, customerId, sub.id ?? null, at, access.canceled ? at : null, carry || null).run();
  }
  await env.DB.prepare("INSERT OR IGNORE INTO billing_events (id, type, user_id, created_at) VALUES (?, ?, ?, ?)").bind(ev.id, ev.eventType, user.id, at).run();
  const after = await planOf(env, user.id);
  if (before !== after) ctx.waitUntil(planMoved(env, user, after).catch((e) => console.error(JSON.stringify({ msg: "plan change failed", user: user.handle, error: String(e) }))));
  return new Response("ok", { status: 200 });
}

/**
 * A full refund takes back what it paid for: the subscription's Pro ends now (the trial time it kept
 * still comes after), and when it still renews, Creem is told to cancel it, so it does not charge again. A Creem
 * refusal leaves an alert on the ops page: then someone cancels it there by hand. A partial refund only goes on the books.
 */
async function refundTakesBack(env: Env, ctx: ExecutionContext, ev: Event, at: number): Promise<void> {
  const o = ev.object!;
  const t = (o.transaction || {}) as { amount_paid?: number };
  if (!fullRefund(Number(o.refund_amount), t.amount_paid != null ? Number(t.amount_paid) : null)) return;
  const s = o.subscription as { id?: string } | string | undefined;
  const subId = typeof s === "string" ? s : s?.id;
  if (!subId) return;
  const e = await env.DB.prepare("SELECT e.user_id, e.canceled_at, e.carry_ms, u.handle, u.deleted_at FROM entitlements e JOIN users u ON u.id = e.user_id WHERE e.subscription_id = ? AND e.provider = 'creem'")
    .bind(subId)
    .first<{ user_id: string; canceled_at: number | null; carry_ms: number | null; handle: string; deleted_at: number | null }>();
  if (!e || e.deleted_at) return;
  if (e.canceled_at == null) {
    await creemCancel(env, subId).catch(async (err) => {
      console.error(JSON.stringify({ msg: "refund: creem did not cancel", account: e.handle, subscription: subId, error: String(err) }));
      const detail = JSON.stringify({ text: `${e.handle} was refunded but Creem did not cancel subscription ${subId}: cancel it in Creem's dashboard, or it charges again.` });
      await env.DB.prepare("INSERT OR IGNORE INTO alerts (kind, subject, day, detail, created_at) VALUES ('refund_cancel', ?, ?, ?, ?)")
        .bind(subId, new Date(now()).toISOString().slice(0, 10), detail, now())
        .run()
        .catch(() => {});
    });
  }
  const t0 = now();
  const access = accessFrom("canceled", t0, t0, e.carry_ms ?? 0)!;
  const before = await planOf(env, e.user_id);
  await env.DB.prepare(REFUND_END_SQL).bind(e.user_id, subId, access.status, access.periodEnd, t0, at).run();
  const after = await planOf(env, e.user_id);
  if (before !== after) ctx.waitUntil(planMoved(env, { id: e.user_id, handle: e.handle }, after).catch((err) => console.error(JSON.stringify({ msg: "plan change failed", user: e.handle, error: String(err) }))));
}

/**
 * Money in, for the ops page: a row per paid subscription period (the product's price) and a negative one per
 * refund (its part before tax). Keyed by Creem's transaction or refund id, so a retried event writes nothing twice.
 */
async function recordPayment(env: Env, ev: Event, userId: string | null, at: number): Promise<void> {
  const o = ev.object;
  if (!o) return;
  let row: { id: string; kind: "paid" | "refund"; product: string | null; amount: number; currency: string } | null = null;
  if (ev.eventType === "subscription.paid") {
    const p = typeof o.product === "object" && o.product ? (o.product as { id?: string; price?: number; currency?: string }) : null;
    if (typeof o.last_transaction_id === "string" && p && Number.isFinite(p.price)) {
      row = { id: o.last_transaction_id, kind: "paid", product: p.id ?? null, amount: p.price!, currency: String(p.currency || "USD") };
    }
  } else if (ev.eventType === "refund.created") {
    const t = (o.transaction || {}) as { id?: string; amount?: number; amount_paid?: number; currency?: string };
    const refunded = Number(o.refund_amount);
    if (typeof o.id === "string" && Number.isFinite(refunded)) {
      const net = t.amount && t.amount_paid ? Math.round((refunded * t.amount) / t.amount_paid) : refunded;
      const subId = typeof o.subscription === "object" && o.subscription ? (o.subscription as { id?: string; product?: string }) : null;
      userId ??= subId?.id ? ((await env.DB.prepare("SELECT user_id FROM entitlements WHERE subscription_id = ?").bind(subId.id).first<{ user_id: string }>())?.user_id ?? null) : null;
      // Or by the payment it refunds (kept, like the entitlement, when the account is deleted).
      userId ??= t.id ? ((await env.DB.prepare("SELECT user_id FROM payments WHERE id = ?").bind(t.id).first<{ user_id: string | null }>())?.user_id ?? null) : null;
      row = { id: o.id, kind: "refund", product: subId?.product ?? null, amount: -net, currency: String(o.refund_currency || t.currency || "USD") };
    }
  }
  if (!row) return;
  await env.DB.prepare("INSERT OR IGNORE INTO payments (id, user_id, kind, product, amount, currency, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.id, userId, row.kind, row.product, row.amount, row.currency, testMode(env) ? "test" : "live", at)
    .run();
}

// ---------- what a plan change does to the owner's rooms (the downgrade) ----------

/** The plan of an account moved: every room of theirs reads it again; a lapse archives, a new subscription restores. */
export async function planMoved(env: Env, user: { id: string; handle: string }, to: string): Promise<void> {
  // Given days banked take over when what the account had ends: no downgrade, the given Pro starts. When they did
  // not start (a deleted account), it downgrades as any other, so the daily lapse does not pick it up again.
  if (to !== "pro" && (await bankedDays(env, user.id)) > 0) {
    await startOrBank(env, user.id);
    if ((await planOf(env, user.id)) === "pro") return;
  }
  if (to === "pro") await restoreDowngraded(env, user);
  else await downgrade(env, user);
  const { results } = await env.DB.prepare("SELECT id FROM rooms WHERE owner_id = ? AND status IN ('active', 'archived')").bind(user.id).all<{ id: string }>();
  for (const r of results) await env.ROOMS.getByName(r.id).planChanged().catch(() => {});
}

/**
 * Pro lapsed: every active room but the one with the latest message is archived with reason "downgrade". "Latest" is
 * D1 rooms.active_at, the retention clock's day of the last message, so no room object is woken to ask. The
 * computers running agents go down to Free's limit the same way: the most recently used stay, the others' tokens are
 * revoked; Pro again brings none back.
 */
async function downgrade(env: Env, user: { id: string; handle: string }): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM rooms WHERE owner_id = ? AND status = 'active' ORDER BY active_at DESC, created_at DESC")
    .bind(user.id)
    .all<{ id: string }>();
  if (results.length > 1) {
    let retries = true;
    for (const r of results.slice(1)) {
      if (await env.ROOMS.getByName(r.id).planArchive(true, "downgrade")) {
        const archivedAt = now();
        const expected = `rooms.status=archived, archived_at=${archivedAt}, archived_reason=downgrade`;
        const write = () => env.DB.prepare("UPDATE rooms SET status = 'archived', archived_at = ?, archived_reason = 'downgrade' WHERE id = ? AND status = 'active'").bind(archivedAt, r.id).run();
        try { await write(); } catch (e) { if (retries) retries = await retryIndexWrite(env, r.id, "downgrade", expected, write); else await indexWriteFailed(env, r.id, "downgrade", expected, e); }
      }
    }
  }
  await keepRecentComputers(env, user.id);
  await env.DB.prepare("UPDATE entitlements SET downgraded_at = ? WHERE user_id = ?").bind(now(), user.id).run();
}

/** Pro again: the rooms still archived for the lapse come back, with 90 quiet days ahead (the retention clock starts over). */
async function restoreDowngraded(env: Env, user: { id: string; handle: string }): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM rooms WHERE owner_id = ? AND status = 'archived' AND archived_reason = 'downgrade'").bind(user.id).all<{ id: string }>();
  let retries = true;
  for (const r of results) {
    await env.ROOMS.getByName(r.id).planArchive(false, "downgrade");
    const activeAt = now();
    const expected = `rooms.status=active, archived_at=NULL, archived_reason=NULL, active_at=${activeAt}`;
    const write = () => env.DB.prepare("UPDATE rooms SET status = 'active', archived_at = NULL, archived_reason = NULL, active_at = ? WHERE id = ?").bind(activeAt, r.id).run();
    try { await write(); } catch (e) { if (retries) retries = await retryIndexWrite(env, r.id, "restoreDowngraded", expected, write); else await indexWriteFailed(env, r.id, "restoreDowngraded", expected, e); }
  }
  await env.DB.prepare("UPDATE entitlements SET downgraded_at = NULL WHERE user_id = ?").bind(user.id).run();
}

/**
 * Daily: a paid or trial Pro whose period ended is downgraded once; handled events older
 * than 30 days are forgotten.
 */
export async function lapseExpired(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT e.user_id AS id, u.handle FROM entitlements e JOIN users u ON u.id = e.user_id
     WHERE e.provider IN ('creem', 'trial', 'invite') AND e.plan = 'pro' AND e.downgraded_at IS NULL AND (e.status != 'active' OR (e.period_end IS NOT NULL AND e.period_end <= ?))
     LIMIT 200`,
  )
    .bind(now())
    .all<{ id: string; handle: string }>();
  for (const u of results) await planMoved(env, u, "free").catch((e) => console.error(JSON.stringify({ msg: "lapse failed", user: u.handle, error: String(e) })));
  await env.DB.prepare("DELETE FROM billing_events WHERE created_at < ?").bind(now() - 30 * 86400_000).run();
}
