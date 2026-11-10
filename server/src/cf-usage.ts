// The ops page's 成本 tab: what this Cloudflare account used in the current billing period, and what that will
// cost on Workers Paid. Usage comes from the GraphQL Analytics API with CF_ANALYTICS_TOKEN (Account Analytics: Read).
// It is the whole account's (its other Workers and buckets too), because the bill is. Kept 10 minutes in KV.
//
// Included amounts and prices: Cloudflare's pricing pages, last updated 2026-10-02:
//   https://developers.cloudflare.com/workers/platform/pricing/  (Workers, Workers KV, D1, Durable Objects)
//   https://developers.cloudflare.com/r2/pricing/                (R2, and which operations are class A and B)
// Included amounts reset each month on the day the plan was subscribed (CF_BILLING_DAY, D1 pricing note 8).

// No imports: the tests load this file as it is.
const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Workers Paid, a month. */
export const PLAN_USD = 5;

export type Fmt = "count" | "ms" | "gbs" | "bytes";
export interface Item {
  key: string;
  zh: string;
  en: string;
  store: boolean; // billed by GB-month (the average stored over the period), not by what was done
  included: number; // a month
  unit: number; // what one price is for
  price: number; // USD a unit beyond the included amount
  fmt: Fmt;
}

const M = 1e6, GB = 1e9;
export const ITEMS: Item[] = [
  { key: "wreq", zh: "Workers 请求", en: "Workers requests", store: false, included: 10 * M, unit: M, price: 0.3, fmt: "count" },
  { key: "wcpu", zh: "Workers CPU 时间", en: "Workers CPU time", store: false, included: 30 * M, unit: M, price: 0.02, fmt: "ms" },
  // HTTP, RPC and alarm invocations, and incoming WebSocket messages at 20 to 1 (DO pricing, footnote 2).
  { key: "doreq", zh: "DO 请求", en: "DO requests", store: false, included: 1 * M, unit: M, price: 0.15, fmt: "count" },
  { key: "dodur", zh: "DO 时长", en: "DO duration", store: false, included: 400_000, unit: M, price: 12.5, fmt: "gbs" },
  { key: "dorr", zh: "DO 读行", en: "DO rows read", store: false, included: 25_000 * M, unit: M, price: 0.001, fmt: "count" },
  { key: "dorw", zh: "DO 写行", en: "DO rows written", store: false, included: 50 * M, unit: M, price: 1, fmt: "count" },
  { key: "dostore", zh: "DO 存储", en: "DO storage", store: true, included: 5 * GB, unit: GB, price: 0.2, fmt: "bytes" },
  { key: "d1rr", zh: "D1 读行", en: "D1 rows read", store: false, included: 25_000 * M, unit: M, price: 0.001, fmt: "count" },
  { key: "d1rw", zh: "D1 写行", en: "D1 rows written", store: false, included: 50 * M, unit: M, price: 1, fmt: "count" },
  { key: "d1store", zh: "D1 存储", en: "D1 storage", store: true, included: 5 * GB, unit: GB, price: 0.75, fmt: "bytes" },
  { key: "r2store", zh: "R2 存储", en: "R2 storage", store: true, included: 10 * GB, unit: GB, price: 0.015, fmt: "bytes" },
  { key: "r2a", zh: "R2 A 类操作", en: "R2 class A", store: false, included: 1 * M, unit: M, price: 4.5, fmt: "count" },
  { key: "r2b", zh: "R2 B 类操作", en: "R2 class B", store: false, included: 10 * M, unit: M, price: 0.36, fmt: "count" },
  { key: "kvr", zh: "KV 读", en: "KV reads", store: false, included: 10 * M, unit: M, price: 0.5, fmt: "count" },
  { key: "kvw", zh: "KV 写", en: "KV writes", store: false, included: 1 * M, unit: M, price: 5, fmt: "count" },
  { key: "kvd", zh: "KV 删", en: "KV deletes", store: false, included: 1 * M, unit: M, price: 5, fmt: "count" },
  { key: "kvl", zh: "KV 列", en: "KV lists", store: false, included: 1 * M, unit: M, price: 5, fmt: "count" },
  { key: "kvstore", zh: "KV 存储", en: "KV storage", store: true, included: 1 * GB, unit: GB, price: 0.5, fmt: "bytes" },
];

const R2_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"]);
const R2_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
const KV_OPS: Record<string, string> = { read: "kvr", write: "kvw", delete: "kvd", list: "kvl" };

/** The billing period `at` is in: from the billing day of this or last month to the next one (end exclusive). */
export function billingPeriod(at: number, billingDay: number): { start: string; end: string; days: number } {
  const d = new Date(at);
  const dayIn = (y: number, m: number) => Math.min(billingDay, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() < dayIn(y, m)) m -= 1;
  const start = Date.UTC(y, m, dayIn(y, m));
  const s = new Date(start);
  y = s.getUTCFullYear();
  m = s.getUTCMonth() + 1;
  const end = Date.UTC(y, m, dayIn(y, m));
  return { start: dayOf(start), end: dayOf(end), days: Math.round((end - start) / DAY_MS) };
}

export const USAGE_QUERY = `query ($account: String!, $start: Time!, $end: Time!, $ds: Date!, $de: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    w: workersInvocationsAdaptive(limit: 5000, filter: { datetime_geq: $start, datetime_leq: $end }) { dimensions { date } sum { requests cpuTimeUs } }
    doi: durableObjectsInvocationsAdaptiveGroups(limit: 5000, filter: { datetime_geq: $start, datetime_leq: $end }) { dimensions { date type } sum { requests } }
    dop: durableObjectsPeriodicGroups(limit: 5000, filter: { datetime_geq: $start, datetime_leq: $end }) { dimensions { date } sum { duration rowsRead rowsWritten } }
    dos: durableObjectsSqlStorageGroups(limit: 100, filter: { date_geq: $ds, date_leq: $de }) { dimensions { date } max { storedBytes } }
    d1: d1AnalyticsAdaptiveGroups(limit: 5000, filter: { date_geq: $ds, date_leq: $de }) { dimensions { date } sum { rowsRead rowsWritten } }
    d1s: d1StorageAdaptiveGroups(limit: 100, filter: { date_geq: $ds, date_leq: $de }) { dimensions { date } max { databaseSizeBytes } }
    r2o: r2OperationsAdaptiveGroups(limit: 5000, filter: { datetime_geq: $start, datetime_leq: $end }) { dimensions { date actionType } sum { requests } }
    r2s: r2StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) { dimensions { date bucketName } max { payloadSize metadataSize } }
    kvo: kvOperationsAdaptiveGroups(limit: 5000, filter: { date_geq: $ds, date_leq: $de }) { dimensions { date actionType } sum { requests } }
    kvs: kvStorageAdaptiveGroups(limit: 100, filter: { date_geq: $ds, date_leq: $de }) { dimensions { date } max { byteCount } }
  } }
}`;

type Group = { dimensions: Record<string, string>; sum?: Record<string, number>; max?: Record<string, number> };

/** Per item, a value a day: what was done (summed), or what was stored (null on a day with no report). */
export function parseUsage(account: Record<string, Group[] | undefined>, days: string[]): Record<string, (number | null)[]> {
  const index = new Map(days.map((d, i) => [d, i]));
  const out: Record<string, (number | null)[]> = {};
  for (const it of ITEMS) out[it.key] = days.map(() => (it.store ? null : 0));
  const add = (key: string, day: string, v: number | undefined) => {
    const i = index.get(day);
    if (i != null && Number.isFinite(v)) out[key][i] = (out[key][i] ?? 0) + (v as number);
  };
  for (const g of account.w || []) {
    add("wreq", g.dimensions.date, g.sum?.requests);
    add("wcpu", g.dimensions.date, (g.sum?.cpuTimeUs ?? 0) / 1000);
  }
  for (const g of account.doi || []) add("doreq", g.dimensions.date, (g.sum?.requests ?? 0) / (g.dimensions.type === "hibernation" ? 20 : 1));
  for (const g of account.dop || []) {
    add("dodur", g.dimensions.date, g.sum?.duration);
    add("dorr", g.dimensions.date, g.sum?.rowsRead);
    add("dorw", g.dimensions.date, g.sum?.rowsWritten);
  }
  for (const g of account.dos || []) add("dostore", g.dimensions.date, g.max?.storedBytes);
  for (const g of account.d1 || []) {
    add("d1rr", g.dimensions.date, g.sum?.rowsRead);
    add("d1rw", g.dimensions.date, g.sum?.rowsWritten);
  }
  for (const g of account.d1s || []) add("d1store", g.dimensions.date, g.max?.databaseSizeBytes);
  for (const g of account.r2o || []) {
    const t = g.dimensions.actionType;
    if (R2_A.has(t)) add("r2a", g.dimensions.date, g.sum?.requests);
    else if (R2_B.has(t)) add("r2b", g.dimensions.date, g.sum?.requests);
  }
  for (const g of account.r2s || []) add("r2store", g.dimensions.date, (g.max?.payloadSize ?? 0) + (g.max?.metadataSize ?? 0));
  for (const g of account.kvo || []) if (KV_OPS[g.dimensions.actionType]) add(KV_OPS[g.dimensions.actionType], g.dimensions.date, g.sum?.requests);
  for (const g of account.kvs || []) add("kvstore", g.dimensions.date, g.max?.byteCount);
  return out;
}

export type Estimate = Item & { used: number; projected: number; share: number; cost: number; daily: number[] };

/**
 * The period so far and where it ends up: what was done so far plus the last 7 whole days' average for each day left;
 * storage as the average stored over the period, growing as it did over the last 7 days. Beyond the included amount is
 * rounded up to whole units, then priced (DO pricing: "rounded up to the next billable unit").
 */
export function estimate(series: Record<string, (number | null)[]>, days: string[], period: { start: string; days: number }): { items: Estimate[]; total: number } {
  const n = days.length;
  const inPeriod = days.map((d) => d >= period.start);
  const elapsed = inPeriod.filter(Boolean).length;
  const left = Math.max(0, period.days - elapsed);
  const items = ITEMS.map((it) => {
    const raw = series[it.key] || days.map(() => null);
    let used: number, projected: number, daily: number[];
    if (!it.store) {
      daily = raw.map((v) => v ?? 0);
      used = daily.reduce((s, v, i) => (inPeriod[i] ? s + v : s), 0);
      const week = daily.slice(Math.max(0, n - 8), n - 1);
      const avg = week.length ? week.reduce((s, v) => s + v, 0) / week.length : 0;
      projected = used + avg * left;
    } else {
      let last = 0;
      daily = raw.map((v) => (last = v ?? last)); // a day with no report keeps the day before's
      used = daily[n - 1];
      const slope = n > 7 ? (daily[n - 1] - daily[n - 8]) / 7 : 0;
      let sum = daily.reduce((s, v, i) => (inPeriod[i] ? s + v : s), 0);
      for (let k = 1; k <= left; k++) sum += Math.max(0, used + slope * k);
      projected = sum / Math.max(1, period.days);
    }
    const over = Math.max(0, projected - it.included);
    const cost = Math.round((over > 0 ? Math.ceil(over / it.unit) * it.price : 0) * 100) / 100;
    return { ...it, used, projected, share: (projected / it.included) * 100, cost, daily };
  });
  items.sort((a, b) => b.share - a.share);
  return { items, total: Math.round((PLAN_USD + items.reduce((s, it) => s + it.cost, 0)) * 100) / 100 };
}

export type Usage = { at: number; days: string[]; series: Record<string, (number | null)[]> };

/** The last 31 days of the account's usage (a billing period is at most 31 days), or why there is none. */
export async function cloudflareUsage(env: Env, at: number): Promise<{ ok: Usage } | { err: "no_token" | "failed"; detail?: string }> {
  const token = env.CF_ANALYTICS_TOKEN;
  if (!token) return { err: "no_token" };
  const slot = `ops:cf:usage:${Math.floor(at / 600_000)}`;
  const cached = await env.KV.get<Usage>(slot, "json").catch(() => null);
  if (cached) return { ok: cached };
  const base = env.CF_API_BASE || "https://api.cloudflare.com/client/v4";
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const out = (await r.json().catch(() => null)) as { result?: { id: string }[]; data?: unknown; errors?: { message?: string }[] } | null;
    if (!r.ok || !out || out.errors?.length) throw new Error(`${r.status} ${out?.errors?.map((e) => e.message).join("; ") || ""}`.trim());
    return out;
  };
  try {
    let account = env.CF_ACCOUNT_ID || (await env.KV.get("ops:cf:account").catch(() => null));
    if (!account) {
      account = (await call("/accounts")).result?.[0]?.id ?? null;
      if (!account) throw new Error("the token sees no account");
      await env.KV.put("ops:cf:account", account, { expirationTtl: 86_400 });
    }
    const today = Math.floor(at / DAY_MS);
    const days = Array.from({ length: 31 }, (_, i) => dayOf((today - 30 + i) * DAY_MS));
    const out = await call("/graphql", { query: USAGE_QUERY, variables: { account, start: `${days[0]}T00:00:00Z`, end: new Date(at).toISOString(), ds: days[0], de: days[days.length - 1] } });
    const acc = (out.data as { viewer?: { accounts?: Record<string, Group[]>[] } })?.viewer?.accounts?.[0];
    if (!acc) throw new Error("no data for the account");
    const usage = { at, days, series: parseUsage(acc, days) };
    await env.KV.put(slot, JSON.stringify(usage), { expirationTtl: 900 });
    return { ok: usage };
  } catch (e) {
    console.error(JSON.stringify({ msg: "cloudflare usage failed", error: String(e) }));
    return { err: "failed", detail: String((e as Error)?.message || e).slice(0, 200) };
  }
}
