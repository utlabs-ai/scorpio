// The tasks domain (docs/api/tasks.md): items, their history, their threads, the last day's deleted ones, the todo
// frame and the per-topic task-write rate. RoomDO holds it through RoomDO.tasksOf(o) and keeps forwards under the old
// names where its own code still calls them (split by domain S6a); a message send's part is the SendSteps at the end
// of the class (S6b).
//
// Members are read through members' functions (activeNameSet, findCaseless, findCaselessName) and search's display
// names through member_names_v (S8d). Messages are read through messages' message_thread_v view:
// seq, ts, from_name, from_kind, text, files, mentions, reply_to and scheduled.
import { ApiError, now } from "../util";
import { notify } from "../room-report";
import { mentionTokens, namesMentioned, proseOf } from "../mentions";
import { NO_DESC_NEXT, activePushRecipient, addInputs, assignedPush, assigneeRefusal, blockersOf, closePlan, closedRefusal, countsOf, deleteDecision, deletedOf, editPlan, editTitleRefusal, idsOf, itemNumberOf, itemViewOf, memberNameOf, personMayCase, rateStep, takeDecision, titleOf, toPersonRefusal } from "../room-items";
import { VISIBLE_COUNTS_SQL, VISIBLE_DONE_MS, VISIBLE_ITEMS_SQL } from "../todo-visibility";
import { CARRIED_SQL, CURRENT_SQL, JOIN_SQL, LAST_REPLY_SQL, THREAD_SQL, joins, lineOf, tNumbers } from "../item-thread";
import { mineOf, openOf, yoursOf } from "../task-brief";
import { pageTodo } from "../page-view";
import { LEFT_DOING_SQL, LEFT_TODO_SQL } from "../left-items";
import { filterSql, likeTerms, page, searchSnippet } from "../search";
import { refuse, toBrowsers, toHosts, viewing, wrap } from "./kernel";
import type { Actor, ActorKind, Result, Row } from "./kernel";
import type { SearchPage, SearchQuery } from "../search";
import type { Refusal } from "../room-items";
import type { OpenItem, Rel } from "../item-thread";
import type { Brief } from "../task-brief";
import type { Limits } from "../plans";
import type { FileMeta } from "../files";
import type { Counts, Deleted, Item, Message, RoomInfo, Round, SendOp, TodoOp } from "./types";
import type { SendSteps } from "./messages";

const TODO_WRITES_PER_MINUTE = 120; // the default; the owner's plan limits (config:plans todoWritesPerRoomMinute) may raise it
// Agent-facing hints keep the 0.4 command syntax (roomId=, todo, in=todo, topic=): a CLI that never updates types
// them as they are, and CLI 0.5.0 shows them in the new one (cli/src/names.mjs). Only the words around them changed.
const ROUNDS_GONE_NEXT = "轮次已经没有了；找已交付的任务用 search in=todo，或 todo show=T…。";

export interface TasksDeps {
  sql(): SqlStorage;
  ctx(): DurableObjectState;
  env(): Env;
  schedule(task: string, ms: number): Promise<void>;
  room: { require(): Row; requireWritable(): void; info(): RoomInfo };
  members: {
    get(name: string): Row | undefined;
    reader(actor: Actor): Row | null;
    require(actor: Actor): Row;
    touch(name: string): void;
    activeNameSet(): Set<string>;
    findCaseless(name: string): Row | undefined;
    findCaselessName(name: string): Row | undefined;
  };
  quota: { ownerLimits(): Promise<{ limits: Limits }> };
  files: { withLinks<T extends FileMeta>(files: T[]): (T & { link: string; view: boolean })[] };
}

const quiet = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };
const itemNo = (id: string | undefined) => Number(/^[TP]?(\d+)$/i.exec(String(id || "").trim())?.[1] ?? NaN);

// send add=: what prepare checked, and what attach opened.
type AddPrep = ReturnType<Tasks["prepareAdd"]>;
type Added = ReturnType<Tasks["insertItem"]>;
/** The threads a send joins, each with its item row, and who its reports go to. */
type Route = { joined: (ReturnType<typeof joins>[number] & { row: Row })[]; closers: string[] };

/** A stored message's @names that its prose really names (as toMessage shows them). */
function mentionsOf(m: Row): string[] {
  const tokens = mentionTokens(String(m.text || ""));
  return (JSON.parse((m.mentions as string) || "[]") as string[]).filter((n) => namesMentioned(tokens, n));
}

export class Tasks implements SendSteps<AddPrep | null, Route, Added> {
  constructor(private readonly d: TasksDeps) {}

  private get sql() { return this.d.sql(); }
  private get ctx() { return this.d.ctx(); }
  private get env() { return this.d.env(); }
  private room() { return this.d.room.require(); }
  private requireWritable() { return this.d.room.requireWritable(); }
  private roomInfo() { return this.d.room.info(); }
  private memberRow(name: string) { return this.d.members.get(name); }
  private reader(actor: Actor) { return this.d.members.reader(actor); }
  private requireMember(actor: Actor) { return this.d.members.require(actor); }
  private touch(name: string) { this.d.members.touch(name); }
  private ownerLimits() { return this.d.quota.ownerLimits(); }
  private withLinks<T extends FileMeta>(files: T[]) { return this.d.files.withLinks(files); }
  private schedule(task: string, ms: number) { return this.d.schedule(task, ms); }
  private wrap<T>(fn: () => T): Result<T> { return wrap(fn); }
  private refuse(r: Refusal): never { return refuse(r); }

  static createSearchView(sql: SqlStorage) {
    sql.exec("CREATE VIEW IF NOT EXISTS item_messages_v AS SELECT n, seq FROM item_messages");
  }

  static migrate(sql: SqlStorage) {
    sql.exec(`
      -- The room's TODO: things being done or waiting to be done. n is shown as T<n>.
      CREATE TABLE IF NOT EXISTS items (
        n INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', -- todo | doing | done
        assignee TEXT, created_by TEXT NOT NULL, created_seq INTEGER, done_seq INTEGER,
        created_ms INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_ms INTEGER NOT NULL
      );
      -- Legacy round rows remain for stored items; no new round lifecycle is exposed.
      CREATE TABLE IF NOT EXISTS rounds (n INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'open', opened_ms INTEGER NOT NULL, done_ms INTEGER);
      -- What happened to each item (todo show=); goes with the item when it is deleted.
      CREATE TABLE IF NOT EXISTS item_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, ms INTEGER NOT NULL, by_name TEXT NOT NULL, op TEXT NOT NULL, from_json TEXT, to_json TEXT
      );
      CREATE INDEX IF NOT EXISTS item_log_n ON item_log (n);
      CREATE INDEX IF NOT EXISTS items_created_seq ON items (created_seq);
      CREATE INDEX IF NOT EXISTS items_done_seq ON items (done_seq);
      -- A person's reply to a message carrying an item under their name reports to it; seq is the reply.
      CREATE TABLE IF NOT EXISTS item_replies (n INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (n, seq));
      -- An item's thread: its sources, the messages that joined by reply or T number, the person's replies
      -- (rel reply; item_replies is no longer written) and the delivering message. One row per item and message.
      CREATE TABLE IF NOT EXISTS item_messages (n INTEGER NOT NULL, seq INTEGER NOT NULL, rel TEXT NOT NULL, PRIMARY KEY (n, seq));
      CREATE INDEX IF NOT EXISTS item_messages_seq ON item_messages (seq);
      -- Deleted items, kept 24 hours (CLI 0.5.3): who deleted what, for the agents' task changes.
      CREATE TABLE IF NOT EXISTS items_deleted (
        n INTEGER PRIMARY KEY, title TEXT NOT NULL, assignee TEXT, created_by TEXT NOT NULL, by_name TEXT NOT NULL, ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_deleted_time ON items_deleted (ms);
      CREATE INDEX IF NOT EXISTS item_replies_seq ON item_replies (seq);
    `);
    const icols = sql.exec("PRAGMA table_info(items)").toArray().map((c) => c.name);
    if (!icols.includes("descr")) sql.exec("ALTER TABLE items ADD COLUMN descr TEXT"); // Markdown, optional
    if (!icols.includes("blocked_by")) sql.exec("ALTER TABLE items ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'"); // JSON [n]
    if (!icols.includes("round")) {
      sql.exec("ALTER TABLE items ADD COLUMN round INTEGER");
      sql.exec("ALTER TABLE items ADD COLUMN done_ms INTEGER");
      // Switching over from the plan (v0.8): cancelled items go, the rest keep their numbers in round 1,
      // open if any of them is. Pins are not carried over.
      sql.exec("DELETE FROM items WHERE status = 'cancelled'");
      const all = sql.exec("SELECT COUNT(*) AS k, MIN(created_ms) AS first, MAX(updated_ms) AS last, SUM(status != 'done') AS open FROM items").one();
      if (all.k) {
        sql.exec(
          "INSERT INTO rounds (n, title, status, opened_ms, done_ms) VALUES (1, NULL, ?, ?, ?)",
          all.open ? "open" : "done",
          all.first,
          all.open ? null : all.last,
        );
        sql.exec("UPDATE items SET round = 1, done_ms = CASE WHEN status = 'done' THEN updated_ms END");
      }
      sql.exec("DROP TABLE IF EXISTS pins");
    }
    // Open items and the recently done ones without reading every item ever made: the visible list, the counts and
    // the open candidates of each send (done_ms exists only after the ALTER above).
    sql.exec("CREATE INDEX IF NOT EXISTS items_status_done ON items (status, done_ms)");
  }

  /**
   * Threads for items from before them: every source the item had (createdSeq now and in its edit
   * history), its replies, its result; then, for open items, (b) and (c) replayed from their latest source on. No
   * history rows, no pushes, no wakes.
   * backfill: run once from RoomDO.migrate.
   */
  backfillThreads() {
    const items = this.sql.exec("SELECT n, status, assignee, created_by, created_seq, done_seq FROM items").toArray();
    const latest = new Map<number, number>();
    for (const it of items) {
      const n = it.n as number;
      const seqs = new Set<number>();
      if (it.created_seq != null) seqs.add(it.created_seq as number);
      for (const h of this.sql.exec("SELECT from_json, to_json FROM item_log WHERE n = ? AND op = 'edit'", n).toArray()) {
        for (const j of [h.from_json, h.to_json]) {
          const v = j ? (JSON.parse(j as string) as { createdSeq?: unknown } | null)?.createdSeq : null;
          if (typeof v === "number") seqs.add(v);
        }
      }
      for (const seq of seqs) this.sql.exec(JOIN_SQL, n, seq, "source");
      if (it.done_seq != null) this.sql.exec(JOIN_SQL, n, it.done_seq, "result");
      if (it.created_seq != null) latest.set(n, it.created_seq as number);
    }
    this.sql.exec("INSERT OR IGNORE INTO item_messages (n, seq, rel) SELECT n, seq, 'reply' FROM item_replies");
    const open = items.filter((it) => it.status !== "done" && latest.has(it.n as number));
    if (!open.length) return;
    const threads = new Map(open.map((it) => [it.n as number, new Set(this.sql.exec("SELECT seq FROM item_messages WHERE n = ?", it.n).toArray().map((r) => r.seq as number))]));
    const marked = new Map<number, number[]>();
    for (const r of this.sql.exec("SELECT n, seq FROM item_messages WHERE rel IN ('source', 'result')").toArray()) {
      marked.set(r.seq as number, [...(marked.get(r.seq as number) || []), r.n as number]);
    }
    const candidates: (OpenItem & { since: number })[] = open.map((it) => ({
      n: it.n as number,
      assignee: (it.assignee as string) ?? null,
      createdBy: it.created_by as string,
      personAssignee: !!it.assignee && this.memberRow(it.assignee as string)?.kind === "human",
      has: (seq: number) => threads.get(it.n as number)!.has(seq),
      since: latest.get(it.n as number)!,
    }));
    const from = Math.min(...candidates.map((c) => c.since));
    for (const m of this.sql.exec("SELECT * FROM message_thread_v WHERE seq > ? AND from_kind != 'system' ORDER BY seq", from).toArray()) {
      const seq = m.seq as number;
      const eligible = candidates.filter((c) => c.since < seq);
      if (!eligible.length) continue;
      for (const j of joins(this.incoming(m, marked.get(seq) || []), eligible)) {
        this.sql.exec(JOIN_SQL, j.n, seq, j.rel);
        threads.get(j.n)!.add(seq);
      }
    }
  }

  /** Use the same command prefix as message storage, for both sending and replay. */
  private daemonCommand(text: string, mentions: string[]): boolean {
    const body = text.replace(/^(\s*@[A-Za-z0-9_.@-]+)*\s*/, "");
    return /^\/([A-Za-z][A-Za-z0-9_-]*)/.test(body) && mentions.some((name) => {
      const member = this.memberRow(name);
      return !!member && member.kind !== "human" && member.kind !== "agent";
    });
  }

  /** A stored message as joins() reads it. */
  private incoming(m: Row, sourceOrResultOf: number[]): Parameters<typeof joins>[0] {
    const replyTo = (m.reply_to as number) ?? null;
    const mentions = mentionsOf(m);
    return {
      author: m.scheduled ? (JSON.parse(m.scheduled as string) as { by: string }).by : m.from_name as string,
      mentions,
      daemonCommand: this.daemonCommand(String(m.text || ""), mentions),
      replyTo,
      replyToAuthor: replyTo == null ? null : this.replyAuthor(replyTo),
      tNumbers: tNumbers(proseOf(String(m.text || ""))),
      sourceOrResultOf,
    };
  }

  private replyAuthor(seq: number): string | null {
    const r = this.sql.exec("SELECT from_name, scheduled FROM message_thread_v WHERE seq = ?", seq).toArray()[0];
    return r?.scheduled ? (JSON.parse(r.scheduled as string) as { by: string }).by : (r?.from_name as string) ?? null;
  }

  /** The open items, as joins() needs them. */
  openCandidates(): OpenItem[] {
    return this.sql.exec("SELECT n, assignee, created_by FROM items WHERE status IN ('todo', 'doing')").toArray().map((it) => ({
      n: it.n as number,
      assignee: (it.assignee as string) ?? null,
      createdBy: it.created_by as string,
      personAssignee: !!it.assignee && this.memberRow(it.assignee as string)?.kind === "human",
      has: (seq: number) => !!this.sql.exec("SELECT 1 FROM item_messages WHERE n = ? AND seq = ?", it.n, seq).toArray()[0],
    }));
  }

  /** The tasks the messages of one page carry (messagesOf), in one query for the page: as todoOf, page-wide. */
  todoFor(rows: Row[], parents: Map<number, Row>): Map<number, NonNullable<Message["todo"]>> {
    const seqs = JSON.stringify(rows.map((r) => r.seq));
    const todos = new Map<number, NonNullable<Message["todo"]>>();
    const carried = this.sql.exec(
      `SELECT t.seq, i.n, i.title, i.assignee, i.status, i.created_by, t.rel, m.reply_to,
              parent.n AS parent_in_thread
       FROM item_messages t JOIN items i ON i.n = t.n JOIN message_thread_v m ON m.seq = t.seq
       LEFT JOIN item_messages parent ON parent.n = t.n AND parent.seq = m.reply_to
       WHERE t.seq IN (SELECT value FROM json_each(?)) ORDER BY t.seq, i.n`, seqs,
    ).toArray();
    for (const x of carried) {
      const seq = x.seq as number;
      const list = todos.get(seq) ?? [];
      const createdBy = x.created_by as string;
      const closer = x.rel === "reply" && x.parent_in_thread != null
        ? this.closerFromParent(parents.get(x.reply_to as number), createdBy) : createdBy;
      list.push({
        id: `T${x.n}`, title: x.title as string, assignee: (x.assignee as string) ?? null,
        status: x.status as string, round: 1, rel: x.rel as Rel,
        ...(x.rel === "reply" ? { closer } : {}),
      });
      todos.set(seq, list);
    }
    return todos;
  }

  /** The TODO items a message carries, as they are now: the threads it is in, and how it joined each. */
  todoOf(seq: number): { todo?: Message["todo"] } {
    const rows = this.carried(seq);
    if (!rows.length) return {};
    const replyTo = rows.some((x) => x.rel === "reply")
      ? this.sql.exec("SELECT reply_to FROM message_thread_v WHERE seq = ?", seq).toArray()[0]?.reply_to as number | null
      : null;
    return { todo: rows.map((x) => ({
      id: `T${x.n}`, title: x.title as string, assignee: (x.assignee as string) ?? null,
      status: x.status as string, round: 1, rel: x.rel as Rel,
      ...(x.rel === "reply" ? { closer: this.reportCloser(replyTo, x.created_by as string, x.n as number) } : {}),
    })) };
  }
  private carried(seq: number): Row[] {
    return this.sql.exec(CARRIED_SQL, seq).toArray();
  }

  /**
   * Who a person's reply reports to: the author of the message they answered, when it is in the item's thread
   * and an agent wrote it; otherwise the item's creator (a reply by T number answers no message).
   */
  reportCloser(answered: number | null, createdBy: string, n: number): string {
    if (answered == null || !this.sql.exec("SELECT 1 FROM item_messages WHERE n = ? AND seq = ?", n, answered).toArray()[0]) return createdBy;
    const parent = this.sql.exec("SELECT from_name, from_kind, scheduled FROM message_thread_v WHERE seq = ?", answered).toArray()[0];
    return this.closerFromParent(parent, createdBy);
  }

  private closerFromParent(parent: Row | undefined, createdBy: string): string {
    const sender = parent?.scheduled ? (JSON.parse(parent.scheduled as string) as { by: string }).by : parent?.from_name as string | undefined;
    return sender?.includes("@") ? sender : createdBy;
  }

  /** The todo frame, a second after a change (todoChanged). */
  async alarm(t: number) {
    if ((this.ctx.storage.kv.get<number>("itemsDue") ?? Infinity) <= t) {
      this.ctx.storage.kv.delete("itemsDue");
      // Daemons get the whole list (they work out what changed for each agent); pages the short form.
      const frame = this.todoFrame();
      toHosts(this.ctx, frame);
      const page = JSON.stringify({ type: "todo", ...pageTodo(this.todoState()) });
      toBrowsers(this.ctx, page);
    }
  }

  nextDue(): number { return this.ctx.storage.kv.get<number>("itemsDue") ?? Infinity; }

  private blockers(r: Row): number[] {
    return blockersOf(r);
  }

  /** Blockers not done yet. */
  private openBlockers(r: Row): number[] {
    return this.blockers(r).filter((b) => {
      const x = this.sql.exec("SELECT status FROM items WHERE n = ?", b).toArray()[0];
      return x && x.status !== "done";
    });
  }

  itemView(r: Row): Item {
    return itemViewOf(r, this.openBlockers(r).length > 0, this.asked(r));
  }

  /**
   * What the assignee is asked now (`current`: the latest thread message not by them, the creator standing in when
   * there is no assignee) and the person's latest reply nothing has been said to them since (`reply`).
   */
  private asked(r: Row): Pick<Item, "current" | "reply"> {
    const n = r.n as number;
    const c = this.sql.exec(CURRENT_SQL, n, (r.assignee as string) ?? (r.created_by as string)).toArray()[0];
    const current = c ? { seq: c.seq as number, from: c.from_name as string, ts: c.ts as number, line: lineOf(c.text as string, c.files ? (JSON.parse(c.files as string) as { name: string }[]) : [], c.seq as number) } : null;
    const x = this.sql.exec(LAST_REPLY_SQL, n, current?.seq ?? 0).toArray()[0];
    const reply = x ? { seq: x.seq as number, from: x.from_name as string, ts: x.ts as number, closer: this.reportCloser((x.reply_to as number) ?? null, r.created_by as string, n) } : null;
    return { current, reply };
  }

  counts(cutoff = now() - VISIBLE_DONE_MS): Counts {
    return countsOf(this.sql.exec(VISIBLE_COUNTS_SQL, cutoff).toArray() as { status: unknown; k: unknown }[]);
  }

  /** Stable compatibility fields for CLI 0.4.9 and earlier; no visible round lifecycle remains. */
  private legacyRound(cutoff = now() - VISIBLE_DONE_MS): Round {
    const first = this.sql.exec("SELECT opened_ms FROM rounds ORDER BY n LIMIT 1").toArray()[0];
    return {
      n: 1,
      title: null,
      status: "open",
      openedMs: (first?.opened_ms as number | undefined) ?? (this.room().created_at as number),
      doneMs: null,
      counts: this.counts(cutoff),
    };
  }

  roundOf(_n: number): Round {
    return this.legacyRound();
  }

  /** The visible list spans all stored rounds and retains completed items for 24 hours. */
  private visibleItems(cutoff = now() - VISIBLE_DONE_MS): Item[] {
    return this.sql
      .exec(VISIBLE_ITEMS_SQL, cutoff)
      .toArray()
      .map((r) => this.itemView(r));
  }

  todoState(): { round: Round; items: Item[]; rounds: Round[]; counts: Counts; deleted: Deleted[] } {
    const cutoff = now() - VISIBLE_DONE_MS;
    const round = this.legacyRound(cutoff);
    return { round, items: this.visibleItems(cutoff), rounds: [round], counts: round.counts, deleted: this.recentlyDeleted(cutoff) };
  }

  private recentlyDeleted(cutoff: number): Deleted[] {
    this.sql.exec("DELETE FROM items_deleted WHERE ms < ?", cutoff);
    return this.sql
      .exec("SELECT * FROM items_deleted WHERE ms >= ? ORDER BY ms", cutoff)
      .toArray()
      .map(deletedOf);
  }

  /** The names of the topic's active members: an item under any other name is under someone who left (Brief.left). */
  private present(): Set<string> {
    return this.d.members.activeNameSet();
  }

  /** What is still open under this name (done answers, join and leave; CLI 0.5.3). */
  yours(name: string): Brief[] {
    return yoursOf(this.openItems(), name, this.present());
  }

  /** Tasks delivered since `since`, per assignee (the overview; index items_status_done). */
  deliveredSince(since: number): import("./overview").DeliveredRow[] {
    return this.sql.exec("SELECT assignee, COUNT(*) AS n FROM items WHERE status = 'done' AND done_ms >= ? AND assignee IS NOT NULL GROUP BY assignee", since)
      .toArray().map((r) => ({ assignee: r.assignee as string, n: r.n as number }));
  }

  /** Open items across all stored rounds. */
  openItems(): Item[] {
    return this.sql.exec("SELECT * FROM items WHERE status IN ('todo', 'doing') ORDER BY n").toArray().map((r) => this.itemView(r));
  }

  todoFrame(): string {
    return JSON.stringify({ type: "todo", ...this.todoState() });
  }

  todoChanged() {
    this.schedule("itemsDue", 1_000).catch((e) => console.error(JSON.stringify({ msg: "schedule failed", error: String(e) })));
  }

  private itemRow(id: string): Row {
    const n = itemNumberOf(id);
    const r = n == null ? undefined : this.sql.exec("SELECT * FROM items WHERE n = ?", n).toArray()[0];
    if (!r) throw new ApiError("item_not_found", `There is no task ${id} in this topic (or it was deleted). See: scorpio todo roomId=${this.roomInfo().id}`, 404);
    return r;
  }

  private liveRow(id: string): Row {
    return this.itemRow(id);
  }

  openRow(id: string): Row {
    const r = this.liveRow(id);
    const refusal = closedRefusal(r);
    if (refusal) this.refuse(refusal);
    return r;
  }

  /** Keep writing the legacy column, but never create another visible round. */
  private ensureRound(): number {
    const first = this.sql.exec("SELECT n FROM rounds ORDER BY n LIMIT 1").toArray()[0];
    if (first) return first.n as number;
    this.sql.exec("INSERT INTO rounds (n, title, status, opened_ms) VALUES (1, NULL, 'open', ?)", now());
    return 1;
  }

  log(n: number, actor: Pick<Actor, "name">, op: string, from: Record<string, unknown> | null, to: Record<string, unknown> | null) {
    this.sql.exec(
      "INSERT INTO item_log (n, ms, by_name, op, from_json, to_json) VALUES (?, ?, ?, ?, ?, ?)",
      n,
      now(),
      actor.name,
      op,
      from ? JSON.stringify(from) : null,
      to ? JSON.stringify(to) : null,
    );
  }

  /**
   * Nobody who left is on anything: the doing items under names that just stopped being in the topic go
   * back to todo in the same step, before the leave is answered. Assignee and blocked_by stay; one history row each.
   */
  releaseItems(names: string[], actor: Pick<Actor, "name">) {
    if (!names.length) return;
    const rows = this.sql.exec(LEFT_DOING_SQL, JSON.stringify(names)).toArray();
    if (!rows.length) return;
    const t = now();
    for (const r of rows) {
      this.sql.exec(LEFT_TODO_SQL, r.n, actor.name, t);
      this.log(r.n as number, actor, "left", { status: "doing" }, { status: "todo" });
    }
    this.todoChanged();
  }

  /** A capped topic removed left agent seats: their open tasks go to each seat's person, in one SQL step. */
  reassignEvictedSeats(seats: { name: string; owner: string }[]): boolean {
    if (!seats.length) return false;
    const map = JSON.stringify(seats);
    const at = now();
    const logged = this.sql.exec(
      `INSERT INTO item_log (n, ms, by_name, op, from_json, to_json)
       SELECT i.n, ?, 'scorpio', 'assign', json_object('assignee', i.assignee),
              json_object('assignee', json_extract(s.value, '$.owner'))
       FROM items i JOIN json_each(?) s ON i.assignee = json_extract(s.value, '$.name')
       WHERE i.status IN ('todo', 'doing')`,
      at, map,
    );
    if (!logged.rowsWritten) return false;
    this.sql.exec(
      `UPDATE items SET assignee = (
         SELECT json_extract(s.value, '$.owner') FROM json_each(?) s
         WHERE json_extract(s.value, '$.name') = items.assignee
       ), updated_by = 'scorpio', updated_ms = ?
       WHERE status IN ('todo', 'doing') AND assignee IN (
         SELECT json_extract(value, '$.name') FROM json_each(?)
       )`,
      map, at, map,
    );
    return true;
  }

  private setItem(n: number, actor: Actor, fields: Record<string, SqlStorageValue>): Item {
    const keys = Object.keys(fields);
    this.sql.exec(
      `UPDATE items SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_by = ?, updated_ms = ? WHERE n = ?`,
      ...keys.map((k) => fields[k]),
      actor.name,
      now(),
      n,
    );
    this.todoChanged();
    return this.itemView(this.sql.exec("SELECT * FROM items WHERE n = ?", n).one());
  }

  /** Close an item, with the message that delivered it (send … done=) or without (todo done=). */
  closeItem(actor: Actor, r: Row, seq: number | null) {
    const n = r.n as number;
    const before = this.waitingOn(n);
    if (seq != null) this.sql.exec(JOIN_SQL, n, seq, "result");
    const plan = closePlan(r, actor, seq, now());
    const item = this.setItem(n, actor, plan.fields);
    this.log(n, actor, "done", plan.previous, plan.logTo);
    return { item, previous: plan.previous, unblocked: this.nowUnblocked(before), round: this.roundOf(item.round) };
  }

  /** Open items that this one blocks and that are still blocked (to see which it frees). */
  private waitingOn(n: number): Row[] {
    return this.sql
      .exec("SELECT * FROM items WHERE status IN ('todo', 'doing') AND EXISTS (SELECT 1 FROM json_each(items.blocked_by) WHERE value = ?)", n)
      .toArray()
      .filter((x) => this.openBlockers(x).length > 0);
  }

  private nowUnblocked(before: Row[]) {
    return before
      .map((x) => this.sql.exec("SELECT * FROM items WHERE n = ?", x.n).toArray()[0])
      .filter((x): x is Row => !!x && x.status !== "done" && this.openBlockers(x).length === 0)
      .map((x) => ({ id: `T${x.n}`, title: x.title as string, assignee: (x.assignee as string) ?? null }));
  }

  /** Item numbers from "T3,T4" / ["T3","4"]; each must exist. */
  private itemNumbers(list: string[] | undefined): number[] {
    return [...new Set(idsOf(list).map((id) => this.itemRow(id).n as number))];
  }

  /** Who an item can be for: a person or an agent in the room (not a daemon seat), by full name. */
  assigneeOf(to: string): string | null {
    const name = memberNameOf(to);
    if (!name) return null;
    const m = this.memberRow(name) ?? this.d.members.findCaseless(name);
    const refusal = assigneeRefusal(name, m);
    if (refusal) this.refuse(refusal);
    return m!.name as string;
  }

  /** Item numbers count up and are never reused, deleted ones included. */
  private nextItemNumber(): number {
    const max = (this.sql.exec("SELECT COALESCE(MAX(n), 0) AS n FROM items").one().n as number) || 0;
    const n = Math.max(this.ctx.storage.kv.get<number>("lastItem") ?? 0, max) + 1;
    this.ctx.storage.kv.put("lastItem", n);
    return n;
  }

  /**
   * A person's item is changed through messages: the message that becomes its source must @ them or be
   * theirs. `name`: who the item is (or will be) under; nothing to check for an agent, nobody, or a name not found.
   */
  requireToPerson(name: string | null, author: string, mentions: string[]) {
    const refusal = toPersonRefusal(name, author, mentions, !!name && this.memberRow(name)?.kind === "human");
    if (refusal) this.refuse(refusal);
  }

  /** The same check for a message already in the room (task add from=, task edit from=). */
  private requireMessageToPerson(name: string | null, seq: number) {
    const m = this.sql.exec("SELECT * FROM message_thread_v WHERE seq = ?", seq).toArray()[0];
    if (m) this.requireToPerson(name, m.from_name as string, mentionsOf(m));
  }

  /** Check an add (todo add, send add=) before anything is written. */
  prepareAdd(p: { title?: string; to?: string; desc?: string; after?: string[]; from?: number | null }) {
    const inputs = addInputs(p);
    if ("code" in inputs) this.refuse(inputs);
    const assignee = p.to ? this.assigneeOf(p.to) : null;
    const after = this.itemNumbers(p.after);
    const desc = null; // items have no description: never written again
    if (inputs.from != null) {
      const src = this.sql.exec("SELECT seq FROM message_thread_v WHERE seq = ?", inputs.from).toArray()[0];
      if (!src) throw new ApiError("message_not_found", `from=${inputs.from}: there is no such message.`, 404);
    }
    return { title: inputs.title, assignee, after, desc, from: inputs.from };
  }

  insertItem(actor: Actor, a: ReturnType<Tasks["prepareAdd"]>, createdSeq: number | null) {
    const round = this.ensureRound();
    const n = this.nextItemNumber();
    const t = now();
    this.sql.exec(
      `INSERT INTO items (n, round, title, status, assignee, created_by, created_seq, created_ms, updated_by, updated_ms, descr, blocked_by)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?)`,
      n,
      round,
      a.title,
      a.assignee,
      actor.name,
      createdSeq,
      t,
      actor.name,
      t,
      a.desc,
      JSON.stringify(a.after),
    );
    this.log(n, actor, "add", null, { title: a.title, assignee: a.assignee, blockedBy: a.after.map((x) => `T${x}`) });
    if (createdSeq != null) this.sql.exec(JOIN_SQL, n, createdSeq, "source");
    this.todoChanged();
    const item = this.itemView(this.sql.exec("SELECT * FROM items WHERE n = ?", n).one());
    this.pushAssigned(actor, item);
    return { item, round: this.roundOf(round) };
  }

  /**
   * An open item put under a person's name: that person is told by Web Push, unless a page of
   * theirs in this room is in view. One notification per item (its tag); handing it on replaces nothing here:
   * the service worker closes what is no longer theirs the next time it runs (POST /push/resolved).
   */
  pushAssigned(actor: Pick<Actor, "name" | "kind">, item: Item, seq?: number) {
    const to = item.assignee;
    const toIsHuman = !!to && activePushRecipient(this.memberRow(to));
    const inView = !!to && viewing(this.ctx, to);
    const info = this.roomInfo();
    const byDisplayName = actor.kind === "human" ? ((this.memberRow(actor.name)?.display_name as string | null) || undefined) : undefined;
    const payload = assignedPush(item, actor, toIsHuman, inView, { id: info.id, name: info.name }, byDisplayName, seq);
    if (payload) this.ctx.waitUntil(notify(this.env, to!, payload).catch((e) => console.error(JSON.stringify({ msg: "push failed", error: String(e) }))));
  }

  /** Of these items, the ones still open and under this person's name (for closing notifications that are not). */
  async openForMe(handle: string, ids: string[]): Promise<string[]> {
    if ("err" in this.wrap(() => this.room())) return []; // deleted or gone: none of its items is open for anyone
    if (this.memberRow(handle)?.status !== "active") return [];
    return ids.filter((id) => {
      const m = /^T(\d+)$/.exec(id);
      const r = m ? this.sql.exec("SELECT assignee, status FROM items WHERE n = ?", Number(m[1])).toArray()[0] : undefined;
      return !!r && r.status !== "done" && r.assignee === handle;
    });
  }

  sourceExists(n: number): boolean { return !!this.sql.exec("SELECT 1 FROM items WHERE n = ?", n).toArray()[0]; }

  /** Search's todo group (room/search.ts): every item, newest first, the creator's display name through member_names_v. */
  searchItems(p: SearchQuery): SearchPage {
    const match = likeTerms("(i.title || ' ' || COALESCE(i.descr, ''))", p.terms);
    const extra = filterSql(p, "todo");
    const args = [...match.args, ...(p.before ? [p.before] : []), ...extra.args];
    const { rows, hasMore } = page(
      this.sql.exec(
        `SELECT i.n, i.title, i.descr, i.status, i.assignee, i.created_by, h.display_name, i.created_seq, i.created_ms FROM items i LEFT JOIN member_names_v h ON h.name = i.created_by WHERE ${match.sql}${p.before ? " AND i.created_seq < ?" : ""} ${extra.sql} ORDER BY ${p.order === "asc" ? "i.created_ms ASC, i.n ASC" : "i.created_ms DESC, i.n DESC"} LIMIT ?`,
        ...args,
        p.limit + 1,
      ).toArray(),
      p.limit,
    );
    return {
      hits: rows.map((r) => ({ type: "todo", id: `T${r.n}`, seq: (r.created_seq as number | null) ?? null, who: r.created_by as string, displayName: (r.display_name as string | null) ?? null, ts: r.created_ms as number, title: r.title as string, status: r.status as string, assignee: (r.assignee as string | null) ?? null, snippet: searchSnippet(`${r.title} ${r.descr || ""}`, p.terms) })),
      hasMore,
    };
  }

  /** TODO changes are not messages, so the daily quota does not count them; this keeps a loop from flooding a room. */
  private todoWrites = { minute: 0, n: 0 };
  todoRate(limits?: Limits | null) {
    const max = limits?.todoWritesPerRoomMinute ?? TODO_WRITES_PER_MINUTE; // a plan cached before this limit existed has none
    const minute = Math.floor(now() / 60_000);
    const step = rateStep(this.todoWrites, minute, max);
    this.todoWrites = step.state;
    if (step.over) {
      throw new ApiError("rate_limited", `More than ${max} task changes in this topic within a minute. Wait a minute and retry.`, 429);
    }
  }

  /**
   * On the web a person changes the TODO in three ways only: an item under their own name done, or
   * undone; and 「加到 TODO」, an item on themselves made from a message.
   */
  private personMay(actor: Actor, p: TodoOp) {
    const own = () => this.itemRow(p.id || "").assignee === actor.name;
    const kind = personMayCase(p);
    if (kind !== "fromMessage" && !(kind === "doneOrUndo" && own())) {
      throw new ApiError("forbidden", "On the web you mark tasks under your own name delivered, or add a message as a task for yourself. For anything else (rename, hand over, delete), say it in the topic and an agent does it.", 403);
    }
  }

  /** 「加到 TODO」: the item's title from the message, its first line after the leading @names, cut at 80 characters. */
  private titleFrom(seq: number): string {
    const m = this.sql.exec("SELECT text, files FROM message_thread_v WHERE seq = ?", seq).toArray()[0];
    if (!m) throw new ApiError("message_not_found", `from=${seq}: there is no such message.`, 404);
    const files = m.files ? (JSON.parse(m.files as string) as { name: string }[]) : [];
    return titleOf(String(m.text || ""), files, seq);
  }

  async todoList(actor: Actor, round?: number): Promise<Result<Record<string, unknown>>> {
    return this.wrap(() => {
      this.reader(actor);
      const roomId = this.roomInfo().id;
      if (round != null) throw new ApiError("bad_request", ROUNDS_GONE_NEXT);
      const st = this.todoState();
      return { roomId, ...st };
    });
  }

  /**
   * task mine=true (yours, and what you opened under other names) and open=true [to=] (the topic's open items, or
   * those under one name, a member who left included): short Brief entries (CLI 0.5.3).
   */
  async todoBrief(actor: Actor, p: { mine?: boolean; to?: string | null }): Promise<Result<Record<string, unknown>>> {
    return this.wrap(() => {
      this.reader(actor);
      const roomId = this.roomInfo().id;
      const open = this.openItems();
      const present = this.present();
      if (p.mine) return { roomId, me: actor.name, ...mineOf(open, actor.name, present), counts: this.counts() };
      let to: string | null = null;
      if (p.to) {
        const name = p.to.trim().replace(/^@/, "");
        const m = this.memberRow(name) ?? this.d.members.findCaselessName(name);
        if (!m) throw new ApiError("bad_request", `to=${name}: no one by that name is or was in this topic; see scorpio members roomId=${roomId}.`);
        to = m.name as string;
      }
      return { roomId, items: openOf(open, to, present), counts: this.counts() };
    });
  }

  /**
   * task show= (and the web's detail, `full`): the item with its thread, its latest source and its history; the web
   * also gets the thread's messages in full.
   */
  async todoShow(actor: Actor, id: string, full = false): Promise<Result<Record<string, unknown>>> {
    return this.wrap(() => {
      this.reader(actor);
      return { roomId: this.roomInfo().id, ...this.showItem(this.itemRow(id), full) };
    });
  }

  /**
   * The export's tasks (room/export.ts): every item, open and delivered, as `task show=` answers it (item, source,
   * history), in one call. Never the thread's messages in full: they are in the export's messages already, and 1,800
   * of them at once would outgrow one RPC answer.
   */
  exportItems(): Record<string, unknown>[] {
    return this.sql.exec("SELECT * FROM items ORDER BY n").toArray().map((r) => this.showItem(r, false));
  }

  /** What todoShow answers about one item, without the roomId: the item with its thread, its latest source and its history. */
  private showItem(r: Row, full: boolean): Record<string, unknown> {
    const seq = r.created_seq as number | null;
    const source = seq == null ? null : this.sql.exec("SELECT seq, from_name, text, files, ts FROM message_thread_v WHERE seq = ?", seq).toArray()[0];
    const history = this.sql
      .exec("SELECT * FROM item_log WHERE n = ? ORDER BY id", r.n)
      .toArray()
      .map((h) => ({
        ms: h.ms as number,
        by: h.by_name as string,
        op: h.op as string,
        from: h.from_json ? JSON.parse(h.from_json as string) : null,
        to: h.to_json ? JSON.parse(h.to_json as string) : null,
      }));
    const rows = this.sql.exec(THREAD_SQL, r.n).toArray();
    const thread = rows.map((t) => ({ seq: t.seq as number, from: t.from_name as string, kind: t.from_kind as string, ts: t.ts as number, rel: t.rel as Rel }));
    const messages = full
      ? rows.map((t) => this.sql.exec("SELECT seq, from_name, from_kind, text, files, ts FROM message_thread_v WHERE seq = ?", t.seq).one()).map((m) => ({
        seq: m.seq as number, from: m.from_name as string, kind: m.from_kind as string, text: m.text as string,
        files: m.files ? this.withLinks(JSON.parse(m.files as string) as FileMeta[]) : [], ts: m.ts as number,
      }))
      : undefined;
    return {
      item: { ...this.itemView(r), thread },
      ...(messages ? { messages } : {}),
      source: source ? {
        seq: source.seq as number,
        from: source.from_name as string,
        text: source.text as string,
        files: source.files ? (JSON.parse(source.files as string) as { name: string }[]).map((f) => f.name) : [],
        ts: source.ts as number,
      } : null,
      history,
    };
  }

  async todo(actor: Actor, p: TodoOp): Promise<Result<Record<string, unknown>>> {
    const owner = await this.ownerLimits().catch(() => null);
    return this.wrap(() => {
      this.requireMember(actor);
      if (p.op === "name") throw new ApiError("bad_request", ROUNDS_GONE_NEXT);
      this.requireWritable();
      if (actor.kind === "human") this.personMay(actor, p);
      this.todoRate(owner?.limits);
      this.touch(actor.name);
      const roomId = this.roomInfo().id;
      if (p.op === "add" && actor.kind === "human") {
        const from = Math.floor(Number(p.from));
        const title = (p.title || "").trim() || this.titleFrom(from);
        return { roomId, ...this.insertItem(actor, this.prepareAdd({ title, to: actor.name, from }), from) };
      }
      if (p.op === "add") {
        // Every item comes from a message, so the web can always open it: send add= makes both in one step.
        if (!(Number(p.from) > 0)) {
          throw new ApiError(
            "source_required",
            `A task comes from a message. Say it and open the task in one step: scorpio send roomId=${roomId} text='@name …' add='<title>' [to=<name>]; or point at the message it came from: todo add='<title>' from=<seq>.`,
          );
        }
        const a = this.prepareAdd(p);
        this.requireMessageToPerson(a.assignee, a.from!);
        return { roomId, ...this.insertItem(actor, a, a.from) };
      }
      if (p.op === "delete") {
        const ids = (p.ids?.length ? p.ids : String(p.id || "").split(",")).map((x) => x.trim()).filter(Boolean);
        if (!ids.length) throw new ApiError("bad_request", "delete=T3[,T4] is required.");
        const rows = [...new Map(ids.map((id) => this.liveRow(id)).map((r) => [r.n as number, r])).values()];
        const refusal = deleteDecision(rows, actor, !!p.force);
        if (refusal) this.refuse(refusal);
        const gone = rows.map((r) => r.n as number);
        const before = gone.flatMap((n) => this.waitingOn(n)).filter((x, i, a) => !gone.includes(x.n as number) && a.findIndex((y) => y.n === x.n) === i);
        this.sql.exec("DELETE FROM items_deleted WHERE ms < ?", now() - VISIBLE_DONE_MS);
        for (const r of rows) {
          this.sql.exec(
            "INSERT OR REPLACE INTO items_deleted (n, title, assignee, created_by, by_name, ms) VALUES (?, ?, ?, ?, ?, ?)",
            r.n, r.title, (r.assignee as string) ?? null, r.created_by, actor.name, now(),
          );
        }
        for (const n of gone) {
          this.sql.exec("DELETE FROM items WHERE n = ?", n);
          this.sql.exec("DELETE FROM item_log WHERE n = ?", n);
          this.sql.exec("DELETE FROM item_replies WHERE n = ?", n);
          this.sql.exec("DELETE FROM item_messages WHERE n = ?", n);
        }
        // What waited for them waits no more.
        for (const r of this.sql.exec("SELECT n, blocked_by FROM items WHERE blocked_by != '[]'").toArray()) {
          const list = this.blockers(r);
          const kept = list.filter((x) => !gone.includes(x));
          if (kept.length !== list.length) this.sql.exec("UPDATE items SET blocked_by = ? WHERE n = ?", JSON.stringify(kept), r.n);
        }
        this.todoChanged();
        return { roomId, deleted: gone.map((n) => `T${n}`), unblocked: this.nowUnblocked(before), round: this.legacyRound() };
      }
      const r = p.op === "edit" ? this.liveRow(p.id || "") : this.openRow(p.id || "");
      const n = r.n as number;
      const holder = (r.assignee as string) ?? null;
      const othersDoing = r.status === "doing" && !!holder && holder !== actor.name;
      if (p.op === "take") {
        const decision = takeDecision(r, actor, !!p.force, this.openBlockers(r));
        if ("refusal" in decision) this.refuse(decision.refusal);
        const item = this.setItem(n, actor, decision.fields);
        this.log(n, actor, "take", decision.previous, decision.fields);
        return { roomId, item, previous: Object.keys(decision.previous).length ? decision.previous : null, round: this.roundOf(item.round) };
      }
      if (p.op === "done") {
        const { item, previous, unblocked, round } = this.closeItem(actor, r, null);
        return { roomId, item, previous, round, unblocked, mine: this.yours(actor.name) };
      }
      if (p.op === "edit") {
        if (p.desc !== undefined) throw new ApiError("bad_request", NO_DESC_NEXT);
        // On a person's item the title changes with a message, and a new source must be one to them.
        const under = p.to !== undefined ? quiet(() => this.assigneeOf(p.to || "")) : holder;
        const person = (name: string | null) => !!name && this.memberRow(name)?.kind === "human";
        const titleRefusal = editTitleRefusal(r, p.title, p.title !== undefined && person(holder), roomId);
        if (titleRefusal) this.refuse(titleRefusal);
        if (p.from != null && Number(p.from) > 0) this.requireMessageToPerson(under, Math.floor(Number(p.from)));
        const out = this.editItem(actor, r, p, (to) => `todo edit=T${n} to=${to} force=true`);
        if (!out) return { roomId, item: this.itemView(r), previous: null, round: this.roundOf(r.round as number) };
        return { roomId, ...out, round: this.roundOf(out.item.round), ...(out.unblocked ? { mine: this.yours(actor.name) } : {}) };
      }
      throw new ApiError("bad_request", "A task change is one of add=, take=, done=, edit=, delete= (show=T3 and the list are reads).");
    });
  }

  /**
   * Change an item's fields (todo edit=, and send … update= with from= this message and to=). Null when nothing
   * changed. `again`: the command that hands over someone else's doing item anyway, for the item_taken hint.
   */
  editItem(
    actor: Actor,
    r: Row,
    p: Pick<TodoOp, "title" | "desc" | "to" | "from" | "after" | "status" | "force">,
    again: (to: string) => string,
  ): { item: Item; previous: Record<string, unknown>; unblocked?: ReturnType<Tasks["nowUnblocked"]> } | null {
    const n = r.n as number;
    const plan = editPlan(r, actor, p, {
      assigneeOf: (to) => this.assigneeOf(to),
      messageExists: (seq) => this.sql.exec("SELECT 1 FROM message_thread_v WHERE seq = ?", seq).toArray().length > 0,
      itemNumbers: (list) => this.itemNumbers(list),
      blockersMap: () => new Map<number, number[]>(this.sql.exec("SELECT n, blocked_by FROM items").toArray().map((row) => [row.n as number, blockersOf(row)])),
    }, again, now());
    if (!plan) return null;
    if ("refusal" in plan) this.refuse(plan.refusal);
    const { fields, prev, next, closing } = plan;
    const before = closing ? this.waitingOn(n) : [];
    const item = this.setItem(n, actor, fields as Record<string, SqlStorageValue>);
    this.log(n, actor, Object.keys(next).length === 1 && "assignee" in next ? "assign" : "edit", prev, next);
    if ("createdSeq" in next) {
      // A new source joins the thread and, written to the person by someone else, reaches their phone.
      const seq = next.createdSeq as number;
      this.sql.exec(JOIN_SQL, n, seq, "source");
      const author = this.sql.exec("SELECT from_name, from_kind FROM message_thread_v WHERE seq = ?", seq).toArray()[0];
      if ("assignee" in next) this.pushAssigned(actor, item);
      else if (author) this.pushAssigned({ name: author.from_name as string, kind: author.from_kind as ActorKind }, this.itemView(this.sql.exec("SELECT * FROM items WHERE n = ?", n).one()), seq);
    } else if ("assignee" in next) this.pushAssigned(actor, item);
    return { item, previous: prev, ...(closing ? { unblocked: this.nowUnblocked(before) } : {}) };
  }

  // A message send's task part (SendSteps): Messages.doSend calls each step where this code ran inside it before S6b.

  refuseSend(p: SendOp) {
    if (p.update && (p.done || p.add !== undefined)) {
      throw new ApiError("bad_request", "update= goes alone: its to= is the task's new assignee. Send done= or add= in a message of their own.");
    }
    if (p.desc !== undefined) throw new ApiError("bad_request", NO_DESC_NEXT);
    if (p.title !== undefined && !p.update) throw new ApiError("bad_request", "title= goes only with update=T5: the message renames the task it updates.");
  }

  addressed(p: SendOp, actor: Actor, mentions: string[]) {
    // A person's item is changed through messages: checked before anything is written.
    if (p.add !== undefined && p.to) this.requireToPerson(quiet(() => this.assigneeOf(p.to!)), actor.name, mentions);
    const updating = p.update ? quiet(() => this.openRow(p.update!)) : null;
    if (updating) this.requireToPerson(p.to !== undefined ? quiet(() => this.assigneeOf(p.to || "")) : (updating.assignee as string) ?? null, actor.name, mentions);
  }

  /**
   * The open items' threads the send joins, and the closers of its reports. Read before anything is written, so an item
   * this send opens never joins.
   */
  route(p: SendOp, actor: Actor, text: string, replyTo: number | null, scheduled: NonNullable<Message["scheduled"]> | undefined, mentions: string[], candidates: OpenItem[]): Route {
    const marked = [...(p.add !== undefined ? [-1] : []), ...(p.update ? [itemNo(p.update)] : []), ...(p.done ? [itemNo(p.done)] : [])];
    const incoming = {
      author: scheduled?.by ?? actor.name,
      daemonCommand: this.daemonCommand(text, mentions),
      mentions,
      replyTo,
      replyToAuthor: replyTo == null ? null : this.replyAuthor(replyTo),
      tNumbers: tNumbers(proseOf(text)),
      sourceOrResultOf: marked,
    };
    const joined = joins(incoming, candidates).map((j) => ({ ...j, row: this.sql.exec("SELECT * FROM items WHERE n = ?", j.n).one() }));
    const reports = joined.filter((j) => j.rel === "reply");
    const closers = [...new Set(reports.map((j) => (j.by === "b" ? this.reportCloser(replyTo, j.row.created_by as string, j.n) : (j.row.created_by as string))))];
    return { joined, closers };
  }

  prepare(p: SendOp, limits: Limits): AddPrep | null {
    // send … add='…': the item is checked before anything is written, and opened with this message as
    // its source, so the message goes out already carrying it (Message.todo).
    if (p.add === undefined) return null;
    const a = this.prepareAdd({ title: p.add, to: p.to, desc: p.desc, after: p.after });
    this.todoRate(limits);
    return a;
  }

  /** The send's task rows, written in insertMessage's transaction right after the message row, numbered `seq`. */
  attach(seq: number, actor: Actor, p: SendOp, prep: AddPrep | null, route: Route): { added: Added | null } {
    const added = prep ? this.insertItem(actor, prep, seq) : null;
    // Carry a valid done= result in the message frame; closeItem still finishes it after the send.
    const delivering = p.done ? quiet(() => this.openRow(p.done!)) : null;
    if (delivering) this.sql.exec(JOIN_SQL, delivering.n, seq, "result");
    // Joined before the message goes out, so it goes out carrying them (todo[] rel: thread / reply).
    for (const j of route.joined) {
      this.sql.exec(JOIN_SQL, j.n, seq, j.rel);
      if (j.rel === "reply") this.log(j.n, actor, "reply", null, { seq });
    }
    return { added };
  }

  after(seq: number, actor: Actor, p: SendOp, route: Route) {
    if (route.joined.length) this.todoChanged();
    // Written to the person an item is under, by someone else: their phone gets it (push follows the thread).
    // The item this message delivers is closing; the one it updates is told by the update.
    for (const j of route.joined) {
      if (j.rel === "thread" && j.n !== itemNo(p.done) && j.n !== itemNo(p.update)) this.pushAssigned(actor, this.itemView(this.sql.exec("SELECT * FROM items WHERE n = ?", j.n).one()), seq);
    }
  }

  answer(seq: number, actor: Actor, p: SendOp, limits: Limits, out: Record<string, unknown>, added: Added | null) {
    if (added) {
      // Read again now that its source message exists, so the answer's item has its current.
      added = { ...added, item: this.itemView(this.sql.exec("SELECT * FROM items WHERE n = ?", Number(added.item.id.slice(1))).one()) };
      out.item = added.item;
      out.round = added.round;
    }
    // send … done=T3: this message is the item's result; the message stands even if the item is wrong.
    // With add= as well (deliver one, open the next) the closed one is `item` and the new one `added`.
    if (p.done) {
      if (added) out.added = added.item;
      try {
        const { item, unblocked, round } = this.closeItem(actor, this.openRow(p.done), seq);
        out.item = item;
        out.unblocked = unblocked;
        out.round = round;
        out.mine = this.yours(actor.name);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        out.item = { error: e.code, next: e.next };
      }
    }
    // send … update=T3 [to=]: this message becomes the item's source (as edit from=), answering the reply waiting
    // on it, and to= hands it on; the message stands even if the item is wrong (CLI 0.5.3).
    if (p.update) {
      try {
        const r = this.openRow(p.update);
        this.todoRate(limits);
        const n = r.n as number;
        const changed = this.editItem(actor, r, { from: seq, to: p.to, force: p.force, title: p.title }, (to) => `scorpio todo roomId=${this.roomInfo().id} edit=T${n} to=${to} from=${seq} force=true`);
        out.item = changed?.item ?? this.itemView(r);
        out.previous = changed?.previous ?? null;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        out.item = { error: e.code, next: e.next };
      }
    }
  }

  /** The items a replayed send closed or opened, from its message row. */
  replay(row: Row, out: Record<string, unknown>) {
    const seq = row.seq as number;
    const closed = this.sql.exec("SELECT * FROM items WHERE done_seq = ?", seq).toArray()[0];
    const opened = this.sql.exec("SELECT * FROM items WHERE created_seq = ? ORDER BY n DESC LIMIT 1", seq).toArray()[0];
    if (closed) Object.assign(out, { item: this.itemView(closed), unblocked: [], round: this.roundOf(closed.round as number) }, opened ? { added: this.itemView(opened) } : {});
    else if (opened) Object.assign(out, { item: this.itemView(opened), round: this.roundOf(opened.round as number) });
  }
}
