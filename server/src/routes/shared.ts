import { RoomDO, type Actor } from "../room-do";
import { ApiError, cookie, parseCookies } from "../util";
import { type User } from "../auth";
import { type Lang } from "../layout";
import { strings } from "../strings";
import { INVITE_COOKIE_DAYS, inviteOf, normalizeInviteCode } from "../invite";

export const ROLE_RE = /^[A-Za-z0-9_.-]{1,62}$/;

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * A topic's link with an invite code (/r/<id>?i=<code>; no longer made, old ones still about) opened
 * while signed out: a code that can be used now is remembered for the sign-up that may follow, on this response only (a
 * public topic's snapshot stays as it is cached). A used code, or one whose inviter has no invites left this month: not.
 */
export async function withInviteCookie(
  req: Request,
  env: Env,
  url: URL,
  res: Response,
): Promise<Response> {
  if (
    req.method !== "GET" ||
    !url.pathname.startsWith("/r/") ||
    !url.searchParams.get("i") ||
    parseCookies(req).sid
  )
    return res;
  const code = normalizeInviteCode(url.searchParams.get("i"));
  if (!code || (await inviteOf(env, code).catch(() => null))?.state !== "ok")
    return res;
  const out = new Response(res.body, res);
  out.headers.append(
    "Set-Cookie",
    cookie("inv", code, INVITE_COOKIE_DAYS * 86400, url.protocol === "https:"),
  );
  out.headers.set("Cache-Control", "private, no-store"); // a public topic's snapshot is cacheable; one with a cookie is not
  return out;
}

/** The invite cookie, cleared once a sign-in has used it (a new account took its code, or an old one ignored it). */
export const clearInvite = (req: Request, url: URL): string[] =>
  parseCookies(req).inv
    ? [cookie("inv", "", 0, url.protocol === "https:")]
    : [];

/** The CLI before v0.8 still has plan and pins; those answer this. */
export function upgradeRequired(): never {
  throw new ApiError(
    "upgrade_required",
    "This scorpio CLI is older than the server: plan and pins are gone (now todo). The daemon on this computer updates the package within the hour; to update now, rerun the install command from your invitation.",
    426,
  );
}

/**
 * The oldest CLI the server still talks to, by the X-Scorpio-Cli header (sent from 0.3.2 on).
 * A CLI that sends no header is older than that; it is stopped only at the endpoints it has lost.
 */
export const MIN_CLI_VERSION = "0.4.0"; // todo instead of plan, no pins. The default: KV config:min_cli changes it.

let minCliCache: { v: string; at: number } | null = null;

/** The oldest CLI version served: KV config:min_cli ("x.y.z", either way), else MIN_CLI_VERSION; read once a minute per isolate. */
export async function minCli(env: Env): Promise<string> {
  if (minCliCache && Date.now() - minCliCache.at < 60_000) return minCliCache.v;
  const v = await env.KV.get("config:min_cli", { cacheTtl: 60 }).catch(
    () => null,
  );
  minCliCache = {
    v: v && /^\d+\.\d+\.\d+$/.test(v.trim()) ? v.trim() : MIN_CLI_VERSION,
    at: Date.now(),
  };
  return minCliCache.v;
}

export function cliTooOld(req: Request, min: string): boolean {
  const v = req.headers.get("x-scorpio-cli");
  if (!v) return false;
  const parts = (x: string) =>
    x
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number(n) || 0);
  const [a, b] = [parts(v), parts(min)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** A page's script asking for JSON (fetch with a JSON body or Accept), not a form that wants a page back. */
export const wantsJsonBody = (req: Request) =>
  /application\/json/.test(req.headers.get("content-type") || "") ||
  /application\/json/.test(req.headers.get("accept") || "");

export const redirect = (location: string, setCookie?: string | string[]) => {
  const h = new Headers({ location });
  for (const c of [setCookie || []].flat()) h.append("set-cookie", c);
  return new Response(null, { status: 303, headers: h });
};

/**
 * Forward a WebSocket upgrade to the room with the authenticated caller attached, and the agent token's id when it
 * came with one (the room closes that token's connections when it stops working).
 */
export function internalUpgrade(req: Request, actor: Actor, tokenId?: string): Request {
  const headers = new Headers({
    upgrade: "websocket",
    "x-scorpio-actor": JSON.stringify(actor),
  });
  if (tokenId) headers.set("x-scorpio-token-id", tokenId);
  for (const h of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
  ]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Request("https://room/ws", { headers });
}

export type RoomStub = DurableObjectStub<RoomDO>;
export type RouteBaseContext = {
  req: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  path: string;
  isPost: boolean;
};
export type RouteContext = RouteBaseContext & {
  lang: Lang;
  t: ReturnType<typeof strings>;
  user: User | null;
};
export type SignedRouteContext = RouteContext & { user: User };
export type Route<C extends RouteBaseContext = RouteContext> = {
  method: "GET" | "POST" | "PUT" | "*" | ("GET" | "POST")[];
  match: string | RegExp;
  handler: (c: C, m: RegExpMatchArray | null) => Promise<Response | null>;
  errors?: "json" | "negotiate";
};
export async function runRoutes<C extends RouteBaseContext>(
  c: C,
  routes: Route<C>[],
): Promise<Response | null> {
  for (const r of routes) {
    if (
      r.method !== "*" &&
      !(Array.isArray(r.method)
        ? r.method.includes(c.req.method as "GET" | "POST")
        : r.method === c.req.method)
    )
      continue;
    const m =
      typeof r.match === "string"
        ? r.match === c.path
          ? ([] as unknown as RegExpMatchArray)
          : null
        : c.path.match(r.match);
    if (m === null) continue;
    const out = await r.handler(c, m);
    if (out !== null) return out;
  }
  return null;
}
