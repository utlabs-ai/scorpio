// The messages domain (docs/api/messages.md): the messages table and what follows from it (messages_fts,
// message_notifies, my_data_cache, the message_files_v and message_thread_v views), the one write path for a message (insertMessage) and its
// fan-out, a member's send (doSend) with its nonce replay, and every read of the history: pages, around, one message,
// @me, listen and pending, my data, activity, search's messages group, and the counts the quota, the retention clock
// and the topic's summary read. RoomDO holds it through RoomDO.messagesIn(o) and keeps forwards under the old names
// (split by domain S8a). A domain whose writes ride on a send takes part through SendSteps (tasks); files keeps its
// explicit calls at its own points.
//
// Members' reads for a send go through members' functions (sendRows, takeoverChanged); members' takeover lookups read
// messages through takeoverCandidates and renamedEvents here, presence's room frame and hello through lastHumanTs and
// recent, the topic's summary through lastTs and unreadFor, the public snapshot through latestForSnapshot. Search reads
// display names through member_names_v.
import { richMessage, pressDecision } from "../room-rich-message";
import { messageScreen, screenFor, type Screen, type OwnedScreen } from "../room-screen";
import type { Ticket } from "../view-ticket";
import type { Button, Card } from "../room-rich-message";
import { ApiError, now } from "../util";
import { membersFor } from "../member-visibility";
import { accountOf } from "../files";
import { MAX_TEXT } from "../plans";
import { mentionTokens, namesMentioned } from "../mentions";
import { pageMessage } from "../page-view";
import { ROOM_DAILY_SQL, ROOM_DATA_CACHE_MS, ROOM_TOTALS_SQL } from "../my-data";
import { ROOM_ACTIVITY_SQL, dayOf } from "../ops-data";
import { TAKEOVER_CANDIDATES_SQL } from "../takeover";
import { hostOfflineSince } from "../host-offline";
import { filterSql, resolveFilters, searchQuery, page, searchSnippet, trigramCandidate, likeTerms } from "../search";
import { safeSend, toBrowsers, tx, wrap } from "./kernel";
import type { Actor, Result, Row } from "./kernel";
import type { SearchPage, SearchQuery, SearchFilters } from "../search";
import type { FileMeta } from "../files";
import type { Limits, Plan } from "../plans";
import type { RoomData } from "../my-data";
import type { OpenItem } from "../item-thread";
import type { Member, Message, RoomInfo, SendOp, SystemEvent } from "./types";
import type { Tasks } from "./tasks";

const PAGE_MAX = 200;
// Ordinary messages keep the original one-row read. Only a card needs the immutable FTS content copy for its
// summary match/snippet; this is an indexed lookup in the same query, never a join of the card/HTML table.
const SEARCH_TEXT_SQL = "CASE WHEN m.kind = 'card' THEN (SELECT text FROM messages_fts WHERE rowid = m.seq) ELSE m.text END";

export const MESSAGE_THREAD_VIEW_SQL = "CREATE VIEW IF NOT EXISTS message_thread_v AS SELECT seq, ts, from_name, from_kind, text, files, mentions, reply_to, scheduled FROM messages";

// The steps a message send asks of a domain whose writes ride on it (split by domain S6b): Messages.doSend calls each
// at a fixed point of the send, not in a loop, because those points sit between the quota check, the delivery lists
// and the count, and moving them would change which refusal wins. Only tasks takes part today (Tasks implements it).
// Types only, so no domain imports another through it.

/**
 * Prep: what prepare checked, for attach to write. Route: what the send joins, worked out before anything is written,
 * with `closers`, the names its reports go to (doSend wakes or tells each). Added: what attach opened, for answer.
 */
export interface SendSteps<Prep, Route extends { closers: string[] }, Added> {
  /** Refusals from the request alone: after the nonce replay, before the topic is checked writable. */
  refuseSend(p: SendOp): void;
  /** Refusals that need the message's @names: just before the quota check. */
  addressed(p: SendOp, actor: Actor, mentions: string[]): void;
  /** What the send joins, after the delivery lists and before the writes. */
  route(p: SendOp, actor: Actor, text: string, replyTo: number | null, scheduled: NonNullable<Message["scheduled"]> | undefined, mentions: string[], candidates: OpenItem[]): Route;
  /** The checks for attach's writes, which may still refuse the send. */
  prepare(p: SendOp, limits: Limits): Prep;
  /** The writes, inside insertMessage's transaction right after the message row (`seq`); throws no ApiError. */
  attach(seq: number, actor: Actor, p: SendOp, prep: Prep, route: Route): { added: Added | null };
  /** Effects once the message is out, before it is counted. */
  after(seq: number, actor: Actor, p: SendOp, route: Route): void;
  /** The domain's part of the answer, filled into `out` in place. */
  answer(seq: number, actor: Actor, p: SendOp, limits: Limits, out: Record<string, unknown>, added: Added | null): void;
  /** The domain's part of a nonce replay's answer, from the stored message row. */
  replay(row: Row, out: Record<string, unknown>): void;
}

/** What insertMessage writes: the message row, and the files it carries. */
export type NewMessage = {
  from: string;
  fromKind: string;
  text: string;
  mentions?: string[];
  broadcast?: boolean;
  replyTo?: number | null;
  command?: string | null;
  event?: SystemEvent | null;
  wake?: string[];
  notify?: string[];
  files?: (FileMeta & { url: string })[];
  nonce?: string;
  receipt?: unknown;
  scheduled?: Message["scheduled"];
  buttons?: Button[];
  card?: Card;
  screen?: Screen;
};

export interface MessagesDeps {
  sql(): SqlStorage;
  ctx(): DurableObjectState;
  /** Messages' own replaySend and insertMessage as doSend calls them: over RoomDO's names, which schedule-room fakes. */
  replaySend(actor: Actor, nonce: string | undefined, echo?: boolean): Record<string, unknown> | null;
  insertMessage(p: NewMessage, attach?: (seq: number) => void): Message;
  room: { require(): Row; requireWritable(): void; info(): RoomInfo };
  members: {
    require(actor: Actor): Row;
    reader(actor: Actor): Row | null;
    get(name: string): Row | undefined;
    touch(name: string): void;
    takeoverFor(name: string, owner: string): { command: string; seq: number } | null;
    currentHost(name: string): string | null;
    all(except?: WebSocket): Member[];
    sendRows(): Row[];
    takeoverChanged(account: string, roles: Set<string>): void;
  };
  presence: { isOnline(name: string, kind: string, except?: WebSocket): boolean; carriers(name: string): WebSocket[]; activity(ts: number): void };
  memo: { steps(): import("./memo").Memos; state(): import("../memo-types").MemoState };
  tasks: {
    steps(): Tasks;
    todoFor(rows: Row[], parents: Map<number, Row>): Map<number, NonNullable<Message["todo"]>>;
    todoOf(seq: number): { todo?: Message["todo"] };
    todoState(): ReturnType<Tasks["todoState"]>;
    openCandidates(): OpenItem[];
  };
  files: {
    withLinks<T extends FileMeta>(files: T[]): (T & { link: string; view: boolean })[];
    sentFiles(files: FileMeta[]): { files?: { id: string; name: string; size: number; link: string }[] };
    attach(seq: number, files: FileMeta[]): void;
    consumeTicket(label: string, expiresAt: number): boolean;
    claim(actor: Actor, ids: string[]): (FileMeta & { url: string })[];
  };
  quota: {
    ownerLimits(): Promise<{ plan: Plan; limits: Limits }>;
    check(lim: Limits): void;
    count(lim: Limits, seq: number): { used: number; limit: number; resetsAt: number } | undefined;
    markActive(): void;
    markSender(kind: string, account: string): void;
  };
  snapshot: { publicChanged(): void };
}

export class Messages {
  constructor(private readonly d: MessagesDeps) {}

  // Same names as RoomDO's, so each body reads as it did there. Each dep is read at call time (room-message-page swaps
  // sql for a counting proxy).
  private get sql() { return this.d.sql(); }
  private get ctx() { return this.d.ctx(); }
  private wrap<T>(fn: () => T): Result<T> { return wrap(fn); }
  private safeSend(ws: WebSocket, data: string) { return safeSend(ws, data); }
  private room() { return this.d.room.require(); }
  private requireWritable() { this.d.room.requireWritable(); }
  private roomInfo() { return this.d.room.info(); }
  private requireMember(actor: Actor) { return this.d.members.require(actor); }
  private reader(actor: Actor) { return this.d.members.reader(actor); }
  private memberRow(name: string) { return this.d.members.get(name); }
  private touch(name: string) { this.d.members.touch(name); }
  private takeoverFor(name: string, owner: string) { return this.d.members.takeoverFor(name, owner); }
  private currentHost(name: string) { return this.d.members.currentHost(name); }
  private allMembers(except?: WebSocket) { return this.d.members.all(except); }
  private sendRows() { return this.d.members.sendRows(); }
  private takeoverChanged(account: string, roles: Set<string>) { this.d.members.takeoverChanged(account, roles); }
  private isOnline(name: string, kind: string, except?: WebSocket) { return this.d.presence.isOnline(name, kind, except); }
  private carriers(name: string) { return this.d.presence.carriers(name); }
  private activity(ts: number) { this.d.presence.activity(ts); }
  private todoOf(seq: number) { return this.d.tasks.todoOf(seq); }
  private todoState() { return this.d.tasks.todoState(); }
  private openCandidates() { return this.d.tasks.openCandidates(); }
  private withLinks<T extends FileMeta>(files: T[]) { return this.d.files.withLinks(files); }
  private sentFiles(files: FileMeta[]) { return this.d.files.sentFiles(files); }
  private claimFiles(actor: Actor, ids: string[]) { return this.d.files.claim(actor, ids); }
  private ownerLimits() { return this.d.quota.ownerLimits(); }
  private checkQuota(lim: Limits) { this.d.quota.check(lim); }
  private countMessage(lim: Limits, seq: number) { return this.d.quota.count(lim, seq); }
  private markActive() { this.d.quota.markActive(); }
  private markSender(kind: string, account: string) { this.d.quota.markSender(kind, account); }
  private publicChanged() { this.d.snapshot.publicChanged(); }

  // Messages' schema, one function per place RoomDO.migrate runs it today: the positions matter (Files.migrate's
  // gone_files backfill reads messages.files, tasks' thread backfill reads the columns added here).

  /** The table, its index, the search index, the @me index and the my-data cache: in the first batch. */
  static createTables(sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY,
        from_name TEXT NOT NULL,
        from_kind TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'text',
        text TEXT NOT NULL,
        card TEXT,
        buttons TEXT,
        memo TEXT,
        mentions TEXT NOT NULL DEFAULT '[]',
        broadcast INTEGER NOT NULL DEFAULT 0,
        reply_to INTEGER,
        command TEXT,
        event TEXT,
        wake TEXT NOT NULL DEFAULT '[]',    -- agents this message wakes
        notify TEXT NOT NULL DEFAULT '[]',  -- people it is addressed to (directly, or as owner of a mentioned agent)
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_cards (
        seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, html TEXT NOT NULL, size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_screens (
        seq INTEGER PRIMARY KEY, account TEXT NOT NULL, text TEXT NOT NULL, hidden INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_screens_account ON message_screens (account);
      CREATE INDEX IF NOT EXISTS messages_kind_seq_ts ON messages (from_kind, seq, ts);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='trigram');
      -- Derived from messages.notify. The primary key answers one person's @me queries by seq.
      CREATE TABLE IF NOT EXISTS message_notifies (
        name TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (name, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS message_mentions (name TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (name, seq)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS messages_from_seq ON messages (from_name, seq);
      CREATE INDEX IF NOT EXISTS messages_reply_to ON messages (reply_to) WHERE reply_to IS NOT NULL;
      CREATE TABLE IF NOT EXISTS my_data_cache (
        account TEXT PRIMARY KEY, since_ms INTEGER NOT NULL, cached_at INTEGER NOT NULL, data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS my_data_cache_time ON my_data_cache(cached_at);
    `);
  }

  /** The scheduled and files columns: before Files.migrate, whose gone_files backfill reads messages.files. */
  static addScheduledAndFiles(sql: SqlStorage) {
    const msgcols = sql.exec("PRAGMA table_info(messages)").toArray().map((c) => c.name);
    if (!msgcols.includes("scheduled")) sql.exec("ALTER TABLE messages ADD COLUMN scheduled TEXT");
    if (!msgcols.includes("files")) sql.exec("ALTER TABLE messages ADD COLUMN files TEXT");
  }

  /** The nonce and receipt columns and the triggers that keep the @me and search indexes: after Files.migrate. */
  static addNonceAndTriggers(sql: SqlStorage) {
    const msgcols = sql.exec("PRAGMA table_info(messages)").toArray().map((c) => c.name);
    // A send's nonce and its delivery receipt ride in the message row: a retry finds the message
    // instead of a nonces table costing four row writes per message. join still uses the table.
    if (!msgcols.includes("nonce")) {
      sql.exec("ALTER TABLE messages ADD COLUMN nonce TEXT");
      sql.exec("ALTER TABLE messages ADD COLUMN receipt TEXT");
    }
    if (!msgcols.includes("memo")) sql.exec("ALTER TABLE messages ADD COLUMN memo TEXT");
    if (!msgcols.includes("buttons")) sql.exec("ALTER TABLE messages ADD COLUMN buttons TEXT");
    const fts = sql.exec("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'").one().sql as string;
    if (/content\s*=/.test(fts)) {
      sql.exec("DROP TRIGGER IF EXISTS messages_fts_insert");
      sql.exec("DROP TABLE messages_fts");
      sql.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(text, tokenize='trigram')");
      // backfill: a stored FTS copy, so searching a summary never joins message_cards.
      sql.exec("INSERT INTO messages_fts(rowid, text) SELECT m.seq, m.text || COALESCE(char(10) || c.summary, '') FROM messages m LEFT JOIN message_cards c ON c.seq = m.seq");
    }
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_screens_delete BEFORE DELETE ON messages BEGIN
      DELETE FROM message_screens WHERE seq = OLD.seq;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS message_cards_fts_insert AFTER INSERT ON message_cards BEGIN
      UPDATE messages_fts SET text = text || char(10) || NEW.summary WHERE rowid = NEW.seq;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_cards_delete BEFORE DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = OLD.seq;
      DELETE FROM message_cards WHERE seq = OLD.seq;
      DELETE FROM message_notifies WHERE seq = OLD.seq;
      DELETE FROM message_mentions WHERE seq = OLD.seq;
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_mentions_insert AFTER INSERT ON messages BEGIN
      INSERT OR IGNORE INTO message_mentions(name, seq) SELECT value, NEW.seq FROM json_each(NEW.mentions);
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_notify_insert AFTER INSERT ON messages BEGIN
      INSERT OR IGNORE INTO message_notifies(name, seq)
      SELECT value, NEW.seq FROM json_each(NEW.notify);
    END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (NEW.seq, NEW.text);
    END`);
  }

  /** The @me and search indexes for messages from before them, once per room. */
  static backfillIndexes(sql: SqlStorage, kv: SyncKvStorage) {
    if (!kv.get("messages:mentionIndexV1")) {
      sql.exec("INSERT OR IGNORE INTO message_mentions(name, seq) SELECT value, messages.seq FROM messages, json_each(messages.mentions)");
      kv.put("messages:mentionIndexV1", true);
    }
    // One scan per existing room, then the trigger keeps this projection current on every send.
    if (!kv.get("notifyIndexV1")) {
      sql.exec(`INSERT OR IGNORE INTO message_notifies(name, seq)
        SELECT value, messages.seq FROM messages, json_each(messages.notify)`);
      kv.put("notifyIndexV1", true);
    }
    if (!kv.get("messageFtsV1")) {
      sql.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
      kv.put("messageFtsV1", true);
    }
  }

  /** Published by messages (read-only; readers: files listFiles, viewFile and searchFiles). Never written through. */
  static createFilesView(sql: SqlStorage) {
    sql.exec("CREATE VIEW IF NOT EXISTS message_files_v AS SELECT seq, ts, from_name, files FROM messages");
  }

  /** Published by messages (read-only; readers: tasks and item-thread.ts's thread queries). Never written through. */
  static createThreadView(sql: SqlStorage) {
    sql.exec(MESSAGE_THREAD_VIEW_SQL);
  }

  /** The reads behind members' takeover lookups (takeoverFor, currentHost); members' deps reach them over RoomDO's names. */
  takeoverCandidates(owner: string, role: string, afterSeq: number): Row[] {
    return this.sql.exec(TAKEOVER_CANDIDATES_SQL, owner, role, afterSeq).toArray();
  }

  renamedEvents(): Row[] {
    return this.sql.exec("SELECT event FROM messages WHERE from_kind = 'system' AND event LIKE '%\"type\":\"renamed\"%' ORDER BY seq").toArray();
  }

  sourceExists(seq: number): boolean { return !!this.sql.exec("SELECT 1 FROM messages WHERE seq = ?", seq).toArray()[0]; }

  writeMemo(seq: number, value: import("../memo-types").MemoReceipt): void {
    this.sql.exec("UPDATE messages SET memo = ? WHERE seq = ?", JSON.stringify(value), seq);
  }

  lastSeq(): number {
    return (this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS s FROM messages").one().s as number) || 0;
  }

  // The export's reads (room/export.ts): the messages up to the seq the export began at, counted once, then in pages.
  exportCount(upTo: number): number {
    return this.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE seq <= ?", upTo).one().n as number;
  }

  /** One page of the export, ascending: the messages after `from` up to `upTo`. */
  exportRows(from: number, upTo: number, limit: number): Row[] {
    return this.sql.exec("SELECT * FROM messages WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?", from, upTo, limit).toArray();
  }

  private canSeeDelivery(from: string, kind: string, viewer: Actor): boolean {
    return from === viewer.name || (viewer.kind === "human" && kind === "agent" && accountOf(from) === viewer.account);
  }

  private withDelivery(message: Message, viewer: Actor, delivery: Message["delivery"] | undefined): Message {
    const sender = message.scheduled?.by ?? message.from;
    const kind = message.scheduled ? (sender.includes("@") ? "agent" : "human") : message.fromKind;
    if (!delivery || !this.canSeeDelivery(sender, kind, viewer)) return message;
    // Older receipts can name @tokens in code or links, or the item creator instead of the reply's closer.
    const reports = message.fromKind === "human" ? message.todo?.filter((t) => t.rel === "reply") : [];
    if (!message.broadcast) {
      const tokens = mentionTokens(message.text);
      const closers = new Set(reports?.map((t) => t.closer).filter((n): n is string => !!n) || []);
      delivery = delivery.filter((d) => closers.has(d.name) || namesMentioned(tokens, d.name));
    }
    return { ...message, delivery };
  }

  /** Resolve a page's reply quotes and task links in two queries, regardless of page length. */
  messagesOf(rows: Row[], viewer?: Actor): Message[] {
    if (!rows.length) return [];
    const parents = new Map<number, Row>();
    const cards = new Map<number, Row>();
    const screens = new Map<number, OwnedScreen>();
    // Quotes, card metadata and account-scoped screens share the hydration query. Card HTML never enters a page read.
    for (const row of this.sql.exec(`SELECT p.seq, p.from_name, p.text, p.scheduled,
      c.seq AS card_seq, c.kind AS card_kind, c.summary AS card_summary, c.size AS card_size,
      s.seq AS screen_seq, s.account AS screen_account, s.text AS screen_text, s.hidden AS screen_hidden
      FROM messages m LEFT JOIN messages p ON p.seq = m.reply_to
      LEFT JOIN message_cards c ON c.seq = m.seq
      LEFT JOIN message_screens s ON s.seq = m.seq AND s.account = ?
      WHERE m.seq IN (SELECT value FROM json_each(?))`, viewer?.account ?? null, JSON.stringify(rows.map(r => r.seq))).toArray()) {
      if (row.seq != null) parents.set(row.seq as number, row);
      if (row.card_seq != null) cards.set(row.card_seq as number, { kind: row.card_kind, summary: row.card_summary, size: row.card_size });
      if (row.screen_seq != null) screens.set(row.screen_seq as number, { account: row.screen_account as string, text: row.screen_text as string, hidden: row.screen_hidden as number });
    }
    const todos = this.d.tasks.todoFor(rows, parents);
    return rows.map((r) => this.toMessage(r, viewer, { parents, todos, cards, screens }));
  }

  toMessage(r: Row, viewer?: Actor, page?: { parents: Map<number, Row>; todos: Map<number, NonNullable<Message["todo"]>>; cards: Map<number, Row>; screens: Map<number, OwnedScreen> }): Message {
    let reply: Message["reply"] = null;
    if (r.reply_to != null) {
      const q = page ? page.parents.get(r.reply_to as number) : this.sql.exec("SELECT seq, from_name, text FROM messages WHERE seq = ?", r.reply_to).toArray()[0];
      if (q) reply = { seq: q.seq as number, from: q.from_name as string, text: q.text as string };
    }
    const card = page ? page.cards.get(r.seq as number) : this.sql.exec("SELECT kind, summary, size FROM message_cards WHERE seq = ?", r.seq).toArray()[0];
    const screen = page ? page.screens.get(r.seq as number) : viewer ? this.screenOf(r.seq as number, viewer.account) : undefined;
    const tokens = mentionTokens(r.text as string);
    const message: Message = {
      ...screenFor(screen, viewer?.account),
      seq: r.seq as number,
      from: r.from_name as string,
      fromKind: r.from_kind as string,
      kind: r.kind as string,
      text: r.text as string,
      ...(r.memo ? { memo: this.memoForReader(r.memo as string) } : {}),
      ...(r.buttons ? { buttons: JSON.parse(r.buttons as string) } : {}),
      ...(card ? { card: { kind: card.kind as "html", summary: card.summary as string, size: card.size as number } } : {}),
      mentions: (JSON.parse(r.mentions as string) as string[]).filter((n) => namesMentioned(tokens, n)),
      broadcast: !!r.broadcast,
      reply,
      command: (r.command as string) ?? null,
      event: r.event ? JSON.parse(r.event as string) : null,
      scheduled: r.scheduled ? JSON.parse(r.scheduled as string) : null,
      ...(r.files ? { files: this.withLinks(JSON.parse(r.files as string)) } : {}),
      ...(page ? (page.todos.has(r.seq as number) ? { todo: page.todos.get(r.seq as number) } : {}) : this.todoOf(r.seq as number)),
      ts: r.ts as number,
    };
    const out = viewer && r.receipt ? this.withDelivery(message, viewer, JSON.parse(r.receipt as string) as Message["delivery"]) : message;
    // A person reads on the room page (frames and /r/ answers): the quoted reply's first 200 characters.
    return viewer?.kind === "human" ? pageMessage(out) : out;
  }

  private screenOf(seq: number, account: string): OwnedScreen | undefined {
    const row = this.sql.exec("SELECT account, text, hidden FROM message_screens WHERE seq = ? AND account = ?", seq, account).toArray()[0];
    return row ? { account: row.account as string, text: row.text as string, hidden: row.hidden as number } : undefined;
  }

  dropAccountScreens(account: string): void {
    this.sql.exec("DELETE FROM message_screens WHERE account = ?", account);
  }

  private memoForReader(raw: string): NonNullable<Message["memo"]> {
    const receipt = JSON.parse(raw) as import("../memo-types").MemoReceipt;
    return { cite: receipt.cite.map(e => e.id), misled: receipt.misled.map(e => e.id),
      uncounted: [...receipt.cite,...receipt.misled].filter(e => !e.counted).map(e => ({id:e.id,reason:e.reason!})) };
  }

  envelope(m: Message) {
    return { ...m, card: m.card ?? null, trusted: null };
  }

  /**
   * A send retried with the same nonce within 10 minutes: the first answer again, from the message itself (its
   * receipt, and the items it closed or opened). Looks only at the last 500 messages, by seq.
   */
  replaySend(actor: Actor, nonce: string | undefined, echo = false): Record<string, unknown> | null {
    if (!nonce) return null;
    const r = this.sql
      .exec("SELECT seq, from_name, ts, receipt, files, memo FROM messages WHERE seq > ? AND from_name = ? AND nonce = ? AND ts > ?", this.lastSeq() - 500, actor.name, nonce, now() - 600_000)
      .toArray()[0];
    if (!r) return null;
    const seq = r.seq as number;
    const out: Record<string, unknown> = {
      roomId: this.roomInfo().id,
      seq,
      from: r.from_name,
      ts: r.ts,
      delivery: r.receipt ? JSON.parse(r.receipt as string) : [],
      ...this.sentFiles(r.files ? (JSON.parse(r.files as string) as FileMeta[]) : []),
    };
    if (echo) out.message = this.toMessage(this.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one(), actor);
    this.d.tasks.steps().replay(r, out);
    this.d.memo.steps().replay(r, out);
    return out;
  }

  /** Write a message and fan it out; the single write path for people, agents and the system. */
  insertMessage(p: NewMessage, attach?: (seq: number) => void): Message {
    const seq = this.lastSeq() + 1;
    // The row and what attaches to it (doSend's task rows, the files) are written together or not at all: a failed
    // attach must not leave a message that went to nobody, was never counted, and answers a nonce retry as sent.
    tx(this.ctx, () => {
      this.sql.exec(
        `INSERT INTO messages (seq, from_name, from_kind, kind, text, mentions, broadcast, reply_to, command, event, wake, notify, files, nonce, receipt, scheduled, buttons, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        seq,
        p.from,
        p.fromKind,
        p.card ? "card" : "text",
        p.text,
        JSON.stringify(p.mentions || []),
        p.broadcast ? 1 : 0,
        p.replyTo ?? null,
        p.command ?? null,
        p.event ? JSON.stringify(p.event) : null,
        JSON.stringify(p.wake || []),
        JSON.stringify(p.notify || []),
        p.files?.length ? JSON.stringify(p.files) : null,
        p.nonce ?? null,
        p.receipt !== undefined ? JSON.stringify(p.receipt) : null,
        p.scheduled ? JSON.stringify(p.scheduled) : null,
        p.buttons ? JSON.stringify(p.buttons) : null,
        now(),
      );
      if (p.card) this.sql.exec("INSERT INTO message_cards (seq, kind, summary, html, size) VALUES (?, ?, ?, ?, ?)", seq, p.card.kind, p.card.summary, p.card.html, p.card.size);
      if (p.screen) this.sql.exec("INSERT INTO message_screens (seq, account, text, hidden) VALUES (?, ?, ?, ?)", seq, accountOf(p.from), p.screen.text, p.screen.hidden);
      attach?.(seq);
      if (p.files?.length) this.d.files.attach(seq, p.files);
    });
    const msg = this.toMessage(this.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one());
    this.fanout(msg, p.wake || [], Array.isArray(p.receipt) ? p.receipt as Message["delivery"] : undefined, p.screen ? { ...p.screen, account: accountOf(p.from) } : undefined);
    this.publicChanged();
    return msg;
  }

  private fanout(msg: Message, wake: string[], delivery?: Message["delivery"], screen?: OwnedScreen) {
    const page = pageMessage(msg); // browsers: the short reply; agents and daemons below get the full message
    for (const ws of this.ctx.getWebSockets("browser")) {
      const attachment = ws.deserializeAttachment() as { kind?: string; name?: string } | null;
      const viewer = attachment?.kind === "human" && attachment.name ? { kind: "human" as const, name: attachment.name, account: attachment.name } : null;
      this.safeSend(ws, JSON.stringify({ type: "message", message: viewer ? { ...this.withDelivery(page, viewer, delivery), ...screenFor(screen, viewer.account) } : page }));
    }
    if (wake.length) {
      for (const name of wake) {
        const push = JSON.stringify({ type: "push", message: this.envelope({ ...msg, ...screenFor(screen, accountOf(name)) }) });
        for (const ws of this.ctx.getWebSockets(`a:${name}`)) this.safeSend(ws, push);
        for (const ws of new Set([...this.carriers(name), ...this.ctx.getWebSockets(`host:${name}`)])) {
          const a = ws.deserializeAttachment() as { account?: string; name?: string } | null;
          const account = a?.account ?? (a?.name ? accountOf(a.name) : null);
          const toHost = JSON.stringify({ type: "push", to: name, message: this.envelope({ ...msg, ...screenFor(screen, account) }) });
          this.safeSend(ws, toHost);
        }
      }
    }
    if (msg.fromKind === "human") this.activity(msg.ts);
  }

  systemMessage(type: "join" | "leave", name: string) {
    // Membership still changes when a busy topic has used its minute; omit only the notice.
    if (this.countMinuteSince(now() - 60_000).n >= 30) return;
    this.insertMessage({
      from: "system",
      fromKind: "system",
      text: type === "join" ? `${name} joined` : `${name} left`,
      event: { type, name },
    });
  }

  /** When a person last wrote (room frames). */
  lastHumanTs(): number | null {
    // From the newest message back to the first a person wrote: not a scan of the whole room.
    return (this.sql.exec("SELECT ts FROM messages WHERE from_kind = 'human' ORDER BY seq DESC LIMIT 1").toArray()[0]?.ts as number | undefined) ?? null;
  }

  /** When the newest message was written, system lines included (summary's lastMs). */
  lastTs(): number | null {
    return (this.sql.exec("SELECT ts FROM messages ORDER BY seq DESC LIMIT 1").toArray()[0]?.ts as number | undefined) ?? null;
  }

  /** The newest `n` messages but system lines, newest first, with the columns a public snapshot shows. */
  latestForSnapshot(n: number): Row[] {
    return this.sql.exec("SELECT seq, from_name, from_kind, text, files, scheduled, ts FROM messages WHERE from_kind != 'system' ORDER BY seq DESC LIMIT ?", n).toArray();
  }

  /** The newest `n` messages, oldest first (a page's hello). */
  recent(n: number): Row[] {
    return this.sql
      .exec("SELECT * FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT ?) ORDER BY seq", n)
      .toArray();
  }

  async messages(actor: Actor, p: SearchFilters & { q?: string; limit?: number }): Promise<Result<{ roomId: string; messages: Message[] }>> {
    return this.wrap(() => {
      this.requireMember(actor);
      const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(p.limit || 50)));
      const filters = resolveFilters(p, actor.name, n => this.d.members.get(n));
      this.touch(actor.name);
      const extra = filterSql(filters, "messages");
      const terms = p.q ? searchQuery({ q: p.q }).terms : [];
      const match = likeTerms(SEARCH_TEXT_SQL, terms);
      const candidate = trigramCandidate(terms);
      const args = [...match.args, ...(candidate ? [`%${candidate}%`] : []), ...extra.args, ...(p.before !== undefined ? [p.before] : [])];
      const direction = p.order === "asc" || (p.from !== undefined && !p.order) ? "ASC" : "DESC";
      const rows = this.sql.exec(`SELECT * FROM (SELECT m.* FROM messages m WHERE ${match.sql}${candidate ? " AND m.seq IN (SELECT rowid FROM messages_fts WHERE text LIKE ?)" : ""}${extra.sql}${p.before !== undefined ? " AND m.seq < ?" : ""} ORDER BY m.seq ${direction} LIMIT ?) ORDER BY seq`, ...args, limit).toArray();
      return { roomId: this.roomInfo().id, messages: this.messagesOf(rows, actor) };
    });
  }

  /** Messages before `before` for the web page's "earlier" button. */
  async history(actor: Actor, before: number, limit = 100): Promise<Result<{ messages: Message[] }>> {
    return this.wrap(() => {
      this.reader(actor);
      const rows = this.sql
        .exec("SELECT * FROM (SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq", before, Math.min(PAGE_MAX, limit))
        .toArray();
      return { messages: this.messagesOf(rows, actor) };
    });
  }

  /** The target and one page on either side, so a search hit can jump without paging back from today. */
  async around(actor: Actor, seq: number): Promise<Result<{ roomId: string; messages: Message[] }>> {
    return this.wrap(() => {
      this.reader(actor);
      const target = this.sql.exec("SELECT 1 FROM messages WHERE seq = ?", seq).toArray()[0];
      if (!target) throw new ApiError("message_not_found", `There is no message #${seq} in this topic.`, 404);
      const before = this.sql.exec("SELECT * FROM messages WHERE seq <= ? ORDER BY seq DESC LIMIT 51", seq).toArray().reverse();
      const after = this.sql.exec("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT 50", seq).toArray();
      return { roomId: this.roomInfo().id, messages: this.messagesOf(before.concat(after), actor) };
    });
  }

  /** Messages addressed to this person (an @ to them, or someone else's @ to one of their agents), newest first. */
  /** Messages addressed to me past my cursor: a scan from the cursor on, not of the whole room. */
  mentionUnread(name: string, cursor: number): number {
    return this.sql
      .exec("SELECT COUNT(*) AS k FROM message_notifies WHERE name = ? AND seq > ?", name, cursor)
      .one().k as number;
  }

  /** Messages by others past this person's cursor, system lines left out (summary's unread). */
  unreadFor(handle: string, cursor: number): number {
    return this.sql.exec("SELECT COUNT(*) AS k FROM messages WHERE seq > ? AND from_kind != 'system' AND from_name != ?", cursor, handle).one().k as number;
  }

  /** All of this person's @me entries, and the unread ones. */
  private mentionCounts(name: string, cursor: number, filters: SearchFilters = {}) {
    const extra = filterSql(filters, "messages");
    const r = this.sql
      .exec(
        `SELECT COUNT(*) AS total, COALESCE(SUM(m.seq > ?), 0) AS unread FROM message_notifies n JOIN messages m ON m.seq = n.seq WHERE n.name = ?${extra.sql}`,
        cursor,
        name, ...extra.args,
      )
      .one();
    return { total: r.total as number, unread: r.unread as number };
  }

  /** The web page's "@me" list: pages of 50 going back with before=, each marked unread past the cursor. */
  async mentions(actor: Actor, before: number, limit = 50, filters: SearchFilters = {}): Promise<Result<Record<string, unknown>>> {
    return this.wrap(() => {
      const m = this.requireMember(actor);
      const cursor = m.cursor as number;
      const extra = filterSql(filters, "messages");
      const n = Math.max(1, Math.min(PAGE_MAX, Math.floor(limit) || 50));
      const rows = this.sql
        .exec(
          `SELECT m.* FROM message_notifies n JOIN messages m ON m.seq = n.seq
           WHERE n.name = ? AND n.seq < ?${extra.sql} ORDER BY n.seq DESC LIMIT ?`,
          actor.name,
          before > 0 ? Math.floor(before) : Number.MAX_SAFE_INTEGER,
          ...extra.args, n + 1,
        )
        .toArray();
      const list = this.messagesOf(rows.slice(0, n), actor).map((message) => ({ ...message, unread: message.seq > cursor }));
      return { roomId: this.roomInfo().id, cursor, ...this.mentionCounts(actor.name, cursor, filters), hasMore: rows.length > n, mentions: list };
    });
  }

  async message(actor: Actor, seq: number): Promise<Result<{ roomId: string; message: Message }>> {
    return this.wrap(() => {
      this.reader(actor);
      const r = this.sql.exec("SELECT * FROM messages WHERE seq = ?", Math.floor(seq)).toArray()[0];
      if (!r) throw new ApiError("message_not_found", `There is no message #${seq} in this topic.`, 404);
      return { roomId: this.roomInfo().id, message: this.toMessage(r, actor) };
    });
  }

  async card(actor: Actor, seq: number): Promise<Result<Card & { seq: number }>> {
    return this.wrap(() => {
      this.reader(actor);
      const row = this.sql.exec("SELECT c.* FROM message_cards c JOIN messages m ON m.seq = c.seq WHERE c.seq = ?", seq).toArray()[0];
      if (!row) throw new ApiError("card_not_found", `There is no card on message #${seq}.`, 404);
      return { seq: row.seq as number, kind: "html", summary: row.summary as string, html: row.html as string, size: row.size as number };
    });
  }

  async consumeCardTicket(ticket: Ticket, label: string): Promise<Result<(Card & { seq: number }) | null>> {
    return this.wrap(() => {
      if (!ticket.a || !Number.isSafeInteger(ticket.c) || ticket.e * 1000 <= now()) return null;
      this.reader({ kind: "human", account: ticket.a, name: ticket.a });
      if (this.roomInfo().id !== ticket.r) return null;
      const row = this.sql.exec("SELECT c.* FROM message_cards c JOIN messages m ON m.seq = c.seq WHERE c.seq = ?", ticket.c!).toArray()[0];
      if (!row) throw new ApiError("card_not_found", "This card is no longer available.", 404);
      if (!this.d.files.consumeTicket(label, ticket.e * 1000)) return null;
      return { seq: row.seq as number, kind: "html", summary: row.summary as string, html: row.html as string, size: row.size as number };
    });
  }

  async press(actor: Actor, seq: number, index: number): Promise<Result<Record<string, unknown>>> {
    const owner = await this.ownerLimits();
    // No awaits after this point: concurrent/double presses decide against the current stored answer.
    return this.wrap(() => {
      const member = this.reader(actor);
      if (actor.kind !== "human" || actor.name !== actor.account || member?.kind !== "human" || member.status !== "active") throw new ApiError("forbidden", "Only an active human member may press a reply button.", 403);
      this.requireWritable();
      if (!Number.isSafeInteger(seq) || seq < 1) throw new ApiError("bad_request", "seq must be a positive message number.");
      const row = this.sql.exec("SELECT buttons, from_name FROM messages WHERE seq = ?", seq).toArray()[0];
      if (!row) throw new ApiError("message_not_found", `There is no message #${seq}.`, 404);
      const decision = pressDecision(row.buttons ? JSON.parse(row.buttons as string) : null, index, actor.name, row.from_name as string);
      if ("error" in decision) throw new ApiError(decision.error.code, decision.error.next, decision.error.status);
      if (decision.unchanged) return { unchanged: true };
      const out = this.doSend(actor, { text: decision.text, replyTo: seq, echo: true }, owner);
      this.sql.exec("UPDATE messages SET buttons = ? WHERE seq = ?", JSON.stringify(decision.buttons), seq);
      this.publicChanged();
      const message = pageMessage(this.toMessage(this.sql.exec("SELECT * FROM messages WHERE seq = ?", seq).one()));
      toBrowsers(this.ctx, JSON.stringify({ type: "message_update", message }));
      return out;
    });
  }

  /** Search's messages group (room/search.ts): newest first, the sender's display name through member_names_v. */
  search(p: SearchQuery): SearchPage {
    const match = likeTerms(SEARCH_TEXT_SQL, p.terms);
    const candidate = trigramCandidate(p.terms);
    const extra = filterSql(p, "messages");
    const args = [...match.args, ...(candidate ? [`%${candidate}%`] : []), ...(p.before ? [p.before] : []), ...extra.args];
    const { rows, hasMore } = page(
      this.sql.exec(
        `SELECT m.seq, m.from_name, h.display_name, m.ts, ${SEARCH_TEXT_SQL} AS text FROM messages m LEFT JOIN member_names_v h ON h.name = m.from_name WHERE ${match.sql}${candidate ? " AND m.seq IN (SELECT rowid FROM messages_fts WHERE text LIKE ?)" : ""}${p.before ? " AND m.seq < ?" : ""} ${extra.sql} ORDER BY ${p.order === "asc" ? "m.ts ASC, m.seq ASC" : "m.ts DESC, m.seq DESC"} LIMIT ?`,
        ...args,
        p.limit + 1,
      ).toArray(),
      p.limit,
    );
    return {
      hits: rows.map((r) => ({ type: "message", id: `#${r.seq}`, seq: r.seq as number, who: r.from_name as string, displayName: (r.display_name as string | null) ?? null, ts: r.ts as number, snippet: searchSnippet(r.text as string, p.terms) })),
      hasMore,
    };
  }

  async send(actor: Actor, p: SendOp): Promise<Result<Record<string, unknown>>> {
    let owner: { plan: Plan; limits: Limits };
    try {
      owner = await this.ownerLimits();
    } catch (e) {
      return this.wrap(() => {
        throw e;
      });
    }
    return this.wrap(() => this.doSend(actor, p, owner));
  }

  /** The one write path for a member's message; throws ApiError. */
  doSend(actor: Actor, p: SendOp, owner: { plan: Plan; limits: Limits }, scheduled?: NonNullable<Message["scheduled"]>): Record<string, unknown> {
    {
      const tasks = this.d.tasks.steps();
      const memo = this.d.memo.steps();
      const me = scheduled ? null : this.requireMember(actor);
      const again = this.d.replaySend(actor, p.nonce, p.echo);
      if (again) return again;
      tasks.refuseSend(p);
      memo.refuseSend(p, !!scheduled);
      const rich = richMessage(scheduled ? "scheduled" : me!.kind as string, p.buttons, p.card, p.lang);
      if (rich.error) throw new ApiError(rich.error.code, rich.error.next, rich.error.status);
      const screen = messageScreen(scheduled ? "scheduled" : me!.kind as string, p.screen);
      if (screen.error) throw new ApiError(screen.error.code, screen.error.next, screen.error.status);
      this.requireWritable();
      const text = (p.text || "").replace(/\r\n/g, "\n");
      const files = this.claimFiles(actor, p.files || []);
      if (!text.trim() && !files.length) throw new ApiError("bad_request", "text is empty.");
      if (text.length > MAX_TEXT) {
        throw new ApiError("text_too_long", `The text has ${text.length} characters; a message holds at most ${MAX_TEXT}. Split it into several messages, or put the long part in a file and attach it.`, 413);
      }
      let replyTo: number | null = null;
      if (p.replyTo != null && Number(p.replyTo) > 0) {
        replyTo = Math.floor(Number(p.replyTo));
        if (!this.sql.exec("SELECT 1 FROM messages WHERE seq = ?", replyTo).toArray()[0]) {
          throw new ApiError("message_not_found", `replyTo=${replyTo}: there is no such message.`, 404);
        }
      }

      const members = new Map(this.sendRows().map((r) => [r.name as string, r]));
      const lower = new Map([...members.keys()].map((n) => [n.toLowerCase(), n]));
      const mentions: string[] = [];
      const unknown: string[] = []; // @names that are not in the room (yet): they reach nobody
      for (const token of mentionTokens(text)) {
        let tok = token;
        let name = members.has(tok) ? tok : lower.get(tok.toLowerCase());
        while (!name && /[.-]$/.test(tok)) {
          tok = tok.slice(0, -1);
          name = members.has(tok) ? tok : lower.get(tok.toLowerCase());
        }
        if (name) {
          if (!mentions.includes(name)) mentions.push(name);
        } else if (tok && !unknown.includes(tok)) unknown.push(tok);
      }

      if (!scheduled && actor.kind === "agent" && mentions.length === 0 && unknown.length === 0) {
        throw new ApiError(
          "agent_must_mention",
          "An agent's message must @ someone by full name (a person is @<account>, an agent is @<role>@<account>); only people can broadcast. See scorpio members.",
        );
      }
      // A broadcast is a person's message with no @ at all; @ing only absent names is not a broadcast.
      const broadcast = actor.kind === "human" && mentions.length === 0 && unknown.length === 0;
      tasks.addressed(p, actor, mentions);
      memo.addressed(p, actor);
      this.checkQuota(owner.limits);

      // Who wakes whom (docs/api/concepts.md): only the owner's account wakes an agent.
      const wake: string[] = [];
      const notify: string[] = [];
      const delivery: { name: string; status: string; host_offline_since?: number; takeover?: string; takeover_seq?: number; renamedTo?: string }[] = [];
      // Delivery for one of the sender's own agents or daemons: woken now; left the room (with the takeover command
      // it left, to bring it back); or queued (with when its computer went offline: a daemon's is its own).
      const own = (name: string, m: Row) => {
        if (m.status === "left") {
          const t = this.takeoverFor(name, m.owner as string);
          return t ? { name, status: "left", takeover: t.command, takeover_seq: t.seq } : { name, status: "left" };
        }
        if (this.isOnline(name, m.kind as string)) return { name, status: "online" };
        const since = hostOfflineSince(m, m.host_id ? this.memberRow(m.host_id as string) : undefined);
        return since ? { name, status: "queued", host_offline_since: since } : { name, status: "queued" };
      };
      // A person who left the topic is not told: `left`, no push; nor is one whose agent is @'d, since leaving
      // took their agents along.
      const personLeft = (account: string) => members.get(account)?.kind === "human" && members.get(account)?.status === "left";
      for (const name of mentions) {
        if (name === actor.name) continue;
        const m = members.get(name)!;
        if (m.kind === "human") {
          if (m.status === "left") {
            delivery.push({ name, status: "left" });
            continue;
          }
          if (!notify.includes(name)) notify.push(name);
          delivery.push({ name, status: "human" });
        } else if (m.owner === actor.account) {
          wake.push(name);
          delivery.push(own(name, m));
        } else {
          const owner = m.owner as string;
          if (owner !== actor.account && !personLeft(owner) && !notify.includes(owner)) notify.push(owner);
          delivery.push({ name, status: m.status === "left" ? "left" : "to_owner" });
        }
      }
      for (const name of unknown) {
        const renamedTo = this.currentHost(name);
        delivery.push({ name, status: "not_member", ...(renamedTo ? { renamedTo } : {}) });
      }
      if (broadcast) {
        for (const [name, m] of members) {
          if (m.kind === "agent" && m.owner === actor.account && m.status === "active") {
            wake.push(name);
            delivery.push(own(name, m));
          }
        }
      }

      // The thread (docs/api/tasks.md): a message replying into an open item's thread, or naming its one T number, joins it as part
      // of this send. Joined by the person the item is under, it is their report: wake its closer. Never closed here.
      const route = tasks.route(p, actor, text, replyTo, scheduled, mentions, this.openCandidates());
      for (const n of route.closers) {
        const m = members.get(n);
        if (!m || m.kind !== "agent" || wake.includes(n) || delivery.some((d) => d.name === n)) continue;
        if (m.owner === actor.account) {
          wake.push(n);
          delivery.push(own(n, m));
        } else {
          if (!personLeft(m.owner as string) && !notify.includes(m.owner as string)) notify.push(m.owner as string);
          delivery.push({ name: n, status: m.status === "left" ? "left" : "to_owner" });
        }
      }

      const body = text.replace(/^(\s*@[A-Za-z0-9_.@-]+)*\s*/, "");
      const cmd = /^\/([A-Za-z][A-Za-z0-9_-]*)/.exec(body);

      const prep = tasks.prepare(p, owner.limits);
      const memoPrep = memo.prepare(p);
      let memoAttached: import("../memo-types").MemoReceipt | null = null;
      let attached: ReturnType<Tasks["attach"]> = { added: null };
      const msg = this.d.insertMessage({
        from: actor.name,
        fromKind: scheduled ? "scheduled" : me!.kind as string,
        text,
        mentions,
        broadcast,
        replyTo,
        command: cmd ? `/${cmd[1]}` : null,
        wake,
        notify,
        files,
        nonce: p.nonce,
        receipt: delivery,
        scheduled,
        buttons: rich.buttons,
        card: rich.card,
        screen: screen.screen,
      }, (seq) => { attached = tasks.attach(seq, actor, p, prep, route); memoAttached = memo.attach(seq, actor, p, memoPrep).added; });
      // A newer takeover line from this account supersedes a cached hit or miss for that role.
      this.takeoverChanged(actor.account, new Set([...text.matchAll(/\/spawn\s+\S+\s+([A-Za-z0-9_.-]+)\s/g)].map((match) => match[1])));
      if (!scheduled) this.touch(actor.name);
      tasks.after(msg.seq, actor, p, route);
      memo.after(msg.seq, actor, p);
      const quota = this.countMessage(owner.limits, msg.seq);
      this.markActive();
      if (!scheduled) this.markSender(me!.kind as string, actor.account);
      const out: Record<string, unknown> = { roomId: this.roomInfo().id, seq: msg.seq, from: msg.from, ts: msg.ts, delivery, ...this.sentFiles(files), ...(quota ? { quota } : {}) };
      if (p.echo) out.message = pageMessage({ ...this.withDelivery(msg, actor, delivery), ...screenFor(screen.screen ? { ...screen.screen, account: actor.account } : undefined, actor.account) }); // only the page asks for it
      tasks.answer(msg.seq, actor, p, owner.limits, out, attached.added);
      memo.answer(msg.seq, actor, p, owner.limits, out, memoAttached);
      return out;
    }
  }

  /**
   * The overview's two counts over the window (docs/api/topics.md "The overview"): messages per sender, and per
   * (sender, @target), for messages from people, agents and schedules (`from_kind` human | agent | scheduled; system
   * lines and computer seats' messages do not count). One scan of the window per request: the page is opened rarely,
   * and an index on ts would cost a write on every message, the hot path.
   */
  windowCounts(since: number): { sent: import("./overview").SentRow[]; mentions: import("./overview").MentionRow[] } {
    const kinds = "('human', 'agent', 'scheduled')";
    return {
      sent: this.sql.exec(`SELECT from_name, from_kind, COUNT(*) AS n FROM messages WHERE ts >= ? AND from_kind IN ${kinds} GROUP BY from_name, from_kind`, since)
        .toArray().map((r) => ({ from_name: r.from_name as string, from_kind: r.from_kind as string, n: r.n as number })),
      mentions: this.sql.exec(
        `SELECT m.from_name, m.from_kind, mm.name AS target, COUNT(*) AS n FROM messages m JOIN message_mentions mm ON mm.seq = m.seq
         WHERE m.ts >= ? AND m.from_kind IN ${kinds} GROUP BY m.from_name, m.from_kind, mm.name`, since)
        .toArray().map((r) => ({ from_name: r.from_name as string, from_kind: r.from_kind as string, target: r.target as string, n: r.n as number })),
    };
  }

  /**
   * Messages written after `ts` that count (people, agents, daemons; not system lines), and when the first was.
   * Reads only that tail of the room: from the newest message back to the first one older than `ts`.
   */
  countSince(ts: number, afterSeq = 0): { n: number; first: number | null } {
    const r = this.sql
      .exec(
        `SELECT COUNT(*) AS n, MIN(ts) AS first FROM messages
          WHERE seq > MAX(?, COALESCE((SELECT seq FROM messages WHERE ts < ? ORDER BY seq DESC LIMIT 1), 0)) AND from_kind != 'system'`,
        afterSeq,
        ts,
      )
      .one();
    return { n: r.n as number, first: (r.first as number) ?? null };
  }

  /** The minute guard counts system lines as well as member messages. Daily quota uses countSince instead. */
  countMinuteSince(ts: number): { n: number; first: number | null } {
    const r = this.sql.exec(
      `SELECT COUNT(*) AS n, MIN(ts) AS first FROM messages
       WHERE seq > COALESCE((SELECT seq FROM messages WHERE ts < ? ORDER BY seq DESC LIMIT 1), 0)`,
      ts,
    ).one();
    return { n: r.n as number, first: (r.first as number) ?? null };
  }

  /** This room's senders per day since `sinceMs`, for filling activity_daily with what was said before it existed. */
  async activitySince(sinceMs: number): Promise<Result<{ day: string; kind: string; account: string }[]>> {
    return this.wrap(() => {
      this.room();
      return this.sql.exec(ROOM_ACTIVITY_SQL, sinceMs).toArray().map((r) => ({ day: dayOf((r.d as number) * 86_400_000), kind: r.sender_kind as string, account: r.account as string }));
    });
  }

  dropAccountCache(account: string): void {
    this.sql.exec("DELETE FROM my_data_cache WHERE account = ?", account);
  }

  /** One private read per room for the signed-in person's data page. */
  async myData(actor: Actor, sinceMs: number): Promise<Result<RoomData>> {
    return this.wrap(() => {
      if (actor.kind !== "human" || actor.name !== actor.account) throw new ApiError("not_member", "This data belongs to a signed-in topic member.", 403);
      this.requireMember(actor);
      const account = actor.account;
      const at = now();
      this.sql.exec("DELETE FROM my_data_cache WHERE cached_at <= ?", at - ROOM_DATA_CACHE_MS);
      const cached = this.sql.exec("SELECT since_ms, cached_at, data_json FROM my_data_cache WHERE account = ?", account).toArray()[0];
      if (cached && cached.since_ms === sinceMs && at - (cached.cached_at as number) < ROOM_DATA_CACHE_MS) {
        return JSON.parse(cached.data_json as string) as RoomData;
      }
      const totals = this.sql.exec(ROOM_TOTALS_SQL, account, account).one();
      const daily = this.sql.exec(ROOM_DAILY_SQL, sinceMs, account, account).toArray();
      const data: RoomData = {
        humanMessages: totals.human as number,
        agentMessages: totals.agents as number,
        lastActive: (totals.last_active as number | null) ?? null,
        daily: daily.map((row) => ({ day: row.day as number, human: row.human as number, agents: row.agents as number })),
      };
      this.sql.exec(`INSERT INTO my_data_cache(account, since_ms, cached_at, data_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET since_ms = excluded.since_ms, cached_at = excluded.cached_at, data_json = excluded.data_json`, account, sinceMs, at, JSON.stringify(data));
      return data;
    });
  }

  /** When the last counted message was written (people, agents, daemons; not system lines), else when the room was made. */
  lastCountedAt(r: Row): number {
    return (this.sql.exec("SELECT ts FROM messages WHERE from_kind != 'system' ORDER BY seq DESC LIMIT 1").toArray()[0]?.ts as number | undefined) ?? (r.created_at as number);
  }

  /** A file's entry in its message: deleted (ms) once it went (or previously removed). Pages are told at once. */
  markFileInMessage(seq: number, id: string, deleted: number | null) {
    const row = this.sql.exec("SELECT files FROM messages WHERE seq = ?", seq).toArray()[0];
    if (!row?.files) return;
    const list = JSON.parse(row.files as string) as (FileMeta & { url: string; deleted?: number })[];
    for (const f of list) {
      if (f.id !== id) continue;
      if (deleted) f.deleted = deleted;
      else delete f.deleted;
    }
    this.sql.exec("UPDATE messages SET files = ? WHERE seq = ?", JSON.stringify(list), seq);
    this.publicChanged();
    const frame = JSON.stringify({ type: "files", seq, files: this.withLinks(list) });
    toBrowsers(this.ctx, frame);
  }

  /** Unmarked messages that wake this agent, oldest first. */
  pending(name: string, cursor: number): Message[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM messages WHERE seq > ? AND EXISTS (SELECT 1 FROM json_each(messages.wake) WHERE value = ?) ORDER BY seq LIMIT 100`,
        cursor,
        name,
      )
      .toArray();
    return this.messagesOf(rows, { name, account: accountOf(name), kind: "agent" });
  }

  async listen(actor: Actor): Promise<Result<Record<string, unknown>>> {
    return this.wrap(() => {
      const m = this.requireMember(actor);
      this.touch(actor.name);
      const cursor = m.cursor as number;
      const waking = this.pending(actor.name, cursor);
      const others = this.sql
        .exec(
          `SELECT COUNT(*) AS n FROM messages WHERE seq > ? AND from_kind != 'system' AND from_name != ?
             AND NOT EXISTS (SELECT 1 FROM json_each(messages.wake) WHERE value = ?)`,
          cursor,
          actor.name,
          actor.name,
        )
        .one().n as number;
      const todo = this.todoState();
      return {
        roomId: this.roomInfo().id,
        me: actor.name,
        cursor,
        total: this.lastSeq(),
        mentions: waking.filter((x) => !x.broadcast),
        broadcasts: waking.filter((x) => x.broadcast),
        others,
        members: membersFor(this.allMembers(), actor.account),
        round: todo.round,
        items: todo.items,
        counts: todo.counts,
        deleted: todo.deleted,
        memo: this.d.memo.state(),
      };
    });
  }
}
