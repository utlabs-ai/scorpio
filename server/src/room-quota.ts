// Decisions for RoomDO message quotas. Limits and fallback values are supplied by the caller.
export function minuteLimit(minute: { n: number; first: number | null }, limit: number, nowMs: number): { wait: number } | null {
  if (minute.n < limit) return null;
  return { wait: Math.max(1, Math.ceil(((minute.first ?? nowMs) + 60_000 - nowMs) / 1000)) };
}

export function dayLimitHit(today: number, limit: number | null): boolean {
  return limit != null && today >= limit;
}

export function accountCapped(cappedDay: string | null | undefined, day: string, limit: number | null): boolean {
  return limit != null && cappedDay === day;
}

export function countsNow(n: number, countEvery: number): boolean {
  return n % countEvery === 0;
}

export function quotaFrame(n: number, before: number, limit: number | null, end: number): {
  quota: { used: number; limit: number; resetsAt: number } | undefined;
  warnOwner: boolean;
} {
  if (limit == null || n < limit * 0.8) return { quota: undefined, warnOwner: false };
  return { quota: { used: n, limit, resetsAt: end }, warnOwner: before < limit * 0.8 };
}

export function usageDelta(reported: { day: string; n: number } | null | undefined, day: string, n: number): number {
  return n - (reported?.day === day ? reported.n : 0);
}

export function dbAlertDue(size: number, threshold: number, alertedDay: string | null | undefined, day: string): boolean {
  return size > threshold && alertedDay !== day;
}

export function opsThreshold(cfg: { roomDbAlertBytes?: number } | null, fallback: number): number {
  const v = Number(cfg?.roomDbAlertBytes);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
