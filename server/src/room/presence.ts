// The presence domain: the live connections (browsers, viewers, agents in `wait`, daemon seats), the hello and ready a
// connection opens with, who is online and what an agent is doing, the agents a daemon carries, the members and room
// frames, and the delayed room frame to daemons (kv roomFrameDue). RoomDO holds it through RoomDO.presenceOf(o) and
// keeps forwards under the old names (split by domain S7a). Its writes to members columns go through members' functions;
// when a person last wrote and the hello's recent messages are messages' reads (lastHumanTs, recent; S8a).
import { memberPermOf, type MemberPerm } from "../spawn-perm";
import { ApiError, now } from "../util";
import { membersFor } from "../member-visibility";
import { notify } from "../room-report";
import { HELLO_MESSAGES, pageTodo } from "../page-view";
import { safeSend, toHosts, viewing, wrap } from "./kernel";
import type { Actor, Result, Row } from "./kernel";
import type { Limits, Plan } from "../plans";
import type { Member, Message, RoomInfo } from "./types";
import type { Messages } from "./messages";
import type { Quota } from "./quota";
import type { Room } from "./room";
import type { Tasks } from "./tasks";

/** Per-connection state of a daemon (host) socket; survives hibernation. */
interface HostAttachment {
  kind: "host";
  name: string;
  carry: string[];
  tokenId?: string;
  account?: string;
}

const BLOCKED_PUSH_GAP_MS = 10 * 60_000;
/**
 * Frames a connection may send per minute. Pings are answered by the runtime and do
 * not count; any other frame wakes the room. A daemon sends carry and work frames now and then; browsers
 * and agents send nothing else at all. Past the limit, or with a frame over 64 KB, the connection is closed.
 */
const FRAMES_PER_MINUTE = { host: 300, other: 10 };
const FRAME_MAX_BYTES = 65_536;

export interface PresenceDeps {
  workspace?: { hostConnected(ws: WebSocket): void; revokedHost(ws: WebSocket): void };
  ctx(): DurableObjectState;
  env(): Env;
  schedule(task: string, ms: number): Promise<void>;
  room: { require(): Row; info(): RoomInfo; memberView(): ReturnType<Room["memberRoomView"]> };
  members: {
    get(name: string): Row | undefined;
    reader(actor: Actor): Row | null;
    require(actor: Actor): Row;
    all(except?: WebSocket): Member[];
    touch(name: string): void;
    setOnline(host: string): void;
    dropCarrier(name: string, host: string): void;
    writeWork(name: string, work: string | null, since: number | null, reason: string | null): void;
    setCarried(host: string, names: string[]): void;
    writePerm(name: string, perm: MemberPerm | null): void;
    setOffline(host: string, at: number): void;
  };
  messages: {
    of(rows: Row[], viewer?: Actor): Message[];
    pending(name: string, cursor: number): Message[];
    envelope(m: Message): ReturnType<Messages["envelope"]>;
    mentionUnread(name: string, cursor: number): number;
    lastHumanTs(): number | null;
    recent(n: number): Row[];
  };
  approvals: {
    browser(ws: WebSocket): void; host(ws: WebSocket): void;
    offline(): void; dropHost(name: string): void;
    open(ws: WebSocket, approval: unknown): boolean;
    close(ws: WebSocket, frame: { id?: unknown; reason?: unknown; result?: unknown }): boolean;
    blockedOf(handle: string, names: string[]): string[];
    closedAt(handle: string, name: string): number;
  };
  memo: { state(): import("../memo-types").MemoState; frame(): string };
  tasks: { todoState(): ReturnType<Tasks["todoState"]>; todoFrame(): string };
  schedules: { count(): number };
  quota: { ownerLimits(): Promise<{ plan: Plan; limits: Limits }>; view(plan: Plan, lim: Limits): ReturnType<Quota["quotaView"]> };
}

export class Presence {
  constructor(private readonly d: PresenceDeps) {}

  private get ctx() { return this.d.ctx(); }
  private get env() { return this.d.env(); }
  private schedule(task: string, ms: number) { return this.d.schedule(task, ms); }
  private wrap<T>(fn: () => T): Result<T> { return wrap(fn); }
  private safeSend(ws: WebSocket, data: string) { return safeSend(ws, data); }
  private room() { return this.d.room.require(); }
  private roomInfo() { return this.d.room.info(); }
  private memberRoomView() { return this.d.room.memberView(); }
  private memberRow(name: string) { return this.d.members.get(name); }
  private reader(actor: Actor) { return this.d.members.reader(actor); }
  private requireMember(actor: Actor) { return this.d.members.require(actor); }
  private allMembers(except?: WebSocket) { return this.d.members.all(except); }
  private touch(name: string) { this.d.members.touch(name); }
  private messagesOf(rows: Row[], viewer?: Actor) { return this.d.messages.of(rows, viewer); }
  private pending(name: string, cursor: number) { return this.d.messages.pending(name, cursor); }
  private envelope(m: Message) { return this.d.messages.envelope(m); }
  private mentionUnread(name: string, cursor: number) { return this.d.messages.mentionUnread(name, cursor); }
  private todoState() { return this.d.tasks.todoState(); }
  private todoFrame() { return this.d.tasks.todoFrame(); }
  private scheduleCount() { return this.d.schedules.count(); }
  private ownerLimits() { return this.d.quota.ownerLimits(); }
  private quotaView(plan: Plan, lim: Limits) { return this.d.quota.view(plan, lim); }

  /** A browser connection of a viewer (a public topic read without joining). */
  isViewer(ws: WebSocket): boolean {
    return !!(ws.deserializeAttachment() as { viewer?: boolean } | null)?.viewer;
  }

  isOnline(name: string, kind: string, except?: WebSocket): boolean {
    const open = (tag: string) => this.ctx.getWebSockets(tag).some((w) => w !== except);
    if (kind === "human") return open(`h:${name}`);
    if (kind === "host") return open(`host:${name}`);
    return open(`a:${name}`) || this.carriers(name).some((w) => w !== except);
  }

  /** Host connections currently carrying (delivering to) this agent. */
  carriers(name: string): WebSocket[] {
    return this.ctx.getWebSockets("host").filter((w) => {
      const a = w.deserializeAttachment() as HostAttachment | null;
      return !!a?.carry?.includes(name);
    });
  }

  /**
   * What an agent is doing, as its daemon last said. It holds only while a daemon carries the agent:
   * when the computer drops, the agent leaves, or its own wait takes over, nobody reports it any more,
   * so it is unknown (null) rather than the last word ("working" for an agent that is gone). The stored
   * value stays: when the daemon carries it again it is shown again, and the daemon sends any change.
   */
  workOf(r: Row, except?: WebSocket): string | null {
    if (!r.work || r.kind !== "agent" || r.status !== "active") return null;
    return this.carriers(r.name as string).some((w) => w !== except) ? (r.work as string) : null;
  }

  private lastActivitySent = 0;

  /** Tell hosts a person spoke (at most once a minute); they use it for keep-alive decisions. */
  activity(ts: number) {
    if (ts - this.lastActivitySent < 60_000) return;
    this.lastActivitySent = ts;
    const frame = JSON.stringify({ type: "activity", last_human_ts: ts });
    toHosts(this.ctx, frame);
  }

  private lastHumanTs() { return this.d.messages.lastHumanTs(); }

  roomFrame(members = this.allMembers(), account: string | null = null): string {
    const info = this.roomInfo();
    return JSON.stringify({
      type: "room",
      room: { id: info.id, name: info.name, topic: info.topic, owner: info.owner, public: info.public, archived: info.archived },
      members: membersFor(members, account),
      last_human_ts: this.lastHumanTs(),
    });
  }

  /**
   * Members changed. Browsers hear at once. Daemons get a room frame at once for membership changes
   * (join, leave, role card, topic); presence changes (online, work) are coalesced into one frame
   * a few seconds later, so an agent's wait reconnecting every few minutes does not flood them.
   */
  broadcastMembers(except?: WebSocket, presence = false) {
    const members = this.allMembers(except);
    this.sendMemberFrames(this.ctx.getWebSockets("browser").filter((w) => w !== except), members, false);
    const hosts = this.ctx.getWebSockets("host").filter((w) => w !== except);
    if (!hosts.length) return;
    if (presence) {
      this.schedule("roomFrameDue", 5_000).catch((e) => console.error(JSON.stringify({ msg: "schedule failed", error: String(e) })));
      return;
    }
    this.ctx.storage.kv.delete("roomFrameDue");
    this.sendMemberFrames(hosts, members, true);
  }

  /** Serialize once per account, including sockets that survived hibernation before accounts were attached. */
  private sendMemberFrames(sockets: WebSocket[], members: Member[], host: boolean) {
    const owners = new Map(members.map((m) => [m.name, m.owner]));
    const frames = new Map<string | null, string>();
    for (const ws of sockets) {
      const a = ws.deserializeAttachment() as { name?: string; account?: string; viewer?: boolean } | null;
      const account = a?.viewer ? null : a?.account ?? owners.get(a?.name || "") ?? null;
      if (!frames.has(account)) frames.set(account, host ? this.roomFrame(members, account) : JSON.stringify({ type: "members", members: membersFor(members, account) }));
      this.safeSend(ws, frames.get(account)!);
    }
  }

  broadcastHostRooms() {
    const hosts = this.ctx.getWebSockets("host");
    if (hosts.length) this.sendMemberFrames(hosts, this.allMembers(), true);
  }

  /** The delayed room frame to daemons (broadcastMembers with presence), when it is due. */
  alarm(t: number) {
    if ((this.ctx.storage.kv.get<number>("roomFrameDue") ?? Infinity) <= t) {
      this.ctx.storage.kv.delete("roomFrameDue");
      const hosts = this.ctx.getWebSockets("host");
      if (hosts.length && !("err" in this.wrap(() => this.room()))) {
        this.broadcastHostRooms();
      }
    }
  }

  nextDue(): number {
    return this.ctx.storage.kv.get<number>("roomFrameDue") ?? Infinity;
  }

  /** Of these agents, those of this account still stuck at a prompt (to close their agent_blocked notifications). */
  async blockedOf(handle: string, names: string[]): Promise<string[]> {
    if ("err" in this.wrap(() => this.room())) return [];
    const approvals = new Set(this.d.approvals.blockedOf(handle, names));
    return names.filter((n) => {
      if (approvals.has(n)) return true;
      const m = this.memberRow(n);
      return !!m && m.owner === handle && this.workOf(m) === "blocked" &&
        (m.work_since as number ?? 0) > this.d.approvals.closedAt(handle, n);
    });
  }

  /**
   * This account's list of rooms changed: tell its daemon seats connected here, except those already told
   * through another room. Returns the seats told.
   */
  async roomsChanged(account: string, skip: string[]): Promise<string[]> {
    const told: string[] = [];
    const frame = JSON.stringify({ type: "rooms_changed" });
    for (const ws of this.ctx.getWebSockets("host")) {
      const a = ws.deserializeAttachment() as HostAttachment | null;
      if (!a || skip.includes(a.name) || told.includes(a.name) || this.memberRow(a.name)?.owner !== account) continue;
      this.safeSend(ws, frame);
      told.push(a.name);
    }
    return told;
  }

  /**
   * An agent token stopped working (docs/api/auth.md): every connection opened with one of these tokens closes with
   * 4011 and the reason, so the client reconnects and hears the 401 with it. Returns how many closed.
   */
  async closeTokens(tokenIds: string[], reason: string): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { tokenId?: string; kind?: string; name: string } | null;
      if (!a?.tokenId || !tokenIds.includes(a.tokenId)) continue;
      if (a.kind === "host") this.d.workspace?.revokedHost(ws);
      if (a.kind === "host") this.d.approvals.dropHost(a.name);
      try { ws.close(4011, reason); closed++; } catch {}
    }
    return closed;
  }

  /**
   * WebSocket upgrade; the Worker has authenticated the caller and passes it in X-Scorpio-Actor, and for an agent token
   * the token's id in X-Scorpio-Token-Id (kept on the connection for closeTokens).
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const actor = JSON.parse(request.headers.get("X-Scorpio-Actor") || "null") as Actor | null;
    const tokenId = request.headers.get("X-Scorpio-Token-Id");
    const token = tokenId ? { tokenId } : {};
    if (!actor) return new Response("no actor", { status: 400 });
    let m: Row | null;
    try {
      m = actor.kind === "human" ? this.reader(actor) : this.requireMember(actor);
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.code, next: e.next }, { status: e.status });
      throw e;
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const info = this.roomInfo();
    if (!m) {
      // A viewer of a public topic: the page live, read only. Not touched, not online, not in the members
      // list; its member rows contain names and kinds only. `v:<account>` lets a join or a leave find it.
      this.ctx.acceptWebSocket(server, ["browser", `v:${actor.account}`]);
      server.serializeAttachment({ kind: actor.kind, name: actor.name, account: actor.account, viewer: true });
      const recent = this.d.messages.recent(HELLO_MESSAGES);
      const owner = await this.ownerLimits().catch(() => null);
      server.send(
        JSON.stringify({
          type: "hello",
          room: this.memberRoomView(),
          me: { name: actor.name, account: actor.account, member: false },
          members: membersFor(this.allMembers(), m ? actor.account : null),
          messages: this.messagesOf(recent, actor),
          todo: pageTodo(this.todoState()),
          memo: this.d.memo.state(),
          schedules: { count: this.scheduleCount(), proRequired: owner?.plan !== "pro" && owner?.plan !== "self" },
          quota: null,
        }),
      );
      server.send(this.d.memo.frame());
      this.d.approvals.browser(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (m.kind === "host") {
      // A daemon: one connection per room per computer, delivering for the agents it carries.
      this.ctx.acceptWebSocket(server, ["host", `host:${actor.name}`]);
      server.serializeAttachment({ kind: "host", name: actor.name, account: actor.account, carry: [], ...token } satisfies HostAttachment);
      this.d.members.setOnline(actor.name);
      this.d.workspace?.hostConnected(server);
      this.d.approvals.host(server);
      server.send(
        JSON.stringify({
          type: "ready",
          room: { id: info.id, name: info.name, topic: info.topic, owner: info.owner },
          me: { name: actor.name, cursor: m.cursor },
          pending: this.pending(actor.name, m.cursor as number).map((x) => this.envelope(x)),
        }),
      );
      server.send(this.roomFrame(this.allMembers(), actor.account));
      server.send(this.todoFrame());
      server.send(this.d.memo.frame());
      this.broadcastMembers(undefined, true);
      return new Response(null, { status: 101, webSocket: client });
    }
    const isAgent = actor.kind === "agent";
    this.ctx.acceptWebSocket(server, isAgent ? [`a:${actor.name}`] : ["browser", `h:${actor.name}`]);
    server.serializeAttachment({ kind: actor.kind, name: actor.name, account: actor.account, ...token });
    this.touch(actor.name);
    if (isAgent) {
      // One delivery connection per member: the agent's own wait now takes over from a daemon carrying it.
      for (const hw of this.carriers(actor.name)) {
        const a = hw.deserializeAttachment() as HostAttachment;
        hw.serializeAttachment({ ...a, carry: a.carry.filter((n) => n !== actor.name) } satisfies HostAttachment);
        this.safeSend(hw, JSON.stringify({ type: "dropped", name: actor.name }));
        this.d.members.dropCarrier(actor.name, a.name);
      }
    }
    if (isAgent) {
      server.send(
        JSON.stringify({
          type: "ready",
          room: { id: info.id, name: info.name, topic: info.topic },
          me: { name: actor.name, cursor: m.cursor },
          pending: this.pending(actor.name, m.cursor as number).map((x) => this.envelope(x)),
        }),
      );
    } else {
      const recent = this.d.messages.recent(HELLO_MESSAGES);
      const owner = await this.ownerLimits().catch(() => null);
      server.send(
        JSON.stringify({
          type: "hello",
          room: this.memberRoomView(),
          me: { name: actor.name, account: actor.account, cursor: m.cursor, mentionUnread: this.mentionUnread(actor.name, m.cursor as number) },
          members: membersFor(this.allMembers(), m ? actor.account : null),
          messages: this.messagesOf(recent, actor),
          todo: pageTodo(this.todoState()),
          memo: this.d.memo.state(),
          schedules: { count: this.scheduleCount(), proRequired: owner?.plan !== "pro" && owner?.plan !== "self" },
          quota: owner ? this.quotaView(owner.plan, owner.limits) : null,
        }),
      );
    }
    if (!isAgent) { server.send(this.d.memo.frame()); this.d.approvals.browser(server); }
    this.broadcastMembers(undefined, true);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Frames per connection in the current minute; kept while the object is awake, which is when frames cost. */
  private frames = new WeakMap<WebSocket, { minute: number; n: number }>();

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as HostAttachment | null;
    const minute = Math.floor(now() / 60_000);
    const f = this.frames.get(ws);
    const count = f && f.minute === minute ? f.n + 1 : 1;
    this.frames.set(ws, { minute, n: count });
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (count > FRAMES_PER_MINUTE[a?.kind === "host" ? "host" : "other"] || size > FRAME_MAX_BYTES) {
      console.warn(JSON.stringify({ msg: "connection closed: too many or too large frames", name: a?.name, count, size }));
      try {
        ws.close(1008, "too many frames");
      } catch {}
      return;
    }
    // Keep-alive pings are answered by the runtime; browsers send and mark over HTTP.
    if (message === "ping") return ws.send("pong");
    // A page says whether it is in view: no push to someone looking at the room.
    if (a && a.kind !== "host" && (message === "visible" || message === "hidden")) {
      ws.serializeAttachment({ ...(a as object), visible: message === "visible" });
      return;
    }
    if (a?.kind !== "host" || typeof message !== "string") return;
    let frame: { type?: string; names?: unknown };
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    // A bad frame must not take the room down (an exception here would reset the object and drop
    // every connection with 1006); log it instead.
    try {
      if (frame.type === "approval_open") this.d.approvals.open(ws, (frame as { approval?: unknown }).approval);
      if (frame.type === "approval_close") this.d.approvals.close(ws, frame as { id?: unknown; reason?: unknown; result?: unknown });
      if (frame.type === "carry") this.carry(ws, a, Array.isArray(frame.names) ? frame.names.map(String) : [], (frame as { perm?: unknown }).perm);
      if (frame.type === "work") {
        const w = frame as { name?: unknown; work?: unknown; reason?: unknown };
        this.setWork(a, String(w.name), w.work, w.reason);
      }
    } catch (e) {
      console.error(JSON.stringify({ msg: "host frame failed", type: frame.type, host: a.name, error: String((e as Error)?.stack || e) }));
    }
  }

  /** The daemon reports what one of its agents is doing (read from the terminal), and for blocked, at what. */
  private setWork(a: HostAttachment, name: string, work: unknown, reason: unknown) {
    if (!a.carry.includes(name)) return;
    const value = work === "working" || work === "idle" || work === "blocked" ? work : null;
    const why = value === "blocked" && typeof reason === "string" ? reason.replace(/\s+/g, " ").trim().slice(0, 80) || null : null;
    const was = this.memberRow(name);
    const since = was && was.work === value && was.work_since != null ? (was.work_since as number) : now();
    this.d.members.writeWork(name, value, value ? since : null, why);
    this.broadcastMembers(undefined, true);
    if (value === "blocked" && was?.work !== "blocked") this.pushBlocked(name, was?.owner as string, why);
  }

  /**
   * An agent stopped at an approval or a question in its terminal: its owner is told once per stop,
   * unless a page of theirs has the room in view, and not again for the same agent within 10 minutes (a
   * screen read as blocked, working, blocked again).
   */
  private pushBlocked(name: string, owner: string, reason: string | null) {
    if (!owner) return;
    const key = `blockedPush:${name}`;
    if (now() - (this.ctx.storage.kv.get<number>(key) ?? 0) < BLOCKED_PUSH_GAP_MS) return;
    const inView = viewing(this.ctx, owner);
    if (inView) return;
    this.ctx.storage.kv.put(key, now());
    const info = this.roomInfo();
    const payload = { type: "agent_blocked" as const, room: { id: info.id, name: info.name }, name, reason, tag: `blocked:${info.id}:${name}`, url: `/r/${info.id}` };
    this.ctx.waitUntil(notify(this.env, owner, payload).catch((e) => console.error(JSON.stringify({ msg: "push failed", error: String(e) }))));
  }

  /** A daemon declares which agents on its computer it delivers for; the list replaces the previous one. */
  private carry(ws: WebSocket, a: HostAttachment, names: string[], perm?: unknown) {
    const host = this.memberRow(a.name);
    if (!host || host.status !== "active") return ws.close(4003, "not_member");
    const owner = host.owner as string;
    const accepted: string[] = [];
    const rejected: { name: string; reason: string }[] = [];
    for (const name of [...new Set(names)].slice(0, 200)) {
      const m = this.memberRow(name);
      if (!m) rejected.push({ name, reason: "not_member" });
      else if (m.kind !== "agent") rejected.push({ name, reason: "not_an_agent" });
      else if (m.owner !== owner) rejected.push({ name, reason: "other_account" });
      else if (m.status !== "active") rejected.push({ name, reason: "left" });
      else accepted.push(name);
    }
    ws.serializeAttachment({ ...a, carry: accepted } satisfies HostAttachment);
    this.d.members.setCarried(a.name, accepted);
    const pending: Record<string, ReturnType<Messages["envelope"]>[]> = {};
    let permChanged = false;
    for (const name of accepted) {
      const entry = perm && typeof perm === "object" && !Array.isArray(perm) && Object.hasOwn(perm, name)
        ? (perm as Record<string, unknown>)[name] : null;
      const nextPerm = memberPermOf(entry), member = this.memberRow(name)!;
      if ((member.perm_level ?? null) !== (nextPerm?.level ?? null) || (member.perm_from ?? null) !== (nextPerm?.from ?? null) || (member.perm_parent ?? null) !== (nextPerm?.parent ?? null)) permChanged = true;
      this.d.members.writePerm(name, nextPerm);
      const cursor = member.cursor as number;
      pending[name] = this.pending(name, cursor).map((x) => this.envelope(x));
    }
    ws.send(JSON.stringify({ type: "carried", names: accepted, rejected, pending }));
    // One delivery connection per member: the daemon now takes over from the agent's own wait.
    // The frame comes first: a client acts on it at once, whatever the close handshake does.
    for (const name of accepted) {
      for (const w of this.ctx.getWebSockets(`a:${name}`)) {
        this.safeSend(w, JSON.stringify({ type: "superseded", name, by: a.name }));
        try {
          w.close(4001, "superseded");
        } catch {}
      }
    }
    // Permission changes reach daemons immediately, like a role-card edit; ordinary presence is coalesced.
    this.broadcastMembers(undefined, !permChanged);
  }

  async webSocketClose(ws: WebSocket) {
    this.afterDisconnect(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.afterDisconnect(ws);
  }

  private afterDisconnect(ws: WebSocket) {
    if ("err" in this.wrap(() => this.room())) return; // the room was deleted or purged: nobody to tell
    const a = ws.deserializeAttachment() as { kind: string; name: string } | null;
    if (a) this.touch(a.name);
    if (a?.kind === "host" && !this.ctx.getWebSockets(`host:${a.name}`).some((w) => w !== ws)) {
      // The computer went away: its agents are offline until it reconnects; senders are told since when.
      this.d.members.setOffline(a.name, now());
      this.d.approvals.offline();
    }
    // getWebSockets() may still list the closing socket; presence is computed without it.
    this.broadcastMembers(ws, true);
  }
}
