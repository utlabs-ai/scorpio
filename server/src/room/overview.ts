// The topic's overview (docs/api/topics.md "The overview"): who talked with whom over the last 7 days, the agents grouped
// by lane and ordered by activity, as one pure function over three domain reads (members, messages' window counts,
// tasks' deliveries). No SQL here: RoomDO.overview gathers the rows and calls overviewOf; the test feeds it plain values.
import type { Member } from "./types";

export const OVERVIEW_WINDOW_MS = 7 * 86_400_000;
/** A delivered task weighs this many messages in the activity sum (the weight is a first guess; the page shows the number). */
export const DELIVERED_WEIGHT = 10;

/** What the overview reads of each member. */
export type OverviewMember = Pick<Member, "name" | "kind" | "lane" | "status" | "online" | "lastActive">;
/** Messages per sender in the window (from_kind human | agent | scheduled). */
export type SentRow = { from_name: string; from_kind: string; n: number };
/** Messages per (sender, @target) in the window. */
export type MentionRow = { from_name: string; from_kind: string; target: string; n: number };
/** Tasks delivered in the window per assignee. */
export type DeliveredRow = { assignee: string; n: number };

export interface OverviewInput {
  roomId: string;
  members: OverviewMember[];
  sent: SentRow[];
  mentions: MentionRow[];
  delivered: DeliveredRow[];
  since: number;
  until: number;
  /** The calling member's name when it is a person: listed in `people` even when silent, so the page has its node. */
  person: string | null;
}

export interface OverviewAgent { name: string; lane: string | null; activity: number; sent: number; mentioned: number; delivered: number }
export interface OverviewLane { lane: string | null; activity: number; stacked: boolean; agents: string[] }
export interface Overview {
  roomId: string;
  since: number;
  until: number;
  messages: number;
  people: { name: string; sent: number; mentioned: number }[];
  agents: OverviewAgent[];
  lanes: OverviewLane[];
  pairs: { a: string; b: string; n: number }[];
  scheduled: { to: string; n: number }[];
}

export function overviewOf(p: OverviewInput): Overview {
  // The nodes: people and agents the topic still has (left ones too). Computer seats and names no longer in members are
  // dropped on both ends: a line to a node that is not drawn says nothing.
  const nodes = new Map<string, OverviewMember & { sent: number; mentioned: number; delivered: number }>();
  for (const m of p.members) if (m.kind === "human" || m.kind === "agent") nodes.set(m.name, { ...m, sent: 0, mentioned: 0, delivered: 0 });
  let messages = 0;
  for (const r of p.sent) {
    messages += r.n;
    const node = r.from_kind === "scheduled" ? undefined : nodes.get(r.from_name);
    if (node) node.sent += r.n;
  }
  const pairs = new Map<string, number>();
  const scheduled = new Map<string, number>();
  for (const r of p.mentions) {
    const target = nodes.get(r.target);
    if (!target) continue;
    if (r.from_kind === "scheduled") {
      target.mentioned += r.n;
      scheduled.set(r.target, (scheduled.get(r.target) ?? 0) + r.n);
      continue;
    }
    if (r.from_name === r.target) continue; // an @ of oneself
    target.mentioned += r.n;
    if (!nodes.has(r.from_name)) continue;
    const key = [r.from_name, r.target].sort().join("\n");
    pairs.set(key, (pairs.get(key) ?? 0) + r.n);
  }
  for (const r of p.delivered) {
    const node = nodes.get(r.assignee);
    if (node && node.kind === "agent") node.delivered += r.n;
  }
  const activity = (n: { sent: number; mentioned: number; delivered: number }) => n.sent + n.mentioned + DELIVERED_WEIGHT * n.delivered;
  const agents: OverviewAgent[] = [];
  const people: Overview["people"] = [];
  for (const n of nodes.values()) {
    if (n.kind === "agent") {
      if (activity(n) > 0 || (n.lastActive ?? 0) >= p.since) agents.push({ name: n.name, lane: n.lane ?? null, activity: activity(n), sent: n.sent, mentioned: n.mentioned, delivered: n.delivered });
    } else if (n.sent > 0 || n.mentioned > 0 || n.name === p.person) people.push({ name: n.name, sent: n.sent, mentioned: n.mentioned });
  }
  agents.sort((a, b) => b.activity - a.activity || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  people.sort((a, b) => (a.name === p.person ? -1 : b.name === p.person ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // One column per lane, and one with lane: null for agents without one. Stacked: none of its agents is in the topic
  // and online now. Those that are not stacked first, then the stacked ones, each by activity; ties by lane, null last.
  const byLane = new Map<string | null, OverviewLane>();
  for (const a of agents) {
    const lane = byLane.get(a.lane) ?? { lane: a.lane, activity: 0, stacked: true, agents: [] };
    lane.activity += a.activity;
    lane.agents.push(a.name); // agents is already by activity
    const m = nodes.get(a.name)!;
    if (m.status === "active" && m.online) lane.stacked = false;
    byLane.set(a.lane, lane);
  }
  const lanes = [...byLane.values()].sort((a, b) =>
    Number(a.stacked) - Number(b.stacked) || b.activity - a.activity || (a.lane === null ? 1 : b.lane === null ? -1 : a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
  return {
    roomId: p.roomId,
    since: p.since,
    until: p.until,
    messages,
    people,
    agents,
    lanes,
    pairs: [...pairs].map(([key, n]) => { const [a, b] = key.split("\n"); return { a, b, n }; }).sort((x, y) => y.n - x.n || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1)),
    scheduled: [...scheduled].map(([to, n]) => ({ to, n })).sort((x, y) => y.n - x.n || (x.to < y.to ? -1 : 1)),
  };
}
