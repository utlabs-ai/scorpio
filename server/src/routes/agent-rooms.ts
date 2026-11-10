import { type Actor } from "../room-do";
import * as actions from "../room-actions";
import {
  unwrap,
  filesOf,
  nonceOf,
  TOPIC_MAX,
  ROLE_CARD_MAX,
} from "../room-actions";
import { ApiError, json, multiline, readBody, str } from "../util";
import { activeRoomIdsOf, activeRoomCount, createAnswer, inRoom, keepCreateAnswer, ownerRoomList, suggestCode } from "../room-index";
import { agentFromRequest } from "../auth";
import { langOf } from "../layout";
import { selfcheck } from "../selfcheck";
import { deviceForHost, deviceIdOf, knownSeat, handoffComputer } from "../device";

import { limitsFor, planOf } from "../plans";
import { configKeys } from "../config-keys";
import { spawnPermOf } from "../accounts";
import { configSpawn } from "../spawn-config";
import { cleanCut } from "../text";
import { laneOf } from "../lane";

import { recordMachine, rewardOnJoin } from "../invite";
import {
  ROLE_RE,
  ROOM_ID_RE,
  upgradeRequired,
  minCli,
  cliTooOld,
  internalUpgrade,
  runRoutes,
  type Route,
  type RouteBaseContext,
  type RoomStub,
} from "./shared";
import { roomStub, createRoom } from "../room-stub";
import { upload, withSpace, fileResponseFor } from "./files";
import { putAgentHandoff, getAgentHandoff } from "./handoffs";
import { scheduleList, scheduleOp } from "./schedules";
import { exportRoute } from "./export";

type OwnerContext = RouteBaseContext & {
  auth: Awaited<ReturnType<typeof agentFromRequest>>;
};
type JoinContext = OwnerContext & {
  roomId: string;
  action: string;
  seqStr?: string;
  stub: RoomStub;
};
type SubContext = JoinContext & { actor: Actor; q: URLSearchParams };
type PostContext = SubContext & { b: Awaited<ReturnType<typeof readBody>> };

export const preAuthRoutes: Route<RouteBaseContext>[] = [
  {
    method: "GET",
    match: "/config/spawn",
    handler: async ({ env }) => json(await configSpawn(env)),
  },
  // The keys /keys can press, for the web's composer and the daemon: no sign-in.
  {
    method: "GET",
    match: "/config/keys",
    handler: async (c) => {
      const { env } = c;
      return json(await configKeys(env));
    },
  },
];
export const ownerRoutes: Route<OwnerContext>[] = [
  {
    method: "GET",
    match: "/account/spawn-perm",
    handler: async ({ env, auth }) => json({ perm: await spawnPermOf(env, auth.user.id) }),
  },
  {
    method: "GET",
    match: "/whoami",
    handler: async (c) => {
      const { env, auth } = c;
      return json({
        account: auth.user.handle,
        email: auth.user.email,
        device: auth.device,
        tokenExpiresAt: auth.expiresAt,
        plan: await planOf(env, auth.user.id),
        displayName: auth.displayName ?? auth.user.handle,
      });
    },
  },
  {
    method: "GET",
    match: "/rooms",
    handler: async (c) => {
      const { env, auth } = c;
      // The account's own rooms (the daemon joins them on its own).
      const results = await ownerRoomList(env, auth.user.id);
      const plan = await planOf(env, auth.user.id);
      const freeLimit =
        plan === "free" ? (await limitsFor(env, plan)).activeRooms : null;
      const activeCount =
        freeLimit == null
          ? 0
          : await activeRoomCount(env, auth.user.id);
      // Where each room is on the retention clock: since when archived, and why when not its owner's doing; since when in the bin.
      return json({
        freeActiveLimitReached: freeLimit != null && activeCount >= freeLimit,
        rooms: results.map((r) => ({
          roomId: r.id,
          name: r.name,
          topic: r.topic,
          status: r.status,
          createdAt: r.created_at,
          ...(r.status === "archived" && r.archived_at != null
            ? { archivedAt: r.archived_at }
            : {}),
          ...(r.status === "archived" && r.archived_reason
            ? { archivedReason: r.archived_reason }
            : {}),
          ...(r.status === "deleted" && r.deleted_at != null
            ? { deletedAt: r.deleted_at }
            : {}),
        })),
      });
    },
  },
  {
    method: "POST",
    match: "/rooms",
    handler: async (c) => {
      const { req, env, ctx, auth } = c;
      // An agent makes a room of its account (docs/api/topics.md); joining it is a separate step.
      const b = await readBody(req);
      const nonce = nonceOf(b.nonce);
      const again = nonce ? await createAnswer(env, auth.user.id, nonce) : null;
      if (again) return json(again);
      const name = str(b.name, 80).trim();
      if (!name)
        throw new ApiError("bad_request", "name='<topic name>' is required.");
      // No code= gets a passcode made up for it (private, as on the web); code='' means no passcode.
      const code = b.code == null ? suggestCode() : str(b.code, 40).trim();
      const topic = multiline(b.topic, TOPIC_MAX, "A description");
      const roomId = await createRoom(env, ctx, auth.user, {
        name,
        topic,
        code,
      });
      const out = {
        roomId,
        name,
        topic,
        owner: auth.user.handle,
        code: code || null,
      };
      if (nonce)
        await keepCreateAnswer(env, auth.user.id, nonce, out);
      return json(out);
    },
  },
];
export const joinRoutes: Route<JoinContext>[] = [
  {
    method: "POST",
    match: "join",
    handler: async (c) => {
      const { req, env, ctx, auth, roomId, stub } = c;
      const b = await readBody(req);
      const host = b.host === true || b.host === "true";
      const deviceId =
        auth.deviceId ||
        deviceIdOf(b.device_id) ||
        `name:${auth.device.trim().toLowerCase() || "unknown"}`;
      const device = host
        ? await deviceForHost(
            env,
            auth.user.id,
            deviceId,
            auth.device,
            b.machine,
            b.clis,
            req.headers.get("x-scorpio-cli"),
            b.rollback,
          )
        : null;
      const known = device
        ? { seat: device.seat, daemon_no: device.daemonNo }
        : await knownSeat(env, auth.user.id, deviceId);
      const seatRole =
        known?.seat ||
        (known?.daemon_no
          ? known.daemon_no === 1
            ? "daemon"
            : `daemon-${known.daemon_no}`
          : null);
      const role = host ? device!.seat! : str(b.role, 100);
      if (!ROLE_RE.test(role))
        throw new ApiError(
          "invalid_role",
          "role must be 1–62 characters of letters, digits, _ . - (for example role=api).",
        );
      const actor: Actor = {
        kind: "agent",
        account: auth.user.handle,
        name: `${role}@${auth.user.handle}`,
      };
      const joined = unwrap(
        await stub.join(actor, {
          role,
          ownerDisplayName: auth.displayName,
          roleCard: cleanCut(b.roleCard, ROLE_CARD_MAX) || undefined,
          lane: laneOf(b.lane),
          resume: b.resume === true || b.resume === "true",
          code: str(b.code, 100) || undefined,
          runtime: str(b.runtime, 20) || undefined,
          backing: str(b.backing, 20) || undefined,
          nonce: nonceOf(b.nonce),
          host,
          seat: seatRole ? `${seatRole}@${auth.user.handle}` : undefined,
          deviceId,
          device: device
            ? {
                name: device.name,
                hostname: device.hostname,
                note: device.note,
              }
            : undefined,
          legacySeat: known?.daemon_no
            ? `${known.daemon_no === 1 ? "daemon" : `daemon-${known.daemon_no}`}@${auth.user.handle}`
            : undefined,
          clis: device?.clis ?? null,
          perms: host ? b.perms : undefined,
          idleHandoffMinutes:
            host && b.idleHandoffMinutes != null && b.idleHandoffMinutes !== ""
              ? Math.max(0, Math.floor(Number(b.idleHandoffMinutes) || 0))
              : null,
        }),
      ) as Record<string, unknown>;
      if (device?.oldSeat && device.oldSeat !== device.seat) {
        ctx.waitUntil(activeRoomIdsOf(env, auth.user.id).then((rooms) => Promise.allSettled(rooms.map((r) =>
          env.ROOMS.getByName(r.id).deviceChanged(auth.user.handle, device.deviceId, device.seat, device.oldSeat!,
            { name: device.name, hostname: device.hostname, note: device.note }),
        ))));
      }
      if (!host) {
        await inRoom(env, roomId, auth.user.id, true);
        // The computer's machine id first (CLI 0.5.9), then an invited friend's agent in a topic: the inviter's days are
        // decided on the first such join.
        ctx.waitUntil(
          recordMachine(env, auth.user.id, auth.deviceId, b.machine_id)
            .then(() => rewardOnJoin(env, auth.user.id, auth.deviceId))
            .catch((e) =>
              console.error(
                JSON.stringify({
                  msg: "invite reward failed",
                  error: String(e),
                }),
              ),
            ),
        );
      } else {
        // A daemon seat's join carries the machine id too: computers used before invites get their first account.
        ctx.waitUntil(
          recordMachine(env, auth.user.id, auth.deviceId, b.machine_id).catch(
            () => {},
          ),
        );
      }
      return json(
        host
          ? {
              ...joined,
              device: {
                name: device!.name,
                hostname: device!.hostname,
                note: device!.note,
              },
            }
          : joined,
      );
    },
  },
  {
    method: "POST",
    match: "rejoin",
    handler: async (c) => {
      const { env, auth, stub } = c;
      if (!auth.deviceId)
        throw new ApiError(
          "device_unknown",
          "This computer needs a current device token. Run scorpio login on it first.",
          403,
        );
      const row = await knownSeat(env, auth.user.id, auth.deviceId);
      const seat =
        row?.seat ||
        (row?.daemon_no === 1
          ? "daemon"
          : row?.daemon_no
            ? `daemon-${row.daemon_no}`
            : "daemon");
      const name = `${seat}@${auth.user.handle}`;
      const legacy = row?.daemon_no
        ? `${row.daemon_no === 1 ? "daemon" : `daemon-${row.daemon_no}`}@${auth.user.handle}`
        : name;
      return json(
        unwrap(
          await stub.rejoinComputer(
            { kind: "agent", account: auth.user.handle, name },
            name,
            auth.deviceId,
            legacy,
          ),
        ),
      );
    },
  },
];
const legacyUpgrade = async () => upgradeRequired();

export const subRoutes: Route<SubContext>[] = [
  {
    method: "GET",
    match: "ws",
    handler: async (c) => {
      const { req, stub, actor, auth } = c;
      if (req.headers.get("upgrade") !== "websocket")
        throw new ApiError("bad_request", "Expected a WebSocket upgrade.", 426);
      return stub.fetch(internalUpgrade(req, actor, auth.tokenId));
    },
  },
  {
    method: "POST",
    match: "files",
    handler: async (c) => {
      const { req, env, ctx, auth, roomId, seqStr, stub, actor } = c;
      if (seqStr) return null;
      return upload(req, env, ctx, stub, actor, roomId, auth.user.id);
    },
  },
  {
    method: "GET",
    match: "files",
    handler: async (c) => {
      const { seqStr, stub, actor, q } = c;
      if (seqStr) return null;
      return json(await actions.listFiles(stub, actor, q));
    },
  },
  {
    method: "GET",
    match: "files",
    handler: async (c) => {
      const { req, env, roomId, seqStr, stub, actor } = c;
      if (!seqStr) return null;
      return fileResponseFor(env, stub, actor, roomId, seqStr, req);
    },
  },
  {
    method: "GET",
    match: "messages",
    handler: async (c) => {
      const { seqStr, stub, actor, q } = c;
      if (seqStr)
        return json(await actions.message(stub, actor, Number(seqStr)));
      return json(await actions.messages(stub, actor, q));
    },
  },
  {
    method: "GET",
    match: "search",
    handler: async (c) => {
      const { seqStr, stub, actor, q } = c;
      if (seqStr) return null;
      return json(await actions.search(stub, actor, q));
    },
  },
  {
    method: "GET",
    match: "memo",
    handler: async ({ stub, actor, q, seqStr }) => seqStr ? null : json(await actions.memoRead(stub, actor, q)),
  },
  {
    method: "GET",
    match: "listen",
    handler: async (c) => {
      const { stub, actor } = c;
      return json(await actions.listen(stub, actor));
    },
  },
  { method: "*", match: "plan", handler: legacyUpgrade },
  { method: "*", match: "pins", handler: legacyUpgrade },
  { method: "*", match: "pin", handler: legacyUpgrade },
  { method: "*", match: "unpin", handler: legacyUpgrade },
  {
    method: "GET",
    match: "todo",
    handler: async (c) => {
      const { seqStr, stub, actor, q } = c;
      if (seqStr) return json(await actions.todoShow(stub, actor, seqStr));
      // The short views (CLI 0.5.3): mine=1, open=1[&to=]; an older CLI sends neither and gets the full list.
      if (q.get("mine") === "1")
        return json(await actions.todoBrief(stub, actor, { mine: true }));
      if (q.get("open") === "1")
        return json(
          await actions.todoBrief(stub, actor, {
            to: q.get("to") ? str(q.get("to"), 120) : null,
          }),
        );
      return json(
        await actions.todoList(
          stub,
          actor,
          q.has("round") ? Number(q.get("round")) : undefined,
        ),
      );
    },
  },
  {
    method: "GET",
    match: "schedules",
    handler: async (c) => {
      const { seqStr, stub, actor } = c;
      return scheduleList(stub, actor, seqStr);
    },
  },
  {
    method: "GET",
    match: "members",
    handler: async (c) => {
      const { stub, actor } = c;
      return json(await actions.members(stub, actor, c.url.searchParams));
    },
  },
  // Who talked with whom over the last 7 days, the agents by lane (docs/api/topics.md "The overview").
  {
    method: "GET",
    match: "overview",
    handler: async (c) => {
      const { stub, actor } = c;
      return json(await actions.overview(stub, actor));
    },
  },
  // The topic's records as one zip (docs/api/export.md).
  {
    method: "GET",
    match: "export",
    handler: async (c) => {
      const { req, env, ctx, auth, seqStr, stub, actor } = c;
      if (seqStr) return null;
      return exportRoute(req, env, ctx, stub, actor, auth.user.id, false);
    },
  },
  // A seat's handoff (docs/api/files.md). PUT reads a raw body, so it comes before the JSON POST block; nothing of the body
  // is read until the topic, the writer and the account's setting have answered.
  {
    method: "PUT",
    match: "handoff",
    handler: async (c) => {
      const { req, env, auth, seqStr, stub, actor } = c;
      if (seqStr) return null;
      return putAgentHandoff(req, stub, actor, auth.handoffLocal, () => handoffComputer(env, auth.user.id, auth.deviceId));
    },
  },
  {
    method: "GET",
    match: "handoff",
    handler: async (c) => {
      const { seqStr, stub, actor, q } = c;
      if (seqStr) return null;
      return getAgentHandoff(stub, actor, q.get("name"));
    },
  },
];
export const postRoutes: Route<PostContext>[] = [
  { method: "POST", match: "memo", handler: async ({ stub, actor, b }) => json(await actions.memoWrite(stub, actor, b, false)) },
  {
    method: "POST",
    match: "send",
    handler: async (c) => {
      const { env, auth, stub, actor, b } = c;
      const files = filesOf(b.files);
      const out = await actions.send(stub, actor, b, { agent: true, files });
      return json(
        await withSpace(
          env,
          auth.user.id,
          files,
          out as Record<string, unknown>,
        ),
      );
    },
  },
  {
    method: "POST",
    match: "todo",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(await actions.todo(stub, actor, b));
    },
  },
  {
    method: "POST",
    match: "schedules",
    handler: async (c) => {
      const { seqStr, stub, actor, b } = c;
      return scheduleOp(stub, actor, b, seqStr);
    },
  },
  {
    method: "POST",
    match: "mark",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(await actions.mark(stub, actor, b, { requireUpTo: true }));
    },
  },
  {
    method: "POST",
    match: "roleCard",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(await actions.setRoleCard(stub, actor, b));
    },
  },
  {
    method: "POST",
    match: "lane",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(await actions.setLane(stub, actor, b));
    },
  },
  {
    method: "POST",
    match: "topic",
    handler: async (c) => {
      const { env, ctx, auth, roomId, stub, actor, b } = c;
      return json(
        await actions.setTopic(
          env,
          ctx,
          stub,
          actor,
          auth.user,
          roomId,
          b.topic,
        ),
      );
    },
  },
  {
    method: "POST",
    match: "name",
    handler: async (c) => {
      const { env, ctx, auth, roomId, stub, actor, b } = c;
      return json(await actions.setName(env, ctx, stub, actor, auth.user, roomId, b.name));
    },
  },
  {
    method: "POST",
    match: "leave",
    handler: async (c) => {
      const { env, ctx, auth, roomId, stub, actor } = c;
      return json(
        await actions.leaveAccount(env, ctx, stub, actor, auth.user, roomId),
      );
    },
  },
];
// ---------- agent API (docs/api/README.md) ----------
export async function agentApi(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
): Promise<Response> {
  if (/^\/rooms\/[^/]+\/approvals\/[^/]+\/answer$/.test(path)) return json({ error: "approval_not_found", next: "Approval not found." }, 404);
  if (cliTooOld(req, await minCli(env))) upgradeRequired();
  const base = {
    req,
    env,
    ctx,
    url: new URL(req.url),
    path,
    isPost: req.method === "POST",
  };
  const pre = await runRoutes(base, preAuthRoutes);
  if (pre) return pre;
  const isSelfcheck = req.method === "GET" && path === "/selfcheck";
  const auth = await agentFromRequest(req, env, ctx, !isSelfcheck);
  if (isSelfcheck) return selfcheck(req);
  const ownerContext: OwnerContext = { ...base, auth };
  const mine = await runRoutes(ownerContext, ownerRoutes);
  if (mine) return mine;
  const cardPath = /^\/rooms\/([A-Za-z0-9_-]{22})\/messages\/([0-9]+)\/card$/.exec(path);
  if (cardPath && req.method === "GET") {
    const role = req.headers.get("x-scorpio-role") || "";
    if (!ROLE_RE.test(role)) throw new ApiError("role_unknown", "Pass role=<your role> or join first.");
    return json(await actions.card(await roomStub(env, cardPath[1]), { kind: "agent", account: auth.user.handle, name: `${role}@${auth.user.handle}` }, Number(cardPath[2])));
  }
  const m =
    /^\/rooms\/([A-Za-z0-9_-]+)\/([A-Za-z]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(
      path,
    );
  if (!m)
    throw new ApiError(
      "bad_request",
      `Unknown endpoint ${req.method} /api/v1${path}.`,
      404,
    );
  const [, roomId, action, seqStr] = m;
  if (!ROOM_ID_RE.test(roomId))
    throw new ApiError(
      "room_not_found",
      "No such topic. Check the topic id in your invitation.",
      404,
    );
  const stub = await roomStub(env, roomId);
  const stage: JoinContext = {
    ...ownerContext,
    path: action,
    roomId,
    action,
    seqStr,
    stub,
  };
  const joined = await runRoutes(stage, joinRoutes);
  if (joined) return joined;
  const role = req.headers.get("x-scorpio-role") || "";
  if (!ROLE_RE.test(role))
    throw new ApiError(
      "role_unknown",
      "Which agent are you in this topic? Pass role=<your role> (or join again with resume=true).",
    );
  const actor: Actor = {
    kind: "agent",
    account: auth.user.handle,
    name: `${role}@${auth.user.handle}`,
  };
  const q = new URL(req.url).searchParams;
  const subContext: SubContext = { ...stage, actor, q };
  const sub = await runRoutes(subContext, subRoutes);
  if (sub) return sub;
  if (req.method === "POST") {
    const b = { ...await readBody(req), lang: langOf(req) };
    const postContext: PostContext = { ...subContext, b };
    const out = await runRoutes(postContext, postRoutes);
    if (out) return out;
  }
  throw new ApiError(
    "bad_request",
    `Unknown endpoint ${req.method} /api/v1${path}.`,
    404,
  );
}
