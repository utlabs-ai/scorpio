// Handoffs in the cloud (docs/api/files.md): the rules, as plain values. One handoff per seat (a full member name), kept in
// the topic's room object (table handoffs), apart from attachments. The room object keeps the SQL and the broadcast;
// what may be written, how big, which headers are kept and when an account is full are decided here. No imports, so
// node tests load it as it is.

/** One handoff: at most 256 KB. Nothing is cut: over it is refused. */
export const HANDOFF_MAX = 262_144;
/** One account's handoffs in one topic, all its seats together. */
export const HANDOFF_ACCOUNT_MAX = 2_621_440;

const SEAT_RE = /^[A-Za-z0-9_.-]{1,62}@[A-Za-z0-9_.-]{1,64}$/;
/** A seat's name as `name=` takes it: role@account. */
export const isSeatName = (name: string): boolean => SEAT_RE.test(name);

/** The role of a seat (`arch` of `arch@kai`), as the web shows it. */
export const roleOf = (name: string): string => name.slice(0, name.lastIndexOf("@"));

export type Refusal = { code: string; next: string; status: number };

/**
 * Whether this member may write its seat's handoff: an active agent only. A left or unknown name is not in the topic;
 * an active daemon seat or a person's name is a member that is not an agent.
 */
export function writerRefusal(m: Record<string, unknown> | undefined, name: string, roomId: string): Refusal | null {
  if (!m || m.status !== "active") {
    return { code: "not_member", next: `${name} is not in this topic. Join first: scorpio join topicId=${roomId} role=${roleOf(name)} resume=true`, status: 403 };
  }
  if (m.kind !== "agent") return { code: "forbidden", next: "Only an agent writes a handoff, for its own seat.", status: 403 };
  return null;
}

/** The answer to an account that keeps handoffs on its computers (Settings), before any of the body is read. */
export const LOCAL_ONLY: Refusal = {
  code: "handoff_local_only",
  next: "This account keeps handoffs on its agents' computers (Settings → Keep handoffs on agents' computers). Nothing was stored; the file stays on this computer.",
  status: 409,
};

const tooLarge = (size: number | null): Refusal => ({
  code: "handoff_too_large",
  next: `The handoff is ${size == null ? "over 256 KB" : `${Math.ceil(size / 1024)} KB`}; the limit is 256 KB. Shorten it and run the same scorpio handoff again.`,
  status: 413,
});

/**
 * The body, read as a stream, never more than `max` bytes of it held: at one byte over, the rest is not read and the
 * answer is handoff_too_large. A Content-Length over the limit is refused before the first read.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, contentLength: string | null, max = HANDOFF_MAX): Promise<Uint8Array | Refusal> {
  const declared = Number(contentLength || 0);
  if (declared > max) return tooLarge(declared);
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return tooLarge(null);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * The text of a handoff: valid UTF-8 with no control character but tab, line feed and carriage return (C0, DEL and
 * C1 are refused). Empty, or nothing but white space: bad_request. Whether it is good Markdown is not judged.
 */
export function handoffText(bytes: Uint8Array): { text: string } | Refusal {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return notText;
  }
  if (!text.trim()) return { code: "bad_request", next: "The handoff is empty. Write it, then run the same scorpio handoff again.", status: 400 };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return notText;
  return { text };
}
const notText: Refusal = {
  code: "handoff_not_text",
  next: "The handoff is not plain text (not UTF-8, or it has control characters). Write it as plain Markdown text and run the same scorpio handoff again.",
  status: 415,
};

/** X-Scorpio-Computer: the daemon's machine name, at most 64 of [a-z0-9_-]; else null (dropped). */
export const computerOf = (header: string | null): string | null => (header && /^[a-z0-9_-]{1,64}$/.test(header) ? header : null);

/**
 * The other seats of this account in this topic, their handoffs' bytes together (the writer's own one is replaced): the
 * account's names come from members (ofAccount) as a JSON array, then the writer's name.
 */
export const HANDOFF_SUM_SQL =
  "SELECT COALESCE(SUM(size), 0) AS total FROM handoffs WHERE name IN (SELECT value FROM json_each(?)) AND name != ?";

/** The read-only view handoffs publishes for members' list (allMembers): each seat's handoff columns, never the body. */
export const HANDOFF_META_VIEW_SQL = "CREATE VIEW IF NOT EXISTS handoff_meta_v AS SELECT name, size, updated_at, computer FROM handoffs";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;

/** Whether a new body of `size` bytes fits beside the account's other handoffs in this topic. */
export function spaceRefusal(others: number, size: number, max = HANDOFF_ACCOUNT_MAX): Refusal | null {
  if (others + size <= max) return null;
  return {
    code: "handoff_space_full",
    next: `This account's handoffs in this topic would be ${mb(others + size)} together; the limit is ${mb(max)}. Delete handoffs of seats no longer used (the member card on the web), then the next handoff is stored.`,
    status: 409,
  };
}

/** The members answer's and frames' `handoff`: never the text. */
export type HandoffMeta = { size: number; updatedAt: number; computer: string | null };

/** The handoff columns allMembers reads beside each member row (LEFT JOIN handoff_meta_v), as `handoff`, or null. */
export function handoffMetaOf(r: { h_size?: unknown; h_updated?: unknown; h_computer?: unknown }): HandoffMeta | null {
  if (r.h_updated == null) return null;
  return { size: r.h_size as number, updatedAt: r.h_updated as number, computer: (r.h_computer as string | null) ?? null };
}

/** Who may delete a seat's handoff: the seat's own account, whether the seat is active or left. */
export function deleteRefusal(seat: Record<string, unknown> | undefined, name: string, account: string): Refusal | null {
  if (!seat) return seatNotFound(name);
  if (seat.owner !== account) return { code: "forbidden", next: `Only ${String(seat.owner)}, whose seat ${name} is, can delete its handoff.`, status: 403 };
  return null;
}

export const seatNotFound = (name: string): Refusal => ({ code: "seat_not_found", next: `${name} is not a member of this topic.`, status: 404 });
export const handoffNotFound = (name: string): Refusal => ({ code: "handoff_not_found", next: `${name} has no handoff in the cloud in this topic.`, status: 404 });
export const badSeatName: Refusal = { code: "bad_request", next: "name= takes a seat's full name, role@account (for example name=arch@kai).", status: 400 };
