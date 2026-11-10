/**
 * The keys /keys can press, and how long the daemon waits before it reads the screen back: KV
 * config:keys, else these defaults. The web's composer and the daemon both read it from GET /api/v1/config/keys, so
 * a key is added by changing KV, without a release. Each terminal adapter reads its own column (herdr).
 */
export type KeysConfig = { keys: { name: string; label: string; herdr?: string }[]; settleMs: number };

export const DEFAULT_KEYS: KeysConfig = {
  keys: [
    { name: "up", label: "↑", herdr: "up" },
    { name: "down", label: "↓", herdr: "down" },
    { name: "enter", label: "Enter", herdr: "enter" },
    { name: "esc", label: "Esc", herdr: "esc" },
  ],
  settleMs: 3000,
};

/** KV's value when it has the basic shape (keys an array of {name, label}, settleMs a positive number), else the defaults. */
export function keysOf(raw: unknown): KeysConfig {
  const c = raw as KeysConfig | null;
  const ok = !!c && Array.isArray(c.keys) && c.keys.every((k) => !!k && typeof k.name === "string" && typeof k.label === "string") &&
    typeof c.settleMs === "number" && c.settleMs > 0;
  return ok ? c : DEFAULT_KEYS;
}

let cache: { v: KeysConfig; at: number } | null = null;
/** Read once a minute per isolate, like minCli. */
export async function configKeys(env: { KV: KVNamespace }): Promise<KeysConfig> {
  if (cache && Date.now() - cache.at < 60_000) return cache.v;
  const raw = await env.KV.get("config:keys", { type: "json", cacheTtl: 60 }).catch(() => null);
  cache = { v: keysOf(raw), at: Date.now() };
  return cache.v;
}
