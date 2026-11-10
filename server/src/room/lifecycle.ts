// The lifecycle operations: a member leaves, a whole account leaves, the creator removes an account, an account is
// deleted, a person removes their own computer, the topic is archived (by its creator, by the plan, by the retention
// clock) or deleted, and the owner's plan lapses. Each changes several domains; here each calls their owners in a fixed
// order (today's), so the order of side effects is read in one place. It owns no data. RoomDO holds it through
// RoomDO.lifecycleOf(o) and keeps every RPC under its name (split by domain S7b).
//
// The socket loops differ per operation on purpose (tags, close codes, reasons, frames): do not merge them. Members are
// written through members' functions; room's writes (archive, restore, deleted_at) through room's (room/room.ts:
// writeArchived, writePlanArchive, writeRestore, writeRetentionArchive, writeDeleted).
import { ApiError, now } from "../util";
import { ownerStays, planArchiveChange } from "../room-membership";
import type { Actor, Result, Row } from "./kernel";
import type { Brief } from "../task-brief";
import type { Limits, Plan } from "../plans";
import type { RoomInfo } from "./types";
import type { Room } from "./room";

export interface LifecycleDeps {
  workspace?: { revokeAccount(account: string): void; revokeComputer(account: string, id: string): void; revokeAll(): void };
  ctx(): DurableObjectState;
  wrap<T>(fn: () => T): Result<T>;
  safeSend(ws: WebSocket, data: string): void;
  room: {
    require(): Row;
    requireOwner(actor: Actor, what: string): Row;
    info(): RoomInfo;
    memberView(): ReturnType<Room["memberRoomView"]>;
    broadcast(hosts: boolean): void;
    setArchived(at: number | null): void;
    planArchive(at: number, reason: string): void;
    planRestore(): void;
    retentionArchive(at: number | null): void;
    setDeleted(at: number): void;
    dropAccountFailures(account: string): void;
  };
  members: {
    require(actor: Actor): Row;
    get(name: string): Row | undefined;
    setLeft(name: string, at: number): void;
    accountActive(account: string): boolean;
    activeNames(account: string): string[];
    setAccountLeft(account: string, at: number): void;
    ofAccount(account: string): Row[];
    drop(names: string[]): void;
    dropAccountComputers(account: string): void;
    carried(owner: string, seat: string): Row[];
    blockComputer(name: string, owner: string, deviceId: string | null): void;
    dropSeat(name: string): void;
    leaveCarried(owner: string, seat: string, at: number): void;
  };
  presence: { broadcastMembers(): void };
  messages: { system(type: "join" | "leave", name: string): void; dropAccountCache(account: string): void; dropAccountScreens(account: string): void };
  tasks: { release(names: string[], actor: Pick<Actor, "name">): void; yours(name: string): Brief[] };
  schedules: { dropAccount(account: string): void; stop(reason: "archived" | "pro_expired"): void; dropAll(): void };
  handoffs: { dropSeats(names: string[]): void };
  approvals: { dropAccount(account: string): void; dropHost(name: string): void };
  quota: { forgetPlan(): void; ownerLimits(): Promise<{ plan: Plan; limits: Limits }> };
  /** Drops the public snapshot only if one was written (Snapshot.dropIfWritten). */
  snapshot: { drop(): void };
}

export class Lifecycle {
  constructor(private readonly d: LifecycleDeps) {}

  // Same names as RoomDO's, so each body reads as it did there.
  private get ctx() { return this.d.ctx(); }
  private wrap<T>(fn: () => T): Result<T> { return this.d.wrap(fn); }
  private safeSend(ws: WebSocket, data: string) { this.d.safeSend(ws, data); }
  private room() { return this.d.room.require(); }
  private requireOwner(actor: Actor, what: string) { return this.d.room.requireOwner(actor, what); }
  private roomInfo() { return this.d.room.info(); }
  private memberRoomView() { return this.d.room.memberView(); }
  private broadcastRoom(hosts: boolean) { this.d.room.broadcast(hosts); }
  private requireMember(actor: Actor) { return this.d.members.require(actor); }
  private memberRow(name: string) { return this.d.members.get(name); }
  private broadcastMembers() { this.d.presence.broadcastMembers(); }
  private systemMessage(type: "join" | "leave", name: string) { this.d.messages.system(type, name); }
  private releaseItems(names: string[], actor: Pick<Actor, "name">) { this.d.tasks.release(names, actor); }
  private yours(name: string) { return this.d.tasks.yours(name); }
  private dropAccountSchedules(account: string) { this.d.schedules.dropAccount(account); }
  private stopSchedules(reason: "archived" | "pro_expired") { this.d.schedules.stop(reason); }
  private dropSnapshot() { this.d.snapshot.drop(); }
  private ownerLimits() { return this.d.quota.ownerLimits(); }

  /** One name leaves: its row stays (status left), its connections close with 1000 and no frame, then the leave line. */
  async leave(actor: Actor): Promise<Result<{ roomId: string; name: string; status: string; accountActive: boolean; open: Brief[] }>> {
    return this.wrap(() => {
      this.requireMember(actor);
      if (actor.kind === "human") this.d.workspace?.revokeAccount(actor.account);
      else { const seat = this.memberRow(actor.name); if (seat?.kind === "host" && seat.device_id) this.d.workspace?.revokeComputer(actor.account, String(seat.device_id)); }
      this.d.members.setLeft(actor.name, now());
      if (this.memberRow(actor.name)?.kind === "host") this.d.approvals.dropHost(actor.name);
      this.releaseItems([actor.name], actor);
      for (const ws of this.ctx.getWebSockets(actor.kind === "human" ? `h:${actor.name}` : `a:${actor.name}`)) {
        try {
          ws.close(1000, "left");
        } catch {}
      }
      this.systemMessage("leave", actor.name);
      this.broadcastMembers();
      const still = this.d.members.accountActive(actor.account);
      // What stays under the name it leaves (CLI 0.5.3), all todo by now: its agent settles it, or hands it over.
      return { roomId: this.roomInfo().id, name: actor.name, status: "left", accountActive: still, open: this.yours(actor.name) };
    });
  }

  /**
   * A person leaves (docs/api/topics.md): they and every agent and daemon seat of their account
   * go to `left`, rows kept (name, cursor and role card are there to resume). Their connections get the `removed`
   * frame with `by` themselves and close with 4004; then a leave message per name, as an agent's own leave. The
   * creator cannot leave (archive or delete instead). A public topic makes them a viewer again; a private one wants
   * the passcode to come back (accountKnown counts only names still here).
   */
  async leaveAccount(actor: Actor): Promise<Result<{ roomId: string; left: string[]; public: boolean }>> {
    return this.wrap(() => {
      const r = this.room();
      if (ownerStays(r, actor.account)) throw new ApiError("the_owner_stays", "The creator cannot leave their own topic. Archive it or delete it instead.", 409);
      this.requireMember(actor);
      const names = this.d.members.activeNames(actor.account);
      this.d.workspace?.revokeAccount(actor.account);
      const t = now();
      this.dropAccountSchedules(actor.account);
      this.d.members.setAccountLeft(actor.account, t);
      for (const name of names) if (this.memberRow(name)?.kind === "host") this.d.approvals.dropHost(name);
      this.releaseItems(names, actor);
      // The frame comes first: a client acts on it at once, whatever the close handshake does.
      const frame = JSON.stringify({ type: "removed", account: actor.account, by: actor.name });
      for (const n of names) {
        for (const tag of [`h:${n}`, `a:${n}`, `host:${n}`]) {
          for (const ws of this.ctx.getWebSockets(tag)) {
            this.safeSend(ws, frame);
            try {
              ws.close(4004, "left");
            } catch {}
          }
        }
      }
      for (const n of names) this.systemMessage("leave", n);
      this.broadcastMembers();
      return { roomId: r.id as string, left: names, public: !!r.public };
    });
  }

  /**
   * The owner asks an account to leave: the person and every agent and daemon seat of theirs go, rows and
   * all (they need the passcode to come back, and read from the start of their return). Their open
   * connections close with 4004. No room message, as when someone leaves quietly.
   */
  async removeAccount(actor: Actor, account: string): Promise<Result<{ roomId: string; account: string; removed: string[] }>> {
    return this.wrap(() => {
      const r = this.requireOwner(actor, "ask someone to leave");
      if (ownerStays(r, account)) throw new ApiError("the_owner_stays", "The creator cannot be removed from their own topic.", 409);
      const names = this.d.members.ofAccount(account);
      if (!names.length) throw new ApiError("not_member", `${account} has nobody in this topic.`, 404);
      this.d.workspace?.revokeAccount(account);
      this.d.approvals.dropAccount(account);
      this.d.messages.dropAccountScreens(account);
      this.dropAccountSchedules(account);
      // The seats' handoffs go with their rows, in the same step: a seat that joins again later starts
      // without one. Only here and in accountGone; removing a computer lets its agents leave and keep theirs.
      this.d.handoffs.dropSeats(names.map((m) => m.name as string));
      this.d.members.drop(names.map((m) => m.name as string));
      this.releaseItems(names.map((m) => m.name as string), actor);
      // The frame comes first: a client acts on it at once, whatever the close handshake does.
      const frame = JSON.stringify({ type: "removed", account, by: actor.name });
      for (const m of names) {
        const n = m.name as string;
        for (const tag of [`h:${n}`, `a:${n}`, `host:${n}`]) {
          for (const ws of this.ctx.getWebSockets(tag)) {
            this.safeSend(ws, frame);
            try {
              ws.close(4004, "removed");
            } catch {}
          }
        }
      }
      this.broadcastMembers();
      return { roomId: r.id as string, account, removed: names.map((m) => m.name as string) };
    });
  }

  /**
   * The account was deleted: the person and every agent and daemon seat of theirs go from this topic, rows and
   * all, as when its creator asks them to leave; their messages and names stay. Connections get `removed` and 4004.
   */
  async accountGone(account: string): Promise<{ removed: string[] }> {
    this.d.workspace?.revokeAccount(account);
    this.d.approvals.dropAccount(account);
    this.d.room.dropAccountFailures(account);
    this.d.messages.dropAccountCache(account);
    this.d.messages.dropAccountScreens(account);
    this.d.members.dropAccountComputers(account);
    const names = this.d.members.ofAccount(account).map((m) => m.name as string);
    if (!names.length) return { removed: [] };
    this.dropAccountSchedules(account);
    // Handoffs with the rows, as in removeAccount.
    this.d.handoffs.dropSeats(names);
    this.d.members.drop(names);
    this.releaseItems(names, { name: "scorpio" });
    const frame = JSON.stringify({ type: "removed", account, by: "scorpio" });
    for (const n of names) {
      for (const tag of [`h:${n}`, `a:${n}`, `host:${n}`, `v:${n}`]) {
        for (const ws of this.ctx.getWebSockets(tag)) {
          this.safeSend(ws, frame);
          try {
            ws.close(4004, "account deleted");
          } catch {}
        }
      }
    }
    this.broadcastMembers();
    return { removed: names };
  }

  /**
   * A person removes a daemon seat of their own account: that computer's row goes, and the agents it carried leave, as
   * with /bye — their rows, tasks (released), role cards and handoffs stay, so the same name is taken over with /spawn
   * on another computer. Each one that was in the topic gets a leave line.
   */
  async removeOwnComputer(actor: Actor, name: string): Promise<Result<{ roomId: string; removed: string[]; left: string[] }>> {
    return this.wrap(() => {
      this.requireMember(actor);
      const r = this.room();
      if (actor.kind !== "human") throw new ApiError("forbidden", "Only the computer's account can remove it.", 403);
      const seat = this.memberRow(name);
      if (!seat || seat.kind !== "host" || seat.status !== "active") throw new ApiError("not_member", "That computer is not in this topic.", 404);
      if (seat.owner !== actor.account) throw new ApiError("forbidden", "Only the computer's account can remove it.", 403);
      if (seat.device_id) this.d.workspace?.revokeComputer(actor.account, String(seat.device_id));
      const agents = this.d.members.carried(actor.account, name);
      const names = agents.map((m) => m.name as string);
      this.d.members.blockComputer(name, actor.account, (seat.device_id as string | null) || null);
      this.d.approvals.dropHost(name);
      this.d.members.dropSeat(name);
      this.d.members.leaveCarried(actor.account, name, now());
      this.releaseItems([name, ...names], actor);
      const frame = JSON.stringify({ type: "removed", account: actor.account, by: actor.name });
      for (const n of [name, ...names]) {
        for (const tag of [`a:${n}`, `host:${n}`]) {
          for (const ws of this.ctx.getWebSockets(tag)) {
            this.safeSend(ws, frame);
            try { ws.close(4004, "computer removed"); } catch {}
          }
        }
      }
      for (const m of agents) if (m.status === "active") this.systemMessage("leave", m.name as string);
      this.broadcastMembers();
      return { roomId: r.id as string, removed: [name], left: names };
    });
  }

  /** Archive (read-only) or restore. Not a room message; browsers and daemons get a room frame. */
  async setArchived(actor: Actor, archived: boolean): Promise<Result<RoomInfo & { code: string | null }>> {
    return this.wrap(() => {
      this.requireOwner(actor, archived ? "archive the topic" : "restore the topic");
      this.d.room.setArchived(archived ? now() : null);
      if (archived) this.stopSchedules("archived");
      this.broadcastRoom(true);
      return this.memberRoomView();
    });
  }

  /**
   * The owner's plan archives or restores the room: archived with the reason when a Pro
   * lapsed; restored only while it is still archived for that reason (not if the owner archived it since).
   * Returns whether anything changed.
   */
  async planArchive(archived: boolean, reason: string): Promise<boolean> {
    const r = this.wrap(() => this.room());
    if ("err" in r) return false;
    const row = r.ok;
    if (!planArchiveChange(row, archived, reason)) return false;
    if (archived) {
      this.d.room.planArchive(now(), reason);
      this.stopSchedules("archived");
    } else {
      this.d.room.planRestore();
    }
    this.broadcastRoom(true);
    return true;
  }

  /** The retention clock archives a quiet topic: read-only like any archived topic, no room message. */
  archiveRoom(reason: "retention", at: number | null) {
    this.d.room.retentionArchive(at);
    this.stopSchedules("archived");
    this.broadcastRoom(true);
  }

  /** Mark inaccessible: the snapshot goes, pages hear it, every connection closes with 4010. */
  markDeleted(why: { by: string } | { reason: "retention" }): number {
    this.d.workspace?.revokeAll();
    const t = now();
    this.d.room.setDeleted(t);
    this.d.schedules.dropAll();
    this.dropSnapshot();
    const frame = JSON.stringify({ type: "deleted", ...why });
    for (const ws of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(ws).includes("browser")) this.safeSend(ws, frame);
      try {
        ws.close(4010, "room deleted");
      } catch {}
    }
    return t;
  }

  /** The owner's plan changed (or its limits did): read it again on the next message; schedules stop without Pro. */
  async planLapsed(): Promise<void> {
    this.d.quota.forgetPlan();
    const owner = await this.ownerLimits();
    if (owner.plan !== "pro" && owner.plan !== "self") this.stopSchedules("pro_expired");
  }
}
