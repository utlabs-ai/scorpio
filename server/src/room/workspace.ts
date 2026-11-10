// Ephemeral, directed transfers. No workspace paths or bytes enter socket attachments or storage.
import { ApiError } from "../util";
import { safeSend } from "./kernel";
import type { Actor, Row } from "./kernel";
import { mayViewWorkspace } from "../workspace-access";
import { WORKSPACE, WORKSPACE_OPS, WORKSPACE_ERRORS, WorkspaceError, workspaceRequest, workspaceDirectoryMeta, wireBytes, isObject, isWorkspaceId,
  beginWorkspace, chunkWorkspace, ackWorkspace, endWorkspace, workspaceCapacity, safeWorkspaceDetails,
  type WorkspaceRequest, type StreamState } from "../workspace-protocol";

export interface WorkspaceComputer { computerId: string; name: string; online: boolean; lastSeenAt: number; workspaceProtocol: 1 | null; directoryNavigation?: 1 | null }
interface Marker { requestId: string; transferId: string; deadlineAt: number }
interface Attachment { kind: string; name: string; account: string; computerId?: string; connectionId?: string; epoch?: string; connectionTokenVerifier?: string; inFlight?: Marker[];
  directoryNavigation?: 1; workspaceProtocol?: number; workspaceEpoch?: string; workspaceOpenedAt?: number; workspaceSuperseded?: boolean; tokenId?: string }
interface Client { ws: WebSocket; verifier: string; account: string; computerId: string; connectionId: string }
interface Pending { transferId: string; requestId: string; epoch: string; account: string; viewer: string; client: Client; host: WebSocket;
  op: WorkspaceRequest["op"]; directoryRequested: boolean; initialDirectory: boolean; deadline: number; progress: number; counts?: StreamState; timer?: ReturnType<typeof setTimeout> }
interface Deps {
  ctx(): DurableObjectState;
  room(): { id: string; name: string };
  computers(actor: Actor): Row[];
  member(name: string): Row | undefined;
  recovery(): Row[];
}
const actorOf = (a: Attachment): Actor => ({ kind: "human", name: a.account, account: a.account });
const attachment = (ws: WebSocket) => ws.deserializeAttachment() as Attachment | null;
const unavailable = (): never => { throw new ApiError("workspace_not_found", "Workspace not found.", 404); };
const problem = (code: string, status = 400): never => { throw new ApiError(code, "Workspace request could not be completed.", status); };

export class Workspace {
  private readonly epoch: string;
  private readonly clients = new Map<string, Client>();
  private readonly pending = new Map<string, Pending>();
  private readonly controls = new WeakMap<WebSocket, Map<string, { minute: number; count: number }>>();
  private readonly bytes = new Map<string, { at: number; tokens: number }>();
  private readonly renewing = new WeakSet<WebSocket>();
  constructor(private readonly d: Deps) {
    const sockets = this.d.ctx().getWebSockets().filter(ws => ws.readyState === 1);
    const rows = sockets.some(ws => { const a = attachment(ws); return a?.kind === "workspace" || a?.workspaceProtocol === 1; }) ? this.d.recovery() : [];
    const members = new Map(rows.map(row => [String(row.name), row]));
    const computers = new Map(rows.filter(row => row.kind === "host" && row.device_id).map(row => [`${row.owner}\0${row.device_id}`, row]));
    const valid = (a: Attachment) => a.kind === "workspace" ? !!a.computerId && mayViewWorkspace(actorOf(a), members.get(a.account), computers.get(`${a.account}\0${a.computerId}`), a.computerId, false) :
      a.kind === "host" && members.get(a.name)?.kind === "host" && members.get(a.name)?.owner === a.account && !a.workspaceSuperseded;
    const live = sockets.map(attachment).filter((a): a is Attachment => a !== null && valid(a));
    this.epoch = live.find(a => a.kind === "workspace" && isWorkspaceId(a.epoch) && /^[a-f0-9]{64}$/.test(a.connectionTokenVerifier || ""))?.epoch ||
      live.find(a => a.kind === "host" && a.workspaceProtocol === 1 && isWorkspaceId(a.workspaceEpoch))?.workspaceEpoch || crypto.randomUUID();
    this.restore(members, computers);
  }
  private send(ws: WebSocket, frame: object) { safeSend(ws, JSON.stringify(frame)); }
  private sockets() { return this.d.ctx().getWebSockets("workspace"); }
  private take(ws: WebSocket, group: string, limit: number) {
    let groups = this.controls.get(ws);
    if (!groups) this.controls.set(ws, groups = new Map());
    const minute = Math.floor(Date.now() / 60_000), previous = groups.get(group);
    const count = previous?.minute === minute ? previous.count + 1 : 1;
    groups.set(group, { minute, count });
    return count <= limit;
  }
  private host(row: Row): WebSocket | undefined {
    return this.d.ctx().getWebSockets(`host:${row.name}`).filter(ws => {
      const a = attachment(ws);
      return a?.kind === "host" && a.account === row.owner && a.name === row.name && !a.workspaceSuperseded && ws.readyState === 1;
    }).sort((a, b) => (attachment(b)?.workspaceOpenedAt || 0) - (attachment(a)?.workspaceOpenedAt || 0))[0];
  }
  private rows(actor: Actor): Row[] {
    if (actor.kind !== "human" || actor.name !== actor.account) return unavailable();
    try { return this.d.computers(actor); } catch { return unavailable(); }
  }
  private summary(row: Row): WorkspaceComputer {
    const host = this.host(row), a = host && attachment(host);
    let name = String(row.name).split("@")[0];
    try { name = JSON.parse(String(row.device))?.name || name; } catch {}
    return { computerId: String(row.device_id), name, online: !!host,
      lastSeenAt: Math.max(Number(row.last_active) || 0, Number(row.offline_since) || 0),
      workspaceProtocol: a?.workspaceProtocol === 1 ? 1 : null, directoryNavigation: a?.workspaceProtocol === 1 && a.directoryNavigation === 1 ? 1 : null };
  }
  hosts(actor: Actor) { return this.rows(actor).map(r => this.summary(r)).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenAt - a.lastSeenAt || a.computerId.localeCompare(b.computerId)); }
  selected(actor: Actor, computerId?: string) {
    const rows = this.rows(actor), row = computerId ? rows.find(r => r.device_id === computerId) : rows.find(r => r.device_id === this.hosts(actor)[0]?.computerId);
    if (!row) return unavailable();
    return { row, computer: this.summary(row), topic: this.d.room() };
  }
  private current(client: Client) {
    const { row, computer } = this.selected({ kind: "human", name: client.account, account: client.account }, client.computerId);
    return { row, computer, host: this.host(row) };
  }
  private token() {
    const random = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...random)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  private async verifier(token: string, connectionId: string) {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`scorpio.workspace.v1\0${connectionId}\0${token}`)))].map(n => n.toString(16).padStart(2, "0")).join("");
  }
  private async ready(ws: WebSocket, computer: WorkspaceComputer) {
    const old = attachment(ws);
    if (!old) return;
    const token = this.token(), connectionId = crypto.randomUUID(), verifier = await this.verifier(token, connectionId);
    // Digest is an asynchronous boundary: permissions and the exact connection must still hold afterwards.
    const current = this.selected(actorOf(old), computer.computerId).computer;
    if (ws.readyState !== 1) return;
    for (const previous of [...this.clients.values()]) if (previous.ws === ws) {
      for (const p of [...this.pending.values()]) if (p.client === previous) this.stop(p, "workspace_reset");
      this.clients.delete(previous.connectionId);
    }
    const client: Client = { ws, account: old.account, computerId: computer.computerId, connectionId, verifier };
    ws.serializeAttachment({ kind: "workspace", name: old.account, account: old.account, computerId: computer.computerId, connectionId: client.connectionId, epoch: this.epoch, connectionTokenVerifier: verifier, inFlight: [] });
    this.clients.set(client.connectionId, client);
    this.send(ws, { type: "workspace_ready", v: 1, connectionId: client.connectionId, connectionToken: token, epoch: this.epoch, computer: current });
  }
  async fetch(request: Request): Promise<Response> {
    const actor = JSON.parse(request.headers.get("X-Scorpio-Actor") || "null") as Actor | null;
    if (!actor || actor.kind !== "human") return new Response(null, { status: 404 });
    const computerId = new URL(request.url).searchParams.get("computer") || undefined;
    const { computer } = this.selected(actor, computerId);
    const [client, server] = Object.values(new WebSocketPair());
    this.d.ctx().acceptWebSocket(server, ["workspace"]);
    server.serializeAttachment({ kind: "workspace", name: actor.account, account: actor.account });
    try { await this.ready(server, computer); } catch (error) { try { server.close(4004, "workspace revoked"); } catch {} throw error; }
    return new Response(null, { status: 101, webSocket: client });
  }
  /** Called on an existing topic host connection, after its member has been authenticated. */
  hostConnected(ws: WebSocket) {
    const a = attachment(ws);
    if (!a) return;
    const previous = this.d.ctx().getWebSockets(`host:${a.name}`).filter(w => w !== ws);
    ws.serializeAttachment({ ...a, workspaceSuperseded: false, workspaceOpenedAt: Math.max(Date.now(), ...previous.map(w => (attachment(w)?.workspaceOpenedAt || 0) + 1)) });
    for (const old of previous) old.serializeAttachment({ ...attachment(old), workspaceSuperseded: true });
    const row = this.d.member(a.name);
    for (const p of [...this.pending.values()]) if (p.host !== ws && p.account === a.account && p.client.computerId === row?.device_id) this.stop(p, "workspace_offline");
    this.status(a.account);
  }
  private arm(p: Pending) {
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.stop(p, "workspace_expired"), Math.max(0, Math.min(p.deadline, p.progress + WORKSPACE.progressMs) - Date.now()));
  }
  private stop(p: Pending, code?: string) {
    if (!this.pending.delete(p.transferId)) return;
    if (p.timer !== undefined) clearTimeout(p.timer);
    this.mark(p.client);
    if (code) {
      this.send(p.client.ws, { type: "workspace_error", v: 1, epoch: p.epoch, requestId: p.requestId, transferId: p.transferId, code });
      this.send(p.host, { type: "workspace_cancel", v: 1, topicId: this.d.room().id, epoch: p.epoch, transferId: p.transferId });
    }
  }
  private progress(p: Pending) { p.progress = Date.now(); this.arm(p); }
  async start(actor: Actor, computerId: string, raw: unknown) {
    this.selected(actor, computerId);
    let input: WorkspaceRequest;
    try { input = workspaceRequest(raw); } catch (e) { return problem(e instanceof WorkspaceError ? e.code : "workspace_protocol_error"); }
    const client = this.clients.get(input.connectionId);
    if (!client || client.account !== actor.account || client.computerId !== computerId || input.epoch !== this.epoch || client.ws.readyState !== 1) return unavailable();
    const verifier = await this.verifier(input.connectionToken, input.connectionId);
    if (this.clients.get(input.connectionId) !== client || client.verifier !== verifier || attachment(client.ws)?.connectionTokenVerifier !== verifier || client.ws.readyState !== 1) return unavailable();
    // The authenticated session, current membership, computer and all budgets are checked again after hashing.
    this.selected(actor, computerId);
    if (!this.take(client.ws, "start", WORKSPACE.startsPerMinute)) return problem("workspace_rate_limited", 429);
    if ([...this.pending.values()].some(p => p.client === client && p.requestId === input.requestId)) return problem("workspace_duplicate_request", 409);
    const { computer, host } = this.current(client);
    if (!host || !computer.online) return problem("workspace_offline", 409);
    const ha = attachment(host);
    if (ha?.workspaceProtocol !== 1 || ha.workspaceEpoch !== this.epoch || (input.directory !== undefined || input.op === "locations") && ha.directoryNavigation !== 1) return problem("workspace_unsupported", 409);
    if (!workspaceCapacity([...this.pending.values()], client.account, client.connectionId)) return problem("workspace_busy", 429);
    const p: Pending = { transferId: crypto.randomUUID(), requestId: input.requestId, epoch: this.epoch, account: client.account, viewer: client.connectionId,
      client, host, op: input.op, directoryRequested: input.directory !== undefined, initialDirectory: input.op === "list" && input.path === "" && input.cursor == null, deadline: Date.now() + WORKSPACE.totalMs, progress: Date.now() };
    this.pending.set(p.transferId, p); this.mark(client); this.arm(p);
    const accepted = { type: "workspace_accepted", v: 1, requestId: p.requestId, transferId: p.transferId, epoch: this.epoch, deadlineAt: p.deadline };
    this.send(client.ws, accepted);
    this.send(host, { type: "workspace_request", v: 1, topicId: this.d.room().id, computerId, owner: actor.account, viewerId: client.connectionId,
      requestId: p.requestId, transferId: p.transferId, epoch: this.epoch, timeoutMs: WORKSPACE.totalMs, op: input.op,
      ...(input.directory !== undefined ? { directory: input.directory } : {}), ...(input.path !== undefined ? { path: input.path } : {}), ...(input.repo !== undefined ? { repo: input.repo } : {}), ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) });
    return accepted;
  }
  private byteBudget(account: string, bytes: number) {
    const at = Date.now(), old = this.bytes.get(account), tokens = Math.min(WORKSPACE.byteBurst, (old?.tokens ?? WORKSPACE.byteBurst) + (at - (old?.at ?? at)) * WORKSPACE.bytesPerMinute / 60_000);
    this.bytes.set(account, { at, tokens: Math.max(0, tokens - bytes) });
    return tokens >= bytes;
  }
  /** Returns true only for this domain's frames, before ordinary topic frame counters/logging. */
  message(ws: WebSocket, message: string | ArrayBuffer): boolean {
    const a = attachment(ws);
    const size = typeof message === "string" ? wireBytes(message) : message.byteLength;
    if (size > WORKSPACE.frameBytes) { try { ws.close(1008, "frame too large"); } catch {} this.disconnected(ws); return true; }
    let frame: Record<string, unknown> | undefined;
    if (typeof message === "string") { try { const value = JSON.parse(message); if (isObject(value)) frame = value; } catch {} }
    const viewer = a?.kind === "workspace";
    if (!viewer && (a?.kind !== "host" || typeof frame?.type !== "string" || !frame.type.startsWith("workspace_"))) return false;
    if (viewer && message === "ping") { safeSend(ws, "pong"); return true; }
    if (viewer && !a?.connectionId) return true;
    if (viewer && !this.clients.has(a!.connectionId!)) { this.migrate(ws); return true; }
    if (!frame || frame.v !== 1) {
      if (!this.take(ws, viewer ? "start" : "host", viewer ? WORKSPACE.startsPerMinute : WORKSPACE.hostControlsPerMinute) && viewer) { try { ws.close(1008, "workspace rate limit"); } catch {} this.disconnected(ws); }
      return true;
    }
    if (viewer) { this.viewerFrame(ws, frame); return true; }
    const type = frame.type;
    if (type !== "workspace_chunk" && !this.take(ws, "host", WORKSPACE.hostControlsPerMinute)) {
      const limited = isWorkspaceId(frame.transferId) ? this.pending.get(frame.transferId) : undefined;
      if (limited?.host === ws && frame.epoch === limited.epoch && frame.topicId === this.d.room().id) this.stop(limited, "workspace_rate_limited");
      return true;
    }
    if (type === "workspace_capabilities") {
      const host = a && this.d.member(a.name);
      if (!a || host?.kind !== "host" || host.status !== "active" || host.owner !== a.account || this.host(host) !== ws ||
        !Array.isArray(frame.ops) || frame.ops.length !== WORKSPACE_OPS.length || !WORKSPACE_OPS.every(op => (frame!.ops as unknown[]).includes(op))) return true;
      ws.serializeAttachment({ ...attachment(ws), workspaceProtocol: 1, directoryNavigation: frame.directoryNavigation === 1 ? 1 : undefined, workspaceEpoch: this.epoch });
      this.send(ws, { type: "workspace_host_ready", v: 1, epoch: this.epoch, computerId: host.device_id }); this.status(a.account); return true;
    }
    const p = typeof frame.transferId === "string" ? this.pending.get(frame.transferId) : undefined;
    if (!p || p.host !== ws || frame.epoch !== p.epoch || frame.topicId !== this.d.room().id) {
      if (type === "workspace_chunk" && !this.take(ws, "host", WORKSPACE.hostControlsPerMinute)) return true;
      if (!p && isWorkspaceId(frame.transferId) && frame.epoch === this.epoch && frame.topicId === this.d.room().id) this.send(ws, { type: "workspace_cancel", v: 1, topicId: this.d.room().id, epoch: this.epoch, transferId: frame.transferId });
      return true;
    }
    try {
      if (Date.now() >= p.deadline || Date.now() >= p.progress + WORKSPACE.progressMs) throw new WorkspaceError("workspace_expired");
      const { host } = this.current(p.client);
      if (host !== ws) throw new WorkspaceError("workspace_offline");
      const base = { v: 1, epoch: p.epoch, requestId: p.requestId, transferId: p.transferId };
      if (type === "workspace_begin") {
        if (p.counts) throw new WorkspaceError("workspace_protocol_error");
        p.counts = beginWorkspace(p.op, frame.streams);
        // Only a fixed metadata schema crosses the relay; arbitrary host fields never reach the viewer.
        const meta: Record<string, unknown> = {};
        if (isObject(frame.meta)) for (const key of ["path", "repo", "size", "mtime", "bom", "eol", "headOid", "kind"]) {
          const value = frame.meta[key];
          if (typeof value === "string" && wireBytes(value) <= WORKSPACE.pathBytes || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null) meta[key] = value;
        }
        if (p.directoryRequested || isObject(frame.meta) && frame.meta.directory !== undefined) Object.assign(meta, workspaceDirectoryMeta(frame.meta, !p.initialDirectory));
        this.send(p.client.ws, { ...base, type, streams: p.counts.streams.map(s => ({ name: s.name, exists: s.exists, bytes: s.bytes, encoding: "utf-8" })), meta }); this.progress(p);
      } else if (type === "workspace_chunk") {
        if (!p.counts) throw new WorkspaceError("workspace_protocol_error");
        const bytes = chunkWorkspace(p.counts, frame);
        if (!this.byteBudget(p.account, bytes)) throw new WorkspaceError("workspace_rate_limited");
        this.send(p.client.ws, { ...base, type, seq: frame.seq, stream: frame.stream, offset: frame.offset, data: frame.data }); this.progress(p);
      } else if (type === "workspace_end") {
        if (!p.counts) throw new WorkspaceError("workspace_protocol_error");
        endWorkspace(p.counts, frame.streams);
        this.send(p.client.ws, { ...base, type, streams: p.counts.streams.map(s => ({ name: s.name, bytes: s.bytes, chunks: s.chunks })), readAt: Date.now() }); this.stop(p);
      } else if (type === "workspace_error") {
        const code = typeof frame.code === "string" && WORKSPACE_ERRORS.has(frame.code) ? frame.code : "workspace_read_failed";
        this.send(p.client.ws, { ...base, type, code, details: safeWorkspaceDetails(frame.details) }); this.stop(p);
      } else throw new WorkspaceError("workspace_protocol_error");
    } catch (e) { if (type === "workspace_chunk") this.take(ws, "host", WORKSPACE.hostControlsPerMinute); this.stop(p, e instanceof WorkspaceError ? e.code : "workspace_revoked"); }
    return true;
  }
  private viewerFrame(ws: WebSocket, frame: Record<string, unknown>) {
    const a = attachment(ws), client = a?.connectionId && this.clients.get(a.connectionId);
    const ack = frame.type === "workspace_ack";
    if (!this.take(ws, ack ? "ack" : "start", ack ? WORKSPACE.acksPerMinute : WORKSPACE.startsPerMinute)) { try { ws.close(1008, "workspace rate limit"); } catch {} this.disconnected(ws); return; }
    if (!client || client.ws !== ws || frame.epoch !== this.epoch || !isWorkspaceId(frame.transferId)) return;
    const p = this.pending.get(frame.transferId);
    if (!p || p.client !== client || p.requestId !== frame.requestId) return;
    if (frame.type === "workspace_cancel") { this.stop(p, "workspace_cancelled"); return; }
    try {
      if (!ack || !p.counts) throw new WorkspaceError("workspace_protocol_error");
      if (ackWorkspace(p.counts, frame.ackSeq)) this.progress(p);
      this.send(p.host, { type: "workspace_ack", v: 1, topicId: this.d.room().id, epoch: this.epoch, transferId: p.transferId, ackSeq: frame.ackSeq });
    } catch { this.stop(p, "workspace_protocol_error"); }
  }
  private status(account: string) {
    for (const client of this.clients.values()) if (client.account === account) {
      try { this.send(client.ws, { type: "workspace_status", v: 1, epoch: this.epoch, ...this.current(client).computer }); } catch { this.revoke(client); }
    }
  }
  private revoke(client: Client) {
    for (const p of [...this.pending.values()]) if (p.client === client) this.stop(p, "workspace_revoked");
    this.clients.delete(client.connectionId);
    this.send(client.ws, { type: "workspace_revoked", v: 1, computerId: client.computerId });
    try { client.ws.close(4004, "workspace revoked"); } catch {}
  }
  private mark(client: Client) {
    const a = attachment(client.ws);
    if (!a || a.kind !== "workspace") return;
    const markers = [...this.pending.values()].filter(p => p.client === client).map(p => ({ requestId: p.requestId, transferId: p.transferId, deadlineAt: p.deadline }));
    client.ws.serializeAttachment({ ...a, inFlight: markers });
  }
  private migrate(ws: WebSocket) {
    const a = attachment(ws);
    if (!a || this.renewing.has(ws)) return;
    this.renewing.add(ws);
    this.send(ws, { type: "workspace_reset", v: 1, epoch: this.epoch, reason: "connection_reset" });
    const renew = async () => {
      try { await this.ready(ws, this.selected(actorOf(a), a.computerId).computer); }
      catch { this.send(ws, { type: "workspace_revoked", v: 1, computerId: a.computerId }); try { ws.close(4004, "workspace revoked"); } catch {} }
      finally { this.renewing.delete(ws); }
    };
    this.d.ctx().waitUntil(renew());
  }
  /** One batch member view rebuilds identity indexes; this never runs on each chunk. */
  private restore(members: Map<string, Row>, computers: Map<string, Row>) {
    for (const host of this.d.ctx().getWebSockets("host")) {
      const a = attachment(host), row = a && members.get(a.name);
      if (!a || row?.kind !== "host" || row.owner !== a.account || a.workspaceSuperseded) continue;
      if (a.workspaceProtocol === 1 && a.workspaceEpoch !== this.epoch) {
        host.serializeAttachment({ ...a, workspaceEpoch: this.epoch, workspaceProtocol: undefined, directoryNavigation: undefined });
        this.send(host, { type: "workspace_reset", v: 1, epoch: this.epoch, reason: "connection_reset" });
      }
    }
    for (const ws of this.sockets()) {
      const a = attachment(ws);
      if (!a || ws.readyState !== 1) continue;
      const computer = computers.get(`${a.account}\0${a.computerId}`);
      if (!a.computerId || !mayViewWorkspace(actorOf(a), members.get(a.account), computer, a.computerId, false)) {
        this.send(ws, { type: "workspace_revoked", v: 1, computerId: a.computerId }); try { ws.close(4004, "workspace revoked"); } catch {} continue;
      }
      if (a.epoch !== this.epoch || !isWorkspaceId(a.connectionId) || !/^[a-f0-9]{64}$/.test(a.connectionTokenVerifier || "") || !Array.isArray(a.inFlight) || a.inFlight.length > WORKSPACE.viewerPending) { this.migrate(ws); continue; }
      const client: Client = { ws, account: a.account, computerId: a.computerId, connectionId: a.connectionId, verifier: a.connectionTokenVerifier! };
      this.clients.set(client.connectionId, client);
      ws.serializeAttachment({ ...a, inFlight: [] });
      for (const marker of a.inFlight) {
        if (!isWorkspaceId(marker.requestId) || !isWorkspaceId(marker.transferId) || !Number.isFinite(marker.deadlineAt)) continue;
        this.send(ws, { type: "workspace_error", v: 1, epoch: this.epoch, requestId: marker.requestId, transferId: marker.transferId, code: "workspace_reset" });
        const host = this.host(computer!);
        if (host) this.send(host, { type: "workspace_cancel", v: 1, topicId: this.d.room().id, epoch: this.epoch, transferId: marker.transferId });
      }
    }
  }
  disconnected(ws: WebSocket) {
    const a = attachment(ws);
    for (const p of [...this.pending.values()]) if (p.host === ws || p.client.ws === ws) this.stop(p, p.host === ws ? "workspace_offline" : "workspace_cancelled");
    if (a?.kind === "workspace" && a.connectionId) this.clients.delete(a.connectionId);
    if (a?.kind === "host") { ws.serializeAttachment({ ...a, workspaceSuperseded: true }); this.status(a.account); }
  }
  revokeAccount(account: string) { for (const c of [...this.clients.values()]) if (c.account === account) this.revoke(c); this.bytes.delete(account); }
  revokeAll() { for (const c of [...this.clients.values()]) this.revoke(c); this.bytes.clear(); }
  revokeComputer(account: string, computerId: string) { for (const c of [...this.clients.values()]) if (c.account === account && c.computerId === computerId) this.revoke(c); }
  revokedHost(ws: WebSocket) {
    const a = attachment(ws), row = a && this.d.member(a.name);
    if (a && row?.device_id) this.revokeComputer(a.account, String(row.device_id));
  }
  hostChanged(account: string, computerId: string) {
    for (const p of [...this.pending.values()]) if (p.account === account && p.client.computerId === computerId) this.stop(p, "workspace_offline");
    this.status(account);
  }
}
