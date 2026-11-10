// Exporting a topic as one zip (docs/api/export.md; the limits and the lock are defined below): the Worker's
// side. The topic's object only hands over records (room/export.ts); this module checks the request, takes the
// account's one-export-at-a-time lease in KV, and streams the zip (zip.ts) with topic.md (export-md.ts), data.json,
// the handoffs and the attachments from R2. Every refusal happens before the first byte; an error after that aborts
// the stream, so a download never ends as a zip that looks complete but is not.
import { ApiError, json, now } from "./util";
import { unwrap } from "./room-actions";
import { fileKey } from "./file-kind";
import { ZipWriter, chunksOf, dosTime, text } from "./zip";
import { dateText, mdHandoffs, mdHead, mdMembers, mdMemo, mdMessage, mdMessagesHead, mdSchedules, mdTasks, timeText, wallClock, type MdContext } from "./export-md";
import { EXPORT_PAGE, EXPORT_PARTS, type ExportHead, type ExportPart } from "./room/export";
import type { Actor, Result, RoomDO } from "./room-do";
import type { Lang } from "./layout";

type RoomStub = DurableObjectStub<RoomDO>;

/** What one export may hold; over any of them it answers export_too_large before the first byte. */
export const EXPORT_LIMITS = { messages: 100_000, files: 1000, bytes: 2 * 1024 ** 3 } as const;
export type ExportCounts = { messages: number; files: number; bytes: number };

/** The limits in force: the constants, or in tests TEST_EXPORT_LIMITS (small ones, to reach them quickly). */
export function exportLimits(env: Env): ExportCounts {
  if (!env.TEST_EXPORT_LIMITS) return { ...EXPORT_LIMITS };
  return { ...EXPORT_LIMITS, ...(JSON.parse(env.TEST_EXPORT_LIMITS) as Partial<ExportCounts>) };
}

/** The lease, KV `export:<userId>`: put with a 2-minute expiry, refreshed about every minute while streaming, deleted when done. */
export const EXPORT_LOCK_MS = 120_000;
const RENEW_AFTER_MS = 60_000;

export type ExportParams = { include: ExportPart[]; tz: string; dry: boolean };

/** The query string, checked: include (a comma list of the five parts; absent = all), tz (IANA), dry=1. */
export function exportParams(q: URLSearchParams): ExportParams {
  const raw = (q.get("include") ?? "").trim();
  const parts = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [...EXPORT_PARTS];
  const unknown = parts.find((p) => !(EXPORT_PARTS as readonly string[]).includes(p));
  if (unknown) throw new ApiError("bad_request", `include=${unknown}: the parts are ${EXPORT_PARTS.join(", ")}, comma-separated; leave include out for all of them.`);
  const include = EXPORT_PARTS.filter((p) => parts.includes(p));
  const tz = (q.get("tz") ?? "").trim() || "UTC";
  if (!validTimeZone(tz)) throw new ApiError("bad_request", `tz=${tz} is not a time zone name. Use an IANA name such as Asia/Shanghai or UTC.`);
  return { include, tz, dry: q.get("dry") === "1" };
}

export function validTimeZone(tz: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A name as it can go into a file name and a zip entry: `/ \ : * ? " < > |`, control characters and a leading `.`
 * become `-`, runs of `-` become one, `-` and spaces at the ends go, at most `max` characters; empty becomes `topic`.
 */
export function safeName(name: string, max: number): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g, "-")
    .replace(/^\./, "-")
    .replace(/-+/g, "-")
    .replace(/^[-\s]+|[-\s]+$/g, "");
  const cut = [...cleaned].slice(0, max).join("").replace(/[-\s]+$/, "");
  return cut || "topic";
}

/** `<topic name>-<YYYY-MM-DD>`: the zip's root folder and, with `.zip`, its file name. */
export const exportBaseName = (topicName: string, date: string) => `${safeName(topicName, 80)}-${date}`;

/** attachment; an ASCII fallback (non-ASCII and quotes as `_`) and the real name percent-encoded (RFC 6266). */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export const countsOf = (head: ExportHead): ExportCounts => ({
  messages: head.messageCount,
  files: head.files?.length ?? 0,
  bytes: head.files?.reduce((sum, f) => sum + f.size, 0) ?? 0,
});

/** export_too_large, with the limits and the counts, when any limit is over; the web renders the first exceeded one. */
export function tooLarge(counts: ExportCounts, limits: ExportCounts = EXPORT_LIMITS): ApiError | null {
  const over = counts.messages > limits.messages || counts.files > limits.files || counts.bytes > limits.bytes;
  if (!over) return null;
  return new ApiError(
    "export_too_large",
    `This topic is over the export limits (${limits.messages.toLocaleString("en-US")} messages, ${limits.files.toLocaleString("en-US")} files, ${Math.round((limits.bytes / 1024 ** 3) * 10) / 10} GiB of files). Export it without files (include= without files), or in parts with messages' filters.`,
    413,
    undefined,
    { limits: { ...limits }, counts },
  );
}

const busy = () => new ApiError("export_busy", "Another export of this account is still being downloaded. Wait for it to finish, then run this again.", 409);

/**
 * The account's lease: one export at a time, for the person and the agents of the account alike. A soft limit (KV
 * is eventually consistent: two requests in the same instant can both pass, which costs one extra download); what it
 * stops is one account streaming many 2 GiB exports at once.
 */
export class ExportLock {
  private renewedAt = 0;
  private readonly key: string;
  constructor(private readonly env: Env, userId: string) { this.key = `export:${userId}`; }

  /** Is a lease held now? dry=1 only looks. */
  async held(): Promise<boolean> {
    return (await this.env.KV.get(this.key)) !== null;
  }

  async take(at: number): Promise<void> {
    this.renewedAt = at;
    await this.env.KV.put(this.key, String(at), { expirationTtl: EXPORT_LOCK_MS / 1000 });
  }

  /** Called after every page and file; writes KV only when the last refresh is a minute old. */
  async renew(at: number): Promise<void> {
    if (at - this.renewedAt < RENEW_AFTER_MS) return;
    await this.take(at);
  }

  async release(): Promise<void> {
    await this.env.KV.delete(this.key).catch((e) => console.error(JSON.stringify({ msg: "export lock release failed", error: String(e) })));
  }
}

/** `lang`: the language of topic.md's labels: the page's on the web route, English on the API. */
export type ExportRequest = { env: Env; ctx: ExecutionContext; stub: RoomStub; actor: Actor; userId: string; q: URLSearchParams; lang: Lang };

/**
 * GET …/export: the checks (parameters, membership, limits, the lease), then the zip as a stream. `dry=1` stops after
 * the checks and answers the counts. The same for the agent API and the web; the routes only pass who is calling.
 */
export async function exportRoom({ env, ctx, stub, actor, userId, q, lang }: ExportRequest): Promise<Response> {
  const p = exportParams(q);
  // The RPC result type loses the head's shape (its memo and task bodies are open records): named back here.
  const head = unwrap((await stub.exportHead(actor, p.include, lang)) as Result<ExportHead>);
  const counts = countsOf(head);
  const over = tooLarge(counts, exportLimits(env));
  if (over) throw over;
  const lock = new ExportLock(env, userId);
  if (await lock.held()) throw busy();
  const at = now();
  if (p.dry) return json({ roomId: head.topic.roomId, include: p.include, counts });
  await lock.take(at);
  const clock = wallClock(at, p.tz);
  const base = exportBaseName(head.topic.name, dateText(clock));
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const zip = new ZipWriter((chunk) => writer.write(chunk), dosTime(clock.y, clock.mo, clock.d, clock.h, clock.mi, clock.s));
  const pump = async () => {
    try {
      await writeEntries(zip, { env, stub, actor, head, p, lang, base, exportedAt: at, lock });
      await zip.end();
      await writer.close();
    } catch (e) {
      // The client's download fails (no end record), never a half zip that looks complete.
      console.error(JSON.stringify({ msg: "export failed", room: head.topic.roomId, error: String((e as Error)?.stack || e) }));
      await writer.abort(e).catch(() => {});
    } finally {
      await lock.release();
    }
  };
  ctx.waitUntil(pump());
  return new Response(readable, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": contentDisposition(`${base}.zip`),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

type Job = { env: Env; stub: RoomStub; actor: Actor; head: ExportHead; p: ExportParams; lang: Lang; base: string; exportedAt: number; lock: ExportLock };

/** The entries in order: topic.md, data.json, handoffs/*, files/*. The messages are read twice, once per text entry. */
async function writeEntries(zip: ZipWriter, j: Job) {
  const { head, p, base } = j;
  const has = (part: ExportPart) => p.include.includes(part);
  const files = (head.files ?? []).map((f) => ({ ...f, path: `files/${f.id}-${safeName(f.name, 120)}` }));
  const paths = new Map(files.map((f) => [f.id, f.path]));
  const handoffs = (head.handoffs ?? []).map((h) => ({ name: h.name, computer: h.computer, size: h.size, updatedAt: h.updatedAt, path: `handoffs/${h.name}.md` }));
  const c: MdContext = {
    lang: j.lang, tz: p.tz, time: (ms) => timeText(wallClock(ms, p.tz)), exportedAt: j.exportedAt, exportedBy: j.actor.name, include: p.include,
    filePath: (id) => paths.get(id),
  };
  await zip.entry(`${base}/topic.md`, topicMd(j, c, handoffs));
  await zip.entry(`${base}/data.json`, dataJson(j, handoffs));
  if (has("handoffs")) {
    for (const h of handoffs) {
      const r = await j.stub.getHandoff(j.actor, h.name);
      // A seat whose handoff went since the head was read: topic.md still names it; the file is simply not there.
      if ("err" in r) { if (r.err.code === "handoff_not_found" || r.err.code === "seat_not_found") continue; throw new ApiError(r.err.code, r.err.next, r.err.status); }
      await zip.entry(`${base}/${h.path}`, [text(r.ok.body)]);
      await j.lock.renew(now());
    }
  }
  if (has("files") && j.env.FILES) {
    for (const f of files) {
      const obj = await j.env.FILES.get(fileKey(head.topic.roomId, f.hash));
      if (!obj) { console.error(JSON.stringify({ msg: "export file missing", room: head.topic.roomId, file: f.id })); continue; }
      await zip.entry(`${base}/${f.path}`, chunksOf(obj.body));
      await j.lock.renew(now());
    }
  }
}

/** The message pages, ascending, bounded by the head's upTo; each page renews the lease. */
async function* pages(j: Job) {
  let from = 0;
  while (from < j.head.upTo) {
    const { messages } = unwrap(await j.stub.exportMessages(j.actor, from, j.head.upTo, EXPORT_PAGE));
    if (!messages.length) return;
    yield messages;
    from = messages[messages.length - 1].seq;
    await j.lock.renew(now());
  }
}

async function* topicMd(j: Job, c: MdContext, handoffs: { name: string; path: string }[]): AsyncIterable<Uint8Array> {
  const { head, p } = j;
  const has = (part: ExportPart) => p.include.includes(part);
  yield text(mdHead(head, c) + "\n");
  yield text(mdMembers(head.members, j.lang) + "\n");
  if (has("messages")) {
    yield text(mdMessagesHead(j.lang));
    for await (const page of pages(j)) yield text(page.map((m) => mdMessage(m, c)).join(""));
  }
  if (has("tasks")) yield text(mdTasks(head.tasks ?? [], c) + "\n");
  if (has("memo")) {
    yield text(mdSchedules(head.schedules ?? [], c) + "\n");
    yield text(mdMemo(head.memo ?? {}, c) + "\n");
  }
  if (has("handoffs")) yield text(mdHandoffs(handoffs, j.lang));
}

/** data.json as a stream: the fixed parts first, then `"messages": [` page by page `]`. */
async function* dataJson(j: Job, handoffs: { name: string; computer: string | null; size: number; updatedAt: number; path: string }[]): AsyncIterable<Uint8Array> {
  const { head, p } = j;
  const has = (part: ExportPart) => p.include.includes(part);
  const fixed: Record<string, unknown> = {
    topic: head.topic,
    exportedAt: j.exportedAt,
    exportedBy: j.actor.name,
    tz: p.tz,
    include: p.include,
    members: head.members,
    ...(has("tasks") ? { tasks: head.tasks ?? [] } : {}),
    ...(has("memo") ? { schedules: head.schedules ?? [], memo: head.memo ?? {} } : {}),
    ...(has("handoffs") ? { handoffs } : {}),
  };
  const json = JSON.stringify(fixed, null, 1);
  if (!has("messages")) { yield text(json + "\n"); return; }
  yield text(json.slice(0, -1).trimEnd() + ',\n "messages": [');
  let first = true;
  for await (const page of pages(j)) {
    const body = page.map((m) => JSON.stringify(m)).join(",\n");
    yield text((first ? "\n" : ",\n") + body);
    first = false;
  }
  yield text("\n ]\n}\n");
}
