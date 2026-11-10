import { ticketFileAvailable } from "../room-file-ticket";
import type { Ticket } from "../view-ticket";
import { ApiError, now } from "../util";
import { MAX_FILES_PER_MESSAGE, fileKey, type FileMeta } from "../files";
import { framed, viewKind } from "../file-kind";
import { deleteObject, fileGone } from "../room-report";
import { classifyFile, isShown } from "../room-eviction";
import { filterSql, resolveFilters, likeTerms, page, searchSnippet } from "../search";
import { wrap } from "./kernel";
import type { Actor, Result, Row } from "./kernel";
import type { SearchPage, SearchQuery } from "../search";
import type { RoomInfo, SystemEvent } from "./types";

/** Uploads not sent with a message within this time are deleted (no using rooms as file storage). */
const UNSENT_TTL = 10 * 60_000;

export type ListFilesQuery = Pick<import("../search").SearchFilters, "by" | "since" | "until"> & { kind?: "files" | "pics"; q?: string; from?: string; before?: number; beforeId?: string; limit?: number };
export type ListedFile = FileMeta & { from: string; displayName: string | null; seq: number; ts: number; link: string; url: string; view: boolean };
export type ListFilesResult = { roomId: string; kind: "files" | "pics" | null; files: ListedFile[]; hasMore: boolean; counts: { files: number; pics: number; gone: number } };
/** An attachment as the export lists it (docs/api/export.md `files`, before its `path` is added): `hash` names its R2 object. */
export type ExportFile = { id: string; name: string; type: string; size: number; hash: string; seq: number };

/** What a file's own page shows (/v/<fileId>): the file, its room, and the files of the same message, in order. */
export interface FileView {
  room: { id: string; name: string; public: boolean; archived: boolean };
  file: FileMeta & {
    by: string; // who uploaded it (the member name: a person's handle, an agent's role@account)
    byDisplay: string | null; // that person's display name in this room
    ts: number; // when its message was sent; the upload's time while it is not sent yet
    seq: number | null; // its message
    deleted: number | null; // when it went (evicted; or removed before eviction existed): nothing to show then
    hash: string | null; // its bytes (R2 key) while it is here
  };
  siblings: (FileMeta & { deleted?: number })[];
}

export interface FilesDeps {
  sql(): SqlStorage;
  ctx(): DurableObjectState;
  env(): Env;
  schedule(task: string, ms: number): Promise<void>;
  room: { require(): Row; requireWritable(): void; row(): Row; info(): RoomInfo };
  members: { get(name: string): Row | undefined; require(actor: Actor): Row; reader(actor: Actor): Row | null };
  messages: {
    insert(m: { from: string; fromKind: string; text: string; event: SystemEvent }): unknown;
    markFile(seq: number, id: string, at: number | null): void;
  };
}

export class Files {
  constructor(private readonly d: FilesDeps) {}

  private get sql() { return this.d.sql(); }
  private get ctx() { return this.d.ctx(); }
  private get env() { return this.d.env(); }
  private room() { return this.d.room.require(); }
  private requireWritable() { return this.d.room.requireWritable(); }
  private roomRow() { return this.d.room.row(); }
  private roomInfo() { return this.d.room.info(); }
  private memberRow(name: string) { return this.d.members.get(name); }
  private requireMember(actor: Actor) { return this.d.members.require(actor); }
  private reader(actor: Actor) { return this.d.members.reader(actor); }
  private insertMessage(m: { from: string; fromKind: string; text: string; event: SystemEvent }) { return this.d.messages.insert(m); }
  private markFileInMessage(seq: number, id: string, at: number | null) { return this.d.messages.markFile(seq, id, at); }
  private schedule(task: string, ms: number) { return this.d.schedule(task, ms); }
  private wrap<T>(fn: () => T): Result<T> { return wrap(fn); }

  static migrate(sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS used_view_tickets (label TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS used_view_tickets_expiry ON used_view_tickets (expires_at)");
    sql.exec(`-- Uploaded images; seq is set once a message carries them (bytes are in R2 / KV under files.ts keys).
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
        uploaded_by TEXT NOT NULL, ts INTEGER NOT NULL, seq INTEGER, hash TEXT
      );
      CREATE INDEX IF NOT EXISTS files_seq ON files (seq);`);
    const fcols = sql.exec("PRAGMA table_info(files)").toArray().map((c) => c.name);
    if (!fcols.includes("hash")) sql.exec("ALTER TABLE files ADD COLUMN hash TEXT"); // object key = sha256 of the bytes
    // A file removed since deleted_at. charged: the bytes of the room's object charged to this
    // row's uploader (the first to store those bytes); before this column that was the oldest row with the hash.
    const fcols2 = sql.exec("PRAGMA table_info(files)").toArray().map((c) => c.name);
    if (!fcols2.includes("deleted_at")) {
      sql.exec("ALTER TABLE files ADD COLUMN deleted_at INTEGER");
      sql.exec("ALTER TABLE files ADD COLUMN charged INTEGER");
      sql.exec(
        "UPDATE files SET charged = CASE WHEN id = (SELECT f2.id FROM files f2 WHERE f2.hash IS files.hash ORDER BY f2.ts, f2.id LIMIT 1) THEN size ELSE 0 END",
      );
    }
    // Files that went from the room, and the message that carried them (null: never sent), so a file's page
    // finds one without reading every message. Filled once from the messages that list a file as deleted.
    // backfill: this one-time read of messages.files is the cross-domain migration exception.
    if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gone_files'").toArray().length) {
      sql.exec("CREATE TABLE gone_files (id TEXT PRIMARY KEY, seq INTEGER)");
      sql.exec(
        `INSERT OR IGNORE INTO gone_files (id, seq) SELECT json_extract(j.value, '$.id'), m.seq FROM messages m, json_each(m.files) j
         WHERE m.files IS NOT NULL AND json_extract(j.value, '$.deleted') IS NOT NULL`,
      );
    }
  }

  attach(seq: number, files: FileMeta[]) {
    for (const f of files) this.sql.exec("UPDATE files SET seq = ? WHERE id = ?", seq, f.id);
  }

  async alarm(t: number) {
    if ((this.ctx.storage.kv.get<number>("sweepDue") ?? Infinity) <= t) {
      this.ctx.storage.kv.delete("sweepDue");
      await this.sweepUnsent();
    }
  }

  nextDue(): number { return this.ctx.storage.kv.get<number>("sweepDue") ?? Infinity; }

  /** A file's own page, /v/<fileId>: on the public origin, so an agent can hand it on (relative where none is set). */
  private fileLink(id: string): string {
    return `${(this.env.PUBLIC_URL || "").replace(/\/$/, "")}/v/${id}`;
  }

  /**
   * A message's files with their pages (files[].link, docs/api/files.md) and whether a row opens that page (`view`:
   * Markdown, plain text, SVG, HTML it can show) or downloads. Stored without either: the origin and the rules may change.
   */
  withLinks<T extends FileMeta>(files: T[]): (T & { link: string; view: boolean })[] {
    return files.map((f) => ({ ...f, link: this.fileLink(f.id), view: framed(viewKind(f.name, f.type), f.size) }));
  }

  /** What a send answers about the files it carried: id, name, size and each one's page. */
  sentFiles(files: FileMeta[]): { files?: { id: string; name: string; size: number; link: string }[] } {
    return files.length ? { files: files.map((f) => ({ id: f.id, name: f.name, size: f.size, link: this.fileLink(f.id) })) } : {};
  }

  /** Delete uploads nobody sent within UNSENT_TTL; an object goes once no file in the room points at it. */
  private async sweepUnsent() {
    let roomId: string;
    try {
      roomId = this.roomRow().id as string;
    } catch {
      return; // purged
    }
    const ttl = this.unsentTtl();
    const stale = this.sql.exec("SELECT * FROM files WHERE seq IS NULL AND ts < ?", now() - ttl).toArray();
    for (const r of stale) await this.dropFileRow(r, roomId);
    const oldest = this.sql.exec("SELECT MIN(ts) AS t FROM files WHERE seq IS NULL").one().t as number | null;
    if (oldest != null) await this.schedule("sweepDue", Math.max(1000, oldest + ttl - now() + 1000));
  }

  /**
   * A file row goes for good. Its object goes when no other row in the room has the same bytes, and the space it
   * was charged comes back to its uploader; when another row still holds the bytes, the charge moves to that one.
   * Out of the room first (nothing else here can take the same row meanwhile), then the account index in D1.
   */
  private async dropFileRow(r: Row, roomId: string) {
    this.sql.exec("DELETE FROM files WHERE id = ?", r.id);
    this.sql.exec("INSERT OR REPLACE INTO gone_files (id, seq) VALUES (?, ?)", r.id, r.seq ?? null);
    const charged = (r.charged as number | null) ?? 0;
    const heir = r.hash ? this.sql.exec("SELECT id FROM files WHERE hash = ? ORDER BY deleted_at IS NOT NULL, ts LIMIT 1", r.hash).toArray()[0] : undefined;
    if (heir && charged) this.sql.exec("UPDATE files SET charged = COALESCE(charged, 0) + ? WHERE id = ?", charged, heir.id);
    await fileGone(this.env, roomId, r.id as string, heir ? (heir.id as string) : null);
    if (r.hash && !heir) await deleteObject(this.env, fileKey(roomId, r.hash as string));
  }

  private unsentTtl(): number {
    return Number(this.env.UPLOAD_UNSENT_TTL_MS) || UNSENT_TTL;
  }

  /** Sent attachments in this topic, newest first. The cursor includes id because one message can carry nine files. */
  async listFiles(actor: Actor, p: ListFilesQuery): Promise<Result<ListFilesResult>> {
    return this.wrap(() => {
      const room = this.room();
      this.reader(actor);
      if (p.kind !== undefined && p.kind !== "files" && p.kind !== "pics") throw new ApiError("bad_request", "kind= is files or pics.");
      const limit = p.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new ApiError("bad_request", "limit= must be a positive whole number.");
      if (p.before !== undefined && (!Number.isSafeInteger(p.before) || p.before < 1)) throw new ApiError("bad_request", "before= must be a positive message seq.");
      if (p.beforeId !== undefined && (!p.before || !p.beforeId)) throw new ApiError("bad_request", "beforeId= requires before= and a file id.");
      const q = (p.q ?? "").trim().replace(/\s+/gu, " ");
      if (q.length > 200) throw new ApiError("bad_request", "q= is at most 200 characters.");
      const terms = /\p{Script=Han}/u.test(q) || [...q.replace(/\s/gu, "")].length >= 2 ? q.split(" ") : [];
      const image = "f.type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')";
      const filters = resolveFilters({ by: p.by ?? (p.from ? [p.from] : undefined), since: p.since, until: p.until }, actor.name, n => this.memberRow(n));
      const extra = filterSql(filters, "files");
      const where = ["f.deleted_at IS NULL" + extra.sql];
      const args: (string | number)[] = [...extra.args];
      if (p.kind) where.push(p.kind === "pics" ? image : `NOT (${image})`);
      if (terms.length) {
        const match = likeTerms("f.name", terms);
        where.push(match.sql);
        args.push(...match.args);
      }

      if (p.before !== undefined) {
        if (p.beforeId !== undefined) {
          const cursor = this.sql.exec(
            "SELECT j.key AS pos FROM message_files_v m JOIN json_each(m.files) j ON json_extract(j.value, '$.id') = ? WHERE m.seq = ? LIMIT 1",
            p.beforeId, p.before,
          ).toArray()[0];
          if (cursor) {
            where.push("(f.seq < ? OR (f.seq = ? AND j.key > ?))");
            args.push(p.before, p.before, cursor.pos as number);
          } else { where.push("f.seq < ?"); args.push(p.before); }
        } else { where.push("f.seq < ?"); args.push(p.before); }
      }
      const size = Math.min(limit, 100);
      const rows = this.sql.exec(
        `SELECT f.id, f.name, f.type, f.size, f.uploaded_by, h.display_name, f.seq, m.ts FROM files f JOIN message_files_v m ON m.seq = f.seq JOIN json_each(m.files) j ON json_extract(j.value, '$.id') = f.id LEFT JOIN member_names_v h ON h.name = f.uploaded_by WHERE ${where.join(" AND ")} ORDER BY f.seq DESC, j.key ASC LIMIT ?`,
        ...args, size + 1,
      ).toArray();
      const counts = this.sql.exec(
        `SELECT COUNT(*) - COALESCE(SUM(CASE WHEN ${image} THEN 1 ELSE 0 END), 0) AS files, COALESCE(SUM(CASE WHEN ${image} THEN 1 ELSE 0 END), 0) AS pics FROM files f JOIN message_files_v m ON m.seq = f.seq WHERE f.deleted_at IS NULL`,
      ).one();
      const gone = this.sql.exec(
        "SELECT (SELECT COUNT(*) FROM gone_files WHERE seq IS NOT NULL) + (SELECT COUNT(*) FROM files f WHERE f.deleted_at IS NOT NULL AND f.seq IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gone_files g WHERE g.id = f.id)) AS n",
      ).one().n as number;
      const files = rows.slice(0, size).map((r) => ({
        ...this.withLinks([{ id: r.id as string, name: r.name as string, type: r.type as string, size: r.size as number, url: `/f/${room.id}/${r.id}` }])[0],
        from: r.uploaded_by as string,
        displayName: (r.display_name as string | null) ?? null,
        seq: r.seq as number,
        ts: r.ts as number,
      }));
      return { roomId: room.id as string, kind: p.kind ?? null, files, hasMore: rows.length > size, counts: { files: counts.files as number, pics: counts.pics as number, gone } };
    });
  }

  /**
   * The export's file list (room/export.ts): the attachments that will be in the zip, which are the sent ones still
   * here (a `seq`, no `deleted_at`) in messages up to `upTo`, in message order. The Worker reads their bytes from R2
   * by `hash`.
   */
  exportFiles(upTo: number): ExportFile[] {
    return this.sql
      .exec("SELECT id, name, type, size, hash, seq FROM files WHERE seq IS NOT NULL AND seq <= ? AND deleted_at IS NULL AND hash IS NOT NULL ORDER BY seq, ts, id", upTo)
      .toArray()
      .map((r) => ({ id: r.id as string, name: r.name as string, type: r.type as string, size: r.size as number, hash: r.hash as string, seq: r.seq as number }));
  }

  /**
   * Search's files group (room/search.ts): sent files still here, newest message first; the message's time through
   * message_files_v, the uploader's display name through member_names_v.
   */
  searchFiles(p: SearchQuery): SearchPage {
    const match = likeTerms("f.name", p.terms);
    const extra = filterSql(p, "files");
    const args = [...match.args, ...(p.before ? [p.before] : []), ...extra.args];
    const { rows, hasMore } = page(
      this.sql.exec(
        `SELECT f.id, f.name, f.size, f.uploaded_by, h.display_name, m.ts, f.seq FROM files f JOIN message_files_v m ON m.seq = f.seq LEFT JOIN member_names_v h ON h.name = f.uploaded_by WHERE f.deleted_at IS NULL AND ${match.sql}${p.before ? " AND f.seq < ?" : ""} ${extra.sql} ORDER BY f.seq ${p.order === "asc" ? "ASC" : "DESC"}, f.id ${p.order === "asc" ? "ASC" : "DESC"} LIMIT ?`,
        ...args,
        p.limit + 1,
      ).toArray(),
      p.limit,
    );
    return {
      hits: rows.map((r) => ({ type: "file", id: `#${r.seq}`, seq: r.seq as number, who: r.uploaded_by as string, displayName: (r.display_name as string | null) ?? null, ts: r.ts as number, title: r.name as string, snippet: searchSnippet(r.name as string, p.terms), fileId: r.id as string, size: r.size as number })),
      hasMore,
    };
  }

  // ---------- images ----------

  private fileView(r: Row): FileMeta & { url: string } {
    const id = r.id as string;
    return { id, name: r.name as string, type: r.type as string, size: r.size as number, url: `/f/${this.roomInfo().id}/${id}` };
  }

  /** Record an upload (the Worker has stored the bytes). */
  async addFile(actor: Actor, meta: FileMeta & { hash: string; charged: number }): Promise<Result<FileMeta & { url: string }>> {
    const r = this.wrap(() => {
      this.requireMember(actor);
      this.requireWritable();
      this.sql.exec(
        "INSERT INTO files (id, name, type, size, uploaded_by, ts, hash, charged) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        meta.id,
        meta.name,
        meta.type,
        meta.size,
        actor.name,
        now(),
        meta.hash,
        meta.charged,
      );
      return this.fileView(this.sql.exec("SELECT * FROM files WHERE id = ?", meta.id).one());
    });
    if ("ok" in r) await this.schedule("sweepDue", this.unsentTtl() + 5_000);
    return r;
  }

  // ---------- a full file space evicts the oldest ----------

  /**
   * The eviction run of an account takes these files out for good, even in an archived room. Each sent one
   * stays in its message marked deleted. `missing`: not here (or not theirs) any more;
   * `trashed`: had already been removed before eviction existed; `shown`: what this room's line will name.
   */
  async evictFiles(
    account: string,
    ids: string[],
  ): Promise<Result<{ gone: string[]; trashed: string[]; missing: string[]; shown: { name: string; size: number }[] }>> {
    let roomId: string;
    try {
      roomId = this.roomRow().id as string;
    } catch (e) {
      if (e instanceof ApiError) return { err: { code: e.code, next: e.next, status: e.status } };
      throw e;
    }
    const out = { gone: [] as string[], trashed: [] as string[], missing: [] as string[], shown: [] as { name: string; size: number }[] };
    const t = now();
    for (const id of ids.slice(0, 500)) {
      const f = this.sql.exec("SELECT * FROM files WHERE id = ?", id).toArray()[0];
      const kind = classifyFile(f, account);
      if (kind === "missing") {
        out.missing.push(id);
        continue;
      }
      // Its message says so first: should the drop fail halfway, the file is out of the room either way.
      const shown = isShown(f!);
      if (shown) this.markFileInMessage(f!.seq as number, id, t);
      await this.dropFileRow(f!, roomId);
      out[kind].push(id); // trashed: its message already said it was deleted
      if (shown) out.shown.push({ name: f!.name as string, size: f!.size as number });
    }
    return { ok: out };
  }

  /** One line per room per eviction run: 已清理：3 个文件（a.png、b.pdf、c.zip），上传者 kai 的空间满了，最早的先删. Wakes nobody, counts nowhere. */
  async evictedLine(account: string, files: { name: string; size: number }[]): Promise<void> {
    try {
      this.roomRow();
    } catch {
      return; // purged
    }
    if (!files.length) return;
    const names = files.slice(0, 5).map((f) => f.name).join("、") + (files.length > 5 ? " 等" : "");
    this.insertMessage({
      from: "system",
      fromKind: "system",
      text: `已清理：${files.length} 个文件（${names}），上传者 ${account} 的空间满了，最早的先删`,
      event: { type: "evicted", name: account, files: files.slice(0, 200) },
    });
  }

  /** Every file row of the room, for building the account index (D1 account_files) once. Any state of the room. */
  async fileIndex(): Promise<Result<{ id: string; uploadedBy: string; size: number; charged: number; ts: number; hash: string; name: string }[]>> {
    try {
      this.roomRow();
    } catch (e) {
      if (e instanceof ApiError) return { err: { code: e.code, next: e.next, status: e.status } };
      throw e;
    }
    return {
      ok: this.sql
        .exec("SELECT id, uploaded_by, size, COALESCE(charged, 0) AS charged, ts, hash, name FROM files")
        .toArray()
        .map((r) => ({
          id: r.id as string,
          uploadedBy: r.uploaded_by as string,
          size: r.size as number,
          charged: r.charged as number,
          ts: r.ts as number,
          hash: r.hash as string,
          name: r.name as string,
        })),
    };
  }

  /**
   * A file's own page, /v/<fileId>, for whoever may download it. A file that went (evicted, or
   * removed before eviction existed) is answered too, with `deleted`, from the message that carried it, so its page can say so.
   */
  async viewFile(actor: Actor, id: string): Promise<Result<FileView>> {
    return this.wrap(() => {
      this.reader(actor); // a member, or a viewer of a public room
      const room = this.roomInfo();
      const r = this.sql.exec("SELECT * FROM files WHERE id = ?", id).toArray()[0];
      // Gone from the room (dropFileRow): its message still lists it, marked deleted.
      const seq = r ? (r.seq as number | null) : ((this.sql.exec("SELECT seq FROM gone_files WHERE id = ?", id).toArray()[0]?.seq as number | null | undefined) ?? null);
      const m = seq == null ? undefined : this.sql.exec("SELECT from_name, files, ts FROM message_files_v WHERE seq = ?", seq).toArray()[0];
      const listed = m?.files ? (JSON.parse(m.files as string) as (FileMeta & { deleted?: number })[]) : [];
      const entry = listed.find((f) => f.id === id);
      if (!r && !entry) throw new ApiError("file_not_found", `There is no file ${id} in this topic.`, 404);
      const by = (r?.uploaded_by as string | undefined) ?? (m!.from_name as string);
      const who = this.memberRow(by);
      const deleted = r ? ((r.deleted_at as number | null) ?? null) : (entry!.deleted ?? now());
      return {
        room: { id: room.id, name: room.name, public: room.public, archived: room.archived },
        file: {
          id,
          name: (r?.name as string | undefined) ?? entry!.name,
          type: (r?.type as string | undefined) ?? entry!.type,
          size: (r?.size as number | undefined) ?? entry!.size,
          by,
          byDisplay: (who?.display_name as string | null | undefined) ?? null,
          ts: (m?.ts as number | undefined) ?? (r!.ts as number),
          seq,
          deleted,
          hash: deleted == null ? (r!.hash as string) : null,
        },
        siblings: listed.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, ...(f.deleted ? { deleted: f.deleted } : {}) })),
      };
    });
  }

  /** Called only after Worker signature verification; synchronous checks and insert cannot interleave. */
  async consumeViewTicket(ticket: Ticket, label: string): Promise<Result<boolean>> {
    return this.wrap(() => {
      const at = now();
      if (!ticket.a || ticket.e * 1000 <= at) return false;
      this.reader({ kind: "human", name: ticket.a, account: ticket.a });
      if (this.roomRow().id !== ticket.r) return false;
      const file = this.sql.exec("SELECT hash, deleted_at FROM files WHERE id = ?", ticket.f).toArray()[0];
      if (!ticketFileAvailable(file, ticket.h)) throw new ApiError("file_not_found", "This file is no longer available.", 404);
      return this.consumeTicket(label, ticket.e * 1000, at);
    });
  }

  /** Consumed tickets belong to files; messages uses this after checking its card and reader. */
  consumeTicket(label: string, expiresAt: number, at = now()): boolean {
    this.sql.exec("DELETE FROM used_view_tickets WHERE expires_at <= ?", at);
    return this.sql.exec("INSERT OR IGNORE INTO used_view_tickets (label, expires_at) VALUES (?, ?) RETURNING label", label, expiresAt).toArray().length === 1;
  }

  /** Metadata of a file in this room, for a member who wants to download it. */
  async fileMeta(actor: Actor, id: string): Promise<Result<FileMeta & { hash: string }>> {
    return this.wrap(() => {
      this.reader(actor);
      const r = this.sql.exec("SELECT * FROM files WHERE id = ?", id).toArray()[0];
      if (!r) throw new ApiError("file_not_found", `There is no file ${id} in this topic.`, 404);
      if (r.deleted_at != null) throw new ApiError("file_not_found", `File ${id} was deleted (it is removed earlier).`, 404);
      return { id, name: r.name as string, type: r.type as string, size: r.size as number, hash: r.hash as string };
    });
  }

  /** The files a message may carry: uploaded by the sender, not attached to another message yet. */
  claimFiles(actor: Actor, ids: string[]): (FileMeta & { url: string })[] {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length > MAX_FILES_PER_MESSAGE) {
      throw new ApiError("bad_request", `A message can carry at most ${MAX_FILES_PER_MESSAGE} files; send the rest in another message.`);
    }
    return unique.map((id) => {
      const r = this.sql.exec("SELECT * FROM files WHERE id = ?", id).toArray()[0];
      if (!r || r.uploaded_by !== actor.name) throw new ApiError("file_not_found", `files: ${id} is not an upload of yours in this topic. Upload it first.`, 404);
      if (r.seq != null) throw new ApiError("bad_request", `files: ${id} is already attached to message #${r.seq}.`);
      return this.fileView(r);
    });
  }

}
