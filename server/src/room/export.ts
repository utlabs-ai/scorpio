// The export's reads (docs/api/export.md): what the Worker's export (src/export.ts) asks the topic for. Two RPCs, both
// reads: the head (the topic, its members, counts and the parts that are small enough to come at once) and the
// messages in pages. Nothing here touches presence, cursors or wakes anyone: an export leaves the topic as it was. The
// zip itself is built in the Worker, so that CRCs and rendering never hold up the topic's object.
import { ApiError } from "../util";
import { wrap } from "./kernel";
import type { Actor, Result, Row } from "./kernel";
import type { ExportFile } from "./files";
import type { Member, Message, RoomInfo } from "./types";
import type { HandoffMeta } from "../handoff";
import type { Lang } from "../layout";

export const EXPORT_PARTS = ["messages", "tasks", "files", "handoffs", "memo"] as const;
export type ExportPart = (typeof EXPORT_PARTS)[number];

/** The topic as `GET /rooms` lists it, with its owner and whether it is public (data.json `topic`). */
export type ExportTopic = {
  roomId: string; name: string; topic: string; status: "active" | "archived"; createdAt: number;
  archivedAt?: number; archivedReason?: string; owner: string; public: boolean;
};

export type ExportHead = {
  topic: ExportTopic;
  members: Member[];
  upTo: number; // the last seq when the export began: both message passes stop there
  messageCount: number;
  files?: ExportFile[];
  handoffs?: (HandoffMeta & { name: string })[];
  tasks?: Record<string, unknown>[];
  schedules?: Record<string, unknown>[];
  memo?: Record<string, unknown>;
};

export const EXPORT_PAGE = 2000;

export interface ExportDeps {
  room: { require(): Row; info(): RoomInfo };
  members: { require(actor: Actor): Row; exportMembers(actor: Actor): Member[] };
  messages: { lastSeq(): number; exportCount(upTo: number): number; exportRows(from: number, upTo: number, limit: number): Row[]; of(rows: Row[], viewer: Actor): Message[] };
  files: { exportFiles(upTo: number): ExportFile[] };
  tasks: { exportItems(): Record<string, unknown>[] };
  schedules: { items(actor: Actor): Record<string, unknown>[] };
  memo: { read(actor: Actor, lang: Lang): Promise<Result<Record<string, unknown>>> };
}

export class Export {
  constructor(private readonly d: ExportDeps) {}

  /**
   * Everything but the messages, and how many of those there are. Refused like every read of the topic: a deleted
   * topic (room_deleted), anyone who is not a member (not_member; a visitor of a public topic has not joined). An
   * archived topic is read as it is.
   */
  async exportHead(actor: Actor, include: readonly ExportPart[], lang: Lang = "en"): Promise<Result<ExportHead>> {
    const has = (p: ExportPart) => include.includes(p);
    let memo: Record<string, unknown> | undefined;
    if (has("memo")) {
      // Memo's read is its own RPC shape; asked first so that its refusal (the same not_member) comes out as one.
      const r = await this.d.memo.read(actor, lang);
      if ("err" in r) return r;
      const { roomId: _roomId, ...rest } = r.ok;
      memo = rest;
    }
    return wrap(() => {
      this.d.room.require();
      this.d.members.require(actor);
      const info = this.d.room.info();
      const upTo = this.d.messages.lastSeq();
      const members = this.d.members.exportMembers(actor);
      const head: ExportHead = {
        topic: {
          roomId: info.id, name: info.name, topic: info.topic, status: info.archived ? "archived" : "active", createdAt: info.createdAt,
          ...(info.archived && info.archivedAt != null ? { archivedAt: info.archivedAt } : {}),
          ...(info.archived && info.archivedReason ? { archivedReason: info.archivedReason } : {}),
          owner: info.owner, public: info.public,
        },
        members,
        upTo,
        messageCount: this.d.messages.exportCount(upTo),
      };
      if (has("files")) head.files = this.d.files.exportFiles(upTo);
      if (has("handoffs")) head.handoffs = members.filter((m) => m.handoff).map((m) => ({ name: m.name, ...m.handoff! }));
      if (has("tasks")) head.tasks = this.d.tasks.exportItems();
      if (has("memo")) {
        head.schedules = this.d.schedules.items(actor);
        head.memo = memo;
      }
      return head;
    });
  }

  /**
   * One page of messages after `from` up to `upTo`, ascending, as this reader sees them in `GET /messages`, except
   * that no message carries a `screen`: a pane's screen is a troubleshooting aid for its owner, not part of the record.
   */
  async exportMessages(actor: Actor, from: number, upTo: number, limit = EXPORT_PAGE): Promise<Result<{ messages: Message[] }>> {
    return wrap(() => {
      this.d.room.require();
      this.d.members.require(actor);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(upTo) || from < 0 || upTo < from) throw new ApiError("bad_request", "from and upTo are message numbers, from <= upTo.");
      const rows = this.d.messages.exportRows(from, upTo, Math.max(1, Math.min(EXPORT_PAGE, limit)));
      const messages = this.d.messages.of(rows, actor);
      for (const m of messages) delete m.screen;
      return { messages };
    });
  }
}
