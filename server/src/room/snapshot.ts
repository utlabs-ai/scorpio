import { publicSnapshotDelete, publicSnapshotPut, publicSnapshotSize, repairPrivateSnapshotIndex } from "../room-report";
import { snapshotOf } from "../room-snapshot";
import type { Row } from "./kernel";

export interface SnapshotDeps {
  ctx(): DurableObjectState;
  env(): Env;
  schedule(task: string, delayMs: number): Promise<void>;
  room: { require(): Row; isPublic(): boolean; idOrNull(): string | null };
  messages: { lastSeq(): number; latestForSnapshot(n: number): Row[] };
  members: { displayNames(): Row[] };
}

export class Snapshot {
  constructor(private readonly d: SnapshotDeps) {}

  async wake() {
    // A public room from before snapshots writes its first one on its next start.
    if (!this.d.ctx().storage.kv.get("publicSnap") && this.d.room.isPublic()) await this.d.schedule("publicDue", 10_000);
    if (!this.d.room.isPublic() && (this.d.ctx().storage.kv.get("publicSnap") || this.d.ctx().storage.kv.get("snapshot:privateIndexPending")))
      await this.d.schedule("publicDue", 10_000);
  }

  /** The visibility action writes D1 after the DO; the alarm repairs it even if that action's retries fail. */
  madePrivate() {
    this.d.ctx().storage.kv.put("snapshot:privateIndexPending", 1);
    this.d.ctx().waitUntil(this.d.schedule("publicDue", 10_000).catch((e) =>
      console.error(JSON.stringify({ msg: "private snapshot retry schedule failed", error: String(e) }))));
  }

  /** Something a snapshot shows changed: rewrite it within 10 s (coalesced), or drop it once the room is not public. */
  publicChanged() {
    if (this.d.room.isPublic()) {
      this.d.ctx().storage.kv.delete("snapshot:privateIndexPending");
      this.d.schedule("publicDue", 10_000).catch((e) => console.error(JSON.stringify({ msg: "schedule failed", error: String(e) })));
    } else {
      this.dropIfWritten();
    }
  }

  /** Drop the snapshot only if one was written, so a private topic sends no KV delete (also when lifecycle deletes the topic). */
  dropIfWritten() {
    if (this.d.ctx().storage.kv.get("publicSnap")) this.d.ctx().waitUntil(this.dropSnapshot());
  }

  private async dropSnapshot() {
    const id = this.d.room.idOrNull();
    if (!id) return;
    try {
      await publicSnapshotDelete(this.d.env(), id);
      this.d.ctx().storage.kv.delete("publicSnap");
    } catch (e) {
      console.error(JSON.stringify({ msg: "public snapshot delete failed", room: id, error: String(e) }));
      await this.d.schedule("publicDue", 10_000);
    }
  }

  /** KV public:<roomId>: name, topic, archived, the last seq, and the last N messages as written (N = config:public_snapshot, 10). */
  async writeSnapshot() {
    if (!this.d.room.isPublic()) {
      if (this.d.ctx().storage.kv.get("publicSnap")) await this.dropSnapshot();
      if (this.d.ctx().storage.kv.get("snapshot:privateIndexPending")) {
        const id = this.d.room.idOrNull();
        if (id) {
          try {
            await repairPrivateSnapshotIndex(this.d.env(), id);
            this.d.ctx().storage.kv.delete("snapshot:privateIndexPending");
          } catch (e) {
            console.error(JSON.stringify({ msg: "private snapshot index repair failed", room: id, error: String(e) }));
            await this.d.schedule("publicDue", 10_000);
          }
        }
      }
      return;
    }
    const r = this.d.room.require();
    const n = Math.min(50, Math.max(1, Math.floor(Number(await publicSnapshotSize(this.d.env())) || 10)));
    const rows = this.d.messages.latestForSnapshot(n).reverse();
    // display: a person's display name, only when they set one.
    const members = this.d.members.displayNames();
    const snap = snapshotOf(r, members, rows, this.d.messages.lastSeq());
    await publicSnapshotPut(this.d.env(), r.id as string, snap);
    this.d.ctx().storage.kv.put("publicSnap", 1);
    // A visibility change may have run while the KV write was in flight.
    if (!this.d.room.isPublic()) await this.dropSnapshot();
  }

  async alarm(t: number) {
    if ((this.d.ctx().storage.kv.get<number>("publicDue") ?? Infinity) <= t) {
      this.d.ctx().storage.kv.delete("publicDue");
      await this.writeSnapshot().catch((e) => console.error(JSON.stringify({ msg: "public snapshot failed", error: String(e) })));
    }
  }

  nextDue(): number {
    return this.d.ctx().storage.kv.get<number>("publicDue") ?? Infinity;
  }
}
