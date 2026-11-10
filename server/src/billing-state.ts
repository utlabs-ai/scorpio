// What a Creem subscription's state means for access and for the pages. Kept apart from billing.ts, with no
// imports, so the node tests can load it.

/** A paid period that renews is kept for this long past its end: Creem charges at the end and tells us after. */
export const RENEWAL_SLACK = 2 * 86400_000;

export type Access = { status: "active" | "canceled"; periodEnd: number | null; canceled: boolean };

/**
 * Access for a subscription in state `st` whose paid period ends at `end` (null when Creem has not said), at time `t`:
 * renewing ones keep a little slack past the period's end; a canceled one runs to the end of what was paid (terms §6)
 * and says so on the pages; expired, unpaid or paused ones end now. `carry`: the trial time this subscription keeps
 * always after the paid end, whatever happens to the subscription. null: a state that changes nothing.
 */
export function accessFrom(st: string, end: number | null, t: number, carry = 0): Access | null {
  if (["active", "trialing", "past_due"].includes(st)) {
    // checkout.completed can come before the first period is known
    return { status: "active", periodEnd: (end != null ? end + RENEWAL_SLACK : t + 31 * 86400_000 + RENEWAL_SLACK) + carry, canceled: false };
  }
  if (st === "scheduled_cancel" || st === "canceled") {
    const last = end != null ? end + carry : carry > 0 ? t + carry : null;
    if (last != null && last > t) return { status: "active", periodEnd: last, canceled: true };
    return { status: "canceled", periodEnd: last, canceled: true };
  }
  if (["expired", "unpaid", "paused"].includes(st)) {
    const last = Math.min(end ?? t, t) + carry;
    return { status: last > t ? "active" : "canceled", periodEnd: last, canceled: true };
  }
  return null;
}

export type PrevEntitlement = { provider: string; status: string; period_end: number | null; subscription_id: string | null; carry_ms: number | null; refunded_at?: number | null } | null;

/**
 * The trial time a subscription event keeps: a purchase replacing a running trial keeps what was left
 * of it at the time of the event; later events of that same subscription keep what it kept; anything else keeps none.
 */
export function carryOf(prev: PrevEntitlement, subId: string | null, at: number): number {
  if (!prev) return 0;
  // A trial, or given days started from an invite: what is left of them is kept.
  if (prev.provider === "trial" || prev.provider === "invite") return prev.status === "active" && prev.period_end != null && prev.period_end > at ? prev.period_end - at : 0;
  if (prev.provider === "creem" && subId != null && prev.subscription_id === subId) return prev.carry_ms ?? 0;
  return 0;
}

/**
 * The webhook's write: ?1 user, ?2 status, ?3 period_end, ?4 customer, ?5 subscription, ?6 event time, ?7 when the
 * subscription was canceled (null while it renews; the first cancel's time is kept until it renews again), ?8 the
 * trial time it keeps (carryOf; period_end already has it).
 */
export const ENTITLEMENT_UPSERT_SQL = `INSERT INTO entitlements (user_id, plan, status, period_end, provider, customer_id, subscription_id, updated_at, downgraded_at, canceled_at, carry_ms)
  VALUES (?1, 'pro', ?2, ?3, 'creem', ?4, ?5, ?6, NULL, ?7, ?8)
  ON CONFLICT (user_id) DO UPDATE SET plan = 'pro', status = ?2, period_end = ?3, carry_ms = ?8,
    refunded_at = CASE WHEN ?7 IS NULL THEN NULL WHEN ?5 IS NOT NULL AND subscription_id IS NOT ?5 THEN NULL ELSE refunded_at END,
    customer_id = COALESCE(?4, customer_id), subscription_id = COALESCE(?5, subscription_id), updated_at = ?6,
    downgraded_at = CASE WHEN ?2 = 'active' THEN NULL ELSE downgraded_at END,
    canceled_at = CASE WHEN ?7 IS NULL THEN NULL ELSE COALESCE(canceled_at, ?7) END, provider = 'creem'`;

/**
 * A full refund: `refunded` the amount refunded, `paid` what the refunded payment came to (null when the
 * event does not say; then it counts as full, the only kind the terms offer, §6).
 */
export function fullRefund(refunded: number, paid: number | null): boolean {
  return Number.isFinite(refunded) && refunded > 0 && (paid == null || !Number.isFinite(paid) || refunded >= paid);
}

/** What a refunded subscription leaves: its paid time ends now; the trial time it kept still comes after. */
export const REFUND_END_SQL = `UPDATE entitlements SET status = ?3, period_end = ?4, canceled_at = COALESCE(canceled_at, ?5), refunded_at = ?5, updated_at = ?6
  WHERE user_id = ?1 AND subscription_id = ?2 AND provider = 'creem'`;

export type EntitlementRow = { provider: string; status: string; period_end: number | null; canceled_at: number | null; carry_ms?: number | null };

/** The row the pricing and settings pages read (?1 the user). */
export const ENTITLEMENT_ROW_SQL = "SELECT provider, status, period_end, canceled_at, carry_ms FROM entitlements WHERE user_id = ?1";

export function entitlementRow(env: Env, userId: string): Promise<EntitlementRow | null> {
  return env.DB.prepare(ENTITLEMENT_ROW_SQL).bind(userId).first<EntitlementRow>();
}

export function trialRow(env: Env, userId: string) {
  return env.DB.prepare(
    "SELECT plan, provider, status, period_end FROM entitlements WHERE user_id = ?",
  )
    .bind(userId)
    .first<{
      plan: string;
      provider: string;
      status: string;
      period_end: number | null;
    }>();
}

/**
 * What is paid for (paidThrough below): until = the last day of Pro, the trial's left days included when a
 * trial was carried over (carryDays, whole days); renewsOn = the next charge (null once canceled). Without a carry the
 * two are the same day and the pages say what they said before.
 */
export type Paid = { until: number; canceled: boolean; renewsOn?: number | null; carryDays?: number };

/**
 * What the pricing and settings pages say about a paid Pro: `until`, the last day of Pro (with the trial time it keeps,
 * without the renewal slack); `renewsOn`, the next charge (Creem's date; null once canceled); `carryDays`, the trial days
 * kept (0 when none, and then `renewsOn` is `until`).
 */
export function paidThrough(e: EntitlementRow | null): { until: number; canceled: boolean; renewsOn: number | null; carryDays: number } | null {
  if (!e || e.provider !== "creem" || e.status !== "active" || e.period_end == null) return null;
  const carry = e.carry_ms ?? 0;
  const carryDays = Math.round(carry / 86400_000);
  if (e.canceled_at != null) return { until: e.period_end, canceled: true, renewsOn: null, carryDays };
  const until = e.period_end - RENEWAL_SLACK;
  return { until, canceled: false, renewsOn: until - carry, carryDays };
}
