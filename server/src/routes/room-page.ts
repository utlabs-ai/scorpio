import { type Actor } from "../room-do";
import * as actions from "../room-actions";
import { unwrap, filesOf } from "../room-actions";
import { ApiError, json, readBody, str } from "../util";
import { inRoom, visited, snapshotIsPublic } from "../room-index";
import { origin, sameOrigin, type User } from "../auth";
import { autoCallBackOf, displayNameOf, spawnPermOf } from "../accounts";
import { spaceNow } from "../space";
import { snapshotPage } from "../snapshot-page";
import { readPublicSnapshot } from "../room-report";
import { enterPage } from "../enter-page";
import { roomPage } from "../room-page";
import { overviewPage } from "../overview-page";
import { FRAME_CSP, FRAME_SANDBOX } from "../file-view";
import { ticketKey } from "../view-ticket";
import { messagePage, pageError } from "../message-page";
import { langOf } from "../layout";
import { strings } from "../strings";
import { MAX_TEXT, limitsFor } from "../plans";
import { retentionDays } from "../retention";
import { driveConfigured, driveState } from "../drive";
import { localNext } from "../safe-next";
import { installCommand, type Latest } from "../install-command";
import {
  wantsJsonBody,
  redirect,
  internalUpgrade,
  runRoutes,
  type Route,
  type SignedRouteContext,
  type RoomStub,
} from "./shared";
import { roomStub } from "../room-stub";
import { purgeRoomNow } from "../room-purge";
import { upload, withSpace } from "./files";
import { handoffRoute, deleteWebHandoff } from "./handoffs";
import { scheduleList, scheduleOp } from "./schedules";
import { exportRoute } from "./export";

/**
 * What the room page needs about the person and this deployment, read in parallel. D1 is in one region; from far away
 * each query is a round trip of 0.4–1 s, and one after another they held the page up by seconds.
 */
export async function roomPageReads(env: Env, url: URL, user: User) {
  const [shown, { space, fileMax }, drive, retention, latest, autoCallBack, spawnPerm] =
    await Promise.all([
      displayNameOf(env, user.id), // the room learns the person's display name, or catches up with it
      // My file space (the composer warns from 80%), and my plan's file size for files I attach: the
      // plan is the one spaceNow read, so planOf is not asked again.
      spaceNow(env, user.id).then(async (space) => ({
        space,
        fileMax: (await limitsFor(env, space.plan)).fileBytes,
      })),
      driveConfigured(env)
        ? driveState(env, user.id).then((d) => ({
            connected: d.connected,
            error: d.error,
          }))
        : null, // and whether files go to Drive first
      retentionDays(env), // the archived banner: 「n 天后彻底删除」 from room.archivedAt
      // The Skill package this deployment serves (built by `npm run build:skill`); npm once it is published.
      env.ASSETS.fetch(new Request(`${url.origin}/dl/latest.json`))
        .then((r) => (r.ok ? (r.json() as Promise<Latest>) : null))
        .catch(() => null),
      autoCallBackOf(env, user.id),
      spawnPermOf(env, user.id),
    ]);
  return { shown, space, fileMax, drive, retention, latest, autoCallBack, spawnPerm };
}

// A public room's link without a session: check D1 before serving its snapshot, so a
// visitor who is not signed in never wakes the room. Private, deleted and unknown rooms go to sign-in alike.
export const snapshotRoutes: Route[] = [
  {
    method: "GET",
    match: /^\/r\/([A-Za-z0-9_-]{8,64})$/,
    handler: async (c, m) => {
      const { env, ctx, url, lang } = c;
      const user = c.user;
      const snapRoom = m!;
      if (user) return null;
      if (!(await snapshotIsPublic(env, snapRoom[1]))) return null;
      const key = new Request(
        `${url.origin}/__snapshot/${snapRoom[1]}?lang=${lang}`,
      );
      let page = await caches.default.match(key).catch(() => undefined);
      if (!page) {
        const snap = await readPublicSnapshot(env, snapRoom[1]);
        if (!snap) return null;
        page = snapshotPage(
          lang,
          env.PUBLIC_URL || url.origin,
          snapRoom[1],
          snap,
        );
        ctx.waitUntil(caches.default.put(key, page.clone()).catch(() => {}));
      }
      // Only the render cache may reuse the page. Browsers and upstream caches must return through D1.
      const response = new Response(page.body, page);
      response.headers.set("cache-control", "private, no-store");
      return response;
    },
  },
];

export const signedRoutes: Route<SignedRouteContext>[] = [
  // --- rooms ---
  {
    method: "*",
    match:
      /^\/r\/([A-Za-z0-9_-]{22})(?:\/([A-Za-z]+)(?:\/([A-Za-z0-9_-]+))?)?$/,
    handler: async (c, m) => {
      const { req, env, ctx, url } = c;
      const user = c.user;
      const rm = m!;
      return roomRoutes(req, env, url, user, rm[1], rm[2] || "", ctx, rm[3]);
    },
  },
];

type RoomRouteContext = SignedRouteContext & {
  user: User;
  roomId: string;
  sub: string;
  scheduleId?: string;
  stub: RoomStub;
  actor: Actor;
  page: ReturnType<typeof roomPageReads> | null;
};
type RoomPostContext = RoomRouteContext & {
  b: Awaited<ReturnType<typeof readBody>>;
};

export const subRoutes: Route<RoomRouteContext>[] = [
  {
    method: "GET",
    match: "",
    handler: async (c) => {
      const { req, env, url, user, roomId, ctx, lang, stub, actor, page } = c;
      const r = await stub.peek(actor);
      if ("err" in r && r.err.code === "room_deleted")
        return messagePage(
          lang,
          user,
          strings(lang).roomDeletedTitle,
          strings(lang).roomDeleted,
          410,
        );
      if ("err" in r) {
        const pe = pageError(lang, r.err.code, r.err.next);
        return messagePage(lang, user, "404", pe.text, r.err.status, pe.detail);
      }
      const { room, member } = r.ok;
      const { shown, space, fileMax, drive, retention, latest, autoCallBack, spawnPerm } = await page!;
      // A public topic is read without joining (a viewer): 「加入」 joins. Its creator, and an old private
      // room without a passcode, are let in as before; any other private topic asks for the passcode.
      let viewer = false;
      if (!member) {
        if (room.owner === user.handle || (!room.public && !room.hasCode)) {
          const joined = await stub.enterHuman(actor, undefined, shown);
          if ("err" in joined && joined.err.code === "person_limit")
            return messagePage(lang, user, strings(lang).personLimitTitle, strings(lang).personLimit, joined.err.status);
          unwrap(joined);
        } else if (room.public) viewer = true;
        else return enterPage(lang, user, room.id);
      } else if (r.ok.displayName !== shown)
        ctx.waitUntil(stub.setDisplayName(user.handle, shown).catch(() => {}));
      // The home page's index is written after the page is on its way: the room object already let them in.
      ctx.waitUntil(
        (viewer
          ? visited(env, roomId, user.id)
          : inRoom(env, roomId, user.id, true)
        ).catch((e) =>
          console.error(
            JSON.stringify({
              msg: "room_members write failed",
              room: roomId,
              error: String(e),
            }),
          ),
        ),
      );
      const base = origin(req, env);
      // Chart cards open in frames on the content domain, as files do: the page allows that origin and sets
      // the same sandbox and csp attributes on the frame. Without a ticket key or a content domain they show their summary.
      const cards = !!ticketKey(env.VIEW_TICKET_KEY) && !!env.CONTENT_DOMAIN;
      return roomPage(lang, user, room, {
        member: !viewer, // false: a viewer, read only, with 「加入」 (POST /r/<id>/enter)
        roomId: room.id,
        roomName: room.name,
        topic: room.topic,
        owner: room.owner,
        me: user.handle,
        autoCallBack,
        spawnPerm,
        meDisplayName: shown,
        hasCode: room.hasCode,
        public: room.public,
        archived: room.archived,
        archivedAt: room.archivedAt,
        archivedReason: room.archivedReason,
        install: installCommand(base, latest),
        fileMax,
        fileStorage: !!env.FILES, // false: this deployment takes no files, so the page offers no attach buttons
        space,
        drive,
        retention,
        textMax: MAX_TEXT,
        card: cards ? { sandbox: FRAME_SANDBOX.html, csp: FRAME_CSP.html } : null,
        // 「拉同事」 links carry no invite code any more: a code works once, so a link for a group would count once.
      }, cards ? `${url.protocol}//*.${env.CONTENT_DOMAIN}${url.port ? `:${url.port}` : ""}` : undefined);
    },
  },
  // Joining (docs/api/topics.md): the passcode form, or the viewer's 「加入」 as JSON. A public topic wants no passcode.
  {
    method: "POST",
    match: "enter",
    handler: async (c) => {
      const { req, env, url, user, roomId, lang, stub, actor } = c;
      const asJson = wantsJsonBody(req);
      const b = await readBody(req);
      // From a file's link, or a handoff's: back there once in.
      const asked = str(b.next, 300);
      const next =
        /^\/v\/[A-Za-z0-9_-]{22}$/.test(asked) ||
        asked === `/r/${roomId}/view` ||
        (asked.startsWith(`/r/${roomId}/handoff?name=`) &&
          localNext(asked, url.origin) === asked)
          ? asked
          : null;
      const r = await stub.enterHuman(
        actor,
        str(b.code, 100),
        await displayNameOf(env, user.id),
      );
      if ("err" in r) {
        if (asJson)
          return json({ error: r.err.code, next: r.err.next, ...(r.err.retryAfter ? { retryAfter: r.err.retryAfter } : {}) }, r.err.status, r.err.retryAfter ? { "retry-after": String(r.err.retryAfter) } : {});
        if (r.err.code === "person_limit")
          return messagePage(lang, user, strings(lang).personLimitTitle, strings(lang).personLimit, r.err.status);
        const info = await stub.info();
        if ("err" in info) {
          const pe = pageError(lang, info.err.code, info.err.next);
          return messagePage(lang, user, "404", pe.text, 404, pe.detail);
        }
        const limited = r.err.code === "rate_limited";
        const page = enterPage(lang, user, info.ok.id, limited ? strings(lang).codeTryLater : strings(lang).badCode, next, limited ? 429 : undefined);
        if (limited && r.err.retryAfter) page.headers.set("retry-after", String(r.err.retryAfter));
        return page;
      }
      await inRoom(env, roomId, user.id, true);
      if (asJson) return json({ roomId, name: user.handle, member: true });
      return redirect(next || `/r/${roomId}`);
    },
  },
  {
    method: "GET",
    match: "ws",
    errors: "json",
    handler: async (c) => {
      const { req, env, stub, actor } = c;
      if (req.headers.get("upgrade") !== "websocket")
        return new Response("expected websocket", { status: 426 });
      if (!sameOrigin(req, env))
        return new Response("forbidden", { status: 403 });
      return stub.fetch(internalUpgrade(req, actor));
    },
  },
  {
    method: "GET",
    match: "handoff",
    handler: async (c) => {
      const { req, env, url, user, roomId, stub } = c;
      return handoffRoute(req, env, url, user, stub, roomId);
    },
  },
  // The overview (docs/api/topics.md "The overview"): access exactly as the topic page's. A member sees it; the creator
  // and an old no-passcode private topic are let in; a public topic's signed-in non-member reads it as a viewer; a private
  // topic asks for the passcode and comes back here. The overview is computed here and booted into the page.
  {
    method: "GET",
    match: "view",
    handler: async (c) => {
      const { env, user, roomId, ctx, lang, stub, actor } = c;
      const r = await stub.peek(actor);
      if ("err" in r && r.err.code === "room_deleted")
        return messagePage(lang, user, strings(lang).roomDeletedTitle, strings(lang).roomDeleted, 410);
      if ("err" in r) {
        const pe = pageError(lang, r.err.code, r.err.next);
        return messagePage(lang, user, "404", pe.text, r.err.status, pe.detail);
      }
      const { room, member } = r.ok;
      let viewer = false;
      if (!member) {
        if (room.owner === user.handle || (!room.public && !room.hasCode)) {
          const joined = await stub.enterHuman(actor, undefined, await displayNameOf(env, user.id));
          if ("err" in joined && joined.err.code === "person_limit")
            return messagePage(lang, user, strings(lang).personLimitTitle, strings(lang).personLimit, joined.err.status);
          unwrap(joined);
        } else if (room.public) viewer = true;
        else return enterPage(lang, user, room.id, undefined, `/r/${roomId}/view`);
      }
      ctx.waitUntil((viewer ? visited(env, roomId, user.id) : inRoom(env, roomId, user.id, true)).catch((e) =>
        console.error(JSON.stringify({ msg: "room_members write failed", room: roomId, error: String(e) }))));
      const overview = unwrap(await stub.viewOverview(actor));
      return overviewPage(lang, user, room, { me: user.handle, member: !viewer, overview });
    },
  },
  {
    method: "GET",
    match: "history",
    errors: "json",
    handler: async (c) => {
      const { url, stub, actor } = c;
      return json(
        await actions.history(
          stub,
          actor,
          Number(url.searchParams.get("before") || 0),
        ),
      );
    },
  },
  {
    method: "GET",
    match: "around",
    errors: "json",
    handler: async (c) => {
      const { url, stub, actor } = c;
      return json(
        await actions.around(stub, actor, Number(url.searchParams.get("seq"))),
      );
    },
  },
  {
    method: "GET",
    match: "memo",
    errors: "json",
    handler: async ({ stub, actor, url, lang }) => json(await actions.memoRead(stub, actor, url.searchParams, lang)),
  },
  {
    method: "GET",
    match: "search",
    errors: "json",
    handler: async (c) => {
      const { url, stub, actor } = c;
      return json(await actions.search(stub, actor, url.searchParams));
    },
  },
  {
    method: "GET",
    match: "files",
    errors: "json",
    handler: async (c) => {
      const { url, stub, actor } = c;
      return json(await actions.listFiles(stub, actor, url.searchParams));
    },
  },
  {
    method: "GET",
    match: "todo",
    errors: "json",
    handler: async (c) => {
      const { url, stub, actor } = c;
      const item = url.searchParams.get("item");
      if (item) return json(await actions.todoShow(stub, actor, item, true)); // the web's detail: the thread's messages in full
      return json(
        await actions.todoList(
          stub,
          actor,
          url.searchParams.has("round")
            ? Number(url.searchParams.get("round"))
            : undefined,
        ),
      );
    },
  },
  {
    method: "GET",
    match: "schedules",
    errors: "json",
    handler: async (c) => {
      const { scheduleId, stub, actor } = c;
      return scheduleList(stub, actor, scheduleId);
    },
  },
  // The topic's records as one zip, for a member's browser (the settings sheet; docs/api/export.md). Refusals are
  // JSON: the sheet asks with dry=1 first and shows them before any download starts.
  {
    method: "GET",
    match: "export",
    errors: "json",
    handler: async (c) => {
      const { req, env, ctx, user, stub, actor } = c;
      return exportRoute(req, env, ctx, stub, actor, user.id, true);
    },
  },
  {
    method: "GET",
    match: "mentions",
    errors: "json",
    handler: async (c) => {
      const { url, stub, actor } = c;
      return json(
        await actions.mentions(
          stub,
          actor,
          Number(url.searchParams.get("before") || 0),
          Number(url.searchParams.get("limit") || 50),
          url.searchParams,
        ),
      );
    },
  },
  {
    method: "POST",
    match: "files",
    errors: "json",
    handler: async (c) => {
      const { req, env, user, roomId, ctx, stub, actor } = c;
      return upload(req, env, ctx, stub, actor, roomId, user.id);
    },
  },
];
export const postRoutes: Route<RoomPostContext>[] = [
  { method: "POST", match: "press", errors: "json", handler: async ({ stub, actor, b }) => json(await actions.press(stub, actor, b)) },
  {
    method: "POST",
    match: "memo",
    errors: "json",
    handler: async ({ stub, actor, b, lang }) => json(await actions.memoWrite(stub, actor, b, true, lang)),
  },
  {
    method: "POST",
    match: "send",
    errors: "json",
    handler: async (c) => {
      const { env, user, stub, actor, b } = c;
      const files = filesOf(b.files);
      const out = await actions.send(stub, actor, b, { agent: false, files });
      return json(
        await withSpace(env, user.id, files, out as Record<string, unknown>),
      );
    },
  },
  {
    method: "POST",
    match: "mark",
    errors: "json",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(await actions.mark(stub, actor, b, { requireUpTo: false }));
    },
  },
  // A person marks an item under their own name done (or undoes that); the room refuses anything else.
  {
    method: "POST",
    match: "todo",
    errors: "json",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(await actions.todo(stub, actor, b));
    },
  },
  {
    method: "POST",
    match: "schedules",
    errors: "json",
    handler: async (c) => {
      const { scheduleId, stub, actor, b } = c;
      if (scheduleId) return null;
      return scheduleOp(stub, actor, b);
    },
  },
  {
    method: "POST",
    match: "topic",
    errors: "json",
    handler: async (c) => {
      const { env, user, roomId, ctx, stub, actor, b } = c;
      return json(
        await actions.setTopic(env, ctx, stub, actor, user, roomId, b.topic),
      );
    },
  },
  {
    method: "POST",
    match: "name",
    errors: "json",
    handler: async (c) => {
      const { env, user, roomId, ctx, stub, actor, b } = c;
      return json(await actions.setName(env, ctx, stub, actor, user, roomId, b.name));
    },
  },
  // A person sets the lane of one of their own agents, a left one too; the room checks it is theirs.
  {
    method: "POST",
    match: "lane",
    errors: "json",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(await actions.setLaneFor(stub, actor, b));
    },
  },
  // A person rewrites the role card of one of their own agents; the room checks it is theirs.
  {
    method: "POST",
    match: "roleCard",
    errors: "json",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(await actions.setRoleCardFor(stub, actor, b));
    },
  },
  {
    method: "POST",
    match: "visibility",
    errors: "json",
    handler: async (c) => {
      const { env, user, roomId, ctx, stub, actor, b } = c;
      const pub = b.public === true || b.public === "true";
      return json(
        await actions.setVisibility(env, ctx, stub, actor, user, roomId, pub),
      );
    },
  },
  // A person leaves, their agents and daemon seats with them; the creator cannot (the_owner_stays).
  {
    method: "POST",
    match: "leave",
    errors: "json",
    handler: async (c) => {
      const { req, env, user, roomId, ctx, stub, actor } = c;
      const out = (await actions.leaveAccount(
        env,
        ctx,
        stub,
        actor,
        user,
        roomId,
      )) as { public: boolean };
      if (wantsJsonBody(req)) return json(out);
      return redirect(out.public ? `/r/${roomId}` : "/app");
    },
  },
  {
    method: "POST",
    match: "remove",
    errors: "json",
    handler: async (c) => {
      const { env, user, roomId, ctx, stub, actor, b } = c;
      const account = str(b.account, 39);
      return json(
        await actions.removeAccount(
          env,
          ctx,
          stub,
          actor,
          user,
          roomId,
          account,
        ),
      );
    },
  },
  {
    method: "POST",
    match: "handoffDelete",
    errors: "json",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return deleteWebHandoff(stub, actor, b.name);
    },
  },
  {
    method: "POST",
    match: "removeComputer",
    errors: "json",
    handler: async (c) => {
      const { stub, actor, b } = c;
      return json(
        unwrap(await stub.removeOwnComputer(actor, str(b.name, 120))),
      );
    },
  },
  {
    method: "POST",
    match: "archive",
    errors: "json",
    handler: async (c) => {
      const { env, user, roomId, ctx, stub, actor, b } = c;
      const on = b.archived !== false && b.archived !== "false";
      return json(
        await actions.setArchived(env, ctx, stub, actor, user, roomId, on),
      );
    },
  },
  {
    method: "POST",
    match: "delete",
    handler: async (c) => {
      const { env, user, roomId, ctx, stub, actor } = c;
      await actions.deleteRoom(env, ctx, stub, actor, user, roomId);
      await purgeRoomNow(env, roomId);
      return json({ roomId, next: "/app" });
    },
  },
  {
    method: "POST",
    match: "code",
    errors: "json",
    handler: async (c) => {
      const { env, user, roomId, ctx, stub, actor } = c;
      return json(
        await actions.rotateCode(env, ctx, stub, actor, user, roomId),
      );
    },
  },
];
export async function roomRoutes(
  req: Request,
  env: Env,
  url: URL,
  user: User,
  roomId: string,
  sub: string,
  ctx: ExecutionContext,
  scheduleId?: string,
): Promise<Response> {
  const lang = langOf(req);
  // The page's reads go out together with the topic's lookup and peek, not after them.
  const page =
    sub === "" && req.method === "GET" ? roomPageReads(env, url, user) : null;
  page?.catch(() => {}); // a missing or deleted topic answers without waiting for them
  let stub: RoomStub;
  try {
    stub = await roomStub(env, roomId);
  } catch (e) {
    if (sub || !(e instanceof ApiError)) throw e; // the page's own calls get the JSON error
    const pe = pageError(lang, e.code, e.next);
    return messagePage(lang, user, "404", pe.text, 404, pe.detail);
  }
  const actor: Actor = {
    kind: "human",
    account: user.handle,
    name: user.handle,
  };
  const base: RoomRouteContext = {
    req,
    env,
    ctx,
    url,
    path: sub,
    lang,
    t: strings(lang),
    user,
    isPost: req.method === "POST",
    roomId,
    sub,
    scheduleId,
    stub,
    actor,
    page,
  };
  const beforeBody = await runRoutes(base, subRoutes);
  if (beforeBody) return beforeBody;
  if (req.method === "POST") {
    const b = await readBody(req);
    const postContext: RoomPostContext = { ...base, b };
    const afterBody = await runRoutes(postContext, postRoutes);
    if (afterBody) return afterBody;
  }
  return json({ error: "bad_request", next: "Unknown topic endpoint." }, 404);
}
