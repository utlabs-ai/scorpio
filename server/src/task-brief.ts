// Short open items for agents (CLI 0.5.3; docs/api/tasks.md): what is
// theirs, what they opened and wait for from others, and the whole topic's. No imports beyond types, so the node
// tests run it as is.

import type { Item } from "./room-do";

export type Brief = {
  id: string;
  title: string;
  status: string; // todo | doing (a Brief is never done)
  assignee: string | null;
  by: string; // createdBy
  after: string[]; // blockedBy
  blocked: boolean;
  since: number; // updatedMs: when it last changed
  reply: { seq: number; from: string } | null; // a person's reply waiting on it
  left: boolean; // the assignee is no longer in the topic
};

/** `present`: the names of the topic's active members. */
export function brief(i: Item, present: Set<string>): Brief {
  return {
    id: i.id,
    title: i.title,
    status: i.status,
    assignee: i.assignee,
    by: i.createdBy,
    after: i.blockedBy,
    blocked: i.blocked,
    since: i.updatedMs,
    reply: i.reply ? { seq: i.reply.seq, from: i.reply.from } : null,
    left: !!i.assignee && !present.has(i.assignee),
  };
}

const open = (items: Item[]) => items.filter((i) => i.status === "todo" || i.status === "doing");
const oldestChangeFirst = (a: Item, b: Item) => a.updatedMs - b.updatedMs || a.id.localeCompare(b.id, "en", { numeric: true });

/** Open items under `me`, oldest change first (task mine=true's `yours`; done, join and leave answers). */
export function yoursOf(items: Item[], me: string, present: Set<string>): Brief[] {
  return open(items).filter((i) => i.assignee === me).sort(oldestChangeFirst).map((i) => brief(i, present));
}

/** task mine=true: `yours`, and `opened` — open items `me` created under someone else's name (what it waits for). */
export function mineOf(items: Item[], me: string, present: Set<string>): { yours: Brief[]; opened: Brief[] } {
  const opened = open(items).filter((i) => i.createdBy === me && !!i.assignee && i.assignee !== me);
  return { yours: yoursOf(items, me, present), opened: opened.sort(oldestChangeFirst).map((i) => brief(i, present)) };
}

/** task open=true [to=]: every open item of the topic in id order, or those under one name. */
export function openOf(items: Item[], to: string | null, present: Set<string>): Brief[] {
  const num = (i: Item) => Number(i.id.slice(1));
  return open(items).filter((i) => to == null || i.assignee === to).sort((a, b) => num(a) - num(b)).map((i) => brief(i, present));
}
