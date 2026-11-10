import { ApiError, now } from "../util";
import { mentionTokens } from "../mentions";
import { nextScheduleAt, reviveCommand, scheduleRule, scheduleRuleText, type Rule } from "../schedules";
import { toBrowsers, tx, wrap } from "./kernel";
import type { Actor, Result, Row } from "./kernel";
import type { Limits, Plan } from "../plans";
import type { ScheduleOp, SendOp, SystemEvent } from "./types";
import type { CalendarItem, CalendarTopic } from "../calendar";

export interface SchedulesDeps {
  sql(): SqlStorage;
  ctx(): DurableObjectState;
  room: { require(): Row; requireWritable(): void };
  members: {
    get(name: string): Row | undefined;
    require(actor: Actor): Row;
    takeoverFor(name: string, owner: string): { command: string; seq: number } | null;
    names(): string[];
  };
  messages: {
    insert(m: { from: string; fromKind: string; text: string; event: SystemEvent }): unknown;
    send(actor: Actor, p: SendOp, owner: { plan: Plan; limits: Limits }, scheduled: { id: string; by: string; at: number }): Record<string, unknown>;
  };
  quota: { ownerLimits(): Promise<{ plan: Plan; limits: Limits }>; cachedPlan(): Plan | undefined };
  alarm: { arm(): Promise<void> }; // brings the room's one alarm forward to the earliest due time of all its timers, nextDue() here included
  nonces: {
    replay(sender: string, nonce: string | undefined): Record<string, unknown> | null;
    remember<T>(sender: string, nonce: string | undefined, result: T): T;
  };
}

export class Schedules {
  constructor(private readonly d: SchedulesDeps) {}

  static migrate(sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        n INTEGER PRIMARY KEY AUTOINCREMENT, by TEXT NOT NULL, by_account TEXT NOT NULL,
        text TEXT NOT NULL, to_names TEXT NOT NULL, rule TEXT NOT NULL,
        revive INTEGER NOT NULL DEFAULT 1, revive_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, next_at INTEGER,
        last_at INTEGER, last_seq INTEGER, last_error TEXT,
        stopped_by TEXT, stopped_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_at);
    `);
    // calendar: listed in the calendar feed of each person the text @s (docs/api/schedules.md, Into a calendar); off by default.
    const cols = sql.exec("PRAGMA table_info(schedules)").toArray().map((c) => c.name);
    if (!cols.includes("calendar")) sql.exec("ALTER TABLE schedules ADD COLUMN calendar INTEGER NOT NULL DEFAULT 0");
  }

  dropAll() {
    this.d.sql().exec("DELETE FROM schedules");
  }

  async alarm(t: number) {
    const retry = this.d.ctx().storage.kv.get<number>("scheduleRetryDue");
    if (retry == null || retry <= t) {
      if (retry != null) this.d.ctx().storage.kv.delete("scheduleRetryDue");
      const due = this.d.sql().exec("SELECT * FROM schedules WHERE enabled = 1 AND next_at <= ? ORDER BY next_at, n", t).toArray();
      for (const row of due) {
        try { await this.fire(row, row.next_at as number); }
        catch (e) { this.d.ctx().storage.kv.put("scheduleRetryDue", now() + 60_000); console.error(JSON.stringify({ msg: "schedule alarm failed", id: `S${row.n}`, error: String(e) })); }
      }
    }
  }

  nextDue(): number {
    return Math.max(this.scheduleDue(), this.d.ctx().storage.kv.get<number>("scheduleRetryDue") ?? -Infinity);
  }

  // ---------- scheduled messages (docs/api/schedules.md) ----------

  scheduleCount(): number {
    return this.d.sql().exec("SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1").one().n as number;
  }

  private scheduleDue(): number {
    return (this.d.sql().exec("SELECT MIN(next_at) AS at FROM schedules WHERE enabled = 1").one().at as number | null) ?? Infinity;
  }

  private schedulesChanged(plan?: Plan) {
    const frame = JSON.stringify({ type: "schedules", count: this.scheduleCount(), proRequired: !["pro", "self"].includes(plan ?? this.d.quota.cachedPlan() ?? "free") });
    toBrowsers(this.d.ctx(), frame);
  }

  private scheduleNames(text: string): string[] {
    const members = this.d.members.names();
    const lower = new Map(members.map((n) => [n.toLowerCase(), n]));
    const names: string[] = [];
    for (const token of mentionTokens(text)) {
      let tok = token;
      let name = lower.get(tok.toLowerCase());
      while (!name && /[.-]$/.test(tok)) { tok = tok.slice(0, -1); name = lower.get(tok.toLowerCase()); }
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  scheduleText(text: unknown, actor: Actor): { text: string; to: string[] } {
    if (typeof text !== "string" || !text.trim()) throw new ApiError("bad_request", "Give the message text.");
    if (text.length > 9_000) throw new ApiError("text_too_long", "A scheduled message holds at most 9000 characters.", 413);
    const to = this.scheduleNames(text);
    if (actor.kind === "agent" && !mentionTokens(text).length) throw new ApiError("agent_must_mention", "An agent's message must @ someone by full name; only people can post without an @.");
    return { text: text.replace(/\r\n/g, "\n"), to };
  }

  private reviveName(to: string[], account: string): string | null {
    return to.find((name) => { const m = this.d.members.get(name); return m?.kind === "agent" && m.owner === account; }) ?? null;
  }

  private reviveHost(row: Row): string | null {
    const name = row.revive_name as string | null;
    if (!name) return null;
    const m = this.d.members.get(name);
    if (!m) return null;
    if (m.status === "active") return (m.host_id as string | null) ?? null;
    const line = this.d.members.takeoverFor(name, row.by_account as string)?.command;
    const host = line ? reviveCommand(line, row.text as string)?.host : null;
    const hostRow = host ? this.d.members.get(host) : null;
    return hostRow?.kind === "host" && hostRow.status === "active" ? host ?? null : null;
  }

  private scheduleView(row: Row, actor: Actor) {
    const byAccount = row.by_account as string;
    return {
      id: `S${row.n}`, by: row.by as string, byAccount,
      text: row.text as string, to: JSON.parse(row.to_names as string) as string[], rule: JSON.parse(row.rule as string) as Rule,
      revive: !!row.revive, reviveName: (row.revive_name as string | null) ?? null, reviveHost: this.reviveHost(row),
      calendar: !!row.calendar,
      on: !!row.enabled, nextAt: (row.next_at as number | null) ?? null,
      lastAt: (row.last_at as number | null) ?? null, lastSeq: (row.last_seq as number | null) ?? null,
      lastError: (row.last_error as string | null) ?? null, stoppedBy: (row.stopped_by as string | null) ?? null,
      stoppedReason: (row.stopped_reason as string | null) ?? null,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number,
      canEdit: actor.account === byAccount, canStop: actor.account === byAccount || actor.account === this.d.room.require().owner,
    };
  }

  private scheduleRow(id: unknown): Row {
    const m = /^S?([1-9]\d*)$/i.exec(String(id ?? ""));
    const row = m ? this.d.sql().exec("SELECT * FROM schedules WHERE n = ?", Number(m[1])).toArray()[0] : undefined;
    if (!row) throw new ApiError("schedule_not_found", "There is no such schedule in this topic.", 404);
    return row;
  }

  private scheduleCaller(actor: Actor) {
    const member = this.d.members.require(actor);
    if (member.kind === "host") throw new ApiError("forbidden", "A computer seat cannot schedule a message.", 403);
  }

  private schedulePermission(actor: Actor, row: Row, edit = false) {
    if (actor.account !== row.by_account && (edit || actor.account !== this.d.room.require().owner)) {
      throw new ApiError("forbidden", "Only the account that set it can edit it; the topic owner can stop, delete or send it now.", 403);
    }
  }

  private schedulePlan(owner: { plan: Plan }) {
    if (owner.plan === "pro" || owner.plan === "self") return;
    throw new ApiError("pro_required", `Scheduling is a Pro feature of the topic owner's plan (${this.d.room.require().owner}); tell your owner.`, 403);
  }

  private scheduleWarning(row: Row): { warn: string; warnCode: string } | {} {
    const name = row.revive_name as string | null;
    const member = name ? this.d.members.get(name) : null;
    if (row.revive && member?.status === "left" && !this.reviveHost(row)) {
      return { warnCode: "no_takeover", warn: `${name} has left and has no takeover command yet.` };
    }
    const rule = JSON.parse(row.rule as string) as Rule;
    if (rule.kind === "every") {
      for (const to of JSON.parse(row.to_names as string) as string[]) {
        const agent = this.d.members.get(to);
        if (agent?.kind !== "agent" || agent.owner !== row.by_account || agent.status !== "active" || !agent.host_id) continue;
        const host = this.d.members.get(agent.host_id as string);
        if (!host || host.kind !== "host" || host.status !== "active") continue;
        const idle = (host?.idle_handoff as number | null) ?? 60;
        const computer = host.device ? (JSON.parse(host.device as string) as { name?: string }).name || host.name : host.name;
        if (idle > 0 && rule.minutes < idle) return { warnCode: "keeps_awake", warn: `${to} is reached every ${rule.minutes} minutes on ${computer}; it keeps the same session, which usually costs more tokens.` };
      }
    }
    return {};
  }

  private calendarFlag(value: unknown) {
    if (value !== undefined && typeof value !== "boolean") throw new ApiError("bad_request", "calendar must be true or false.");
  }

  /**
   * The person's calendar feed (docs/api/schedules.md, Into a calendar) asks each topic: the schedules that are on,
   * marked `calendar`, and @ this person (their account name; their agents are not them). Only the filter happens here:
   * the Worker expands runs. Someone who is not an active member here, or an archived topic, gets `not_member`.
   */
  calendarItems(handle: string): Result<CalendarTopic> {
    return wrap(() => {
      const r = this.d.room.require();
      const me = this.d.members.get(handle);
      if (!me || me.kind !== "human" || me.status !== "active" || r.archived_at != null) throw new ApiError("not_member", "Not a member of this topic.", 403);
      const rows = this.d.sql().exec("SELECT n, text, rule, by, updated_at, next_at, to_names FROM schedules WHERE enabled = 1 AND calendar = 1 ORDER BY n").toArray();
      const items: CalendarItem[] = [];
      for (const row of rows) {
        if (!(JSON.parse(row.to_names as string) as string[]).includes(handle)) continue;
        items.push({ id: `S${row.n}`, text: row.text as string, rule: JSON.parse(row.rule as string) as Rule, by: row.by as string, updatedAt: row.updated_at as number, nextAt: (row.next_at as number | null) ?? null });
      }
      return { roomId: r.id as string, name: r.name as string, items };
    });
  }

  async schedules(actor: Actor, id?: string): Promise<Result<Record<string, unknown>>> {
    let owner: { plan: Plan; limits: Limits };
    try { owner = await this.d.quota.ownerLimits(); } catch (e) { return wrap(() => { throw e; }); }
    return wrap(() => {
      this.scheduleCaller(actor);
      const roomId = this.d.room.require().id as string;
      if (id) return { roomId, item: this.scheduleView(this.scheduleRow(id), actor) };
      return { roomId, items: this.items(actor), count: this.scheduleCount(), proRequired: owner.plan !== "pro" && owner.plan !== "self" };
    });
  }

  /** Every schedule as GET /schedules lists them (the export reads them too, room/export.ts): on ones first, by next firing. */
  items(actor: Actor): Record<string, unknown>[] {
    const rows = this.d.sql().exec("SELECT * FROM schedules ORDER BY enabled DESC, CASE WHEN enabled = 1 THEN next_at END, n").toArray();
    return rows.map((r) => this.scheduleView(r, actor));
  }

  async scheduleOp(actor: Actor, p: ScheduleOp): Promise<Result<Record<string, unknown>>> {
    let owner: { plan: Plan; limits: Limits };
    try { owner = await this.d.quota.ownerLimits(); } catch (e) { return wrap(() => { throw e; }); }
    const result = wrap(() => {
      this.d.room.require();
      this.d.room.requireWritable();
      this.scheduleCaller(actor);
      const roomId = this.d.room.require().id as string;
      const op = p.op;
      const nonceSender = `schedule:${op}:${actor.name}`;
      if (op === "add" || op === "send") {
        const replayed = this.d.nonces.replay(nonceSender, p.nonce);
        if (replayed) return replayed;
      }
      const row = op === "add" || op === "stop_all" ? null : this.scheduleRow(p.id);
      if (row) this.schedulePermission(actor, row, op === "edit");
      if (op === "add" || op === "edit" || op === "on" || op === "send") this.schedulePlan(owner);
      if (p.files !== undefined) throw new ApiError("schedule_no_files", "A scheduled message takes no files: send the file into the topic first and write its #seq in the text.");
      const t = now();
      if (op === "add") {
        const { text, to } = this.scheduleText(p.text, actor);
        const rule = scheduleRule(p.rule, t);
        if (p.revive !== undefined && typeof p.revive !== "boolean") throw new ApiError("bad_request", "revive must be true or false.");
        this.calendarFlag(p.calendar);
        const next = nextScheduleAt(rule, t);
        const out = tx(this.d.ctx(), () => {
          this.d.sql().exec(`INSERT INTO schedules (by, by_account, text, to_names, rule, revive, revive_name, calendar, next_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, actor.name, actor.account, text, JSON.stringify(to), JSON.stringify(rule), p.revive === false ? 0 : 1, this.reviveName(to, actor.account), p.calendar === true ? 1 : 0, next, t, t);
          const made = this.d.sql().exec("SELECT * FROM schedules ORDER BY n DESC LIMIT 1").one();
          const id = `S${made.n}`;
          this.d.messages.insert({ from: "system", fromKind: "system", text: `${actor.name} scheduled ${id}: ${scheduleRuleText(rule)}${to.length ? ` → ${to.join(", ")}` : ""} (first ${new Date(next).toISOString().replace(".000Z", "Z")})`, event: { type: "schedule_created", who: actor.name, id, rule, to, first: next } });
          return this.d.nonces.remember(nonceSender, p.nonce, { roomId, item: this.scheduleView(made, actor), ...this.scheduleWarning(made) });
        });
        this.schedulesChanged(owner.plan);
        return out;
      }
      if (op === "stop_all") {
        const where = actor.account === this.d.room.require().owner ? "enabled = 1" : "enabled = 1 AND by_account = ?";
        const stopped = actor.account === this.d.room.require().owner
          ? this.d.sql().exec(`SELECT COUNT(*) AS n FROM schedules WHERE ${where}`).one().n as number
          : this.d.sql().exec(`SELECT COUNT(*) AS n FROM schedules WHERE ${where}`, actor.account).one().n as number;
        if (actor.account === this.d.room.require().owner)
          this.d.sql().exec(`UPDATE schedules SET enabled = 0, next_at = NULL, stopped_by = ?, stopped_reason = 'manual', updated_at = ? WHERE ${where}`, actor.name, t);
        else
          this.d.sql().exec(`UPDATE schedules SET enabled = 0, next_at = NULL, stopped_by = ?, stopped_reason = 'manual', updated_at = ? WHERE ${where}`, actor.name, t, actor.account);
        this.schedulesChanged(owner.plan);
        return { roomId, stopped };
      }
      if (!row) throw new ApiError("bad_request", "Unknown schedule operation.");
      const id = `S${row.n}`;
      if (op === "edit") {
        const changedText = p.text !== undefined ? this.scheduleText(p.text, actor) : null;
        const rule = p.rule !== undefined ? scheduleRule(p.rule, t, JSON.parse(row.rule as string) as Rule) : JSON.parse(row.rule as string) as Rule;
        if (p.revive !== undefined && typeof p.revive !== "boolean") throw new ApiError("bad_request", "revive must be true or false.");
        this.calendarFlag(p.calendar);
        const to = changedText?.to ?? JSON.parse(row.to_names as string) as string[];
        const next = p.rule !== undefined && row.enabled ? nextScheduleAt(rule, t) : row.next_at;
        this.d.sql().exec(`UPDATE schedules SET text = ?, to_names = ?, rule = ?, revive = ?, revive_name = ?, calendar = ?, next_at = ?, updated_at = ? WHERE n = ?`,
          changedText?.text ?? row.text, JSON.stringify(to), JSON.stringify(rule), p.revive === undefined ? row.revive : p.revive ? 1 : 0,
          this.reviveName(to, row.by_account as string), p.calendar === undefined ? row.calendar : p.calendar ? 1 : 0, next, t, row.n);
        const updated = this.scheduleRow(id);
        this.schedulesChanged(owner.plan);
        return { roomId, item: this.scheduleView(updated, actor), ...this.scheduleWarning(updated) };
      }
      if (op === "on" || op === "off") {
        if (!!row.enabled === (op === "on")) return { roomId, item: this.scheduleView(row, actor) };
        const rule = JSON.parse(row.rule as string) as Rule;
        if (op === "on" && rule.kind === "once") scheduleRule(rule, t);
        this.d.sql().exec("UPDATE schedules SET enabled = ?, next_at = ?, stopped_by = ?, stopped_reason = ?, updated_at = ? WHERE n = ?",
          op === "on" ? 1 : 0, op === "on" ? nextScheduleAt(rule, t) : null, op === "off" ? actor.name : null, op === "off" ? "manual" : null, t, row.n);
        this.schedulesChanged(owner.plan);
        return { roomId, item: this.scheduleView(this.scheduleRow(id), actor) };
      }
      if (op === "delete") {
        const rule = JSON.parse(row.rule as string) as Rule;
        const to = JSON.parse(row.to_names as string) as string[];
        tx(this.d.ctx(), () => {
          this.d.sql().exec("DELETE FROM schedules WHERE n = ?", row.n);
          this.d.messages.insert({ from: "system", fromKind: "system", text: `${actor.name} deleted schedule ${id}: ${scheduleRuleText(rule, false)}${to.length ? ` → ${to.join(", ")}` : ""}`, event: { type: "schedule_deleted", who: actor.name, id, rule, to } });
        });
        this.schedulesChanged(owner.plan);
        return { roomId, deleted: id };
      }
      if (op === "send") {
        const fired = this.fireSync(row, t, owner, true, p.nonce ? { sender: nonceSender, nonce: p.nonce, actor } : undefined);
        this.schedulesChanged(owner.plan);
        if (fired.failure) throw fired.failure;
        return fired.output ?? { roomId, seq: fired.seq, item: fired.deleted ? null : this.scheduleView(this.scheduleRow(id), actor) };
      }
      throw new ApiError("bad_request", "Unknown schedule operation.");
    });
    if ("ok" in result) await this.d.alarm.arm();
    return result;
  }

  stopSchedules(reason: "archived" | "pro_expired") {
    const changed = this.d.sql().exec("UPDATE schedules SET enabled = 0, next_at = NULL, stopped_by = NULL, stopped_reason = ?, updated_at = ? WHERE enabled = 1", reason, now());
    if (changed.rowsWritten) this.schedulesChanged();
  }

  dropAccountSchedules(account: string) {
    const changed = this.d.sql().exec("DELETE FROM schedules WHERE by_account = ?", account);
    if (changed.rowsWritten) this.schedulesChanged();
  }

  /** Called only in a synchronous transaction after the one owner-plan read. */
  private fireSync(row: Row, at: number, owner: { plan: Plan; limits: Limits }, manual: boolean,
    nonce?: { sender: string; nonce: string; actor: Actor }): { seq?: number; deleted?: boolean; error?: string; failure?: ApiError; output?: Record<string, unknown> } {
    return tx(this.d.ctx(), () => {
      const current = this.d.sql().exec("SELECT * FROM schedules WHERE n = ?", row.n).toArray()[0];
      if (!current || (!manual && (!current.enabled || (current.next_at as number) !== at))) return {};
      if (this.d.room.require().archived_at != null) { this.stopSchedules("archived"); return {}; }
      if (owner.plan !== "pro" && owner.plan !== "self") { this.stopSchedules("pro_expired"); return {}; }
      const rule = JSON.parse(current.rule as string) as Rule;
      const t = now();
      let error: string | undefined;
      let failure: ApiError | undefined;
      let seq: number | undefined;
      try {
        let text = current.text as string;
        const agent = current.revive && current.revive_name ? this.d.members.get(current.revive_name as string) : null;
        if (agent?.status === "left") {
          const takeover = this.d.members.takeoverFor(agent.name as string, current.by_account as string);
          const revive = takeover ? reviveCommand(takeover.command, text) : null;
          const host = revive ? this.d.members.get(revive.host) : null;
          if (!revive || host?.kind !== "host" || host.status !== "active") throw new ApiError("no_takeover", "This agent has no usable takeover command.", 409);
          text = revive.line;
        }
        const out = this.d.messages.send({ kind: "agent", name: "scheduled", account: current.by_account as string },
          { text, nonce: `S${current.n}:${at}` }, owner, { id: `S${current.n}`, by: current.by as string, at });
        seq = out.seq as number;
      } catch (e) {
        if (e instanceof ApiError && ["rate_limited", "quota_exceeded", "no_takeover"].includes(e.code)) {
          error = e.code;
          failure = e;
        } else {
          error = "unknown";
          failure = new ApiError("server_error", "The scheduled message failed; try again later.", 500);
        }
        if (error === "unknown") console.error(JSON.stringify({ msg: "schedule fire failed", id: `S${current.n}`, error: String(e) }));
      }
      if (seq != null && rule.kind === "once") {
        this.d.sql().exec("DELETE FROM schedules WHERE n = ?", current.n);
        const output = manual && nonce ? this.d.nonces.remember(nonce.sender, nonce.nonce, { roomId: this.d.room.require().id, seq, item: null }) : undefined;
        return { seq, deleted: true, ...(output ? { output } : {}) };
      }
      const next = manual ? current.next_at : rule.kind === "once" ? null : nextScheduleAt(rule, t, at);
      const failedOnce = !manual && !seq && rule.kind === "once";
      this.d.sql().exec(`UPDATE schedules SET last_at = ?, last_seq = ?, last_error = ?, next_at = ?, enabled = ?, stopped_reason = ?, updated_at = ? WHERE n = ?`,
        t, seq ?? null, error === "unknown" ? null : error ?? null, next, failedOnce ? 0 : current.enabled,
        failedOnce ? "failed" : current.stopped_reason, t, current.n);
      const output = manual && seq != null && nonce ? this.d.nonces.remember(nonce.sender, nonce.nonce,
        { roomId: this.d.room.require().id, seq, item: this.scheduleView(this.scheduleRow(`S${current.n}`), nonce.actor) }) : undefined;
      return { seq, ...(error ? { error } : {}), ...(failure ? { failure } : {}), ...(output ? { output } : {}) };
    });
  }

  async fire(row: Row, at: number) {
    let owner: { plan: Plan; limits: Limits };
    try { owner = await this.d.quota.ownerLimits(); }
    catch { this.d.ctx().storage.kv.put("scheduleRetryDue", now() + 60_000); return; }
    this.fireSync(row, at, owner, false);
    this.schedulesChanged(owner.plan);
    await this.d.alarm.arm();
  }

}
