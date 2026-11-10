// The topics on a person's left column and on /app: owned, current membership, or previously visited and still public,
// each with its own numbers from its room object, and whether they pinned it.

import { ApiError } from "./util";
import type { RoomSummary } from "./room-do";
import { CAN_SEE_SQL, MY_TOPICS_SQL } from "./app-topics-sql";

export interface MyTopic {
  id: string;
  name: string;
  topic: string; // the description
  owned: boolean;
  active: boolean; // created it, or a member who has not left
  summary: RoomSummary | null;
  archivedAt: number | null;
  archivedReason: string | null;
  pinnedAt: number | null;
}

type Row = { id: string; name: string; topic: string; owned: number; active: number | null; archived_at: number | null; archived_reason: string | null; pinned_at: number | null };

export async function myTopics(env: Env, user: { id: string; handle: string }): Promise<MyTopic[]> {
  const { results } = await env.DB.prepare(MY_TOPICS_SQL).bind(user.id).all<Row>();
  // Each room's own numbers (tasks, people, last activity), one small call per room.
  const topics = await Promise.all(
    results.map(async (r) => {
      const sum = await env.ROOMS.getByName(r.id).summary(user.handle).catch(() => null);
      // The DO is the truth when a privacy or membership change has not reached the index yet.
      if (sum && "err" in sum && sum.err.code === "not_member") return null;
      return {
        id: r.id,
        name: r.name,
        topic: r.topic,
        owned: !!r.owned,
        active: !!r.owned || r.active === 1,
        summary: sum && "ok" in sum ? sum.ok : null,
        archivedAt: r.archived_at,
        archivedReason: r.archived_reason,
        pinnedAt: r.pinned_at,
      };
    }),
  );
  return topics.filter((topic): topic is NonNullable<typeof topic> => topic !== null);
}

/** What the page script needs per topic: no more than the old home page used, and the pin. */
export function topicsForPage(topics: MyTopic[]) {
  return topics.map((t) => {
    const s = t.summary;
    return {
      id: t.id,
      name: t.name,
      desc: t.topic,
      owned: t.owned,
      active: t.active,
      pinnedAt: t.pinnedAt,
      archivedAt: t.archivedAt,
      archived: !!s?.archived,
      public: !!s?.public,
      lastMs: s?.lastMs ?? 0,
      agents: s?.agents ?? 0,
      humans: s?.humans ?? 0,
      working: s?.working ?? 0,
      open: s ? s.counts.todo + s.counts.doing : 0,
      // what waits on me: how many, and since when the oldest has
      mine: s?.mine.length ?? 0,
      mineSince: s && s.mine.length ? Math.min(...s.mine.map((i) => i.createdMs)) : null,
      // what I have not read there (null when I am not in it as a person), and how many of those @ me
      unread: s?.unread ?? null,
      mentionUnread: s?.mentionUnread ?? 0,
      known: !!s,
    };
  });
}
export type PageTopic = ReturnType<typeof topicsForPage>[number];

/** Pin or unpin one topic for this person; only one they can see (created it, or a member). */
export async function setPin(env: Env, user: { id: string }, topicId: string, pinned: boolean, at: number): Promise<{ topicId: string; pinnedAt: number | null }> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(topicId)) throw new ApiError("bad_request", "topicId=<topic id> is required.");
  const seen = await env.DB.prepare(CAN_SEE_SQL).bind(user.id, topicId).first<{ ok: number }>();
  if (!seen) throw new ApiError("room_not_found", "No such topic for you.", 404);
  if (pinned) {
    await env.DB.prepare("INSERT INTO pins (user_id, room_id, pinned_at) VALUES (?, ?, ?) ON CONFLICT (user_id, room_id) DO UPDATE SET pinned_at = excluded.pinned_at").bind(user.id, topicId, at).run();
    return { topicId, pinnedAt: at };
  }
  await env.DB.prepare("DELETE FROM pins WHERE user_id = ? AND room_id = ?").bind(user.id, topicId).run();
  return { topicId, pinnedAt: null };
}

export function pinsGone(env: Env, roomId: string) {
  return env.DB.prepare("DELETE FROM pins WHERE room_id = ?").bind(roomId);
}
