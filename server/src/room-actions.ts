// Room actions shared by the agent and page routes. HTTP parsing and responses stay in index.ts.
import type { ApprovalAnswerResult } from "./room-approvals";
import { ApiError, multiline, randomId, str } from "./util";
import { cleanCut } from "./text";
import { laneOf } from "./lane";
import { filterNumber, searchFilters, searchQuery } from "./search";
import { archiveRow, checkRoomQuota, createRow, deleteState, dropMember, dropMemberByHandle, inRoom, markRoomDeleted, ownerAndStatus, restoreRow, retryIndexWrite, roomsChanged, setNameRow, setTopicRow, setVisibilityRow, suggestCode } from "./room-index";
import type { Actor, ListFilesQuery, Result, RoomDO, TodoOp, ScheduleOp } from "./room-do";
import type { Lang } from "./layout";
import { LOCAL_ONLY, computerOf, handoffText } from "./handoff";
import { requireNewCode } from "./room/room";

import { memberFilters } from "./member-filters";

type RoomStub = DurableObjectStub<RoomDO>;
export const TOPIC_MAX = 2000;
export const ROLE_CARD_MAX = 1000;

export function unwrap<T>(r: Result<T>): T {
  if ("err" in r) throw new ApiError(r.err.code, r.err.next, r.err.status, r.err.retryAfter, r.err.extra);
  return r.ok;
}

/** A list of item ids: ["T3","T4"] or "T3,T4"; undefined when not given ("" clears it). */
function idsOf(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v.map(String) : String(v).split(",");
  return list.map((x) => x.trim()).filter(Boolean).slice(0, 100);
}

const given = (v: unknown, max: number) => (v === undefined || v === null ? undefined : str(v, max));

function todoOf(b: Record<string, unknown>): TodoOp {
  return {
    op: str(b.op, 20),
    id: str(b.id, 20) || undefined,
    ids: idsOf(b.ids),
    title: given(b.title, 300),
    desc: given(b.desc, 8000),
    to: given(b.to, 120),
    after: idsOf(b.after),
    status: given(b.status, 10),
    from: b.from != null && b.from !== "" ? Number(b.from) : null,
    force: b.force === true || b.force === "true",
  };
}

export function filesOf(v: unknown): string[] | undefined {
  if (v == null || v === "") return undefined;
  const list = Array.isArray(v) ? v : String(v).split(",");
  return list.map((x) => String(x).trim()).filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x));
}

export function nonceOf(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v);
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(s)) throw new ApiError("bad_request", "nonce must be 1–64 characters of letters, digits, _ . : -");
  return s;
}

export async function messages(stub: RoomStub, actor: Actor, q: URLSearchParams) {
  const input = Object.fromEntries(q);
  const filters = searchFilters(input, "messages");
  if (input.q) searchQuery({ q: input.q });
  return unwrap(await stub.messages(actor, { ...filters, q: input.q, limit: input.limit === undefined ? 50 : filterNumber(input.limit, "limit", 1) }));
}

export async function message(stub: RoomStub, actor: Actor, seq: number) {
  return unwrap(await stub.message(actor, seq));
}

export async function card(stub: RoomStub, actor: Actor, seq: number) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new ApiError("bad_request", "seq must be a positive message number.");
  return unwrap(await stub.card(actor, seq));
}

export async function press(stub: RoomStub, actor: Actor, b: Record<string, unknown>) {
  return unwrap(await stub.press(actor, Number(b.seq), typeof b.index === "number" ? b.index : NaN));
}

export async function search(stub: RoomStub, actor: Actor, q: URLSearchParams) {
  return unwrap(await stub.search(actor, searchQuery(Object.fromEntries(q))));
}

export async function listen(stub: RoomStub, actor: Actor) {
  return unwrap(await stub.listen(actor));
}

// lang: the topic page's language for memo error next lines; agent routes leave it en.
export async function memoRead(stub: RoomStub, actor: Actor, q: URLSearchParams, lang: Lang = "en") {
  return unwrap(await stub.memoRead(actor, Object.fromEntries(q), lang));
}

export async function memoWrite(stub: RoomStub, actor: Actor, b: Record<string, unknown>, page: boolean, lang: Lang = "en") {
  return unwrap(await stub.memoWrite(actor, { ...b, op: b.op, nonce: nonceOf(b.nonce) }, page, lang));
}

export async function todoShow(stub: RoomStub, actor: Actor, id: string, full = false) {
  return unwrap(await (full ? stub.todoShow(actor, id, true) : stub.todoShow(actor, id)));
}

export async function answerApproval(stub: RoomStub, actor: Actor, id: string, body: Record<string, unknown>) {
  // RPC typing cannot infer the hook input whose JSON is deliberately passed through.
  const result = await stub.answerApproval(actor, id, body) as ApprovalAnswerResult;
  if ("err" in result) {
    const error = result.err;
    throw new ApiError(error.code, error.next, error.status, undefined, error.approval ? { approval: error.approval } : undefined);
  }
  return result.ok;
}

export async function schedules(stub: RoomStub, actor: Actor, id?: string) {
  return unwrap(await stub.schedules(actor, id));
}

export async function scheduleOp(stub: RoomStub, actor: Actor, b: Record<string, unknown>) {
  const p: ScheduleOp = {
    op: str(b.op, 20), id: b.id == null ? undefined : str(b.id, 30),
    text: b.text === undefined ? undefined : b.text as string,
    rule: b.rule as ScheduleOp["rule"], revive: b.revive as boolean | undefined, calendar: b.calendar as boolean | undefined,
    nonce: nonceOf(b.nonce), files: b.files,
  };
  return unwrap(await stub.scheduleOp(actor, p));
}

export async function todoBrief(stub: RoomStub, actor: Actor, query: { mine: true } | { to: string | null }) {
  return unwrap(await stub.todoBrief(actor, query));
}

export async function todoList(stub: RoomStub, actor: Actor, round?: number) {
  return unwrap(await stub.todoList(actor, round));
}

export async function members(stub: RoomStub, actor: Actor, q = new URLSearchParams()) {
  return unwrap(await stub.members(actor, memberFilters(Object.fromEntries(q))));
}

export async function send(stub: RoomStub, actor: Actor, b: Record<string, unknown>, options: { agent: boolean; files?: string[] }) {
  const base = {
    text: str(b.text, 40_000),
    ...(b.cite !== undefined ? { cite: b.cite } : {}),
    ...(b.misled !== undefined ? { misled: b.misled } : {}),
    ...(b.buttons !== undefined ? { buttons: b.buttons } : {}),
    ...(b.card !== undefined ? { card: b.card } : {}),
    ...(b.screen !== undefined ? { screen: b.screen } : {}),
    ...(b.buttons !== undefined || b.card !== undefined ? { lang: b.lang === "zh" ? "zh" as const : "en" as const } : {}),
    replyTo: options.agent ? (b.replyTo != null && b.replyTo !== "" ? Number(b.replyTo) : null) : (b.replyTo ? Number(b.replyTo) : null),
    nonce: nonceOf(b.nonce),
    files: options.files,
  };
  const p = options.agent ? {
    ...base,
    done: b.done ? str(b.done, 20) : undefined,
    add: given(b.add, 300),
    update: b.update ? str(b.update, 20) : undefined,
    force: b.force === true || b.force === "true",
    to: given(b.to, 120),
    desc: given(b.desc, 8000),
    title: given(b.title, 300),
    after: idsOf(b.after),
  } : { ...base, echo: true };
  return unwrap(await stub.send(actor, p));
}

export async function todo(stub: RoomStub, actor: Actor, b: Record<string, unknown>) {
  return unwrap(await stub.todo(actor, todoOf(b)));
}

export async function mark(stub: RoomStub, actor: Actor, b: Record<string, unknown>, options: { requireUpTo: boolean }) {
  if (options.requireUpTo && (b.upTo == null || b.upTo === "")) throw new ApiError("bad_request", "upTo=<seq> is required.");
  return unwrap(await stub.mark(actor, Number(b.upTo)));
}

export async function setRoleCard(stub: RoomStub, actor: Actor, b: Record<string, unknown>) {
  return unwrap(await stub.setRoleCard(actor, cleanCut(b.roleCard, ROLE_CARD_MAX)));
}

export async function setRoleCardFor(stub: RoomStub, actor: Actor, b: Record<string, unknown>) {
  return unwrap(await stub.setRoleCardFor(actor, str(b.name, 200), multiline(b.roleCard, ROLE_CARD_MAX, "A role card")));
}

/** An agent sets its own lane (docs/api/topics.md "The lane"); lane="" clears it. */
export async function setLane(stub: RoomStub, actor: Actor, b: Record<string, unknown>) {
  return unwrap(await stub.setLane(actor, laneOf(b.lane)));
}

/** A person sets the lane of one of their own agents from the web, a left one too. */
export async function setLaneFor(stub: RoomStub, actor: Actor, b: Record<string, unknown>) {
  return unwrap(await stub.setLaneFor(actor, str(b.name, 200), laneOf(b.lane)));
}

export async function overview(stub: RoomStub, actor: Actor) {
  return unwrap(await stub.overview(actor));
}

export async function history(stub: RoomStub, actor: Actor, before: number) {
  return unwrap(await stub.history(actor, before));
}

export async function around(stub: RoomStub, actor: Actor, seq: number) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new ApiError("bad_request", "seq= must be a positive message number.");
  return unwrap(await stub.around(actor, seq));
}

export async function mentions(stub: RoomStub, actor: Actor, before: number, limit: number, q = new URLSearchParams()) {
  return unwrap(await stub.mentions(actor, before, limit, searchFilters(Object.fromEntries(q), "mentions")));
}

export async function listFiles(stub: RoomStub, actor: Actor, q: URLSearchParams) {
  if (q.has("by") && q.has("from")) throw new ApiError("bad_request", "Use by= or its synonym from=, not both.");
  const input = Object.fromEntries(q);
  delete input.kind; delete input.from;
  if (q.has("from")) input.by = q.get("from")!;
  const { from: ignoredFrom, ...filters } = searchFilters(input, "files");
  const params: ListFilesQuery = {
    ...filters,
    kind: (q.has("kind") ? q.get("kind") : undefined) as ListFilesQuery["kind"],
    q: q.get("q") ?? undefined,
    before: q.has("before") ? Number(q.get("before")) : undefined,
    beforeId: q.has("beforeId") ? q.get("beforeId")! : undefined,
    limit: q.has("limit") ? Number(q.get("limit")) : undefined,
  };
  const out = unwrap(await stub.listFiles(actor, params));
  if (actor.kind === "human") return out;
  return { ...out, files: out.files.map(({ url, view, ...file }) => file) };
}

/** A DO change is already committed. D1 is its index: return success and repair a failed index write in waitUntil. */
async function writeRoomIndex(
  env: Env, ctx: ExecutionContext, roomId: string, action: string, expected: string,
  write: () => Promise<unknown>, after?: () => Promise<void>,
): Promise<void> {
  try {
    await write();
    if (after) ctx.waitUntil(after());
  } catch {
    ctx.waitUntil(retryIndexWrite(env, roomId, action, expected, write, after));
  }
}

/** Create the topic in its DO before writing the D1 list and membership indexes. */
export async function createRoom(env: Env, ctx: ExecutionContext, user: { id: string; handle: string }, p: { name: string; topic: string; code: string }) {
  requireNewCode(p.code || null);
  await checkRoomQuota(env, user.id, true);
  const id = randomId(22);
  const t = Date.now();
  await env.ROOMS.getByName(id).init({ id, name: p.name, topic: p.topic, owner: user.handle, code: p.code || null });
  await writeRoomIndex(env, ctx, id, "createRoom", `rooms(${id}) and room_members(${id}, ${user.id})`, async () => {
    // The membership write can fail after the room row lands; a retry must be able to finish both.
    await createRow(env, { id, ownerId: user.id, name: p.name, topic: p.topic, visibility: p.code ? "private" : "link", createdAt: t });
    await inRoom(env, id, user.id, true);
  }, () => roomsChanged(env, user, id));
  return id;
}

export async function setTopic(env: Env, ctx: ExecutionContext, stub: RoomStub, actor: Actor, _user: { id: string; handle: string }, roomId: string, value: unknown) {
  if (value == null) throw new ApiError("bad_request", "topic='<new description>' is required (topic='' clears it).");
  const topic = multiline(value, TOPIC_MAX, "A description");
  unwrap(await stub.setTopic(actor, topic));
  await writeRoomIndex(env, ctx, roomId, "setTopic", `rooms.topic=${JSON.stringify(topic)}`,
    () => setTopicRow(env, roomId, topic));
  return { roomId, topic };
}

export async function setName(env: Env, ctx: ExecutionContext, stub: RoomStub, actor: Actor, _user: { id: string; handle: string }, roomId: string, value: unknown) {
  // Cleaned exactly as creation cleans the name (agent-rooms.ts and home.ts): cut at 80, the ends trimmed.
  const name = str(value, 80).trim();
  if (!name) throw new ApiError("bad_request", "name='<new name>' is required: a topic needs a name.");
  unwrap(await stub.setName(actor, name));
  await writeRoomIndex(env, ctx, roomId, "setName", `rooms.name=${JSON.stringify(name)}`,
    () => setNameRow(env, roomId, name));
  return { roomId, name };
}

export async function setVisibility(env: Env, ctx: ExecutionContext, stub: RoomStub, actor: Actor, _user: { id: string; handle: string }, roomId: string, pub: boolean) {
  const room = unwrap(await stub.setVisibility(actor, pub, suggestCode()));
  const visibility = pub ? "link" : "private";
  await writeRoomIndex(env, ctx, roomId, "setVisibility", `rooms.visibility=${visibility}`,
    () => setVisibilityRow(env, roomId, visibility));
  return room;
}

export async function setArchived(env: Env, ctx: ExecutionContext, stub: RoomStub, actor: Actor, user: { id: string; handle: string }, roomId: string, on: boolean) {
  if (!on) {
    const r = await ownerAndStatus(env, roomId);
    if (r?.owner_id === user.id && r.status !== "active") await checkRoomQuota(env, user.id, false);
  }
  const room = unwrap(await stub.setArchived(actor, on));
  if (on) {
    const archivedAt = room.archivedAt ?? Date.now();
    await writeRoomIndex(env, ctx, roomId, "setArchived", `rooms.status=archived, archived_at=${archivedAt}, archived_reason=NULL`,
      () => archiveRow(env, roomId, archivedAt),
      () => roomsChanged(env, user, roomId));
  } else {
    const activeAt = Date.now();
    await writeRoomIndex(env, ctx, roomId, "setArchived", `rooms.status=active, archived_at=NULL, archived_reason=NULL, active_at=${activeAt}`,
      () => restoreRow(env, roomId, activeAt),
      () => roomsChanged(env, user, roomId));
  }
  return room;
}

export async function leaveAccount(env: Env, ctx: ExecutionContext, stub: RoomStub, actor: Actor, user: { id: string; handle: string }, roomId: string, _input?: unknown) {
  if (actor.kind === "agent") {
    const left = unwrap(await stub.leave(actor));
    if (!left.accountActive) await writeRoomIndex(env, ctx, roomId, "leaveAccount", `room_members(${roomId}, ${user.id}).active=0`,
      () => inRoom(env, roomId, user.id, false));
    return left;
  }
  const out = unwrap(await stub.leaveAccount(actor));
  if (out.public) {
    await writeRoomIndex(env, ctx, roomId, "leaveAccount", `room_members(${roomId}, ${user.id}).active=0`,
      () => inRoom(env, roomId, user.id, false), () => roomsChanged(env, user, roomId));
  } else {
    await writeRoomIndex(env, ctx, roomId, "leaveAccount", `room_members(${roomId}, ${user.id}) absent`,
      () => dropMember(env, roomId, user.id),
      () => roomsChanged(env, user, roomId));
  }
  return out;
}

export async function removeAccount(env: Env, ctx: ExecutionContext, stub: RoomStub, actor: Actor, _user: { id: string; handle: string }, roomId: string, account: string) {
  const out = unwrap(await stub.removeAccount(actor, account));
  await writeRoomIndex(env, ctx, roomId, "removeAccount", `room_members(${roomId}, ${account}) absent`,
    () => dropMemberByHandle(env, roomId, account));
  return out;
}

/** Deletion keeps its old exception: the D1 retry marker must land before the DO can be deleted. */
export async function deleteRoom(env: Env, ctx: ExecutionContext, stub: RoomStub, actor: Actor, user: { id: string; handle: string }, roomId: string, _input?: unknown) {
  const row = await deleteState(env, roomId);
  if (!row || row.owner_id !== user.id) throw new ApiError("forbidden", "Only the topic's creator can delete it.", 403);
  if (row.status === "deleted" && !row.purge_pending) throw new ApiError("room_deleted", "This topic is already deleted.", 410);
  if (row.status !== "deleted") {
    await markRoomDeleted(env, roomId);
  }
  const out = await stub.deleteRoom(actor);
  if ("err" in out && out.err.code !== "room_deleted") unwrap(out);
  ctx.waitUntil(roomsChanged(env, user, roomId));
  return "ok" in out ? out.ok : null;
}

export async function rotateCode(_env: Env, _ctx: ExecutionContext, stub: RoomStub, actor: Actor, _user: { id: string; handle: string }, _roomId: string, _input?: unknown) {
  const code = suggestCode();
  unwrap(await stub.rotateCode(actor, code));
  return { code };
}

// ---------- handoffs in the cloud (docs/api/files.md) ----------

/**
 * A handoff's PUT before its body is read, in this order: the topic and the writer (the room), then the account's
 * 「交接只存在 agent 的电脑上」, so the CLI's quiet stored: "local" never hides a real error.
 */
export async function handoffWriter(stub: RoomStub, actor: Actor, localOnly: boolean) {
  unwrap(await stub.handoffWriter(actor));
  if (localOnly) throw new ApiError(LOCAL_ONLY.code, LOCAL_ONLY.next, LOCAL_ONLY.status);
}

/** The body (already read up to 256 KB): text checks, the computer's name kept or dropped, then the room stores it. */
export async function putHandoff(stub: RoomStub, actor: Actor, bytes: Uint8Array, computer: string | null) {
  const t = handoffText(bytes);
  if ("code" in t) throw new ApiError(t.code, t.next, t.status);
  return unwrap(await stub.putHandoff(actor, { body: t.text, size: bytes.byteLength, computer: computerOf(computer) }));
}

export async function getHandoff(stub: RoomStub, actor: Actor, name: unknown) {
  return unwrap(await stub.getHandoff(actor, str(name, 200)));
}

export async function deleteHandoff(stub: RoomStub, actor: Actor, name: unknown) {
  return unwrap(await stub.deleteHandoff(actor, str(name, 200)));
}
