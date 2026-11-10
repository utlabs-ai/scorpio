import type { Actor, Counts, Deleted, Item, TodoOp } from "./room-do";
import type { PushPayload } from "./push";

type Row = Record<string, unknown>;
export type Refusal = { code: string; next: string; status?: number };

export const NO_DESC_NEXT = "A task stores no description: write it in the message (send … add= / update=); the task shows the thread of its messages.";
export const TO_PERSON_NEXT = (name: string) => `A task for a person comes from a message to them: @${name} in it (or let them write it).`;

export function blockersOf(row: Row): number[] {
  try {
    return JSON.parse((row.blocked_by as string) || "[]");
  } catch {
    return [];
  }
}

export function itemViewOf(row: Row, blocked: boolean, asked: Pick<Item, "current" | "reply">): Item {
  return {
    id: `T${row.n}`,
    round: 1,
    title: row.title as string,
    desc: (row.descr as string) ?? null,
    blockedBy: blockersOf(row).map((b) => `T${b}`),
    blocked,
    status: row.status as string,
    assignee: (row.assignee as string) ?? null,
    createdBy: row.created_by as string,
    createdSeq: (row.created_seq as number) ?? null,
    doneSeq: (row.done_seq as number) ?? null,
    createdMs: row.created_ms as number,
    doneMs: (row.done_ms as number) ?? null,
    updatedBy: row.updated_by as string,
    updatedMs: row.updated_ms as number,
    ...asked,
  };
}

export function countsOf(rows: { status: unknown; k: unknown }[]): Counts {
  const c = { todo: 0, doing: 0, done: 0, total: 0 };
  for (const row of rows) {
    if (row.status === "todo" || row.status === "doing" || row.status === "done") c[row.status] = row.k as number;
  }
  c.total = c.todo + c.doing + c.done;
  return c;
}

export function deletedOf(row: Row): Deleted {
  return { id: `T${row.n}`, title: row.title as string, assignee: (row.assignee as string) ?? null, createdBy: row.created_by as string, by: row.by_name as string, ms: row.ms as number };
}

export function itemNumberOf(id: unknown): number | null {
  const match = /^[TP]?(\d+)$/i.exec(String(id || "").trim());
  return match ? Number(match[1]) : null;
}

export function closedRefusal(row: Row): Refusal | null {
  return row.status === "done" ? { code: "item_closed", next: `T${row.n} is already delivered. Open a new task if there is more to do.`, status: 409 } : null;
}

export function idsOf(list: string[] | undefined): string[] {
  return (list || []).map((x) => String(x).trim()).filter(Boolean);
}

export function memberNameOf(to: string): string {
  return to.trim().replace(/^@/, "");
}

export function assigneeRefusal(name: string, member: { status?: unknown; kind?: unknown } | undefined): Refusal | null {
  if (member && member.status === "active" && member.kind !== "host") return null;
  return { code: "bad_request", next: `to=${name}: give it to a person or an agent in this topic by full name (a person is their account, an agent role@account; see scorpio members).` };
}

export function toPersonRefusal(name: string | null, author: string, mentions: string[], isPerson: boolean): Refusal | null {
  if (!name || name === author || !isPerson || mentions.includes(name)) return null;
  return { code: "bad_request", next: TO_PERSON_NEXT(name) };
}

export function addInputs(p: { title?: string; desc?: string; from?: number | null }): { title: string; from: number | null } | Refusal {
  if (p.desc !== undefined) return { code: "bad_request", next: NO_DESC_NEXT };
  const title = (p.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!title) return { code: "bad_request", next: "add='<title>' is required: one line, one thing that will be delivered on its own." };
  const from = p.from != null && Number(p.from) > 0 ? Math.floor(Number(p.from)) : null;
  return { title, from };
}

export function activePushRecipient(member: { kind?: unknown; status?: unknown } | undefined): boolean {
  return member?.kind === "human" && member.status === "active";
}

export function assignedPush(item: Item, actor: Pick<Actor, "name" | "kind">, toIsHuman: boolean, inView: boolean, info: { id: string; name: string }, byDisplayName: string | undefined, seq?: number): PushPayload | null {
  const to = item.assignee;
  if (!to || to === actor.name || item.status === "done" || !toIsHuman || inView) return null;
  return {
    type: "todo_assigned",
    room: { id: info.id, name: info.name },
    seq: seq ?? item.createdSeq,
    item: { id: item.id, title: item.title },
    tag: `todo:${info.id}:${item.id}`,
    url: seq != null ? `/r/${info.id}?jump=${seq}` : `/r/${info.id}#todo`,
    by: actor.name,
    byDisplayName: actor.kind === "human" ? byDisplayName : undefined,
  };
}

export function rateStep(state: { minute: number; n: number }, minute: number, max: number): { state: { minute: number; n: number }; over: boolean } {
  const next = state.minute === minute ? { minute, n: state.n + 1 } : { minute, n: 1 };
  return { state: next, over: next.n > max };
}

export function personMayCase(p: TodoOp): "fromMessage" | "doneOrUndo" | "other" {
  const undo = p.op === "edit" && p.status === "todo" && p.title === undefined && p.desc === undefined && p.to === undefined && p.after === undefined && p.from == null;
  const fromMessage = p.op === "add" && p.from != null && p.from > 0 && p.to === undefined && p.desc === undefined && !p.after?.length && p.status === undefined && !p.force;
  if (fromMessage) return "fromMessage";
  return p.op === "done" || undo ? "doneOrUndo" : "other";
}

export function titleOf(text: string, files: { name: string }[], seq: number): string {
  const line = text.replace(/^(\s*@[A-Za-z0-9_.@-]+)*\s*/, "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  const title = line || files[0]?.name || `#${seq}`;
  return [...title].length > 80 ? [...title].slice(0, 79).join("") + "…" : title;
}

export function makesCycle(n: number, after: number[], blockedBy: Map<number, number[]>): boolean {
  const seen = new Set<number>();
  const stack = [...after];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === n) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(blockedBy.get(x) ?? []));
  }
  return false;
}

export function takeDecision(row: Row, actor: Actor, force: boolean, openBlockers: number[]): { refusal: Refusal } | { previous: Record<string, unknown>; fields: { assignee: string; status: "doing" } } {
  const n = row.n as number;
  const holder = (row.assignee as string) ?? null;
  if (row.status === "doing" && holder && holder !== actor.name && !force) {
    return { refusal: { code: "item_taken", next: `${holder} is doing T${n}. To take it over anyway: todo take=T${n} force=true, then tell ${holder}.`, status: 409 } };
  }
  if (openBlockers.length && !force) {
    return { refusal: { code: "item_blocked", next: `T${n} waits for ${openBlockers.map((x) => `T${x}`).join(", ")}, not delivered yet. Take something that can start (scorpio todo), or force=true to start anyway.`, status: 409 } };
  }
  const previous: Record<string, unknown> = {};
  if (holder !== actor.name) previous.assignee = holder;
  if (row.status !== "doing") previous.status = row.status;
  return { previous, fields: { assignee: actor.name, status: "doing" } };
}

export function closePlan(row: Row, actor: Actor, seq: number | null, nowMs: number): { assignee: string | null; previous: Record<string, unknown>; fields: { status: "done"; done_seq: number | null; done_ms: number; assignee: string | null }; logTo: Record<string, unknown> } {
  const holder = (row.assignee as string) ?? null;
  const assignee = holder ?? (actor.kind === "agent" ? actor.name : null);
  const previous: Record<string, unknown> = { status: row.status };
  if (assignee !== holder) previous.assignee = holder;
  return {
    assignee,
    previous,
    fields: { status: "done", done_seq: seq, done_ms: nowMs, assignee },
    logTo: { status: "done", ...(assignee !== holder ? { assignee } : {}), ...(seq ? { doneSeq: seq } : {}) },
  };
}

export function deleteDecision(rows: Row[], actor: Actor, force: boolean): Refusal | null {
  for (const row of rows) {
    const holder = (row.assignee as string) ?? null;
    if (row.status === "doing" && holder && holder !== actor.name && !force) {
      return { code: "item_taken", next: `${holder} is doing T${row.n}. To delete it anyway: todo delete=T${row.n} force=true, then tell ${holder}.`, status: 409 };
    }
  }
  return null;
}

export function editPlan(
  row: Row,
  actor: Actor,
  p: Pick<TodoOp, "title" | "desc" | "to" | "from" | "after" | "status" | "force">,
  deps: {
    assigneeOf(to: string): string | null;
    messageExists(seq: number): boolean;
    itemNumbers(list: string[] | undefined): number[];
    blockersMap(): Map<number, number[]>;
  },
  again: (to: string) => string,
  nowMs: number,
): { refusal: Refusal } | { fields: Record<string, unknown>; prev: Record<string, unknown>; next: Record<string, unknown>; closing: boolean } | null {
  const n = row.n as number;
  const holder = (row.assignee as string) ?? null;
  const othersDoing = row.status === "doing" && !!holder && holder !== actor.name;
  const fields: Record<string, unknown> = {};
  const prev: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  const change = (key: string, field: string, from: unknown, to: unknown, shown: unknown = to) => {
    fields[field] = to;
    prev[key] = from;
    next[key] = shown;
  };
  if (p.title !== undefined) {
    const title = (p.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title) return { refusal: { code: "bad_request", next: "title= cannot be empty." } };
    if (title !== row.title) change("title", "title", row.title, title);
  }
  if (p.desc !== undefined) return { refusal: { code: "bad_request", next: NO_DESC_NEXT } };
  if (p.to !== undefined) {
    const to = deps.assigneeOf(p.to || "");
    if (to !== holder) {
      if (othersDoing && !p.force) {
        return { refusal: { code: "item_taken", next: `${holder} is doing T${n}. To hand it over anyway: ${again(to ?? "")}, then tell ${holder}.`, status: 409 } };
      }
      change("assignee", "assignee", holder, to);
    }
  }
  if (p.from != null) {
    const seq = Number(p.from);
    if (!(seq > 0)) return { refusal: { code: "bad_request", next: "from= is the seq of the message the task came from." } };
    const from = Math.floor(seq);
    if (!deps.messageExists(from)) return { refusal: { code: "message_not_found", next: `from=${from}: there is no such message.`, status: 404 } };
    if (from !== ((row.created_seq as number) ?? null)) change("createdSeq", "created_seq", (row.created_seq as number) ?? null, from);
  }
  if (p.after !== undefined) {
    const after = deps.itemNumbers(p.after);
    if (after.includes(n) || makesCycle(n, after, deps.blockersMap())) {
      return { refusal: { code: "item_cycle", next: `T${n} cannot wait on ${after.map((x) => `T${x}`).join(", ")}: that would make it wait on itself.`, status: 409 } };
    }
    const old = blockersOf(row);
    if (JSON.stringify(after) !== JSON.stringify(old)) change("blockedBy", "blocked_by", old.map((x) => `T${x}`), JSON.stringify(after), after.map((x) => `T${x}`));
  }
  let closing = false;
  if (p.status !== undefined) {
    const status = String(p.status);
    if (status !== "todo" && status !== "doing" && status !== "done") return { refusal: { code: "bad_request", next: "status= is todo, doing or done." } };
    if (status !== row.status) {
      change("status", "status", row.status, status);
      if (status === "done") {
        fields.done_ms = nowMs;
        closing = true;
      } else {
        fields.done_ms = null;
        fields.done_seq = null;
      }
      if (status === "doing" && !("assignee" in fields ? fields.assignee : holder)) change("assignee", "assignee", holder, actor.name);
    }
  }
  if (!Object.keys(fields).length) return null;
  return { fields, prev, next, closing };
}

export function editTitleRefusal(row: Row, title: string | undefined, holderIsPerson: boolean, roomId: string): Refusal | null {
  if (title === undefined || !holderIsPerson) return null;
  const holder = (row.assignee as string) ?? null;
  return { code: "bad_request", next: `T${row.n} is ${holder}'s: its title changes with a message to them: scorpio send roomId=${roomId} replyTo=<seq> text='@${holder} …' update=T${row.n} title='…'.` };
}
