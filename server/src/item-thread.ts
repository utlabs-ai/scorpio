// An item's thread (docs/api/tasks.md, "The thread"): the messages about
// it, collected by structure, never by wording. One row per message and item in item_messages; `rel` is how it joined.
// No imports, so the node tests run it as it is (RoomDO passes the prose, mentions and rows in).

export type Rel = "source" | "result" | "reply" | "thread";

/** Write a message into a thread; a stronger rel replaces a weaker one: source, then result, then reply, then thread. ?1 n, ?2 seq, ?3 rel. */
export const JOIN_SQL = `INSERT INTO item_messages (n, seq, rel) VALUES (?1, ?2, ?3)
  ON CONFLICT (n, seq) DO UPDATE SET rel = excluded.rel
  WHERE (CASE excluded.rel WHEN 'source' THEN 0 WHEN 'result' THEN 1 WHEN 'reply' THEN 2 ELSE 3 END)
      < (CASE item_messages.rel WHEN 'source' THEN 0 WHEN 'result' THEN 1 WHEN 'reply' THEN 2 ELSE 3 END)`;

/** The thread, oldest first: ?1 n. */
export const THREAD_SQL =
  "SELECT t.seq, t.rel, m.from_name, m.from_kind, m.ts FROM item_messages t JOIN message_thread_v m ON m.seq = t.seq WHERE t.n = ?1 ORDER BY t.seq";

/** What the assignee is asked now: the latest thread message not by ?2 (the assignee, or the creator when none); ?1 n. */
export const CURRENT_SQL =
  "SELECT m.seq, m.from_name, m.ts, m.text, m.files FROM item_messages t JOIN message_thread_v m ON m.seq = t.seq WHERE t.n = ?1 AND m.from_name != ?2 ORDER BY t.seq DESC LIMIT 1";

/** The person's latest reply that nothing has been said to them since: after ?2 (current's seq, 0 when there is none); ?1 n. */
export const LAST_REPLY_SQL =
  "SELECT m.seq, m.from_name, m.ts, m.reply_to FROM item_messages t JOIN message_thread_v m ON m.seq = t.seq WHERE t.n = ?1 AND t.rel = 'reply' AND t.seq > ?2 ORDER BY t.seq DESC LIMIT 1";

/** The items a message carries (Message.todo[]), with how it joined each: ?1 seq. */
export const CARRIED_SQL =
  "SELECT i.n, i.title, i.assignee, i.status, i.round, i.created_by, t.rel FROM item_messages t JOIN items i ON i.n = t.n WHERE t.seq = ?1 ORDER BY i.n";

/** The distinct T numbers a message's prose names (`T309` as a whole word; `T3090`, `xT3`, `#309` do not count). */
export function tNumbers(prose: string): number[] {
  return [...new Set([...prose.matchAll(/\bT(\d{1,9})\b/g)].map((m) => Number(m[1])))];
}

/** A message's first line after the leading @names, at most 80 characters; its first file's name, or #seq (the 「加到 TODO」 rule). */
export function lineOf(text: string | null, files: { name: string }[], seq: number): string {
  const line = String(text || "").replace(/^(\s*@[A-Za-z0-9_.@-]+)*\s*/, "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  const t = line || files[0]?.name || `#${seq}`;
  return [...t].length > 80 ? [...t].slice(0, 79).join("") + "…" : t;
}

export type OpenItem = {
  n: number;
  assignee: string | null;
  createdBy: string;
  /** The assignee is a person: their own joining message is a reply (the report). */
  personAssignee: boolean;
  /** Whether that message is already in this item's thread. */
  has: (seq: number) => boolean;
};

export type Incoming = {
  author: string;
  /** A slash command addressed to a daemon seat never joins by (b) or (c). */
  daemonCommand: boolean;
  mentions: string[];
  replyTo: number | null;
  replyToAuthor: string | null;
  /** tNumbers() of its prose. */
  tNumbers: number[];
  /** The items this message is a source or the result of (send add= / update= / done=, or already). */
  sourceOrResultOf: number[];
};

/**
 * Which open items a message joins by (b), a reply into the thread, or (c), naming its one T number, and as what:
 * the assignee — the creator when there is none — must write it or be @'d in it, or (b) the message answered be
 * theirs. A message that is another item's source or result joins nothing by (c). `reply` when it is by the person the
 * item is under, else `thread`.
 */
export function joins(msg: Incoming, open: OpenItem[]): { n: number; rel: "reply" | "thread"; by: "b" | "c" }[] {
  if (msg.daemonCommand) return [];
  const out: { n: number; rel: "reply" | "thread"; by: "b" | "c" }[] = [];
  const add = (it: OpenItem, by: "b" | "c") => {
    if (out.some((o) => o.n === it.n)) return;
    out.push({ n: it.n, rel: it.personAssignee && msg.author === it.assignee ? "reply" : "thread", by });
  };
  const who = (it: OpenItem) => it.assignee ?? it.createdBy;
  const toThem = (it: OpenItem) => msg.author === who(it) || msg.mentions.includes(who(it));
  if (msg.replyTo != null) {
    for (const it of open) {
      if (it.has(msg.replyTo) && (toThem(it) || msg.replyToAuthor === who(it))) add(it, "b");
    }
  }
  if (msg.tNumbers.length === 1) {
    const n = msg.tNumbers[0];
    const it = open.find((x) => x.n === n);
    const elsewhere = msg.sourceOrResultOf.length > 0 && !msg.sourceOrResultOf.includes(n);
    if (it && !elsewhere && toThem(it)) add(it, "c");
  }
  return out;
}
