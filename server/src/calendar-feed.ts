// GET /cal/<token>.ics: the person's calendar feed (docs/api/schedules.md, Into a calendar), without a session. The
// token names the account (D1 calendar_tokens, read on every request, so a reset is immediate); the feed itself is
// built from the person's current topics and cached for 5 minutes per account, so however often calendar programs
// fetch it, the topics are asked at most once in those 5 minutes. The CalDAV account (caldav.ts) reads the same topics.

import { userByCalendarToken } from "./accounts";
import { MY_TOPICS_SQL } from "./app-topics-sql";
import { origin } from "./auth";
import { calendarText, type CalendarTopic } from "./calendar";

export const CACHE_MS = 300_000;
/** What follows `/cal/`: the token and `.ics`; anything else under /cal/ is 404 like an unknown token. */
const FEED_RE = /^([A-Za-z0-9_-]{32})\.ics$/;

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

type TopicRow = { id: string; name: string; owned: number; active: number | null; archived_at: number | null };

/** The topics the person has not left (an archived topic's schedules are off, so it is skipped), each asked for its items; a topic that fails is skipped and logged. */
export async function calendarTopics(env: Env, user: { id: string; handle: string }): Promise<CalendarTopic[]> {
  const { results } = await env.DB.prepare(MY_TOPICS_SQL).bind(user.id).all<TopicRow>();
  const rows = results.filter((r) => (r.owned || r.active === 1) && r.archived_at == null);
  const topics = await Promise.all(rows.map(async (r) => {
    try {
      const out = await env.ROOMS.getByName(r.id).calendarItems(user.handle);
      return "ok" in out && out.ok.items.length ? out.ok : null;
    } catch (e) {
      console.error(JSON.stringify({ msg: "calendar items failed", roomId: r.id, error: String(e) }));
      return null;
    }
  }));
  return topics.filter((t): t is CalendarTopic => t !== null);
}

export async function calendarFeed(req: Request, env: Env, ctx: ExecutionContext, rest: string): Promise<Response> {
  const token = FEED_RE.exec(rest)?.[1];
  if (!token) return notFound();
  const user = await userByCalendarToken(env, token);
  if (!user) return notFound();
  return feedOf(req, env, ctx, user);
}

/** The account's feed, from the 5-minute copy when there is one (also what a GET of the CalDAV calendar answers). */
export async function feedOf(req: Request, env: Env, ctx: ExecutionContext, user: { id: string; handle: string }): Promise<Response> {
  const headers = { "content-type": "text/calendar; charset=utf-8", "cache-control": `private, max-age=${CACHE_MS / 1000}`, "content-disposition": 'inline; filename="scorpio.ics"' };
  // The Cache API keys on a URL: an internal one per account, never the request's (the token must not be a cache key,
  // and a reset must not find the old copy). The stored copy carries a public max-age, which the Cache API needs; the
  // answer to the calendar program says private.
  const key = new Request(`https://cal-cache.invalid/${user.id}`);
  const cache = (globalThis as { caches?: CacheStorage }).caches?.default;
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) return new Response(hit.body, { status: 200, headers });
  const site = origin(req, env);
  const text = calendarText(await calendarTopics(env, user), { now: Date.now(), origin: site, host: new URL(site).hostname });
  if (cache) ctx.waitUntil(cache.put(key, new Response(text, { headers: { "content-type": headers["content-type"], "cache-control": `max-age=${CACHE_MS / 1000}` } })).catch(() => undefined));
  return new Response(text, { status: 200, headers });
}
