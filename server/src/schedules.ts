import { ApiError } from "./util";

export type Rule =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string; tz: string; step?: number; from?: string }
  | { kind: "weekly"; days: string[]; time: string; tz: string; step?: number; from?: string }
  | { kind: "every"; minutes: number };

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const clock = (time: unknown): time is string => typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

export function scheduleRule(input: unknown, at = Date.now(), previous?: Rule): Rule {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError("bad_request", "Give one schedule rule.");
  const r = input as Record<string, unknown>;
  if ((r.kind === "once" || r.kind === "every") && (r.step !== undefined || r.from !== undefined)) throw new ApiError("bad_request", "step and from go with daily or weekly.");
  if (r.kind === "once") {
    if (!Number.isSafeInteger(r.at) || !Number.isFinite(new Date(r.at as number).getTime())) throw new ApiError("bad_request", "once.at must be UTC milliseconds.");
    if ((r.at as number) <= at) throw new ApiError("schedule_in_past", "Choose a future time for this schedule.");
    return { kind: "once", at: r.at as number };
  }
  if (r.kind === "every") {
    if (!Number.isInteger(r.minutes) || (r.minutes as number) > 10080) throw new ApiError("bad_request", "every.minutes must be at most 10080.");
    if ((r.minutes as number) < 10) throw new ApiError("schedule_too_frequent", "At least every 10 minutes.");
    return { kind: "every", minutes: r.minutes as number };
  }
  if (r.kind !== "daily" && r.kind !== "weekly") throw new ApiError("bad_request", "Unknown schedule rule.");
  if (!clock(r.time) || typeof r.tz !== "string") throw new ApiError("bad_request", "Give HH:MM and an IANA time zone.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: r.tz }).format(at); }
  catch { throw new ApiError("bad_request", "Unknown IANA time zone."); }
  const old = previous?.kind === r.kind ? previous as Extract<Rule, { kind: "daily" | "weekly" }> : undefined;
  const step = r.step === undefined ? old?.step ?? 1 : r.step;
  if (!Number.isInteger(step) || (step as number) < 1 || (step as number) > (r.kind === "daily" ? 365 : 52)) throw new ApiError("bad_request", "step is out of range.");
  if (step === 1 && r.from !== undefined) throw new ApiError("bad_request", "from needs step 2 or more.");
  const from = r.from === undefined ? old?.from : r.from;
  if (from !== undefined && (typeof from !== "string" || calendarDate(from) === null)) throw new ApiError("bad_request", "from must be a real YYYY-MM-DD date.");
  const rule: Extract<Rule, { kind: "daily" | "weekly" }> = r.kind === "daily"
    ? { kind: "daily", time: r.time, tz: r.tz }
    : { kind: "weekly", days: [], time: r.time, tz: r.tz };
  if (step !== 1) {
    rule.step = step as number;
    rule.from = from as string | undefined;
  }
  if (r.kind === "daily") return anchoredRule(rule, at);
  if (!Array.isArray(r.days) || !r.days.length || r.days.length > 7 || r.days.some((d) => !DAYS.includes(d))) {
    throw new ApiError("bad_request", "weekly.days must contain 1–7 weekdays.");
  }
  const days = r.days as string[];
  if (rule.kind === "weekly") rule.days = DAYS.filter((d) => days.includes(d));
  return anchoredRule(rule, at);
}

const DAY_MS = 86_400_000;
function calendarDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}
function anchoredRule(rule: Extract<Rule, { kind: "daily" | "weekly" }>, at: number): Rule {
  if (rule.step && !rule.from) {
    const first = nextScheduleAt({ ...rule, step: undefined }, at);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: rule.tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(first);
    const date = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    rule.from = `${date.year}-${date.month}-${date.day}`;
  }
  return rule;
}

function wall(ms: number, fmt: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute) };
}

/** First wall-clock occurrence after `after`; gaps move forward, repeated hours use their first occurrence. */
export function nextScheduleAt(rule: Rule, after: number, due?: number): number {
  if (rule.kind === "once") return rule.at;
  if (rule.kind === "every") {
    const step = rule.minutes * 60_000;
    return due == null ? after + step : due + (Math.floor(Math.max(0, after - due) / step) + 1) * step;
  }
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: rule.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const today = wall(after, fmt);
  const [h, min] = rule.time.split(":").map(Number);
  const step = rule.step ?? 1;
  const anchor = rule.from ? calendarDate(rule.from)! : Date.UTC(today.y, today.m - 1, today.d);
  const start = Math.max(Date.UTC(today.y, today.m - 1, today.d), anchor);
  const monday = (ms: number) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
  const limit = rule.kind === "daily" ? step + 1 : 7 * (step + 1);
  for (let n = 0; n <= limit; n++) {
    const date = new Date(start + n * DAY_MS);
    if (step > 1 && (rule.kind === "daily" ? (date.getTime() - anchor) / DAY_MS : (monday(date.getTime()) - monday(anchor)) / (7 * DAY_MS)) % step !== 0) continue;
    const day = DAYS[(date.getUTCDay() + 6) % 7];
    if (rule.kind === "weekly" && !rule.days.includes(day)) continue;
    const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, min);
    const offsets = new Set([-12, 0, 12].map((hours) => {
      const probe = base + hours * 3_600_000;
      const w = wall(probe, fmt);
      return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - probe;
    }));
    const candidates = [...offsets].map((offset) => base - offset).sort((a, b) => a - b);
    const sameDay = candidates.map((ms) => ({ ms, w: wall(ms, fmt) })).filter(({ w }) => w.y === date.getUTCFullYear() && w.m === date.getUTCMonth() + 1 && w.d === date.getUTCDate());
    const exact = sameDay.find(({ w }) => w.h === h && w.min === min);
    if (exact) { if (exact.ms > after) return exact.ms; else continue; }
    // A spring-forward wall time does not exist: choose the instant shifted by the gap.
    const shifted = sameDay.filter(({ w }) => w.h * 60 + w.min > h * 60 + min).sort((a, b) => (a.w.h * 60 + a.w.min) - (b.w.h * 60 + b.w.min))[0];
    if (shifted && shifted.ms > after) return shifted.ms;
  }
  throw new ApiError("bad_request", "Could not calculate the next scheduled time.");
}

/** Keep only the takeover command's spawn arguments, replacing its old prompt. */
export function reviveCommand(command: string, text: string): { host: string; line: string } | null {
  const head = /^(@[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+)\s+\/spawn\s+(claude|codex)\s+([A-Za-z0-9_.-]+)(?:\s+|$)/.exec(command);
  if (!head) return null;
  let tail = command.slice(head[0].length);
  let dir: string | null = null;
  const quoted = /^cwd="((?:\\.|[^"\\])*)"(?=$|[\s，。、；：！？])([\s\S]*)$/.exec(tail);
  if (quoted) {
    dir = quoted[1].replace(/\\(["\\])/g, "$1");
    tail = quoted[2].replace(/^[\s，。、；：！？]*/, "");
  } else {
    const bare = /^([/~～][^\s，。、；：！？]*)[\s，。、；：！？]*([\s\S]*)$/.exec(tail);
    if (bare) {
      dir = bare[1].replace(/^～/, "~");
      tail = bare[2];
    }
  }
  if (dir !== null && (!/^[\/~]/.test(dir) || /[\r\n\t]/.test(dir))) return null;
  const options: string[] = [];
  for (let option; (option = /^(model|effort|handoff)=(\S*)(?:\s+|$)([\s\S]*)$/.exec(tail));) {
    if (option[1] === "handoff") { if (option[2] !== "skip") return null; }
    else {
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(option[2])) return null;
      options.push(`${option[1]}=${option[2]}`);
    }
    tail = option[3];
  }
  const dirArg = dir === null ? null : /[\s"，。、；：！？]/.test(dir) ? `cwd="${dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : dir;
  return { host: head[1].slice(1), line: `${head[1]} /spawn ${head[2]} ${head[3]}${dirArg ? ` ${dirArg}` : ""}${options.length ? ` ${options.join(" ")}` : ""} ${text}` };
}

export function scheduleRuleText(rule: Rule, zone = true): string {
  switch (rule.kind) {
    case "once": return `once ${new Date(rule.at).toISOString()}`;
    case "daily": return `${rule.step ? `every ${rule.step} days` : "every day"} ${rule.time}${zone ? ` (${rule.tz})` : ""}`;
    case "weekly": return `every ${rule.step ? `${rule.step} weeks ` : ""}${rule.days.join(",")} ${rule.time}${zone ? ` (${rule.tz})` : ""}`;
    case "every": return `every ${rule.minutes} minutes`;
  }
}
