import { type Actor } from "../room-do";
import { TOPIC_MAX } from "../room-actions";
import { ApiError, json, multiline, readBody, str } from "../util";
import { searchableRooms, suggestCode } from "../room-index";
import { displayNameOf } from "../accounts";
import { trialRow } from "../billing-state";
import { messagePage } from "../message-page";
import { retentionDays } from "../retention";
import { searchQuery } from "../search";
import { cutChars } from "../text";
import { myTopics, setPin, topicsForPage } from "../app-topics";
import { appPage } from "../app-page";
import { redirect, type Route, type SignedRouteContext } from "./shared";
import { createRoom } from "../room-stub";

/** The left column's foot: my shown name and, on the launch trial, the day it ends. */
export async function shellOf(env: Env, user: { id: string; handle: string }) {
  const [displayName, ent] = await Promise.all([
    displayNameOf(env, user.id),
    trialRow(env, user.id),
  ]);
  const trialUntil =
    ent &&
    ent.plan === "pro" &&
    ent.provider === "trial" &&
    ent.status === "active" &&
    (ent.period_end ?? 0) > Date.now()
      ? ent.period_end
      : null;
  // No invite link here: the avatar menu's 「邀请朋友」 opens /settings#invite, and this is read every 30 s.
  return { handle: user.handle, displayName, trialUntil };
}

export const appRoutes: Route<SignedRouteContext>[] = [
  {
    method: "GET",
    match: "/search",
    errors: "json",
    handler: async (c) => {
      const { env, url } = c;
      const user = c.user;

      const query = { ...searchQuery({ q: url.searchParams.get("q") }), groups: ["messages", "todo", "files"] as import("../search").SearchGroup[] };
      const results = await searchableRooms(env, user.id);
      const actor: Actor = {
        kind: "human",
        account: user.handle,
        name: user.handle,
      };
      const rooms = await Promise.all(
        results.map(async (r) => {
          // A room that refuses or fails (left it, made private, deleted a moment ago) is left out; the others still answer.
          const res = await env.ROOMS.getByName(r.id)
            .search(actor, { ...query, limit: 4 })
            .catch(() => null);
          if (!res || "err" in res) return null;
          const found = res.ok;
          const all = [
            ...found.groups.todo,
            ...found.groups.files,
            ...found.groups.messages,
          ];
          return {
            roomId: r.id,
            roomName: r.name,
            results: all.slice(0, 3),
            hasMore:
              all.length > 3 || Object.values(found.hasMore).some(Boolean),
          };
        }),
      );
      return json({
        q: query.q,
        rooms: rooms.filter(
          (r): r is NonNullable<typeof r> => !!r && r.results.length > 0,
        ),
      });
    },
  },
  // GET /home: what is waiting on me across rooms, one line per room, as data.
  {
    method: "GET",
    match: "/home",
    handler: async (c) => {
      const { env } = c;
      const user = c.user;

      const rooms = await myTopics(env, user);
      const live = rooms.filter(
        (r) => r.active && r.summary && !r.summary.archived,
      );
      return json({
        mine: live.flatMap((r) =>
          r.summary!.mine.map((item) => ({
            roomId: r.id,
            roomName: r.name,
            item,
          })),
        ),
        rooms: live.map((r) => ({
          roomId: r.id,
          name: r.name,
          counts: r.summary!.counts,
          working: r.summary!.workingNames,
        })),
      });
    },
  },
  // /app: the topics on the left, the big box in the middle (a phone: the topic list; a new person: the form).
  {
    method: "GET",
    match: /^\/app(?:\/new)?$/,
    handler: async (c) => {
      const { env, path, lang } = c;
      const user = c.user;

      const [topics, shell] = await Promise.all([
        myTopics(env, user),
        shellOf(env, user),
      ]);
      return appPage(lang, user, {
        topics: topicsForPage(topics),
        shell,
        binAfterDays: (await retentionDays(env)).binAfterDays,
        code: suggestCode(),
        form: path === "/app/new",
      });
    },
  },
  // The left column's list, again every 30 seconds and when the window comes back (the same numbers as /app).
  {
    method: "GET",
    match: "/app/topics.json",
    handler: async (c) => {
      const { env } = c;
      const user = c.user;

      const [topics, shell, days] = await Promise.all([
        myTopics(env, user),
        shellOf(env, user),
        retentionDays(env),
      ]);
      return json({
        topics: topicsForPage(topics),
        me: shell,
        binAfterDays: days.binAfterDays,
        at: Date.now(),
      });
    },
  },
  {
    method: "POST",
    match: "/app/pin",
    handler: async (c) => {
      const { req, env } = c;
      const user = c.user;

      const b = await readBody(req);
      return json(
        await setPin(
          env,
          user,
          str(b.topicId, 80),
          b.pinned === true || b.pinned === "true",
          Date.now(),
        ),
      );
    },
  },
];

export const createTopicRoutes: Route<SignedRouteContext>[] = [
  {
    method: "POST",
    match: "/rooms",
    handler: async (c) => {
      const { req, env, ctx, lang, t } = c;
      const user = c.user;

      // The new-topic form and the big box on /app send JSON and show a refusal where the person typed;
      // a plain form post (an older page) still gets a page.
      const asJson = (req.headers.get("accept") || "").includes(
        "application/json",
      );
      const b = await readBody(req);
      let id: string, code: string;
      try {
        const topic = multiline(b.topic, TOPIC_MAX, "A description");
        // The big box sends only the description: the name is its first line's first 20 characters, changeable later.
        const name =
          str(b.name, 80).trim() ||
          cutChars(topic.split("\n")[0].trim(), 20).trim();
        // No code at all gets one made up (private); public, or code='', means none.
        code =
          b.public === true || b.public === "true"
            ? ""
            : b.code == null
              ? suggestCode()
              : str(b.code, 40).trim();
        if (!name) {
          if (asJson) throw new ApiError("bad_request", t.nameNeeded);
          return redirect("/app");
        }
        id = await createRoom(env, ctx, user, { name, topic, code });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (asJson) {
          const message =
            e.code === "room_limit"
              ? t.roomLimitForm
              : e.code === "rate_limited"
                ? t.roomsPerDay
                : e.code === "bad_code"
                  ? t.codeTooShort
                : e.next;
          return json({ error: e.code, message }, e.status);
        }
        if (e.code === "bad_code") return messagePage(lang, user, t.enterCode, t.codeTooShort, 400);
        if (e.code !== "room_limit" && e.code !== "rate_limited") throw e;
        return e.code === "room_limit"
          ? messagePage(lang, user, t.roomLimitTitle, t.roomLimit, 429)
          : messagePage(lang, user, t.roomsPerDayTitle, t.roomsPerDay, 429);
      }
      const to = `/r/${id}#invite=${encodeURIComponent(code)}`;
      return asJson ? json({ topicId: id, code, url: to }) : redirect(to);
    },
  },
];
