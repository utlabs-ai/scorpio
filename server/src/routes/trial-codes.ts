import { json, readBody } from "../util";
import { inviteView } from "../invite";
import { redeem } from "../trial-codes";
import { localNext } from "../safe-next";
import { hosted } from "../plans";
import type { Route, SignedRouteContext } from "./shared";

// Trial codes are Pro days: a deployment without plans (PLANS) has no such routes (null falls through to 404).

export const publicRoutes: Route[] = [{
  method: "GET", match: /^\/trial\/([^/]*)$/,
  handler: async ({ env, user, url }, match) => {
    if (!hosted(env)) return null;
    let code = match![1];
    try { code = decodeURIComponent(code); } catch { /* malformed encoding is an unknown code too */ }
    code = code.trim().toUpperCase();
    const next = localNext(`/settings?trial=${encodeURIComponent(code)}#trial-code`, url.origin);
    return new Response(null, { status: 302, headers: { location: user ? next : `/login?next=${encodeURIComponent(next)}`, "cache-control": "private, no-store" } });
  },
}];
export const signedRoutes: Route<SignedRouteContext>[] = [{
  method: "POST", match: "/settings/trial-code",
  handler: async ({ req, env, user, url, lang }) => {
    if (!hosted(env)) return null;
    if (!(await env.DEVICE_CODE_LIMIT.limit({ key: `trial-code:${user.id}` })).success)
      return json({ error: "rate_limited", next: lang === "zh" ? "尝试太多，请一分钟后再试。" : "Too many attempts; try again in a minute." }, 429, { "retry-after": "60" });
    const result = await redeem(env, user.id, (await readBody(req)).code);
    if (typeof result !== "string") return json({ ...result, invite: await inviteView(env, user, (env.PUBLIC_URL || url.origin).replace(/\/$/, "")) });
    const next = {
      unknown: ["没有这个体验码，和发你码的人核对一下。", "There is no such trial code; check it with whoever gave it to you."],
      used: ["这个体验码已经用过了。", "This trial code has already been used."],
      batch_used: ["同一批体验码一个账号只能用一个。", "One trial code per account from the same batch."],
    }[result][lang === "zh" ? 0 : 1];
    return json({ error: `trial_${result}`, next }, 400);
  },
}];
