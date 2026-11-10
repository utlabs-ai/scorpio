// The room domain: the topic itself. The room table (one row: name, description, creator, passcode, public, archived,
// deleted), its lookups and refusals, what members' pages and daemons are told about it, the room RPCs (init, info,
// indexState, peek, rotateCode, setVisibility, setTopic, setName, summary, deleteRoom, purgeRoom) and the five room writes the
// lifecycle operations make (archive, restore, deleted_at). RoomDO holds it through RoomDO.roomOf(o) and keeps forwards
// under the old names (split by domain S8b).
//
// Room's own lookup is require(); room() here is RoomDO's name for it, a dep read at call time, so a fake with its own
// room (room-membership's requireOwner) is still the one asked. The creator's row and the reads of members (indexState,
// summary) are members' functions; summary's last time and unread count are messages'.
import { ApiError, now, safeEqual } from "../util";
import { deleteRoomObjects } from "../room-report";
import { isPublic } from "../room-snapshot";
import { mayReadSummary, requireOwner as accountOwnsRoom } from "../room-membership";
import { RETENTION_SINCE } from "../retention";
import { safeSend, tx, wrap } from "./kernel";
import type { Actor, Result, Row } from "./kernel";
import type { IndexAccount, IndexState } from "../room-index-fix";
import type { Counts, Item, RoomInfo, RoomSummary, SystemEvent } from "./types";

export interface RoomDeps {
  sql(): SqlStorage;
  ctx(): DurableObjectState;
  env(): Env;
  schedule(task: string, ms: number): Promise<void>;
  /** RoomDO's room(), which comes back to require(). */
  require(): Row;
  members: {
    require(actor: Actor): Row;
    get(name: string): Row | undefined;
    touch(name: string): void;
    addOwner(owner: string, at: number): void;
    accounts(): IndexAccount[];
    accountKnown(account: string): boolean;
    activeCount(kind: string): number;
    workingAgents(): Row[];
  };
  presence: { isViewer(ws: WebSocket): boolean; broadcastHostRooms(): void; workOf(r: Row, except?: WebSocket): string | null };
  snapshot: { publicChanged(): void; madePrivate(): void };
  tasks: { counts(): Counts; openItems(): Item[] };
  quota: { messagesToday(): number };
  messages: { mentionUnread(name: string, cursor: number): number; lastTs(): number | null; unreadFor(handle: string, cursor: number): number };
  lifecycle: { markDeleted(why: { by: string } | { reason: "retention" }): number };
  /** The rename's system line (messages' insert). */
  insertMessage(m: { from: string; fromKind: string; text: string; event: SystemEvent }): void;
}

/** Passcodes compare without case, spaces or punctuation: "xk7 9qd 4m2" is XK7-9QD-4M2. */
export function normalizeCode(code: string): string {
  return code.normalize("NFKC").toUpperCase().replace(/[\s\-_.·・,，]+/g, "");
}

export function requireNewCode(code: string | null): void {
  if (code && [...normalizeCode(code)].length < 6)
    throw new ApiError("bad_code", "Use a passcode of at least 6 characters.", 400);
}

export class Room {
  constructor(private readonly d: RoomDeps) {}

  // Same names as RoomDO's, so each body reads as it did there. Each dep is read at call time: room-membership,
  // room-retention and room-snapshot give their fakes an sql of their own, room-search-equal counts it.
  private get sql() { return this.d.sql(); }
  private get ctx() { return this.d.ctx(); }
  private get env() { return this.d.env(); }
  private wrap<T>(fn: () => T): Result<T> { return wrap(fn); }
  private safeSend(ws: WebSocket, data: string) { return safeSend(ws, data); }
  private room() { return this.d.require(); }
  private requireMember(actor: Actor) { return this.d.members.require(actor); }
  private memberRow(name: string) { return this.d.members.get(name); }
  private touch(name: string) { this.d.members.touch(name); }
  private isViewer(ws: WebSocket) { return this.d.presence.isViewer(ws); }
  private broadcastHostRooms() { this.d.presence.broadcastHostRooms(); }
  private workOf(r: Row, except?: WebSocket) { return this.d.presence.workOf(r, except); }
  private publicChanged() { this.d.snapshot.publicChanged(); }
  private counts() { return this.d.tasks.counts(); }
  private openItems() { return this.d.tasks.openItems(); }
  private messagesToday() { return this.d.quota.messagesToday(); }
  private mentionUnread(name: string, cursor: number) { return this.d.messages.mentionUnread(name, cursor); }
  private markDeleted(why: { by: string } | { reason: "retention" }) { return this.d.lifecycle.markDeleted(why); }

  // Room's schema, one function per place RoomDO.migrate runs it.

  /** The table: first, before the kernel's nonces. */
  static createTable(sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT NOT NULL, owner TEXT NOT NULL,
        code_salt TEXT, code_hash TEXT, created_at INTEGER NOT NULL
      );
    `);
    sql.exec(`CREATE TABLE IF NOT EXISTS passcode_failures (
      account TEXT NOT NULL, failed_at INTEGER NOT NULL
    );`);
    sql.exec("CREATE INDEX IF NOT EXISTS passcode_failures_account_time ON passcode_failures(account, failed_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS passcode_failures_time ON passcode_failures(failed_at)");
  }

  /** The later columns and the retention clock's start: after Members.migrate, before Messages.addScheduledAndFiles. */
  static migrate(sql: SqlStorage) {
    // The passcode is a room-level shared secret that members can read again, so it is
    // kept as entered; code_salt / code_hash are from the first deployment and only ever read.
    const cols = sql.exec("PRAGMA table_info(room)").toArray().map((c) => c.name);
    if (!cols.includes("code")) sql.exec("ALTER TABLE room ADD COLUMN code TEXT");
    // public: anyone signed in with the link enters without a passcode. Rooms made before this column
    // were public exactly when they had no passcode. archived_at: archived (read-only) since then.
    const rcols = sql.exec("PRAGMA table_info(room)").toArray().map((c) => c.name);
    if (!rcols.includes("public")) {
      sql.exec("ALTER TABLE room ADD COLUMN public INTEGER NOT NULL DEFAULT 0");
      sql.exec("UPDATE room SET public = CASE WHEN code IS NULL AND code_hash IS NULL THEN 1 ELSE 0 END");
    }
    if (!rcols.includes("archived_at")) sql.exec("ALTER TABLE room ADD COLUMN archived_at INTEGER");
    // deleted_at: the purge marker; every call answers room_deleted while cleanup is pending.
    if (!rcols.includes("deleted_at")) sql.exec("ALTER TABLE room ADD COLUMN deleted_at INTEGER");
    // archived_reason: "retention" when the clock archived it, "downgrade" when a lapsed Pro did; null when its owner did.
    if (!rcols.includes("archived_reason")) sql.exec("ALTER TABLE room ADD COLUMN archived_reason TEXT");
    // A room archived before the retention clock shipped is on it from that day, as in D1 (0010); matches nothing after.
    sql.exec("UPDATE room SET archived_at = ? WHERE archived_at < ?", RETENTION_SINCE, RETENTION_SINCE);
  }

  // ---------- helpers ----------

  /** The room's row, unless it is deleted (RoomDO's room()). */
  require(): Row {
    const r = this.roomRow();
    if (r.deleted_at != null) {
      throw new ApiError(
        "room_deleted",
        "This topic has been deleted. Its messages, files and tasks cannot be read or restored.",
        410,
      );
    }
    return r;
  }

  /** The room's row, deleted or not (deleting, restoring and purging need it). */
  roomRow(): Row {
    let r: Row | undefined;
    try {
      r = this.sql.exec("SELECT * FROM room LIMIT 1").toArray()[0];
    } catch {
      // Purged: the storage is gone (no tables) until the object starts again.
    }
    if (!r) throw new ApiError("room_not_found", "No such topic. Check the topic id in your invitation.", 404);
    return r;
  }

  /** The room's id, deleted or not, or null before init (the snapshot's drop). */
  idOrNull(): string | null {
    return (this.sql.exec("SELECT id FROM room LIMIT 1").toArray()[0]?.id as string | undefined) ?? null;
  }

  roomInfo(r = this.room()): RoomInfo {
    return {
      id: r.id as string,
      name: r.name as string,
      topic: r.topic as string,
      owner: r.owner as string,
      hasCode: !!(r.code || r.code_hash),
      public: !!r.public,
      archived: r.archived_at != null,
      archivedAt: (r.archived_at as number | null) ?? null,
      archivedReason: r.archived_at != null ? ((r.archived_reason as string) ?? null) : null,
      createdAt: r.created_at as number,
    };
  }

  /** An archived room is read-only: what it holds stays, nothing new goes in. */
  requireWritable() {
    if (this.room().archived_at != null) {
      throw new ApiError("room_archived", "This topic is archived (read-only): the history is there, nothing can be sent or changed in its tasks. Its creator can restore it on the web.", 409);
    }
  }

  checkCode(r: Row, code: string | undefined, account: string) {
    if (r.public || (!r.code && !r.code_hash)) return;
    if (!code) throw new ApiError("code_required", "This topic has a passcode. Add code=<passcode from your invitation>.", 403);
    const t = now();
    this.prunePasscodeFailures(t);
    const recent = this.sql.exec("SELECT failed_at FROM passcode_failures WHERE account = ? AND failed_at > ? ORDER BY failed_at LIMIT 10", account, t - 3_600_000).toArray();
    if (recent.length === 10) throw new ApiError("rate_limited", "Too many wrong passcodes. Try again in an hour.", 429, Math.max(1, Math.ceil(((recent[0].failed_at as number) + 3_600_000 - t) / 1000)));
    if (!r.code || !safeEqual(normalizeCode(code), normalizeCode(r.code as string))) {
      this.sql.exec("INSERT INTO passcode_failures (account, failed_at) VALUES (?, ?)", account, t);
      this.armPasscodeExpiry(3_600_000);
      throw new ApiError("bad_code", "Wrong passcode. Copy it again from the invitation; ask the topic's creator if it was changed.", 403);
    }
  }

  dropAccountFailures(account: string): void {
    this.sql.exec("DELETE FROM passcode_failures WHERE account = ?", account);
  }

  private prunePasscodeFailures(t: number): void {
    this.sql.exec("DELETE FROM passcode_failures WHERE failed_at <= ?", t - 3_600_000);
  }

  private armPasscodeExpiry(delayMs: number): void {
    this.ctx.waitUntil(this.d.schedule("room:passcodeFailuresDue", delayMs));
  }

  nextDue(): number { return this.ctx.storage.kv.get<number>("room:passcodeFailuresDue") ?? Infinity; }

  async wake(): Promise<void> {
    this.prunePasscodeFailures(now());
    const oldest = this.sql.exec("SELECT MIN(failed_at) AS at FROM passcode_failures").one().at as number | null;
    if (oldest != null) await this.d.schedule("room:passcodeFailuresDue", Math.max(0, oldest + 3_600_000 - now()));
  }

  alarm(t: number): void {
    if (this.nextDue() > t) return;
    this.prunePasscodeFailures(t);
    this.ctx.storage.kv.delete("room:passcodeFailuresDue");
    const oldest = this.sql.exec("SELECT MIN(failed_at) AS at FROM passcode_failures").one().at as number | null;
    if (oldest != null) this.armPasscodeExpiry(Math.max(0, oldest + 3_600_000 - now()));
  }

  // ---------- the snapshot of a public room for visitors who are not signed in ----------

  isPublicRoom(): boolean {
    try {
      const r = this.sql.exec("SELECT public, deleted_at FROM room LIMIT 1").toArray()[0];
      return isPublic(r);
    } catch {
      return false; // no tables yet, or purged
    }
  }

  // ---------- room lifecycle ----------

  async init(p: { id: string; name: string; topic: string; owner: string; code: string | null }): Promise<RoomInfo> {
    requireNewCode(p.code);
    const existing = this.sql.exec("SELECT id FROM room").toArray()[0];
    if (existing) throw new Error("room already initialised");
    const t = now();
    tx(this.ctx, () => {
      this.sql.exec(
        "INSERT INTO room (id, name, topic, owner, code, public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        p.id,
        p.name,
        p.topic,
        p.owner,
        p.code || null,
        p.code ? 0 : 1,
        t,
      );
      this.d.members.addOwner(p.owner, t);
    });
    return this.roomInfo();
  }

  async info(): Promise<Result<RoomInfo>> {
    return this.wrap(() => this.roomInfo());
  }

  /** What D1's index should say about this room (the daily repair). Read only; deleted rooms too. */
  async indexState(): Promise<Result<IndexState>> {
    return this.wrap(() => {
      const r = this.roomRow();
      const accounts = this.d.members.accounts();
      return { topic: r.topic as string, public: !!r.public, archivedAt: (r.archived_at as number | null) ?? null,
        archivedReason: r.archived_at != null ? ((r.archived_reason as string) ?? null) : null, deletedAt: (r.deleted_at as number | null) ?? null, accounts };
    });
  }

  /** What the room page needs to decide between the room and the passcode form; displayName: what this room has for the person. */
  async peek(actor: Actor): Promise<Result<{ room: RoomInfo; member: boolean; displayName: string | null }>> {
    return this.wrap(() => {
      const room = this.roomInfo();
      const m = this.memberRow(actor.name);
      return { room, member: !!m && m.status === "active", displayName: (m?.display_name as string) ?? null };
    });
  }

  async rotateCode(actor: Actor, code: string | null): Promise<Result<{ hasCode: boolean }>> {
    return this.wrap(() => {
      const r = this.room();
      if (actor.account !== r.owner) throw new ApiError("forbidden", "Only the topic's creator can change the passcode.", 403);
      requireNewCode(code);
      // Rotating revokes the old passcode at once; nobody already in the room is affected.
      this.sql.exec("UPDATE room SET code = ?, code_salt = NULL, code_hash = NULL", code || null);
      this.broadcastRoom();
      return { hasCode: !!code };
    });
  }

  /** Room metadata for members' pages, passcode included (members may read it). */
  memberRoomView() {
    const r = this.room();
    return { ...this.roomInfo(r), code: r.public ? null : ((r.code as string) ?? null) };
  }

  /** Room metadata changed: members' browsers get the room (passcode included), viewers' without it, daemons a room frame. */
  broadcastRoom(hosts = false) {
    this.publicChanged();
    const view = this.memberRoomView();
    const frame = JSON.stringify({ type: "room", room: view });
    const viewerFrame = JSON.stringify({ type: "room", room: { ...view, code: null } });
    for (const ws of this.ctx.getWebSockets("browser")) this.safeSend(ws, this.isViewer(ws) ? viewerFrame : frame);
    if (!hosts) return;
    this.broadcastHostRooms();
  }

  requireOwner(actor: Actor, what: string): Row {
    this.requireMember(actor);
    const r = this.room();
    if (!accountOwnsRoom(r, actor)) throw new ApiError("forbidden", `You do not have permission to ${what}.`, 403);
    return r;
  }

  /**
   * Public: anyone signed in with the link enters, no passcode. Private: the passcode is asked for again;
   * a room that never had one gets `code` (made up by the Worker). Not a room message.
   */
  async setVisibility(actor: Actor, pub: boolean, code: string): Promise<Result<RoomInfo & { code: string | null }>> {
    return this.wrap(() => {
      const r = this.requireOwner(actor, "make the topic public or private");
      if (!pub && !r.code) requireNewCode(code);
      if (!pub && !r.code) this.sql.exec("UPDATE room SET code = ?, code_salt = NULL, code_hash = NULL", code);
      this.sql.exec("UPDATE room SET public = ?", pub ? 1 : 0);
      if (!pub && r.public) this.d.snapshot.madePrivate();
      if (pub) this.sql.exec("DELETE FROM passcode_failures");
      // Private now: viewers may no longer read. They go before the room frame, which carries the passcode.
      if (!pub) {
        for (const ws of this.ctx.getWebSockets("browser")) {
          if (!this.isViewer(ws)) continue;
          const a = ws.deserializeAttachment() as { name?: string } | null;
          this.safeSend(ws, JSON.stringify({ type: "removed", account: a?.name ?? null, by: actor.name }));
          try {
            ws.close(4004, "private");
          } catch {}
        }
      }
      this.broadcastRoom(true);
      return this.memberRoomView();
    });
  }

  /** The owner's account (the person or one of their agents) changes the topic; not a room message. */
  async setTopic(actor: Actor, topic: string): Promise<Result<{ topic: string }>> {
    return this.wrap(() => {
      const r = this.room();
      this.requireMember(actor);
      if (actor.account !== r.owner) throw new ApiError("forbidden", `Only the creator's account (${r.owner as string}) can change the description.`, 403);
      this.sql.exec("UPDATE room SET topic = ?", topic);
      this.touch(actor.name);
      this.broadcastRoom(true);
      return { topic };
    });
  }

  /**
   * The owner's account renames the topic. A system line records it (so members see who renamed what; an archived
   * topic is read-only and refuses); the room frame carries the new name to every page and daemon, and the public
   * snapshot is rewritten. `name` arrives cleaned (the action cuts and trims it as creation does).
   */
  async setName(actor: Actor, name: string): Promise<Result<{ name: string }>> {
    return this.wrap(() => {
      const r = this.room();
      this.requireMember(actor);
      if (actor.account !== r.owner) throw new ApiError("forbidden", `Only the creator's account (${r.owner as string}) can rename the topic.`, 403);
      this.requireWritable();
      const from = r.name as string;
      this.sql.exec("UPDATE room SET name = ?", name);
      this.d.insertMessage({ from: "system", fromKind: "system", text: `${actor.name} renamed the topic to ${name}`, event: { type: "topic_renamed", by: actor.name, from, to: name } });
      this.touch(actor.name);
      this.broadcastRoom(true);
      return { name };
    });
  }

  // The lifecycle operations' writes (room/lifecycle.ts), with their SQL and their arguments: room-membership and
  // room-retention record them through a fake sql.

  writeArchived(at: number | null) {
    this.sql.exec("UPDATE room SET archived_at = ?, archived_reason = NULL", at);
  }

  writePlanArchive(at: number, reason: string) {
    this.sql.exec("UPDATE room SET archived_at = ?, archived_reason = ?", at, reason);
  }

  writeRestore() {
    this.sql.exec("UPDATE room SET archived_at = NULL, archived_reason = NULL");
  }

  writeRetentionArchive(at: number | null) {
    this.sql.exec("UPDATE room SET archived_at = ?, archived_reason = 'retention'", at);
  }

  writeDeleted(at: number) {
    this.sql.exec("UPDATE room SET deleted_at = ?", at);
  }

  /**
   * For the home page row of one person: the plan's numbers, agents working, who is in it, when it last
   * moved, and (when they are in it) what they have not read and what is addressed to them.
   */
  async summary(handle?: string): Promise<Result<RoomSummary>> {
    return this.wrap(() => {
      const r = this.room();
      if (!mayReadSummary(r, handle, !!handle && this.d.members.accountKnown(handle))) {
        throw new ApiError("not_member", "You are not in this topic. Open the topic link and enter the passcode.", 403);
      }
      const count = (kind: string) => this.d.members.activeCount(kind);
      const me = handle ? this.memberRow(handle) : undefined;
      const cursor = me && me.status === "active" ? (me.cursor as number) : null;
      const working = this.d.members
        .workingAgents()
        .filter((m) => this.workOf(m) === "working")
        .map((m) => m.name as string);
      return {
        counts: this.counts(),
        todayMessages: this.messagesToday(),
        working: working.length,
        workingNames: working,
        mine: handle ? this.openItems().filter((i) => i.assignee === handle) : [],
        public: !!r.public,
        archived: r.archived_at != null,
        lastMs: this.d.messages.lastTs() ?? (r.created_at as number),
        humans: count("human"),
        agents: count("agent"),
        unread: cursor == null ? null : this.d.messages.unreadFor(handle!, cursor),
        mentionUnread: cursor == null ? 0 : this.mentionUnread(handle!, cursor),
      };
    });
  }

  // ---------- permanent room deletion ----------

  /** The owner dissolves the room. Everyone connected is told and let go before its storage is purged. */
  async deleteRoom(actor: Actor): Promise<Result<{ roomId: string; deletedAt: number }>> {
    return this.wrap(() => {
      const r = this.requireOwner(actor, "delete the topic");
      return { roomId: r.id as string, deletedAt: this.markDeleted({ by: actor.name }) };
    });
  }

  /** R2 objects and all storage go; the Worker gives the space back by the index. */
  async purgeRoom(): Promise<Result<{ objects: number }>> {
    let r: Row;
    try {
      r = this.roomRow();
    } catch (e) {
      if (e instanceof ApiError) return { err: { code: e.code, next: e.next, status: e.status } };
      throw e;
    }
    const objects = await deleteRoomObjects(this.env, r.id as string);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4010, "room deleted");
      } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { ok: { objects } };
  }
}
