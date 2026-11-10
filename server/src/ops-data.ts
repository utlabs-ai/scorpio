// The ops page /admin: its queries and the arithmetic behind the 用户 tab. Real accounts only (users.is_test = 0).

export const DAY_MS = 86_400_000;
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The `n` UTC days ending with the day of `at`, oldest first. */
export function lastDays(n: number, at: number): string[] {
  const today = Math.floor(at / DAY_MS);
  return Array.from({ length: n }, (_, i) => dayOf((today - n + 1 + i) * DAY_MS));
}

export type AccountRow = {
  id: string;
  handle: string;
  created_at: number;
  plan: string | null;
  status: string | null;
  provider: string | null;
  period_end: number | null;
  last_human: string | null; // the last day the person sent a message themselves
  last_agent: string | null; // the last day one of their agents did
};

/** Every real account with its grant and the last day it (or an agent of it) said something; also the page's raw-data query. */
export const ACCOUNTS_SQL = `SELECT u.id, u.handle, u.created_at, e.plan, e.status, e.provider, e.period_end,
  (SELECT MAX(a.day) FROM activity_daily a WHERE a.user_id = u.id AND a.kind = 'human') AS last_human,
  (SELECT MAX(a.day) FROM activity_daily a WHERE a.user_id = u.id AND a.kind = 'agent') AS last_agent
FROM users u LEFT JOIN entitlements e ON e.user_id = u.id
WHERE u.is_test = 0
ORDER BY u.created_at, u.handle`;

/** Who said something on which day, from the first day a 7-day window on the chart reaches back to. */
export const ACTIVITY_SQL = `SELECT a.user_id, a.day, a.kind FROM activity_daily a JOIN users u ON u.id = a.user_id
WHERE u.is_test = 0 AND a.day >= ?`;

export const PRO_DAILY_SQL = "SELECT day, paid, trial, comp, invite FROM pro_daily ORDER BY day";

/** Latest host-join reports, never a live online signal. */
export const DAEMON_VERSIONS_SQL = `SELECT daemon_version AS version, COUNT(*) AS computers FROM devices
WHERE daemon_joined_at >= ? AND daemon_version IS NOT NULL
GROUP BY daemon_version ORDER BY computers DESC, daemon_version`;
export const RECENT_ROLLBACKS_SQL = `SELECT u.handle, COALESCE(d.name, d.device_name) AS computer, d.rollback_bad_version AS bad_version, d.rollback_at
FROM devices d JOIN users u ON u.id = d.user_id
WHERE d.rollback_at >= ? ORDER BY d.rollback_at DESC`;

/** Today's Pro accounts by source, written by the daily cron (real accounts only). */
export const PRO_SNAPSHOT_SQL = `INSERT OR REPLACE INTO pro_daily (day, paid, trial, comp, invite)
SELECT ?1,
  COUNT(CASE WHEN e.provider = 'creem' THEN 1 END),
  COUNT(CASE WHEN e.provider = 'trial' THEN 1 END),
  COUNT(CASE WHEN e.provider = 'comp' THEN 1 END),
  COUNT(CASE WHEN e.provider = 'invite' THEN 1 END)
FROM entitlements e JOIN users u ON u.id = e.user_id
WHERE u.is_test = 0 AND u.deleted_at IS NULL AND e.plan = 'pro' AND e.status = 'active' AND (e.period_end IS NULL OR e.period_end > ?2)`;

/** invite: days given for invites; like trial and comp, not paid. */
export type Source = "paid" | "trial" | "comp" | "invite";

/** Where an account's Pro comes from now, or null on the free plan (the same test as plans.ts planFrom). */
export function proSource(row: Pick<AccountRow, "plan" | "status" | "provider" | "period_end">, at: number): Source | null {
  if (row.plan !== "pro" || row.status !== "active" || (row.period_end != null && row.period_end <= at)) return null;
  return row.provider === "trial" ? "trial" : row.provider === "comp" ? "comp" : row.provider === "invite" ? "invite" : "paid";
}

export function proNow(rows: AccountRow[], at: number): Record<Source, number> {
  const out = { paid: 0, trial: 0, comp: 0, invite: 0 };
  for (const row of rows) {
    const s = proSource(row, at);
    if (s) out[s] += 1;
  }
  return out;
}

/** Signups per day over `days`, and the running total of real accounts (those from before the window included). */
export function signupSeries(rows: Pick<AccountRow, "created_at">[], days: string[]): { daily: number[]; total: number[] } {
  const index = new Map(days.map((d, i) => [d, i]));
  const daily = days.map(() => 0);
  let before = 0;
  for (const row of rows) {
    const day = dayOf(row.created_at);
    const i = index.get(day);
    if (i != null) daily[i] += 1;
    else if (day < days[0]) before += 1;
  }
  let sum = before;
  return { daily, total: daily.map((n) => (sum += n)) };
}

/** For each day: the accounts that said something themselves, and those whose agents did, in the 7 days ending that day. */
export function activeSeries(activity: { user_id: string; day: string; kind: string }[], days: string[]): { human: number[]; agent: number[] } {
  const byDay = new Map<string, { human: Set<string>; agent: Set<string> }>();
  for (const a of activity) {
    const slot = byDay.get(a.day) || { human: new Set<string>(), agent: new Set<string>() };
    (a.kind === "agent" ? slot.agent : slot.human).add(a.user_id);
    byDay.set(a.day, slot);
  }
  const human: number[] = [], agent: number[] = [];
  for (const day of days) {
    const end = Date.parse(`${day}T00:00:00Z`);
    const h = new Set<string>(), g = new Set<string>();
    for (let k = 0; k < 7; k++) {
      const slot = byDay.get(dayOf(end - k * DAY_MS));
      slot?.human.forEach((id) => h.add(id));
      slot?.agent.forEach((id) => g.add(id));
    }
    human.push(h.size);
    agent.push(g.size);
  }
  return { human, agent };
}

/** Pro accounts per day: the daily snapshots, carried forward over a missed day, and today as it is now. */
export function proSeries(snapshots: { day: string; paid: number; trial: number; comp: number; invite?: number }[], days: string[], today: Record<Source, number>): { total: number[]; paid: number[] } {
  const byDay = new Map(snapshots.map((s) => [s.day, s]));
  let last: { paid: number; trial: number; comp: number; invite?: number } = { paid: 0, trial: 0, comp: 0, invite: 0 };
  for (const s of snapshots) if (s.day < days[0]) last = s;
  const total: number[] = [], paid: number[] = [];
  days.forEach((day, i) => {
    const s = i === days.length - 1 ? today : byDay.get(day);
    if (s) last = s;
    total.push(last.paid + last.trial + last.comp + (last.invite ?? 0));
    paid.push(last.paid);
  });
  return { total, paid };
}

export function planLabel(row: AccountRow, lang: "zh" | "en", at: number): { label: string; sort: number } {
  const s = proSource(row, at);
  const zh = lang === "zh";
  if (!s) return { label: zh ? "免费" : "Free", sort: 0 };
  if (s === "paid") return { label: zh ? "Pro（付费）" : "Pro (paid)", sort: 3 };
  if (s === "comp") return { label: zh ? "Pro（赠送）" : "Pro (comp)", sort: 2 };
  if (s === "invite") return { label: zh ? `邀请送的 Pro，到 ${row.period_end == null ? "?" : dayOf(row.period_end)}` : `Invite Pro until ${row.period_end == null ? "?" : dayOf(row.period_end)}`, sort: 1 };
  const until = row.period_end == null ? "?" : dayOf(row.period_end);
  return { label: zh ? `试用到 ${until}` : `Trial until ${until}`, sort: 1 };
}

/** 今天 / 昨天 / MM-DD for a day, or — for never. */
export function dayLabel(day: string | null, at: number, lang: "zh" | "en"): string {
  if (!day) return "—";
  const today = dayOf(at), yesterday = dayOf(at - DAY_MS);
  if (day === today) return lang === "zh" ? "今天" : "Today";
  if (day === yesterday) return lang === "zh" ? "昨天" : "Yesterday";
  return day.slice(5);
}

// ---------- activity_daily: written by the rooms, filled for older messages once a room ----------

/** One room's senders per UTC day since `ts` (an agent counts for its owner: the part after @); daemons and system lines don't count. */
export const ROOM_ACTIVITY_SQL = `SELECT CAST(ts / 86400000 AS INTEGER) AS d, from_kind AS sender_kind,
  CASE WHEN from_kind = 'agent' THEN substr(from_name, instr(from_name, '@') + 1) ELSE from_name END AS account
FROM messages WHERE ts >= ? AND from_kind IN ('human', 'agent')
GROUP BY 1, 2, 3`; // by position: messages has a column of its own called kind

export const ACTIVITY_INSERT_SQL = "INSERT OR IGNORE INTO activity_daily (user_id, day, kind) SELECT id, ?, ? FROM users WHERE handle = ?";

/** How far back a room's earlier messages are read into activity_daily. */
export const BACKFILL_DAYS = 30;

// ---------- money in (payments, written by the Creem webhook) ----------

/** Creem's fee per successful transaction: 3.9% + $0.40 (https://www.creem.io/pricing). */
/** Creem's fee on a payment: 3.9% + 40¢ by default; KV config:creem.fee {percent, fixedCents} changes it (the ops page only). */
export type CreemFee = { percent: number; fixedCents: number };
export const CREEM_FEE: CreemFee = { percent: 3.9, fixedCents: 40 };
export function creemFeeOf(cfg: unknown): CreemFee {
  const f = (cfg as { fee?: Partial<CreemFee> } | null)?.fee;
  const p = Number(f?.percent), c = Number(f?.fixedCents);
  return Number.isFinite(p) && p >= 0 && p < 100 && Number.isFinite(c) && c >= 0 ? { percent: p, fixedCents: c } : CREEM_FEE;
}
export const creemFee = (cents: number, fee: CreemFee = CREEM_FEE) => (cents > 0 ? Math.round((cents * fee.percent) / 100 + fee.fixedCents) : 0);

export const PAYMENTS_SQL = `SELECT p.id, p.created_at, u.handle, p.kind, p.product, p.amount, p.currency
FROM payments p LEFT JOIN users u ON u.id = p.user_id
WHERE p.mode = 'live' AND COALESCE(u.is_test, 0) = 0 AND p.created_at >= ?
ORDER BY p.created_at DESC`;
