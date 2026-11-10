import { ApiError, json, readBody, str } from "../util";
import { type User } from "../auth";
import { notifyPerson, vapidPublicKey } from "../push";
import {
  isAllowedPushEndpoint,
  readPushPreferences,
  removePushSubscription,
  reservePushTest,
  savePushSubscription,
  writePushPreferences,
} from "../push-preferences";
import { type Route, type SignedRouteContext } from "./shared";
import { roomStub } from "../room-stub";

/** The person's own push endpoints: subscribe this browser, drop it, send a test, and check notifications for staleness. */
export async function pushRoutes(
  req: Request,
  env: Env,
  path: string,
  user: User,
): Promise<Response> {
  if (path === "/push/key" && req.method === "GET")
    return json({ publicKey: vapidPublicKey(env) });
  if (req.method !== "POST")
    throw new ApiError(
      "bad_request",
      `Unknown endpoint ${req.method} ${path}.`,
      404,
    );
  const b = await readBody(req);
  if (path === "/push/preferences/read")
    return json(await readPushPreferences(env, user.id, b.endpoint));
  if (path === "/push/preferences/write")
    return json(await writePushPreferences(env, user.id, b));
  if (path === "/push/subscribe") {
    const endpoint = str(b.endpoint, 1000);
    const keys = (b.keys || {}) as Record<string, unknown>;
    const p256dh = str(keys.p256dh, 200);
    const auth = str(keys.auth, 100);
    if (!isAllowedPushEndpoint(endpoint) || !p256dh || !auth)
      throw new ApiError(
        "bad_request",
        "Only subscriptions from a known push service (FCM, Mozilla, Apple or Windows), with their keys, are accepted.",
      );
    await savePushSubscription(env, user.id, endpoint, p256dh, auth);
    return json({ ok: true });
  }
  if (path === "/push/unsubscribe") {
    await removePushSubscription(env, str(b.endpoint, 1000), user.id);
    return json({ ok: true });
  }
  if (path === "/push/test") {
    await reservePushTest(env, user.id);
    const sent = await notifyPerson(env, user.handle, {
      type: "test",
      tag: "test",
      url: "/",
    });
    return json({ sent });
  }
  if (path === "/push/resolved") {
    // Tags of notifications still showing — todo:<room>:<T3> and blocked:<room>:<agent> — that are no longer
    // true: the item is not open and mine any more, the agent of mine is not stuck any more (to close them).
    const tags = (Array.isArray(b.tags) ? b.tags.map(String) : []).slice(
      0,
      100,
    );
    const byRoom = new Map<string, { items: string[]; agents: string[] }>();
    for (const t of tags) {
      const m = /^(todo|blocked):([A-Za-z0-9_-]{22}):(.+)$/.exec(t);
      if (!m) continue;
      const r = byRoom.get(m[2]) || { items: [], agents: [] };
      if (m[1] === "todo" && /^T\d+$/.test(m[3])) r.items.push(m[3]);
      if (m[1] === "blocked") r.agents.push(m[3]);
      byRoom.set(m[2], r);
    }
    const still = new Set<string>();
    for (const [roomId, { items, agents }] of byRoom) {
      const stub = await roomStub(env, roomId).catch(() => null);
      if (!stub) continue;
      if (items.length)
        for (const id of await stub
          .openForMe(user.handle, items)
          .catch(() => [] as string[]))
          still.add(`todo:${roomId}:${id}`);
      if (agents.length)
        for (const n of await stub
          .blockedOf(user.handle, agents)
          .catch(() => [] as string[]))
          still.add(`blocked:${roomId}:${n}`);
    }
    return json({
      stale: tags.filter((t) => /^(todo|blocked):/.test(t) && !still.has(t)),
    });
  }
  throw new ApiError("bad_request", `Unknown endpoint POST ${path}.`, 404);
}

export const signedRoutes: Route<SignedRouteContext>[] = [
  // --- Web Push: this browser's subscription, a test, and which notifications are stale ---
  {
    method: "*",
    match: /^\/push\//,
    handler: async (c) => {
      const { req, env, path } = c;
      const user = c.user;

      return pushRoutes(req, env, path, user);
    },
  },
];
