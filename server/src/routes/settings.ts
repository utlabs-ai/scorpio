import { json, readBody } from "../util";
import { DAV_ROOT } from "../caldav";
import { origin, providersOf, startOAuth, type User } from "../auth";
import { autoCallBackOf, setAutoCallBack, calendarTokenOf, displayNameOf, handoffLocalOf, resetCalendarToken, setDisplayName, setHandoffLocal, spawnPermOf, setSpawnPerm } from "../accounts";
import { configSpawn } from "../spawn-config";
import { computersOf } from "../device";
import { loggedOutDevices } from "../device-logout";
import { spaceNow } from "../space";
import { settingsPage, type InviteView } from "../settings-page";
import {
  entitlementRow,
  paidThrough,
} from "../billing-state";
import { hosted, limitsFor, planOf } from "../plans";
import { driveConfigured, driveDisconnect, driveState } from "../drive";
import { inviteView } from "../invite";
import { listedRoomIds, memberRoomNames, ownedRoomStatuses } from "../room-index";
import { redirect, type Route, type SignedRouteContext } from "./shared";

/**
 * The person's Drive: GET /settings/drive → its state; POST connect (to Google's consent page, back
 * through the sign-in callback), disconnect. Copies happen only right before an eviction (space.ts). The forms on
 * /settings get the page back; scripts asking for JSON get JSON.
 */
// ---------- copies to Drive before files are cleared ----------
export async function driveRoutes(
  req: Request,
  env: Env,
  path: string,
  user: User,
): Promise<Response> {
  const page = !(req.headers.get("accept") || "").includes("application/json");
  const back = (done: string) => redirect(`/settings?drive=${done}#drive`);
  if (!driveConfigured(env))
    return page
      ? back("off")
      : json(
          {
            error: "not_configured",
            next: "Drive backup is not set up on this server.",
          },
          404,
        );
  if (path === "/settings/drive" && req.method === "GET")
    return json(await driveState(env, user.id));
  if (req.method === "POST" && path === "/settings/drive/connect") {
    return startOAuth(req, env, "google", {
      userId: user.id,
      next: "/settings?drive=connected#drive",
    });
  }
  if (req.method === "POST" && path === "/settings/drive/disconnect") {
    await driveDisconnect(env, user.id);
    return page ? back("disconnected") : json({ connected: false });
  }
  return json(
    { error: "bad_request", next: `Unknown endpoint ${req.method} ${path}.` },
    404,
  );
}

/**
 * The calendar subscription (docs/api/schedules.md, Into a calendar): the address `<public origin>/cal/<token>.ics` and the
 * three items of the CalDAV account, which the page shows as they are: the server is `<public origin>/dav/` (a calendar that
 * asks there directly, without /.well-known/caldav, lands on the account and not on the homepage), the handle as the account,
 * the token as the password.
 */
const calendarAnswer = (c: SignedRouteContext, token: string) => {
  const site = origin(c.req, c.env);
  return { url: `${site}/cal/${token}.ics`, caldav: { server: `${site}${DAV_ROOT}`, account: c.user.handle, password: token } };
};

export const signedRoutes: Route<SignedRouteContext>[] = [
  // Settings → Notifications → Calendar subscription: the address and the CalDAV account, made on the first call (the row opened), and their reset.
  {
    method: "POST",
    match: "/settings/calendar",
    handler: async (c) => json(calendarAnswer(c, await calendarTokenOf(c.env, c.user.id))),
  },
  {
    method: "POST",
    match: "/settings/calendar/reset",
    handler: async (c) => json(calendarAnswer(c, await resetCalendarToken(c.env, c.user.id))),
  },
  {
    method: "POST",
    match: "/settings/spawn-perm",
    handler: async (c) => json({ perm: await setSpawnPerm(c.env, c.user.id, (await readBody(c.req)).perm) }),
  },
  // Settings: the existing Drive backup alongside account, notification, appearance and device controls.
  {
    method: "GET",
    match: "/settings",
    handler: async (c) => {
      const { env, url, lang } = c;
      const user = c.user;

      const plan = await planOf(env, user.id);
      const hostedPlans = hosted(env);
      const [
        displayName,
        computers,
        providers,
        limits,
        space,
        ownedRooms,
        visibleRooms,
        entitlement,
        freeLimits,
        proLimits,
        autoCallBack,
        handoffLocal,
        loggedOut,
        spawnPerm,
        spawnConfig,
      ] = await Promise.all([
        displayNameOf(env, user.id),
        // One row per computer running agents, its newest token's id for 撤销.
        computersOf(env, user.id),
        providersOf(env, user.id),
        limitsFor(env, plan),
        spaceNow(env, user.id),
        ownedRoomStatuses(env, user.id),
        memberRoomNames(env, user.id),
        entitlementRow(env, user.id),
        limitsFor(env, "free"),
        limitsFor(env, "pro"),
        autoCallBackOf(env, user.id),
        handoffLocalOf(env, user.id),
        loggedOutDevices(env, user.id, Date.now()),
        spawnPermOf(env, user.id),
        configSpawn(env),
      ]);
      const countedRooms =
        plan === "free"
          ? ownedRooms.filter((r) => r.status === "active")
          : ownedRooms;
      const [roomUsage, roomMembers] = await Promise.all([
        Promise.allSettled(
          countedRooms.map((r) =>
            env.ROOMS.getByName(r.id).summary(user.handle),
          ),
        ),
        Promise.allSettled(
          visibleRooms.map((r) =>
            env.ROOMS.getByName(r.id).members({
              kind: "human",
              account: user.handle,
              name: user.handle,
            }),
          ),
        ),
      ]);
      const messagesToday = roomUsage.every(
        (result) => result.status === "fulfilled" && "ok" in result.value,
      )
        ? roomUsage.reduce(
            (sum, result) =>
              sum +
              (result.status === "fulfilled" && "ok" in result.value
                ? result.value.ok.todayMessages
                : 0),
            0,
          )
        : null;
      const seats = new Map<
        string,
        {
          online: boolean;
          idleHandoffMinutes: number | null;
          lastActive: number | null;
        }
      >();
      roomMembers.forEach((result) => {
        if (result.status !== "fulfilled" || !("ok" in result.value)) return;
        result.value.ok.members
          .filter(
            (m) =>
              m.kind === "host" &&
              m.owner === user.handle &&
              m.status === "active",
          )
          .forEach((seat) => {
            const previous = seats.get(seat.name);
            if (
              !previous ||
              (seat.online && !previous.online) ||
              (seat.online === previous.online &&
                (seat.lastActive ?? 0) > (previous.lastActive ?? 0))
            )
              seats.set(seat.name, seat);
          });
      });
      return settingsPage(lang, user, {
        drive: driveConfigured(env) ? await driveState(env, user.id) : null,
        done: url.searchParams.get("drive") || "",
        displayName,
        devices: computers
          .filter((c) => c.newestToken)
          .map((c) => {
            const seat = c.seat ? seats.get(`${c.seat}@${user.handle}`) : null;
            return {
              id: c.newestToken!,
              name: c.name,
              hostname: c.hostname,
              note: c.note,
              device_name: c.hostname,
              created_at: c.createdAt,
              last_used_at: c.lastUsed,
              revoked_at: null,
              online: seat?.online ?? null,
              idleHandoffMinutes: seat?.idleHandoffMinutes ?? null,
              clis: c.clis,
              loggedOut: c.deviceIds.map((id) => loggedOut.get(id)).find(Boolean) ?? null,
            };
          }),
        // n of the plan's limit; Free's and Pro's for the Devices lead (null on someone's own deployment: no numbers)
        computers: {
          n: computers.length,
          limit: limits.devices,
          free: hostedPlans ? freeLimits.devices : null,
          pro: hostedPlans ? proLimits.devices : null,
        },
        providers,
        plan,
        trialUntil:
          plan === "pro" &&
          entitlement?.provider === "trial" &&
          entitlement.status === "active"
            ? entitlement.period_end
            : null,
        paid: plan === "pro" ? paidThrough(entitlement) : null,
        limits,
        space,
        activeRooms: ownedRooms.filter((r) => r.status === "active")
          .length,
        messagesToday,
        visibleRooms,
        invite: hostedPlans
          ? ((await inviteView(
              env,
              user,
              (env.PUBLIC_URL || url.origin).replace(/\/$/, ""),
            ).catch(() => null)) as InviteView | null)
          : null,
        autoCallBack,
        handoffLocal,
        spawnPerm,
        permOptions: spawnConfig.perm,
      });
    },
  },
  {
    method: "*",
    match: /^\/settings\/drive/,
    handler: async (c) => {
      const { req, env, path } = c;
      const user = c.user;

      return driveRoutes(req, env, path, user);
    },
  },
  // The person's display name: one per account, every room they are in shows it at once. Settings → 账号 calls it.
  {
    method: "POST",
    match: "/settings/name",
    handler: async (c) => {
      const { req, env, ctx } = c;
      const user = c.user;

      const shown = await setDisplayName(
        env,
        user,
        (await readBody(req)).displayName,
      );
      const results = await listedRoomIds(env, user.id);
      ctx.waitUntil(
        Promise.allSettled(
          results.map((x) =>
            env.ROOMS.getByName(x.id).setDisplayName(user.handle, shown),
          ),
        ),
      );
      return json({ displayName: shown ?? user.handle });
    },
  },
  {
    method: "POST",
    match: "/settings/call-back",
    handler: async (c) => {
      const b = await readBody(c.req);
      const on = b.on === true || b.on === "true";
      await setAutoCallBack(c.env, c.user.id, on);
      return json({ on });
    },
  },
  // 「交接只存在 agent 的电脑上」 (Settings → 账号): only the person changes it; only storing is affected.
  {
    method: "POST",
    match: "/settings/handoff",
    handler: async (c) => {
      const { req, env } = c;
      const user = c.user;

      const b = await readBody(req);
      const local = b.local === true || b.local === "true";
      await setHandoffLocal(env, user.id, local);
      return json({ local });
    },
  },
];
