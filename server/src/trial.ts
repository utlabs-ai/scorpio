/** Trial grants are hosted-service entitlements, controlled without a deployment by config:trial. */
export const TRIAL_DAY_MS = 86400_000;
export const DEFAULT_TRIAL = { enabled: true, days: 7 } as const;

export function trialPolicy(raw: unknown): { enabled: boolean; days: number } {
  if (raw == null) return { ...DEFAULT_TRIAL };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("config:trial must be an object");
  const c = raw as { enabled?: unknown; days?: unknown };
  const enabled = c.enabled === undefined ? true : c.enabled;
  const days = c.days === undefined ? 7 : c.days;
  if (typeof enabled !== "boolean" || typeof days !== "number" || !Number.isSafeInteger(days) || days < 1) {
    throw new Error("config:trial requires enabled:boolean and positive integer days");
  }
  return { enabled, days };
}

export async function trialForSignup(env: Env): Promise<{ enabled: boolean; days: number; invalid: boolean }> {
  try {
    return { ...trialPolicy(await env.KV.get("config:trial", { type: "json" })), invalid: false };
  } catch {
    // A bad or unavailable KV value must not block account creation or silently grant paid access.
    return { enabled: false, days: DEFAULT_TRIAL.days, invalid: true };
  }
}
