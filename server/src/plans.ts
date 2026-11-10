// Plans and their limits: what an account may use, by the plan it is on.
// Messages count against the room owner's plan (the room's cost is theirs); files and storage against
// the uploader's. The numbers are configuration in KV (config:plans) that only ever goes up.

import { now } from "./util";
import { DAY_MS, retentionDays } from "./retention";

/** free / pro on our hosted service; self on a deployment that does not sell plans (PLANS unset). */
export type Plan = "free" | "pro" | "self";

export interface Limits {
  activeRooms: number | null; // rooms of one's own that are not archived; null = no limit
  roomsPerDay: number; // rooms one account may make in a day (archive-and-make-another would get round activeRooms)
  msgsPerRoomDay: number | null; // messages in one room per UTC day (people, agents and daemons; not system lines)
  msgsPerRoomMinute: number; // a loop of agents stops here
  msgsPerAccountDay: number | null; // messages in all the rooms one account owns, per UTC day
  storageBytes: number; // files one account has uploaded and that are still kept
  fileBytes: number; // one file
  uploadsPerDay: number;
  uploadBytesPerDay: number;
  todoWritesPerRoomMinute: number; // task changes in one room per minute: a loop stops here (they are not messages)
  devices: number | null; // computers running agents (device.ts computersOf); null = no limit
}

/** One message's text, on every plan (longer goes as a file). */
export const MAX_TEXT = 10_000;

const MB = 1024 * 1024;
const GB = 1024 * MB;

const DEFAULTS: Record<Plan, Limits> = {
  free: {
    activeRooms: 1,
    roomsPerDay: 20,
    msgsPerRoomDay: 300,
    msgsPerRoomMinute: 30,
    msgsPerAccountDay: null,
    storageBytes: 1 * GB,
    fileBytes: 10 * MB,
    uploadsPerDay: 300,
    uploadBytesPerDay: 500 * MB,
    todoWritesPerRoomMinute: 120,
    devices: 1,
  },
  pro: {
    activeRooms: null,
    roomsPerDay: 20,
    msgsPerRoomDay: null,
    msgsPerRoomMinute: 30,
    msgsPerAccountDay: 20_000,
    storageBytes: 20 * GB,
    fileBytes: 25 * MB,
    uploadsPerDay: 300,
    uploadBytesPerDay: 5 * GB,
    todoWritesPerRoomMinute: 120,
    devices: 5,
  },
  // Someone's own deployment: no tiers, only the guards against a runaway loop.
  self: {
    activeRooms: null,
    roomsPerDay: 100,
    msgsPerRoomDay: null,
    msgsPerRoomMinute: 30,
    msgsPerAccountDay: null,
    storageBytes: 20 * GB,
    fileBytes: 25 * MB,
    uploadsPerDay: 1000,
    uploadBytesPerDay: 5 * GB,
    todoWritesPerRoomMinute: 120,
    devices: null,
  },
};

/** Plans apply on our hosted service only (wrangler var PLANS=hosted; someone's own deployment leaves it out). */
export const hosted = (env: Env) => (env as { PLANS?: string }).PLANS === "hosted";

/** The limits of a plan: the defaults, raised by config:plans where it says more. */
export async function limitsFor(env: Env, plan: Plan): Promise<Limits> {
  const cfg = await env.KV.get<Partial<Record<Plan, Partial<Limits>>>>("config:plans", { type: "json", cacheTtl: 300 }).catch(() => null);
  const base = DEFAULTS[plan];
  const more = cfg?.[plan] || {};
  const out = { ...base };
  for (const k of Object.keys(base) as (keyof Limits)[]) {
    const v = Number(more[k]);
    if (base[k] != null && Number.isFinite(v) && v > (base[k] as number)) (out[k] as number) = v;
  }
  // Tests only: small limits, so a local run reaches them in a few messages.
  if (env.TEST_LIMITS) Object.assign(out, (JSON.parse(env.TEST_LIMITS) as Partial<Record<Plan, Partial<Limits>>>)[plan] || {});
  return out;
}

const PLAN_SQL = "SELECT e.plan, e.status, e.period_end, e.grace_until FROM entitlements e";
type PlanRow = { plan: string; status: string; period_end: number | null; grace_until: number | null };

function planFrom(r: PlanRow | null): Plan {
  return r && r.plan === "pro" && r.status === "active" && (r.period_end == null || r.period_end > now()) ? "pro" : "free";
}

export async function planOf(env: Env, userId: string): Promise<Plan> {
  if (!hosted(env)) return "self";
  return planFrom(await env.DB.prepare(`${PLAN_SQL} WHERE e.user_id = ?`).bind(userId).first<PlanRow>());
}


/**
 * The file space an account has: its plan's, except that a Pro that lapsed keeps Pro's until graceUntil — the
 * entitlement's grace_until when the payment side wrote one, else 30 days from the end of the last paid period.
 */
export async function spaceOf(env: Env, userId: string): Promise<{ plan: Plan; limit: number; graceUntil: number | null }> {
  if (!hosted(env)) return { plan: "self", limit: (await limitsFor(env, "self")).storageBytes, graceUntil: null };
  const r = await env.DB.prepare(`${PLAN_SQL} WHERE e.user_id = ?`).bind(userId).first<PlanRow>();
  const plan = planFrom(r);
  let graceUntil: number | null = null;
  // How long a lapsed Pro keeps its file space: config:retention.proGraceDays, 30 by default.
  if (plan === "free" && r) graceUntil = r.grace_until ?? (r.plan === "pro" && r.period_end != null ? r.period_end + (await retentionDays(env)).proGraceDays * DAY_MS : null);
  if (graceUntil != null && graceUntil <= now()) graceUntil = null;
  return { plan, limit: (await limitsFor(env, graceUntil ? "pro" : plan)).storageBytes, graceUntil };
}

export async function planOfHandle(env: Env, handle: string): Promise<Plan> {
  if (!hosted(env)) return "self";
  return planFrom(await env.DB.prepare(`${PLAN_SQL} JOIN users u ON u.id = e.user_id WHERE u.handle = ?`).bind(handle).first<PlanRow>());
}

/** The UTC day of a moment, and when it started and ends. */
export function utcDay(t = now()): { day: string; start: number; end: number } {
  const start = Math.floor(t / 86400_000) * 86400_000;
  return { day: new Date(start).toISOString().slice(0, 10), start, end: start + 86400_000 };
}

/** "3 h 12 min" until a moment, for `next` texts. */
export function untilText(t: number): string {
  const min = Math.max(1, Math.ceil((t - now()) / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

export const mb = (bytes: number) => (bytes >= GB ? `${Math.round((bytes / GB) * 10) / 10} GB` : `${Math.round(bytes / MB)} MB`);
