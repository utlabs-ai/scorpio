// The members domain: the members and removed_computers tables, joins (agents, daemon seats, people on the web), role
// cards, display names, the read cursor (mark), takeover lookups and the members list as the API and frames give it.
// RoomDO holds it through RoomDO.membersOf(o) and keeps forwards under the old names (split by domain S7a). Presence
// writes its columns through setOnline, dropCarrier, writeWork, setCarried, setOffline and touch; the lifecycle
// operations (room/lifecycle.ts, S7b) through setLeft, setAccountLeft, drop, blockComputer, dropSeat and leaveCarried; a
// message send (room/messages.ts, S8a) reads them through sendRows and resets cached takeovers through takeoverChanged;
// the topic (room/room.ts, S8b) writes its creator's row through addOwner and reads them through accounts, activeCount
// and workingAgents; the public snapshot reads displayNames, schedules names, tasks activeNameSet, findCaseless and
// findCaselessName, handoffs ofAccount (S8d). Search reads display names through the member_names_v view.
//
// The takeover candidates and the renamed events are messages' reads, through deps; MEMBERS_WITH_HANDOFF_SQL joins
// handoffs' read-only view handoff_meta_v for the list.
import { isSpawnPerm, memberPermOf, type MemberPerm } from "../spawn-perm";
import { filterMembers, type MemberFilters } from "../member-filters";
import { ApiError, now } from "../util";
import { agentSeatsToRemove, mayEnter, personSlotAvailable } from "../room-membership";
import { takeoverFromCandidates } from "../takeover";
import { handoffMetaOf } from "../handoff";
import { membersFor } from "../member-visibility";
import { mayViewWorkspace } from "../workspace-access";
import { SEND_MEMBERS_SQL, hostOfflineSince } from "../host-offline";
import { safeSend, tx } from "./kernel";
import type { Actor, Result, Row } from "./kernel";
import type { Brief } from "../task-brief";
import type { IndexAccount } from "../room-index-fix";
import type { Member, Message, RoomInfo, SystemEvent } from "./types";

const ROLE_RE = /^[A-Za-z0-9_.-]{1,62}$/;
/** The agents a daemon seat carries or last carried (removing a computer). */
const CARRIED = "kind = 'agent' AND owner = ? AND (seat_id = ? OR host_id = ?)";
/** Every member with its handoff's columns from handoffs' view handoff_meta_v (never the body); a handoff whose seat is gone is never read. */
export const MEMBERS_WITH_HANDOFF_SQL =
  "SELECT m.*, h.size AS h_size, h.updated_at AS h_updated, h.computer AS h_computer FROM members m LEFT JOIN handoff_meta_v h ON h.name = m.name ORDER BY m.joined_at";

export interface MembersDeps {
  sql(): SqlStorage;
  ctx(): DurableObjectState;
  wrap<T>(fn: () => T): Result<T>;
  room(): Row;
  roomInfo(r?: Row): RoomInfo;
  checkCode(r: Row, code: string | undefined, account: string): void;
  lastSeq(): number;
  replay(sender: string, nonce: string | undefined): Record<string, unknown> | null;
  remember<T>(sender: string, nonce: string | undefined, result: T): T;
  yours(name: string): Brief[];
  systemMessage(type: "join" | "leave", name: string): void;
  insertMessage(m: { from: string; fromKind: string; text: string; event: SystemEvent }): Message;
  publicChanged(): void;
  broadcastMembers(): void;
  presence: { isOnline(name: string, kind: string, except?: WebSocket): boolean; workOf(r: Row, except?: WebSocket): string | null };
  messages: { takeoverCandidates(owner: string, role: string, afterSeq: number): Row[]; renamedEvents(): Row[] };
  handoffs: { dropSeats(names: string[]): void };
  tasks: { reassignEvictedSeats(seats: { name: string; owner: string }[]): boolean; todoChanged(): void };
}

export class Members {
  /** One bounded member-domain read for cold connection recovery, including removed-computer exclusions. */
  workspaceRecovery(): Row[] {
    return this.sql.exec(`SELECT m.* FROM members m WHERE m.status = 'active' AND m.kind IN ('human', 'host')
      AND (m.kind != 'host' OR NOT EXISTS (SELECT 1 FROM removed_computers r WHERE r.owner = m.owner AND (r.device_id = m.device_id OR r.name = m.name)))`).toArray();
  }
  /** Owner-scoped read-only view. Workspace never reads or writes the members tables itself. */
  workspaceComputers(actor: Actor): Row[] {
    const member = this.requireMember(actor);
    if (actor.kind !== "human" || actor.name !== actor.account || member.kind !== "human" || member.owner !== actor.account) {
      throw new ApiError("workspace_not_found", "Workspace not found.", 404);
    }
    return this.sql.exec(`SELECT m.* FROM members m WHERE m.kind = 'host' AND m.status = 'active' AND m.owner = ? AND m.device_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM removed_computers r WHERE r.owner = m.owner AND (r.device_id = m.device_id OR r.name = m.name))`, actor.account)
      .toArray().filter(host => mayViewWorkspace(actor, member, host, String(host.device_id), false));
  }
  dropAccountComputers(account: string): void {
    this.sql.exec("DELETE FROM removed_computers WHERE owner = ?", account);
  }

  constructor(private readonly d: MembersDeps) {}

  // Same names as RoomDO's: enterHuman is tested on a fake that has these (room-membership.test.mjs).
  private get sql() { return this.d.sql(); }
  private get ctx() { return this.d.ctx(); }
  private wrap<T>(fn: () => T): Result<T> { return this.d.wrap(fn); }
  private room() { return this.d.room(); }
  private roomInfo(r?: Row) { return this.d.roomInfo(r); }
  private checkCode(r: Row, code: string | undefined, account: string) { this.d.checkCode(r, code, account); }
  private lastSeq() { return this.d.lastSeq(); }
  private replay(sender: string, nonce: string | undefined) { return this.d.replay(sender, nonce); }
  private remember<T>(sender: string, nonce: string | undefined, result: T): T { return this.d.remember(sender, nonce, result); }
  private yours(name: string) { return this.d.yours(name); }
  private systemMessage(type: "join" | "leave", name: string) { this.d.systemMessage(type, name); }
  private insertMessage(m: { from: string; fromKind: string; text: string; event: SystemEvent }) { return this.d.insertMessage(m); }
  private publicChanged() { this.d.publicChanged(); }
  private broadcastMembers() { this.d.broadcastMembers(); }
  private isOnline(name: string, kind: string, except?: WebSocket) { return this.d.presence.isOnline(name, kind, except); }
  private workOf(r: Row, except?: WebSocket) { return this.d.presence.workOf(r, except); }

  static migrate(sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS members (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,                 -- human | agent | host
        owner TEXT NOT NULL,                -- account; the only input to wake-up decisions
        host_id TEXT,
        role_card TEXT,
        cursor INTEGER NOT NULL DEFAULT 0,  -- written only by mark
        last_active INTEGER,
        status TEXT NOT NULL DEFAULT 'active',  -- active | left (reserved: invited)
        runtime TEXT NOT NULL DEFAULT 'local',  -- reserved: local | cloud
        backing TEXT NOT NULL DEFAULT 'subscription', -- reserved: subscription | byok | metered
        seat_id TEXT,
        joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS removed_computers (
        name TEXT PRIMARY KEY, owner TEXT NOT NULL, device_id TEXT
      );
    `);
    // Hosts (daemon seats): when the last connection of a host closed; null while connected or never seen.
    const mcols = sql.exec("PRAGMA table_info(members)").toArray().map((c) => c.name);
    if (!mcols.includes("offline_since")) sql.exec("ALTER TABLE members ADD COLUMN offline_since INTEGER");
    // display_name: a person's display name, copied from D1 users when they set it or open the room; null = none.
    if (!mcols.includes("display_name")) sql.exec("ALTER TABLE members ADD COLUMN display_name TEXT");
    if (!mcols.includes("work")) sql.exec("ALTER TABLE members ADD COLUMN work TEXT"); // working | idle | blocked, from the daemon
    if (!mcols.includes("work_since")) {
      sql.exec("ALTER TABLE members ADD COLUMN work_since INTEGER"); // since when `work` has had its value
      sql.exec("ALTER TABLE members ADD COLUMN work_reason TEXT"); // blocked: what it is stopped at, from the daemon
      sql.exec("ALTER TABLE members ADD COLUMN idle_handoff INTEGER"); // host seats: that computer's idle_handoff_minutes
    }
    if (!mcols.includes("takeover_checked")) sql.exec("ALTER TABLE members ADD COLUMN takeover_checked INTEGER NOT NULL DEFAULT 0");
    if (!mcols.includes("takeover_command")) sql.exec("ALTER TABLE members ADD COLUMN takeover_command TEXT");
    if (!mcols.includes("takeover_seq")) sql.exec("ALTER TABLE members ADD COLUMN takeover_seq INTEGER");
    // Who last wrote an agent's role card and when: the agent itself, or its owner on the web.
    if (!mcols.includes("role_card_by")) {
      sql.exec("ALTER TABLE members ADD COLUMN role_card_by TEXT");
      sql.exec("ALTER TABLE members ADD COLUMN role_card_at INTEGER");
    }
    // An agent's lane (docs/api/topics.md "The lane"), who set it last (the agent itself, or its person on the web) and when.
    if (!mcols.includes("lane")) {
      sql.exec("ALTER TABLE members ADD COLUMN lane TEXT");
      sql.exec("ALTER TABLE members ADD COLUMN lane_by TEXT");
      sql.exec("ALTER TABLE members ADD COLUMN lane_at INTEGER");
    }
    if (!mcols.includes("device_id")) sql.exec("ALTER TABLE members ADD COLUMN device_id TEXT");
    if (!mcols.includes("device")) sql.exec("ALTER TABLE members ADD COLUMN device TEXT");
    if (!mcols.includes("clis")) sql.exec("ALTER TABLE members ADD COLUMN clis TEXT"); // host seats: the CLIs the daemon detected (JSON, ⑧)
    for (const col of ["perm_level", "perm_from", "perm_parent", "perms"]) {
      if (!mcols.includes(col)) sql.exec(`ALTER TABLE members ADD COLUMN ${col} TEXT`);
    }
    if (!mcols.includes("born_seq")) sql.exec("ALTER TABLE members ADD COLUMN born_seq INTEGER NOT NULL DEFAULT 0"); // new seats cannot reuse an evicted seat's takeover line
    const removedCols = sql.exec("PRAGMA table_info(removed_computers)").toArray().map((c) => c.name);
    if (!removedCols.includes("device_id")) sql.exec("ALTER TABLE removed_computers ADD COLUMN device_id TEXT");
  }

  /**
   * The takeover command an agent left when it handed over: the `/spawn` line for its role in the code
   * block of the newest message from its own account that holds one (by convention its own "takeover
   * command" message). Only its own account's messages count: the command is offered to its owner to
   * send, so nobody else gets to word it.
   */
  takeoverFor(name: string, owner: string): { command: string; seq: number } | null {
    const member = this.memberRow(name);
    if (!member) return null;
    if (member.takeover_checked) return member.takeover_command
      ? { command: member.takeover_command as string, seq: member.takeover_seq as number }
      : null;
    const role = name.slice(0, name.lastIndexOf("@"));
    const rows = this.d.messages.takeoverCandidates(owner, role, (member.born_seq as number) || 0);
    const result = takeoverFromCandidates(rows as { seq: number; text: string }[], name, owner, (candidate) => this.currentHost(candidate));
    this.sql.exec("UPDATE members SET takeover_checked = 1, takeover_command = ?, takeover_seq = ? WHERE name = ?", result?.command ?? null, result?.seq ?? null, name);
    return result;
  }

  memberRow(name: string): Row | undefined {
    return this.sql.exec("SELECT * FROM members WHERE name = ?", name).toArray()[0];
  }

  currentHost(name: string): string | null {
    const member = this.memberRow(name);
    if (member) return member.kind === "host" ? name : null;
    const rows = this.d.messages.renamedEvents();
    const moved = new Map<string, string>();
    for (const row of rows) {
      try {
        const event = JSON.parse(row.event as string);
        if (event.type === "renamed") moved.set(event.from, event.to);
      } catch {}
    }
    const seen = new Set<string>();
    let current = name;
    while (moved.has(current) && !seen.has(current)) {
      seen.add(current);
      current = moved.get(current)!;
    }
    return current !== name && this.memberRow(current)?.kind === "host" ? current : null;
  }

  requireMember(actor: Actor): Row {
    const r = this.room();
    const m = this.memberRow(actor.name);
    if (!m || m.status !== "active") {
      const role = actor.name.split("@")[0];
      throw new ApiError(
        "not_member",
        actor.kind === "agent"
          ? `${actor.name} is not in this topic. Join first: scorpio join roomId=${this.roomInfo().id} role=${role} roleCard='…' (add code=… if the topic has a passcode; resume=true if it was you before).`
          : r.public
            ? "You are viewing this topic. Press Join to take part."
            : "You are not in this topic. Open the topic link and enter the passcode.",
        403,
      );
    }
    return m;
  }

  /**
   * Who may read: a member, or in a public topic a signed-in person who has not joined, a viewer
   * (docs/api/topics.md): null for a viewer. Anyone else gets requireMember's not_member. Writes keep requireMember.
   */
  reader(actor: Actor): Row | null {
    const r = this.room();
    const m = this.memberRow(actor.name);
    if (m?.status === "active") return m;
    if (actor.kind === "human" && actor.name === actor.account && r.public) return null;
    return this.requireMember(actor);
  }

  touch(name: string) {
    this.sql.exec("UPDATE members SET last_active = ? WHERE name = ?", now(), name);
  }

  // A message send's read and write, at its points and with its SQL.

  /** Every member as a send reads them: who is mentioned, who wakes, how each delivery went. */
  sendRows(): Row[] {
    return this.sql.exec(SEND_MEMBERS_SQL).toArray();
  }

  /** A newer takeover line from this account supersedes a cached hit or miss for these roles. */
  takeoverChanged(account: string, roles: Set<string>) {
    for (const role of roles) {
      this.sql.exec("UPDATE members SET takeover_checked = 0, takeover_command = NULL, takeover_seq = NULL WHERE name = ? AND owner = ? AND status = 'left' AND takeover_checked = 1", `${role}@${account}`, account);
    }
  }

  // Presence's writes, at its points and with its SQL.

  /** Membership clocks for the bounded set of hosts with pending approval cards. */
  approvalHosts(names: string[]): Row[] {
    if (!names.length) return [];
    return this.sql.exec(`SELECT name, status, offline_since FROM members WHERE kind = 'host' AND name IN (${names.map(() => '?').join(',')})`, ...names).toArray();
  }

  /** A daemon seat connected: online again. */
  setOnline(host: string) {
    this.sql.exec("UPDATE members SET offline_since = NULL, last_active = ? WHERE name = ?", now(), host);
  }

  /** The agent's own wait took over from the daemon that carried it. */
  dropCarrier(name: string, host: string) {
    this.sql.exec("UPDATE members SET host_id = NULL WHERE name = ? AND host_id = ?", name, host);
  }

  writeWork(name: string, work: string | null, since: number | null, reason: string | null) {
    this.sql.exec("UPDATE members SET work = ?, work_since = ?, work_reason = ? WHERE name = ?", work, since, reason, name);
  }

  /** The agents this daemon seat carries now, and no others. */
  setCarried(host: string, names: string[]) {
    this.sql.exec("UPDATE members SET host_id = NULL WHERE host_id = ?", host);
    for (const name of names) this.sql.exec("UPDATE members SET host_id = ?, seat_id = ? WHERE name = ?", host, host, name);
  }

  /** Only presence calls this, after accepting the host carry for an active agent of its account. */
  writePerm(name: string, perm: MemberPerm | null) {
    this.sql.exec("UPDATE members SET perm_level = ?, perm_from = ?, perm_parent = ? WHERE name = ?", perm?.level ?? null, perm?.from ?? null, perm?.parent ?? null, name);
  }

  /** The seat's last connection closed. */
  setOffline(host: string, at: number) {
    this.sql.exec("UPDATE members SET offline_since = ? WHERE name = ?", at, host);
  }

  // The lifecycle operations' reads and writes (room/lifecycle.ts), at their points and with their SQL.

  /** One name leaves; its row stays to resume. */
  setLeft(name: string, at: number) {
    this.sql.exec("UPDATE members SET status = 'left', last_active = ? WHERE name = ?", at, name);
  }

  /** The account still has a person or an agent here (daemon seats do not count). */
  accountActive(account: string): boolean {
    return !!this.sql.exec("SELECT 1 FROM members WHERE owner = ? AND status = 'active' AND kind != 'host' LIMIT 1", account).toArray()[0];
  }

  /** The account's names still here, the person first. */
  activeNames(account: string): string[] {
    return this.sql.exec("SELECT name FROM members WHERE owner = ? AND status = 'active' ORDER BY kind = 'human' DESC, name", account).toArray().map((x) => x.name as string);
  }

  setAccountLeft(account: string, at: number) {
    this.sql.exec("UPDATE members SET status = 'left', last_active = ? WHERE owner = ? AND status = 'active'", at, account);
  }

  /** Every row of the account, left or not. */
  ofAccount(account: string): Row[] {
    return this.sql.exec("SELECT name, kind FROM members WHERE owner = ?", account).toArray();
  }

  drop(names: string[]) {
    this.sql.exec("DELETE FROM members WHERE name IN (SELECT value FROM json_each(?))", JSON.stringify(names));
  }

  carried(owner: string, seat: string): Row[] {
    return this.sql.exec(`SELECT name, status FROM members WHERE ${CARRIED}`, owner, seat, seat).toArray();
  }

  /** Join refuses this seat until its own device rejoins (rejoinComputer). */
  blockComputer(name: string, owner: string, deviceId: string | null) {
    this.sql.exec("INSERT OR IGNORE INTO removed_computers (name, owner, device_id) VALUES (?, ?, ?)", name, owner, deviceId);
  }

  dropSeat(name: string) {
    this.sql.exec("DELETE FROM members WHERE name = ?", name);
  }

  /** The seat's agents leave and keep their rows, so a takeover elsewhere continues them. */
  leaveCarried(owner: string, seat: string, at: number) {
    this.sql.exec(`UPDATE members SET status = 'left', host_id = NULL, last_active = ? WHERE ${CARRIED}`, at, owner, seat, seat);
  }

  // The topic's reads and write (room/room.ts), at their points and with their SQL.

  /** The creator's row, written with the topic's row when it is made (init). */
  addOwner(owner: string, at: number) {
    this.sql.exec(
      "INSERT INTO members (name, kind, owner, cursor, last_active, status, joined_at) VALUES (?, 'human', ?, 0, ?, 'active', ?)",
      owner,
      owner,
      at,
      at,
    );
  }

  /** Every account here: whether it still has a person or an agent in (daemon seats do not count), and a person (indexState). */
  accounts(): IndexAccount[] {
    return this.sql.exec(
      "SELECT owner AS account, MAX(status = 'active' AND kind != 'host') AS active, MAX(kind = 'human') AS human FROM members GROUP BY owner",
    ).toArray().map((x) => ({ account: x.account as string, active: !!x.active, human: !!x.human }));
  }

  /** How many people or agents are in the topic now (summary). */
  activeCount(kind: string): number {
    return this.sql.exec("SELECT COUNT(*) AS k FROM members WHERE kind = ? AND status = 'active'", kind).one().k as number;
  }

  /** The agents in the topic whose daemon last said working, whole rows: presence's workOf decides whether it still holds. */
  workingAgents(): Row[] {
    return this.sql.exec("SELECT * FROM members WHERE kind = 'agent' AND status = 'active' AND work = 'working'").toArray();
  }

  // Other domains' reads (S8d), at their points and with their SQL.

  /** People who set a display name (the public snapshot). */
  displayNames(): Row[] {
    return this.sql.exec("SELECT name, display_name FROM members WHERE kind = 'human' AND display_name IS NOT NULL").toArray();
  }

  /** Every name, left or not (a schedule's @names). */
  names(): string[] {
    return this.sql.exec("SELECT name FROM members").toArray().map((r) => r.name as string);
  }

  /** The names of the active members (tasks: an item under any other name is under someone who left). */
  activeNameSet(): Set<string> {
    return new Set(this.sql.exec("SELECT name FROM members WHERE status = 'active'").toArray().map((m) => m.name as string));
  }

  /** A member's row by name in any case (an item's assignee). */
  findCaseless(name: string): Row | undefined {
    return this.sql.exec("SELECT * FROM members WHERE lower(name) = lower(?)", name).toArray()[0];
  }

  /** A member's name in its own case, by name in any case (a task list's to=). */
  findCaselessName(name: string): Row | undefined {
    return this.sql.exec("SELECT name FROM members WHERE lower(name) = lower(?)", name).toArray()[0];
  }

  toMember(r: Row, except?: WebSocket): Member {
    const work = this.workOf(r, except);
    const hostRow = r.kind === "agent" && r.host_id ? this.memberRow(r.host_id as string) : undefined;
    return {
      name: r.name as string,
      kind: r.kind as string,
      owner: r.owner as string,
      displayName: r.kind === "human" ? ((r.display_name as string) || (r.name as string)) : null,
      roleCard: (r.role_card as string) ?? null,
      roleCardBy: (r.role_card_by as string) ?? null,
      roleCardAt: (r.role_card_at as number) ?? null,
      lane: (r.lane as string) ?? null,
      laneBy: (r.lane_by as string) ?? null,
      laneAt: (r.lane_at as number) ?? null,
      status: r.status as string,
      lastActive: (r.last_active as number) ?? null,
      online: this.isOnline(r.name as string, r.kind as string, except),
      cursor: (r.cursor as number) ?? 0,
      work,
      workSince: work ? ((r.work_since as number) ?? null) : null,
      workReason: work === "blocked" ? ((r.work_reason as string) ?? null) : null,
      host: hostRow ? (hostRow.name as string) : null,
      hostOfflineSince: hostOfflineSince(r, hostRow),
      idleHandoffMinutes: r.kind === "host" ? ((r.idle_handoff as number) ?? null) : null,
      device: r.kind === "host" && r.device ? JSON.parse(r.device as string) : null,
      clis: r.kind === "host" && r.clis ? JSON.parse(r.clis as string) : null,
      perm: r.kind === "agent" ? memberPermOf({ level: r.perm_level, from: r.perm_from, parent: r.perm_parent ?? null }) : null,
      perms: r.kind === "host" && r.perms ? JSON.parse(r.perms as string) : null,
      handoff: handoffMetaOf(r),
    };
  }

  /** The list joins handoffs' view handoff_meta_v for each seat's handoff (MEMBERS_WITH_HANDOFF_SQL), still one query. */
  allMembers(except?: WebSocket): Member[] {
    return this.sql
      .exec(MEMBERS_WITH_HANDOFF_SQL)
      .toArray()
      .map((r) => this.toMember(r, except));
  }

  renameHost(oldName: string, newName: string, deviceId: string, device: { name: string; hostname: string; note: string | null }): boolean {
    const old = this.memberRow(oldName);
    if (!old || old.kind !== "host") return false;
    if (oldName !== newName && this.memberRow(newName)) {
      throw new ApiError("name_taken", `${newName} is an agent's name in this topic. Rename this computer in Settings → Devices.`, 409);
    }
    const factsChanged = old.device !== JSON.stringify(device);
    if (oldName !== newName) {
      this.sql.exec("UPDATE members SET name = ?, device_id = ?, device = ? WHERE name = ?", newName, deviceId, JSON.stringify(device), oldName);
      this.sql.exec("UPDATE members SET host_id = ? WHERE host_id = ?", newName, oldName);
      this.sql.exec("UPDATE members SET seat_id = ? WHERE seat_id = ?", newName, oldName);
      this.sql.exec("UPDATE OR IGNORE removed_computers SET name = ? WHERE name = ? AND owner = ?", newName, oldName, old.owner);
      this.sql.exec("UPDATE members SET takeover_checked = 0, takeover_command = NULL, takeover_seq = NULL WHERE owner = ? AND status = 'left'", old.owner);
      this.insertMessage({ from: "system", fromKind: "system", text: `${oldName} is now ${newName}`, event: { type: "renamed", from: oldName, to: newName } });
    } else {
      this.sql.exec("UPDATE members SET device_id = ?, device = ? WHERE name = ?", deviceId, JSON.stringify(device), newName);
    }
    if (oldName !== newName || factsChanged) for (const ws of this.ctx.getWebSockets(`host:${oldName}`)) {
      try { ws.close(4002, "seat renamed"); } catch {}
    }
    return true;
  }

  async deviceChanged(account: string, deviceId: string, seat: string | null, oldSeat: string | null, device: { name: string; hostname: string; note: string | null }): Promise<Result<boolean>> {
    return this.wrap(() => {
      if (!seat) return false;
      const target = `${seat}@${account}`;
      if (oldSeat && oldSeat !== seat) this.sql.exec("UPDATE OR IGNORE removed_computers SET name = ?, device_id = COALESCE(device_id, ?) WHERE name = ? AND owner = ?", target, deviceId, `${oldSeat}@${account}`, account);
      const old = this.sql.exec("SELECT name FROM members WHERE kind = 'host' AND owner = ? AND device_id = ? LIMIT 1", account, deviceId).toArray()[0]?.name as string | undefined
        || (oldSeat ? this.memberRow(`${oldSeat}@${account}`)?.name as string | undefined : undefined);
      if (!old) return false;
      const changed = this.renameHost(old, target, deviceId, device);
      if (changed) this.broadcastMembers();
      return changed;
    });
  }

  /**
   * A computer of `account` logged out unexpectedly (docs/api/auth.md): one line where its daemon seat is active here,
   * waking nobody. Whether it wrote one.
   */
  async loggedOutLine(account: string, deviceId: string, device: string): Promise<Result<boolean>> {
    return this.wrap(() => {
      const seat = this.sql.exec("SELECT name FROM members WHERE kind = 'host' AND owner = ? AND device_id = ? AND status = 'active' LIMIT 1", account, deviceId).toArray()[0]?.name as string | undefined;
      if (!seat) return false;
      this.insertMessage({ from: "system", fromKind: "system", text: `${device} is logged out: its agents receive no messages`, event: { type: "logged_out", name: seat, device } });
      return true;
    });
  }

  /** A person enters the room from the web (passcode unless owner or already a member), with their display name. */
  async enterHuman(actor: Actor, code?: string, displayName: string | null = null): Promise<Result<{ room: RoomInfo }>> {
    return this.wrap(() => {
      const r = this.room();
      const m = this.memberRow(actor.name);
      const known = m?.status !== "active" && actor.account !== r.owner && this.accountKnown(actor.account);
      const route = mayEnter(r, m, actor, known);
      if (route === "already") return { room: this.roomInfo(r) };
      if (route === "needsCode") this.checkCode(r, code, actor.account);
      if (!personSlotAvailable(this.activeCount("human"))) {
        throw new ApiError("person_limit", "A topic holds 20 people. Wait for someone to leave, or ask the creator to remove someone.", 409);
      }
      const t = now();
      // Someone coming back (they left) reads on from the latest message, not from where they stopped.
      if (m) this.sql.exec("UPDATE members SET status = 'active', last_active = ?, display_name = ?, cursor = ? WHERE name = ?", t, displayName, this.lastSeq(), actor.name);
      else
        this.sql.exec(
          "INSERT INTO members (name, kind, owner, display_name, cursor, last_active, status, joined_at) VALUES (?, 'human', ?, ?, ?, ?, 'active', ?)",
          actor.name,
          actor.account,
          displayName,
          this.lastSeq(),
          t,
          t,
        );
      this.systemMessage("join", actor.name);
      this.broadcastMembers();
      return { room: this.roomInfo(r) };
    });
  }

  /**
   * A person's display name changed (they set it, or the room had an old one when they opened it): members see
   * it at once and a public room's snapshot shows it. Whether this room had a different one.
   */
  async setDisplayName(account: string, displayName: string | null): Promise<boolean> {
    const changed = this.sql.exec("UPDATE members SET display_name = ? WHERE name = ? AND kind = 'human' AND display_name IS NOT ?", displayName, account, displayName).rowsWritten > 0;
    if (changed) {
      this.broadcastMembers();
      this.publicChanged();
    }
    return changed;
  }

  /**
   * The account has someone here now, so it has shown the passcode. Only names still here count: once a person left
   * (and their agents with them), coming back to a private topic needs the passcode again.
   */
  accountKnown(account: string): boolean {
    return !!this.sql.exec("SELECT 1 FROM members WHERE owner = ? AND status = 'active' LIMIT 1", account).toArray()[0];
  }

  /** Called with the seat name derived from this computer's authenticated device, never a caller supplied name. */
  async rejoinComputer(actor: Actor, name: string, deviceId = "", legacyName = name): Promise<Result<{ roomId: string; name: string; rejoined: boolean }>> {
    return this.wrap(() => {
      const r = this.room();
      if (actor.account !== name.split("@").slice(1).join("@") || actor.name !== name) {
        throw new ApiError("forbidden", "Only this computer can add itself back.", 403);
      }
      const gone = this.sql.exec("DELETE FROM removed_computers WHERE owner = ? AND (device_id = ? OR name = ? OR name = ?)", actor.account, deviceId, name, legacyName);
      return { roomId: r.id as string, name, rejoined: !!gone.rowsWritten };
    });
  }

  async join(
    actor: Actor,
    p: {
      role: string;
      ownerDisplayName?: string | null;
      roleCard?: string;
      lane?: string | null; // null or absent leaves the lane as it is (laneOf)
      resume?: boolean;
      code?: string;
      runtime?: string;
      backing?: string;
      nonce?: string;
      host?: boolean;
      seat?: string;
      deviceId?: string;
      device?: { name: string; hostname: string; note: string | null };
      legacySeat?: string;
      perms?: unknown;
      idleHandoffMinutes?: number | null;
      clis?: { kind: string; installed: boolean; version: string | null; at: number }[] | null;
    },
  ): Promise<Result<Record<string, unknown>>> {
    return this.wrap(() => {
      const r = this.room();
      if (this.sql.exec("SELECT 1 FROM removed_computers WHERE owner = ? AND (device_id = ? OR name = ? OR name = ?)", actor.account, p.deviceId || "", p.seat || "", p.legacySeat || "").toArray().length) {
        throw new ApiError("computer_removed", `This computer was removed from this topic. On that computer, run scorpio daemon rejoin=${r.id} to add it back.`, 403);
      }
      const again = this.replay(actor.name, p.nonce);
      // A cached join is not membership: a left or removed seat must really join again.
      if (again && this.memberRow(actor.name)?.status === "active") return again;
      if (!ROLE_RE.test(p.role)) {
        throw new ApiError("invalid_role", "role must be 1–62 characters of letters, digits, _ . - (for example role=api).");
      }
      // daemon, daemon-2, … are the daemon's seats (assigned per device by the Worker); daemon.* is the
      // old naming. Agents cannot take any of them.
      const reserved = /^daemon(-\d+)?$/.test(p.role) || p.role.startsWith("daemon.") || p.role.endsWith("-daemon");
      if (!p.host && reserved && this.memberRow(actor.name)?.kind !== "agent") {
        throw new ApiError("reserved_name", "That name is reserved for the Scorpio daemon. Pick another role.");
      }
      const kind = p.host ? "host" : "agent";
      const runtime = p.runtime || "local";
      const backing = p.backing || "subscription";
      if (backing === "subscription" && runtime !== "local") {
        throw new ApiError("invalid_backing", "A subscription-backed agent can only run on its owner's computer (runtime=local).");
      }
      const name = actor.name;
      const before = this.memberRow(name);
      // Check access before a host join can rename an old row or write a system line.
      if (before?.status !== "active" && actor.account !== r.owner && !this.accountKnown(actor.account)) this.checkCode(r, p.code, actor.account);
      if (p.host && p.deviceId && p.device) {
        const old = this.sql.exec("SELECT name FROM members WHERE kind = 'host' AND owner = ? AND device_id = ? LIMIT 1", actor.account, p.deviceId).toArray()[0]?.name as string | undefined
          || (p.legacySeat && this.memberRow(p.legacySeat)?.kind === "host" ? p.legacySeat : undefined);
        if (old) this.renameHost(old, name, p.deviceId, p.device);
      }
      const existing = this.memberRow(name);
      if (existing && existing.kind !== (p.host ? "host" : "agent")) {
        throw new ApiError("name_taken", `${name} is already another kind of seat in this topic. Pick another name.`, 409);
      }
      if (p.host && existing?.device_id && existing.device_id !== p.deviceId) {
        throw new ApiError("name_taken", `${name} belongs to another computer in this topic. Rename this computer in Settings → Devices.`, 409);
      }
      // The passcode is waived for a name still here (reconnecting), the creator's account, and an account with someone
      // still here. An agent that left on its own while its person stayed comes back free; once the whole account left,
      // a private topic wants the passcode again, even to resume.
      if (existing && existing.status === "active" && !p.resume) {
        throw new ApiError(
          "name_taken",
          `${name} is already in this topic. If that is you reconnecting, rerun with resume=true; otherwise pick another role.`,
          409,
        );
      }
      if (!p.host && !existing) {
        const counts = this.sql.exec(
          "SELECT COUNT(*) AS total, SUM(status = 'left') AS left_count FROM members WHERE kind = 'agent'",
        ).one();
        const needed = agentSeatsToRemove(counts.total as number, (counts.left_count as number | null) ?? 0);
        if (needed === null) {
          throw new ApiError("agent_limit", "This topic already has 100 agent seats, all in use. Reuse an existing name, or let one agent leave first.", 409);
        }
        if (needed) {
          const seats = this.sql.exec(
            `SELECT name, owner FROM members WHERE kind = 'agent' AND status = 'left'
             ORDER BY owner != ?, last_active, name LIMIT ?`,
            actor.account, needed,
          ).toArray().map((row) => ({ name: row.name as string, owner: row.owner as string }));
          const names = seats.map((seat) => seat.name);
          let reassigned = false;
          tx(this.ctx, () => {
            reassigned = this.d.tasks.reassignEvictedSeats(seats);
            this.d.handoffs.dropSeats(names);
            this.sql.exec("DELETE FROM members WHERE name IN (SELECT value FROM json_each(?))", JSON.stringify(names));
          });
          if (reassigned) this.d.tasks.todoChanged();
        }
      }
      const t = now();
      let announce = false;
      if (existing) {
        announce = existing.status !== "active";
        this.sql.exec(
          // A role card given with the join is the agent's own words (role_card_by); without one the card stays as it was.
          // The lane the same way: given, it is the agent's (lane_by); absent, the seat keeps the lane it has.
          `UPDATE members SET status = 'active', kind = ?1, role_card = COALESCE(?2, role_card), seat_id = ?7,
             role_card_by = CASE WHEN ?2 IS NULL THEN role_card_by ELSE ?6 END, role_card_at = CASE WHEN ?2 IS NULL THEN role_card_at ELSE ?3 END,
             lane = COALESCE(?10, lane), lane_by = CASE WHEN ?10 IS NULL THEN lane_by ELSE ?6 END, lane_at = CASE WHEN ?10 IS NULL THEN lane_at ELSE ?3 END,
             last_active = ?3, runtime = ?4, backing = ?5, takeover_checked = 0, takeover_command = NULL, takeover_seq = NULL,
             device_id = COALESCE(?8, device_id), device = COALESCE(?9, device) WHERE name = ?6`,
          kind,
          p.roleCard ? p.roleCard : null,
          t,
          runtime,
          backing,
          name,
          p.seat || null,
          p.host ? p.deviceId || null : null,
          p.host && p.device ? JSON.stringify(p.device) : null,
          p.lane ?? null,
        );
      } else {
        announce = true;
        this.sql.exec(
          `INSERT INTO members (name, kind, owner, role_card, role_card_by, role_card_at, lane, lane_by, lane_at, cursor, born_seq, last_active, status, runtime, backing, joined_at, seat_id, device_id, device)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
          name,
          kind,
          actor.account,
          p.roleCard || "",
          p.roleCard ? name : null,
          p.roleCard ? t : null,
          p.lane ?? null,
          p.lane ? name : null,
          p.lane ? t : null,
          this.lastSeq(),
          this.lastSeq(),
          t,
          runtime,
          backing,
          t,
          p.seat || null,
          p.host ? p.deviceId || null : null,
          p.host && p.device ? JSON.stringify(p.device) : null,
        );
      }
      if (announce) this.systemMessage("join", name);
      // A seat reports its computer's idle handoff setting on every join; shown here, changed only there.
      if (p.host && p.idleHandoffMinutes != null) this.sql.exec("UPDATE members SET idle_handoff = ? WHERE name = ?", p.idleHandoffMinutes, name);
      // ... and the agent CLIs it detected; none sent keeps what is there.
      if (p.host && p.clis) this.sql.exec("UPDATE members SET clis = ? WHERE name = ?", JSON.stringify(p.clis), name);
      if (p.host) this.sql.exec("UPDATE members SET perms = ? WHERE name = ?", Array.isArray(p.perms) ? JSON.stringify([...new Set(p.perms.filter(isSpawnPerm))]) : null, name);
      if (p.host && p.device) {
        // The old seat of this same computer (daemon.<machine>@account) gives way to the new one.
        const old = `daemon.${p.device.hostname}@${actor.account}`;
        const legacy = this.memberRow(old);
        if (old !== name && legacy && legacy.status === "active") {
          this.sql.exec("UPDATE members SET status = 'left', last_active = ? WHERE name = ?", now(), old);
          this.sql.exec("UPDATE members SET host_id = NULL WHERE host_id = ?", old);
          for (const w of this.ctx.getWebSockets(`host:${old}`)) {
            try {
              w.close(4002, "seat renamed");
            } catch {}
          }
          this.systemMessage("leave", old);
        }
      }
      this.broadcastMembers();
      const m = this.memberRow(name)!;
      const info = this.roomInfo(r);
      return this.remember(actor.name, p.nonce, {
        roomId: info.id,
        roomName: info.name,
        topic: info.topic,
        owner: info.owner,
        ownerDisplayName: p.ownerDisplayName ?? null,
        name,
        kind: m.kind,
        cursor: m.cursor,
        roleCard: m.role_card,
        lane: (m.lane as string) ?? null,
        resources: [],
        // How messages reach it is the CLI's part (its registration); the server names the owner (CLI 0.5.3).
        mine: this.yours(name),
        next: `Your owner is ${actor.account}${p.ownerDisplayName && p.ownerDisplayName !== actor.account ? ` (nickname: ${p.ownerDisplayName.replace(/[\x00-\x1f\x7f-\x9f|]+/g, " ").trim()})` : ""}. Read recent history (scorpio messages roomId=${info.id}), mark the latest seq, and report in to @${actor.account} with send.`,
      });
    });
  }

  async mark(actor: Actor, upTo: number): Promise<Result<{ roomId: string; name: string; cursor: number }>> {
    return this.wrap(() => {
      const m = this.requireMember(actor);
      if (!Number.isFinite(upTo) || upTo < 0) throw new ApiError("bad_request", "upTo=<seq> is required.");
      const target = Math.min(Math.floor(upTo), this.lastSeq());
      const cursor = Math.max(m.cursor as number, target);
      this.sql.exec("UPDATE members SET cursor = ?, last_active = ? WHERE name = ?", cursor, now(), actor.name);
      if (cursor !== m.cursor) {
        const frame = JSON.stringify({ type: "cursor", name: actor.name, cursor });
        for (const ws of this.ctx.getWebSockets("browser")) {
          if (!(ws.deserializeAttachment() as { viewer?: boolean } | null)?.viewer) {
            safeSend(ws, frame);
          }
        }
      }
      return { roomId: this.roomInfo().id, name: actor.name, cursor };
    });
  }

  async members(actor: Actor, p: MemberFilters = {}): Promise<Result<{ roomId: string; members: Member[] }>> {
    return this.wrap(() => {
      this.requireMember(actor);
      return { roomId: this.roomInfo().id, members: filterMembers(membersFor(this.allMembers(), actor.account), p, actor.account) };
    });
  }

  /** The export's member list (room/export.ts): every member, present or left, as GET /members shows them to this actor. */
  exportMembers(actor: Actor): Member[] {
    this.requireMember(actor);
    return membersFor(this.allMembers(), actor.account);
  }

  async setRoleCard(actor: Actor, roleCard: string): Promise<Result<{ roomId: string; name: string; roleCard: string }>> {
    return this.wrap(() => {
      this.requireMember(actor);
      if (!roleCard.trim()) throw new ApiError("bad_request", "roleCard is empty.");
      const t = now();
      // Cleaned and cut by the Worker (cleanCut); the answer is the card as stored.
      this.sql.exec("UPDATE members SET role_card = ?1, role_card_by = ?3, role_card_at = ?2, last_active = ?2 WHERE name = ?3", roleCard, t, actor.name);
      this.broadcastMembers();
      return { roomId: this.roomInfo().id, name: actor.name, roleCard };
    });
  }

  /**
   * A person rewrites the role card of one of their own agents on the web. Only the agent's
   * owner may: the room's owner cannot change the card of an agent someone else brought in. Not a message and not
   * the agent's activity; the agent learns of it from its next delivery (roleCardBy names the person).
   */
  async setRoleCardFor(
    actor: Actor,
    target: string,
    roleCard: string,
  ): Promise<Result<{ roomId: string; name: string; roleCard: string; roleCardBy: string; roleCardAt: number }>> {
    return this.wrap(() => {
      this.requireMember(actor);
      const m = this.memberRow(target);
      if (!m || m.kind !== "agent") throw new ApiError("bad_request", `${target || "name="} is not an agent in this topic. name= takes an agent's full name, e.g. impl@kai.`);
      if (m.owner !== actor.account) {
        throw new ApiError("forbidden", `Only ${m.owner as string}, whose agent ${target} is, can change its role card.`, 403);
      }
      if (m.status !== "active") throw new ApiError("bad_request", `${target} has left this topic; its role card is written when it joins again.`);
      if (!roleCard) throw new ApiError("bad_request", "The role card is empty. Write what this agent does here.");
      const t = now();
      this.sql.exec("UPDATE members SET role_card = ?, role_card_by = ?, role_card_at = ? WHERE name = ?", roleCard, actor.name, t, target);
      this.broadcastMembers();
      return { roomId: this.roomInfo().id, name: target, roleCard, roleCardBy: actor.name, roleCardAt: t };
    });
  }

  /** An agent sets its own lane (docs/api/topics.md "The lane"); null clears it. Not a message; wakes nobody. */
  async setLane(actor: Actor, lane: string | null): Promise<Result<LaneAnswer>> {
    return this.wrap(() => {
      this.requireMember(actor);
      const t = now();
      this.sql.exec("UPDATE members SET lane = ?1, lane_by = ?3, lane_at = ?2, last_active = ?2 WHERE name = ?3", lane, t, actor.name);
      this.broadcastMembers();
      return { roomId: this.roomInfo().id, name: actor.name, lane, laneBy: actor.name, laneAt: t };
    });
  }

  /**
   * A person sets the lane of one of their own agents on the web. Unlike the role card, an agent that has left is
   * allowed: it stays on the overview for 7 days and its person should be able to place it (a join without `lane`
   * leaves the lane alone, so nothing overwrites this). Not the agent's activity: last_active stays.
   */
  async setLaneFor(actor: Actor, target: string, lane: string | null): Promise<Result<LaneAnswer>> {
    return this.wrap(() => {
      this.requireMember(actor);
      const m = this.memberRow(target);
      if (!m || m.kind !== "agent") throw new ApiError("bad_request", `${target || "name="} is not an agent in this topic. name= takes an agent's full name, e.g. impl@kai.`);
      if (m.owner !== actor.account) {
        throw new ApiError("forbidden", `Only ${m.owner as string}, whose agent ${target} is, can change its lane.`, 403);
      }
      const t = now();
      this.sql.exec("UPDATE members SET lane = ?, lane_by = ?, lane_at = ? WHERE name = ?", lane, actor.name, t, target);
      this.broadcastMembers();
      return { roomId: this.roomInfo().id, name: target, lane, laneBy: actor.name, laneAt: t };
    });
  }
}

/** What setting a lane answers (docs/api/topics.md "The lane"). */
export type LaneAnswer = { roomId: string; name: string; lane: string | null; laneBy: string; laneAt: number };
