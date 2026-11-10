import { calendarFeed } from "../calendar-feed";
import { caldav, wellKnown } from "../caldav";
import type { Route } from "./shared";

/**
 * The calendar subscription (docs/api/schedules.md, Into a calendar): the address and the read-only CalDAV account, both
 * without a session (the token is the password); a HEAD is a GET without the body (index.ts). CalDAV's methods (PROPFIND,
 * REPORT, OPTIONS, and the writes it refuses) are not in Route.method: the route takes every method and caldav() sorts them.
 */
export const publicRoutes: Route[] = [
  { method: "GET", match: /^\/cal\/(.*)$/, handler: async ({ req, env, ctx }, match) => calendarFeed(req, env, ctx, match![1]) },
  { method: "*", match: "/.well-known/caldav", handler: async () => wellKnown() },
  { method: "*", match: /^\/dav(?:\/.*)?$/, handler: async ({ req, env, ctx, path }) => caldav(req, env, ctx, path) },
];
