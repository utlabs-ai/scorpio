import { ApiError, now } from "../util";
import { untilText, utcDay, type Limits, type Plan } from "../plans";
import { addUsage, alertOps, markActive as reportActive, markSender as reportSender, notify, opsConfig, ownerPlan } from "../room-report";
import { accountCapped, countsNow, dayLimitHit, dbAlertDue, minuteLimit, opsThreshold, quotaFrame, usageDelta } from "../room-quota";
import { viewing } from "./kernel";
import type { Row } from "./kernel";
import type { RoomInfo } from "./types";

/** The room owner's plan is read from D1 at most this often (a plan change also clears it: planChanged). */
const PLAN_TTL = 10 * 60_000;
/** Today's message count is written down every this many messages, and Pro rooms report to D1 then. */
const COUNT_EVERY = 20;
/** A room whose database grows past this is reported to the people running the service. */
const ROOM_DB_ALERT_BYTES = 1024 ** 3; // the default; KV config:ops.roomDbAlertBytes changes it

export interface QuotaDeps {
  ctx(): DurableObjectState;
  env(): Env;
  room(): Row;
  roomInfo(): RoomInfo;
  countSince(ts: number, afterSeq?: number): { n: number; first: number | null };
  countMinuteSince(ts: number): { n: number; first: number | null };
  safeSend(ws: WebSocket, data: string): void;
}

export class Quota {
  constructor(private readonly d: QuotaDeps) {}

  private get ctx() { return this.d.ctx(); }
  private get env() { return this.d.env(); }
  private room() { return this.d.room(); }
  private roomInfo() { return this.d.roomInfo(); }
  private countSince(ts: number, afterSeq?: number) { return this.d.countSince(ts, afterSeq); }
  private countMinuteSince(ts: number) { return this.d.countMinuteSince(ts); }
  private safeSend(ws: WebSocket, data: string) { return this.d.safeSend(ws, data); }

  /** The room owner's plan and its limits, kept in storage so a waking room does not ask D1 each time. */
  async ownerLimits(): Promise<{ plan: Plan; limits: Limits }> {
    const cached = this.ctx.storage.kv.get<{ plan: Plan; limits: Limits; at: number }>("plan");
    if (cached && now() - cached.at < PLAN_TTL) return cached;
    const { plan, limits } = await ownerPlan(this.env, this.room().owner as string);
    const v = { plan, limits, at: now() };
    this.ctx.storage.kv.put("plan", v);
    return v;
  }

  /** The plan as last read, without asking D1 (the schedules frame); undefined when none is kept. */
  cachedPlan(): Plan | undefined {
    return this.ctx.storage.kv.get<{ plan: Plan }>("plan")?.plan;
  }

  forgetPlan() {
    this.ctx.storage.kv.delete("plan");
    this.ctx.storage.kv.delete("accountCapped");
  }

  /** Today's count, kept while the room is awake; on waking, from the last written count onwards. */
  private dayCount: { day: string; n: number } | null = null;

  messagesToday(): number {
    const { day, start } = utcDay();
    if (this.dayCount?.day !== day) {
      const saved = this.ctx.storage.kv.get<{ day: string; n: number; seq: number }>("dayCount");
      const n = saved?.day === day ? saved.n + this.countSince(start, saved.seq).n : this.countSince(start).n;
      this.dayCount = { day, n };
    }
    return this.dayCount.n;
  }

  /** Before a message is written: the room's minute, the room's day (free), the owner's day (Pro). */
  checkQuota(lim: Limits) {
    const today = this.messagesToday(); // counted now, before this message is in the table
    const minute = this.countMinuteSince(now() - 60_000);
    const minuteHit = minuteLimit(minute, lim.msgsPerRoomMinute, now());
    if (minuteHit) {
      const { wait } = minuteHit;
      throw new ApiError(
        "rate_limited",
        `More than ${lim.msgsPerRoomMinute} messages in this topic within a minute; this stops agents caught in a loop. Wait ${wait} s and send again.`,
        429,
        wait,
      );
    }
    const { day, end } = utcDay();
    const owner = this.room().owner as string;
    if (dayLimitHit(today, lim.msgsPerRoomDay)) {
      throw new ApiError(
        "quota_exceeded",
        `This topic has used its ${lim.msgsPerRoomDay} messages for today (free plan: ${lim.msgsPerRoomDay} per topic per day). Sending opens again at 00:00 UTC, in ${untilText(end)}; do not retry before then. The topic's creator (${owner}) can upgrade to Pro for no daily limit.`,
        429,
        Math.ceil((end - now()) / 1000),
      );
    }
    const cappedDay = lim.msgsPerAccountDay == null ? null : this.ctx.storage.kv.get<string>("accountCapped");
    if (accountCapped(cappedDay, day, lim.msgsPerAccountDay)) {
      throw new ApiError(
        "quota_exceeded",
        `The topics of ${owner} have sent ${lim.msgsPerAccountDay} messages today, the daily limit of an account. Sending opens again at 00:00 UTC, in ${untilText(end)}; do not retry before then.`,
        429,
        Math.ceil((end - now()) / 1000),
      );
    }
  }

  /**
   * After a message is written: count it. Every COUNT_EVERY messages the count is written down, a Pro room
   * reports to its owner's daily total in D1, and the database size is looked at. Near the room's daily limit
   * the pages hear how much is left, the owner gets one quota_warn, and the sender's receipt carries `quota`.
   */
  countMessage(lim: Limits, seq: number): { used: number; limit: number; resetsAt: number } | undefined {
    const before = this.messagesToday();
    const { day, end } = utcDay();
    const n = before + 1;
    this.dayCount = { day, n };
    if (countsNow(n, COUNT_EVERY)) {
      this.ctx.storage.kv.put("dayCount", { day, n, seq });
      this.ctx.waitUntil(this.afterCount(lim, day, n).catch((e) => console.error(JSON.stringify({ msg: "usage report failed", error: String(e) }))));
    }
    const { quota, warnOwner } = quotaFrame(n, before, lim.msgsPerRoomDay, end);
    if (!quota) return undefined;
    const frame = JSON.stringify({ type: "quota", ...quota });
    for (const ws of this.ctx.getWebSockets("browser")) this.safeSend(ws, frame);
    if (warnOwner) this.pushQuotaWarn(quota);
    return quota;
  }

  /** The UTC day whose first counted message has been written to D1 (rooms.active_at). */
  private activeDay: string | null = null;

  /**
   * A counted message: the retention clock's rooms.active_at in D1, at the day's first one only — at most one D1 write
   * a UTC day per room (a daily clock needs no finer grain). A failed write is tried again with the next message.
   */
  markActive() {
    const { day } = utcDay();
    if (this.activeDay === day) return;
    if (this.ctx.storage.kv.get<string>("activeDay") === day) {
      this.activeDay = day;
      return;
    }
    this.activeDay = day;
    this.ctx.storage.kv.put("activeDay", day);
    const nowMs = now();
    const write = reportActive(this.env, this.roomInfo().id, nowMs);
    this.ctx.waitUntil(
      write.then(
        () => {},
        (e) => {
          this.activeDay = null;
          this.ctx.storage.kv.delete("activeDay");
          console.error(JSON.stringify({ msg: "active_at write failed", error: String(e) }));
        },
      ),
    );
  }

  /** The accounts written to D1 activity_daily today (key kind:account), for the ops page. */
  private senders: { day: string; keys: string[] } | null = null;

  /**
   * A person or an agent said something: D1 activity_daily gets the account's day (an agent's is its owner's), at its
   * first message of the day in this room only. A failed write is tried again with that account's next message.
   */
  markSender(kind: string, account: string) {
    if (kind !== "human" && kind !== "agent") return; // daemons are command seats, not activity
    const { day } = utcDay();
    if (this.senders?.day !== day) {
      const saved = this.ctx.storage.kv.get<{ day: string; keys: string[] }>("senders");
      this.senders = saved?.day === day ? saved : { day, keys: [] };
    }
    const key = `${kind}:${account}`;
    if (this.senders.keys.includes(key)) return;
    this.senders.keys.push(key);
    this.ctx.storage.kv.put("senders", this.senders);
    const write = reportSender(this.env, day, kind, account);
    this.ctx.waitUntil(
      write.then(
        () => {},
        (e) => {
          if (this.senders?.day === day) this.senders.keys = this.senders.keys.filter((k) => k !== key);
          this.ctx.storage.kv.put("senders", this.senders);
          console.error(JSON.stringify({ msg: "activity write failed", error: String(e) }));
        },
      ),
    );
  }

  /** What the room page shows about today's messages (limit null: no daily limit). */
  quotaView(plan: Plan, lim: Limits) {
    return { plan, used: this.messagesToday(), limit: lim.msgsPerRoomDay, resetsAt: utcDay().end };
  }

  private async afterCount(lim: Limits, day: string, n: number) {
    const info = this.roomInfo();
    if (lim.msgsPerAccountDay != null) {
      // Report what this room counted since its last report; the answer is the owner's total today.
      const reported = this.ctx.storage.kv.get<{ day: string; n: number }>("reported");
      const delta = usageDelta(reported, day, n);
      if (delta > 0) {
        const msgs = await addUsage(this.env, day, delta, info.owner);
        this.ctx.storage.kv.put("reported", { day, n });
        if (msgs != null && msgs >= lim.msgsPerAccountDay) {
          this.ctx.storage.kv.put("accountCapped", day);
          await alertOps(this.env, "account_day", info.owner, `${info.owner} 今天的主题发了 ${msgs} 条，到了每账号每天 ${lim.msgsPerAccountDay} 条，当天暂停。`, {
            msgs,
            room: info.id,
          });
        }
      }
    }
    const size = this.ctx.storage.sql.databaseSize;
    const threshold = await this.roomDbAlertBytes();
    const alertedDay = size > threshold ? this.ctx.storage.kv.get<string>("dbAlerted") : null;
    if (dbAlertDue(size, threshold, alertedDay, day)) {
      this.ctx.storage.kv.put("dbAlerted", day);
      await alertOps(this.env, "room_db", info.id, `主题「${info.name}」（${info.owner}）的数据库 ${(size / 1024 ** 3).toFixed(2)} GB，超过 ${(this.opsCfg!.bytes / 1024 ** 3).toFixed(2)} GB。`, { bytes: size });
    }
  }

  /** The room database size that raises an alert: KV config:ops.roomDbAlertBytes (a positive number), else 1 GB; read every 5 minutes. */
  private opsCfg: { bytes: number; at: number } | null = null;
  private async roomDbAlertBytes(): Promise<number> {
    if (this.opsCfg && now() - this.opsCfg.at < 300_000) return this.opsCfg.bytes;
    const cfg = await opsConfig(this.env);
    this.opsCfg = { bytes: opsThreshold(cfg, ROOM_DB_ALERT_BYTES), at: now() };
    return this.opsCfg.bytes;
  }

  /** The room reached 80% of its day: its owner is told once, unless they have the room in view. */
  private pushQuotaWarn(q: { used: number; limit: number }) {
    const info = this.roomInfo();
    const inView = viewing(this.ctx, info.owner);
    if (inView) return;
    const payload = { type: "quota_warn" as const, room: { id: info.id, name: info.name }, used: q.used, limit: q.limit, tag: `quota:${info.id}`, url: `/r/${info.id}` };
    this.ctx.waitUntil(notify(this.env, info.owner, payload).catch((e) => console.error(JSON.stringify({ msg: "push failed", error: String(e) }))));
  }

}
