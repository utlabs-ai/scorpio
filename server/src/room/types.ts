// The types RoomDO's RPCs answer with and take, shared by the room domains and, through room-do.ts's re-export, by the
// routes, actions and pages. Types only: no runtime import.

import type { MemberPerm, SpawnPerm } from "../spawn-perm";
import type { FileMeta } from "../files";
import type { Rel } from "../item-thread";
import type { HandoffMeta } from "../handoff";
import type { Rule } from "../schedules";

/** What a system line is about: someone joined or left, an uploader's oldest files were evicted, a computer logged out. */
export type SystemEvent = { type: "join" | "leave"; name: string } | { type: "renamed"; from: string; to: string } | { type: "topic_renamed"; by: string; from: string; to: string } | { type: "evicted"; name: string; files: { name: string; size: number }[] } | { type: "schedule_created"; who: string; id: string; rule: Rule; to: string[]; first: number } | { type: "schedule_deleted"; who: string; id: string; rule: Rule; to: string[] } | { type: "logged_out"; name: string; device: string };

export interface Message {
  seq: number;
  from: string;
  fromKind: string;
  kind: string;
  text: string;
  screen?: import("../room-screen").Screen;
  mentions: string[];
  broadcast: boolean;
  reply: { seq: number; from: string; text: string } | null;
  command: string | null;
  event: SystemEvent | null;
  memo?: { cite: string[]; misled: string[]; uncounted?: { id: string; reason: string }[] };
  buttons?: import("../room-rich-message").Button[] | null;
  card?: { kind: "html"; summary: string; size: number } | null;
  scheduled: { id: string; by: string; at: number } | null;
  files?: (FileMeta & { url: string; link: string; view: boolean; deleted?: number })[]; // link: its own page, view: a row opens it; deleted: when it went
  delivery?: { name: string; status: string; host_offline_since?: number; takeover?: string; takeover_seq?: number; renamedTo?: string }[];
  // The items this message opened (source), delivered (result) or reported to as a person's reply (reply).
  todo?: { id: string; title: string; assignee: string | null; status: string; round: number; rel: Rel; closer?: string }[];
  ts: number;
}

/** A TODO item (docs/api/tasks.md). */
export interface Item {
  id: string; // T<n>
  round: number;
  title: string;
  desc: string | null;
  blockedBy: string[];
  blocked: boolean;
  status: string; // todo | doing | done
  assignee: string | null; // a member name: an agent or a person
  createdBy: string;
  createdSeq: number | null;
  doneSeq: number | null;
  createdMs: number;
  doneMs: number | null;
  updatedBy: string;
  updatedMs: number;
  reply: { seq: number; from: string; ts: number; closer: string } | null; // who closes the latest report
  current: { seq: number; from: string; ts: number; line: string } | null; // what the assignee is asked now
  thread?: { seq: number; from: string; kind: string; ts: number; rel: Rel }[]; // task show= and the web's detail only
}

export type Counts = { todo: number; doing: number; done: number; total: number };

/** An item deleted in the last 24 hours: a delivery can say who deleted it. */
export type Deleted = { id: string; title: string; assignee: string | null; createdBy: string; by: string; ms: number };

export interface Round {
  n: number;
  title: string | null;
  status: string; // open | done
  openedMs: number;
  doneMs: number | null;
  counts: Counts;
}

export interface Member {
  name: string;
  kind: string;
  owner: string;
  displayName: string | null; // people: the account's display name, the handle itself until they set one; null for agents and hosts
  roleCard: string | null;
  roleCardBy: string | null; // who last wrote the role card: the agent itself, or its owner on the web; null before that was kept
  roleCardAt: number | null; // when
  lane: string | null; // agents: the line of work it is on (docs/api/topics.md "The lane"); null when none
  laneBy: string | null; // who set the lane last: the agent itself, or its person on the web; null when none
  laneAt: number | null; // when
  status: string;
  lastActive: number | null;
  online: boolean;
  cursor: number; // last seq this member marked read; drives read receipts
  work: string | null; // working | idle | blocked (stopped at an approval or question screen), from the daemon; null = unknown
  workSince: number | null; // since when `work` has had its value
  workReason: string | null; // blocked only: what it is stopped at, in a few words from the daemon
  host: string | null; // agents: the daemon seat that carries it (or last did, while that one is offline)
  hostOfflineSince: number | null; // a seat whose connection is gone, and the agents it carried: since when
  idleHandoffMinutes: number | null; // host seats: that computer's idle_handoff_minutes (0 = off)
  device: { name: string; hostname?: string; note: string | null } | null;
  clis?: { kind: string; installed: boolean; version: string | null; at: number }[] | null; // only the seat's account receives its CLI report
  perm: MemberPerm | null; // daemon carry only; visible to this account
  perms: SpawnPerm[] | null; // host join capability; visible to this account
  handoff: HandoffMeta | null; // agents: the seat's handoff in the cloud, never its text; null when it has none
}

/** A seat's handoff as the API answers it; `body` only where the text is asked for. */
export type Handoff = HandoffMeta & { roomId: string; name: string; body?: string };

/** What the handoff's page shows: the topic, the seat (null: not in the topic), its handoff (null: none). */
export interface HandoffView {
  room: { id: string; name: string; public: boolean; archived: boolean };
  seat: { name: string; owner: string; kind: string; status: string } | null;
  handoff: (HandoffMeta & { body: string }) | null; // the text too: the page renders it as messages are (md.js)
  member: boolean; // the reader is in the topic (a viewer of a public topic is not): only a member deletes (deleteHandoff)
}

export interface RoomInfo {
  id: string;
  name: string;
  topic: string;
  owner: string;
  hasCode: boolean; // a passcode is set (in a public room it is kept for going private again, not asked for)
  public: boolean; // anyone signed in with the link can enter, no passcode (D1 visibility link)
  archived: boolean; // read-only: no sending, uploading or TODO changes; the owner can restore it
  archivedAt: number | null; // since when (ms): the retention clock purges it after 90 days
  archivedReason: string | null; // "retention": 90 days without a message; "downgrade": its owner's Pro lapsed; null: its owner archived it
  createdAt: number;
}

export interface RoomSummary {
  counts: Counts; // open items and items completed in the last 24 hours
  todayMessages: number; // counted messages in this room since 00:00 UTC
  working: number;
  workingNames: string[]; // agents at work now (connected, daemon says working)
  mine: Item[]; // open items under this person's name, across the old stored rounds
  public: boolean;
  archived: boolean;
  lastMs: number; // the last message (system lines included), else when the room was made
  humans: number;
  agents: number;
  unread: number | null; // messages by others past my cursor; null when I am not in the room as a person
  mentionUnread: number;
}

export interface SendOp {
  text: string;
  cite?: unknown;
  misled?: unknown;
  screen?: unknown;
  buttons?: unknown;
  card?: unknown;
  lang?: "en" | "zh";
  replyTo?: number | null;
  nonce?: string;
  files?: string[];
  echo?: boolean; // the web reconciles its sent card even when its WebSocket missed the message frame
  done?: string;
  add?: string; // opens a TODO item with this message (to, desc, after as for todo add)
  update?: string; // makes this message the item's source, and with `to` reassigns it (CLI 0.5.3; force as for edit)
  force?: boolean;
  to?: string;
  desc?: string; // refused (items have no description)
  title?: string; // with update= only: renames the item in the same step (CLI 0.5.8)
  after?: string[];
}

export interface ScheduleOp {
  op: string;
  id?: string;
  text?: string;
  rule?: Rule;
  revive?: boolean;
  calendar?: boolean;
  nonce?: string;
  files?: unknown;
}

/** A TODO request (POST /todo, docs/api/tasks.md): undefined fields are not given; "" clears where that means something. */
export interface TodoOp {
  op: string;
  id?: string;
  ids?: string[];
  title?: string;
  desc?: string;
  to?: string;
  after?: string[];
  status?: string;
  from?: number | null;
  force?: boolean;
}
