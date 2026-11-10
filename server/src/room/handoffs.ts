import { now } from "../util";
import { HANDOFF_META_VIEW_SQL, HANDOFF_SUM_SQL, badSeatName, deleteRefusal, handoffNotFound, isSeatName, seatNotFound, spaceRefusal, writerRefusal, type HandoffMeta } from "../handoff";
import { refuse, refuseIf, type Actor, type Row } from "./kernel";
import type { Handoff, HandoffView, RoomInfo } from "./types";

export interface HandoffsDeps {
  sql(): SqlStorage;
  publicUrl(): string;
  room: { require(): Row; requireWritable(): void; info(): RoomInfo };
  members: {
    get(name: string): Row | undefined;
    reader(actor: Actor): Row | null;
    require(actor: Actor): Row;
    broadcast(): void;
    ofAccount(account: string): Row[];
  };
}

export class Handoffs {
  constructor(private readonly d: HandoffsDeps) {}

  static migrate(sql: SqlStorage) {
    sql.exec(`
      -- One handoff per seat (docs/api/files.md): the note an agent leaves for whoever takes its seat over. Not a column of
      -- members (memberRow reads SELECT * on almost every request); its rows go with their members rows (lifecycle calls dropSeats).
      CREATE TABLE IF NOT EXISTS handoffs (
        name TEXT PRIMARY KEY,          -- the seat: role@account
        body TEXT NOT NULL,             -- the Markdown, UTF-8
        size INTEGER NOT NULL,          -- bytes of body as UTF-8
        updated_at INTEGER NOT NULL,    -- ms, server time when it was stored: the only order
        computer TEXT                   -- the computer it came from (X-Scorpio-Computer), shown
      );
    `);
    // Published for members' list (allMembers), read-only. A changed view takes a new name: IF NOT EXISTS keeps the old one.
    sql.exec(HANDOFF_META_VIEW_SQL);
  }

  dropSeats(names: string[]) {
    this.d.sql().exec("DELETE FROM handoffs WHERE name IN (SELECT value FROM json_each(?))", JSON.stringify(names));
  }

  /** A seat's handoff page, on the public origin like a file's (its `link`): it always opens the seat's latest one. */
  private handoffLink(name: string): string {
    return `${this.d.publicUrl().replace(/\/$/, "")}/r/${this.d.room.info().id}/handoff?name=${encodeURIComponent(name)}`;
  }

  /** What a PUT checks before its body is read, in order: the topic (deleted, archived), then the writer. */
  private requireHandoffWriter(actor: Actor) {
    const r = this.d.room.require();
    this.d.room.requireWritable();
    refuseIf(writerRefusal(this.d.members.get(actor.name), actor.name, r.id as string));
  }

  /** The Worker asks this first, so that a refusal never waits for (or reads) up to 256 KB of body. */
  writer(actor: Actor): { name: string } {
    this.requireHandoffWriter(actor);
    return { name: actor.name };
  }

  /**
   * Stores the seat's own handoff, replacing the one before. The checks again, then the account's sum and the
   * write in one step: two seats of one account writing at once cannot both pass the 2.5 MB check.
   */
  put(actor: Actor, p: { body: string; size: number; computer: string | null }): Handoff & { link: string } {
    this.requireHandoffWriter(actor);
    const names = this.d.members.ofAccount(actor.account).map((m) => m.name as string);
    const others = this.d.sql().exec(HANDOFF_SUM_SQL, JSON.stringify(names), actor.name).one().total as number;
    refuseIf(spaceRefusal(others, p.size));
    const t = now();
    this.d.sql().exec(
      `INSERT INTO handoffs (name, body, size, updated_at, computer) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET body = excluded.body, size = excluded.size, updated_at = excluded.updated_at, computer = excluded.computer`,
      actor.name, p.body, p.size, t, p.computer,
    );
    this.d.members.broadcast();
    return { roomId: this.d.room.info().id, name: actor.name, size: p.size, updatedAt: t, computer: p.computer, link: this.handoffLink(actor.name) };
  }

  /** The seat's member row and handoff row (never a handoff whose seat is gone). */
  private handoffRows(name: string): { seat: Row | undefined; row: Row | undefined } {
    if (!isSeatName(name)) refuse(badSeatName);
    const seat = this.d.members.get(name);
    return { seat, row: seat ? this.d.sql().exec("SELECT * FROM handoffs WHERE name = ?", name).toArray()[0] : undefined };
  }

  private handoffOf(row: Row): HandoffMeta {
    return { size: row.size as number, updatedAt: row.updated_at as number, computer: (row.computer as string | null) ?? null };
  }

  /** A seat's handoff with its text, for whoever may read the topic's messages (an agent, a daemon seat). */
  get(actor: Actor, name: string): Handoff & { body: string } {
    this.d.members.reader(actor);
    const { seat, row } = this.handoffRows(name);
    if (!seat) refuse(seatNotFound(name));
    if (!row) refuse(handoffNotFound(name));
    return { roomId: this.d.room.info().id, name, ...this.handoffOf(row!), body: row!.body as string };
  }

  /** What the handoff's page shows, its text included; no refusal for a seat or handoff that is not there. */
  view(actor: Actor, name: string): HandoffView {
    const me = this.d.members.reader(actor);
    const room = this.d.room.info();
    const { seat, row } = this.handoffRows(name);
    return {
      room: { id: room.id, name: room.name, public: room.public, archived: room.archived },
      seat: seat ? { name, owner: seat.owner as string, kind: seat.kind as string, status: seat.status as string } : null,
      handoff: row ? { ...this.handoffOf(row), body: row.body as string } : null,
      member: !!me,
    };
  }

  /** A person deletes the handoff of a seat of their own account, active or left, also in an archived topic. */
  delete(actor: Actor, name: string): { roomId: string; name: string; deleted: true } {
    this.d.members.require(actor);
    if (!isSeatName(name)) refuse(badSeatName);
    refuseIf(deleteRefusal(this.d.members.get(name), name, actor.account));
    if (!this.d.sql().exec("DELETE FROM handoffs WHERE name = ?", name).rowsWritten) refuse(handoffNotFound(name));
    this.d.members.broadcast();
    return { roomId: this.d.room.info().id, name, deleted: true as const };
  }
}
