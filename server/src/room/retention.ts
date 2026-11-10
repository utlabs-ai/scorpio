import { now } from "../util";
import { quietDecision, purgeDecision } from "../room-retention";
import { wrap } from "./kernel";
import type { Result, Row } from "./kernel";

export interface RetentionDeps {
  room: {
    require(): Row;
    row(): Row;
    markDeleted(why: { reason: "retention" }): number;
  };
  messages: { lastCountedAt(r: Row): number };
  lifecycle: { archiveRoom(reason: "retention", at: number | null): void };
}

export class Retention {
  constructor(private readonly d: RetentionDeps) {}

  /**
   * Stage 1: quiet since before `cutoff` → archived for that reason, read-only like any archived room, no room message.
   * A counted message since then keeps it active (lastAt: when, for D1). Already archived: as it is, so D1 can follow.
   */
  async quietArchive(cutoff: number): Promise<Result<{ archivedAt: number | null; archivedReason: string | null; lastAt: number }>> {
    return wrap(() => {
      const r = this.d.room.require();
      const lastAt = this.d.messages.lastCountedAt(r);
      const decision = quietDecision(r, lastAt, cutoff, now());
      if (decision.write) this.d.lifecycle.archiveRoom("retention", decision.archivedAt);
      return { archivedAt: decision.archivedAt, archivedReason: decision.archivedReason, lastAt: decision.lastAt };
    });
  }

  /**
   * Stage 2: archived beyond cutoff → mark inaccessible before permanent purge. A concurrent restore or
   * re-archive starts a fresh clock, which is checked here rather than trusting D1's daily summary.
   */
  async retentionPurge(cutoff: number): Promise<Result<{ deletedAt: number | null }>> {
    return wrap(() => {
      const r = this.d.room.row();
      const decision = purgeDecision(r, cutoff, now());
      return { deletedAt: decision.write ? this.d.room.markDeleted({ reason: "retention" }) : decision.deletedAt };
    });
  }

}
