import { json, readBody, str } from "../util";
import {
  decide,
  deviceCode,
  deviceToken,
  findPending,
  renameDevice,
  revokeComputer,
} from "../device";
import { activatePage } from "../activate-page";
import { activeRoomIdsOf } from "../room-index";
import {
  redirect,
  type Route,
  type RouteBaseContext,
  type SignedRouteContext,
} from "./shared";

export const activationRoutes: Route<SignedRouteContext>[] = [
  // --- device authorization: the person's side ---
  {
    method: "*",
    match: "/activate",
    handler: async (c) => {
      const { req, env, url, lang, isPost } = c;
      const user = c.user;

      if (isPost) {
        const b = await readBody(req);
        const ok = await decide(
          env,
          str(b.user_code, 20),
          user.id,
          str(b.decision) === "approve",
        );
        // At the computer cap: not approved, the code stays pending; the page says how many and which.
        if (typeof ok === "object") return activatePage(lang, user, ok);
        return activatePage(lang, user, {
          state: ok
            ? str(b.decision) === "approve"
              ? "approved"
              : "denied"
            : "invalid",
        });
      }
      const code = url.searchParams.get("code");
      if (!code) return activatePage(lang, user, { state: "form" });
      const p = await findPending(env, code, user.id);
      return activatePage(
        lang,
        user,
        p
          ? {
              state: "confirm",
              code: p.code,
              device: p.device,
              createdAt: p.createdAt,
              relogin: p.relogin,
            }
          : { state: "invalid" },
      );
    },
  },
];

export const signedRoutes: Route<SignedRouteContext>[] = [
  // The computers live in settings: the old page's address still works.
  {
    method: "GET",
    match: "/devices",
    handler: async (c) => {
      return redirect("/settings#devices");
    },
  },
  {
    method: "POST",
    match: /^\/devices\/([A-Za-z0-9_-]+)\/name$/,
    handler: async (c, m) => {
      const { req, env, ctx } = c;
      const user = c.user;
      const naming = m!;
      const { device, changed, oldSeat } = await renameDevice(
        env,
        user.id,
        naming[1],
        await readBody(req),
      );
      if (changed) {
        const results = await activeRoomIdsOf(env, user.id);
        ctx.waitUntil(
          Promise.allSettled(
            results.map((r) =>
              env.ROOMS.getByName(r.id).deviceChanged(
                user.handle,
                device.deviceId,
                device.seat,
                oldSeat,
                {
                  name: device.name,
                  hostname: device.hostname,
                  note: device.note,
                },
              ),
            ),
          ),
        );
      }
      return (req.headers.get("content-type") || "").includes(
        "application/json",
      )
        ? json({
            id: naming[1],
            name: device.name,
            machine: device.machine,
            hostname: device.hostname,
            note: device.note,
            seat: device.seat ? `${device.seat}@${user.handle}` : null,
          })
        : redirect("/settings#devices");
    },
  },
  {
    method: "POST",
    match: /^\/devices\/([A-Za-z0-9_-]+)\/revoke$/,
    handler: async (c, m) => {
      const { env, ctx } = c;
      const user = c.user;
      const revoke = m!;
      // The whole computer goes: every live token of it, not only the row's.
      await revokeComputer(env, ctx, user.id, revoke[1]);
      return redirect("/settings#devices");
    },
  },
];

export const stageOneRoutes: Route<RouteBaseContext>[] = [
  {
    method: "POST",
    match: "/oauth/device/code",
    errors: "json",
    handler: async ({ req, env, ctx }) => deviceCode(req, env, ctx),
  },
  {
    method: "POST",
    match: "/oauth/token",
    errors: "json",
    handler: async ({ req, env, ctx }) => deviceToken(req, env, ctx),
  },
];
