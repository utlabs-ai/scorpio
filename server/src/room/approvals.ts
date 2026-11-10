import { now } from '../util';
import { configKeys } from '../config-keys';
import { notify } from '../room-report';
import { approvalHostDue, approvalAnswer, approvalAnswerError, approvalClosed, approvalViewer, validApproval, normalizeApproval } from '../room-approvals';
import type { Approval, ApprovalAnswerResult } from '../room-approvals';
import { safeSend } from './kernel';
import type { Actor, Row } from './kernel';

interface Deps {
  sql(): SqlStorage; ctx(): DurableObjectState; env(): Env;
  schedule(task: string, ms: number): Promise<void>;
  room(): { id: string; name: string };
  member(name: string): Row | undefined;
  hosts(names: string[]): Row[];
  reader(actor: Actor): Row | null;
}
const DAY = 86_400_000;
const PRESENT = 'approvals:present';
const DUE = 'approvals:due', RECONNECT = 'approvals:reconnect';
type Reconnect = Record<string, { due: number; connection: string }>;
type Host = { kind: string; name: string; account?: string; approvalSeen?: string[]; approvalReconnect?: number; approvalConnection?: string };
export class Approvals {
  constructor(private readonly d: Deps) {}
  private cache = new Map<string, Map<string, Approval>>();
  private cacheValue(r: Row) {
    const account = r.account as string;
    let cards = this.cache.get(account);
    if (!cards) this.cache.set(account, cards = new Map());
    cards.set(r.id as string, this.view(r));
  }
  wake() {
    if (!this.ctx.storage.kv.get(PRESENT)) return;
    for (const r of this.sql.exec('SELECT * FROM approvals WHERE closed_ms IS NULL OR closed_ms > ?', now() - 600_000).toArray()) {
      this.cacheValue(r);
    }
    this.arm();
  }
  private cacheRow(id: string) {
    const r = this.row(id);
    if (r) this.cacheValue(r);
  }
  private get sql() { return this.d.sql(); }
  private get ctx() { return this.d.ctx(); }
  static migrate(sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL, host TEXT NOT NULL, cli TEXT NOT NULL,
      detail TEXT, menu TEXT, screen TEXT, status TEXT NOT NULL, answer TEXT, result TEXT,
      opened_ms INTEGER NOT NULL, closed_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS approvals_account ON approvals(account, opened_ms);
    CREATE INDEX IF NOT EXISTS approvals_host ON approvals(host, status);
    CREATE INDEX IF NOT EXISTS approvals_closed ON approvals(closed_ms);`);
  }
  private row(id: string) { return this.sql.exec('SELECT * FROM approvals WHERE id = ?', id).toArray()[0]; }
  private view(r: Row): Approval {
    return { id: r.id as string, name: r.name as string, cli: r.cli as Approval['cli'],
      detail: r.detail ? JSON.parse(r.detail as string) : null, menu: r.menu ? JSON.parse(r.menu as string) : null,
      screen: r.screen as string | null, status: r.status as Approval['status'],
      answer: r.answer ? JSON.parse(r.answer as string) : null, result: r.result as Approval['result'],
      opened_ms: r.opened_ms as number, closed_ms: r.closed_ms as number | null };
  }
  private items(account: string) {
    return [...(this.cache.get(account)?.values() ?? [])].filter(r => r.closed_ms === null || r.closed_ms > now() - 600_000)
      .sort((a, b) => a.opened_ms - b.opened_ms || a.id.localeCompare(b.id));
  }

  /** Page connections read the account cache only; cold wake rebuilds it once if cards exist. */
  connectBrowser(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Parameters<typeof approvalViewer>[0];
    if (a?.account && approvalViewer(a, a.account)) {
      safeSend(ws, JSON.stringify({ type: 'approvals', items: this.items(a.account) }));
    }
  }
  private browsers(account: string) {
    return this.ctx.getWebSockets('browser').filter(w => approvalViewer(w.deserializeAttachment() as Parameters<typeof approvalViewer>[0], account));
  }
  private broadcast(account: string) {
    const sockets = this.browsers(account);
    if (!sockets.length) return;
    const frame = JSON.stringify({ type: 'approvals', items: this.items(account) });
    for (const ws of sockets) safeSend(ws, frame);
  }
  connectHost(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Host;
    const due = now() + 30_000, connection = crypto.randomUUID();
    ws.serializeAttachment({ ...a, approvalSeen: [], approvalReconnect: due, approvalConnection: connection });
    if (!this.ctx.storage.kv.get(PRESENT)) return;
    const pending = this.ctx.storage.kv.get<Reconnect>(RECONNECT) ?? {};
    pending[a.name] = { due, connection };
    this.ctx.storage.kv.put(RECONNECT, pending);
    this.arm();
  }
  private host(a: Host): string | null {
    const m = this.d.member(a.name);
    return a.kind === 'host' && m?.kind === 'host' && m.status === 'active' && m.owner === a.account ? a.account! : null;
  }
  open(ws: WebSocket, raw: unknown) {
    const input = raw;
    const id = input && typeof input === 'object' ? (input as { id?: unknown }).id : undefined;
    const refuse = (error: 'bad_request' | 'approval_limit') => {
      console.warn(JSON.stringify({ msg: 'approval_open refused', error }));
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) safeSend(ws, JSON.stringify({ type: 'approval_refused', id, error }));
      return false;
    };
    const a = ws.deserializeAttachment() as Host, account = this.host(a);
    if (!account || !validApproval(input, account)) return refuse('bad_request');
    const approval = normalizeApproval(input);
    const old = this.row(approval.id);
    if (old && (old.host !== a.name || old.account !== account)) return refuse('bad_request');
    if (!old && (this.sql.exec("SELECT COUNT(*) AS n FROM approvals WHERE closed_ms IS NULL").toArray()[0].n as number) >= 50) return refuse('approval_limit');
    if (old?.closed_ms != null) return true;
    // Replays do not resurrect a final answer, nor replace a choice already being applied.
    const seen = new Set(a.approvalSeen ?? []); seen.add(approval.id);
    ws.serializeAttachment({ ...a, approvalSeen: [...seen].slice(-50) });
    if (old && old.status !== 'open') return true;
    const detail = approval.detail === null ? null : JSON.stringify(approval.detail), menu = approval.menu === null ? null : JSON.stringify(approval.menu);
    if (old) this.sql.exec('UPDATE approvals SET name = ?, cli = ?, detail = ?, menu = ?, screen = ? WHERE id = ?', approval.name, approval.cli, detail, menu, approval.screen, approval.id);
    else this.sql.exec("INSERT INTO approvals (id, name, account, host, cli, detail, menu, screen, status, opened_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)", approval.id, approval.name, account, a.name, approval.cli, detail, menu, approval.screen, now());
    this.ctx.storage.kv.put(PRESENT, true);
    this.cacheRow(approval.id);
    this.broadcast(account);
    if (!old && !this.browsers(account).some(w => (w.deserializeAttachment() as { visible?: boolean }).visible !== false)) {
      const room = this.d.room();
      this.ctx.waitUntil(notify(this.d.env(), account, { type: 'agent_blocked', room, name: approval.name,
        approval: approval.id, tag: `blocked:${room.id}:${approval.name}`, url: `/r/${room.id}?approval=${approval.id}`
      }).catch(() => console.error(JSON.stringify({ msg: 'approval push failed' }))));
    }
    return true;
  }
  close(ws: WebSocket, frame: { id?: unknown; reason?: unknown; result?: unknown }) {
    const a = ws.deserializeAttachment() as Host, account = this.host(a);
    if (!account || typeof frame.id !== 'string' || !approvalClosed(frame.reason) ||
      (frame.reason === 'answered' && frame.result !== 'ok' && frame.result !== 'failed') ||
      (frame.reason !== 'answered' && frame.result !== undefined)) { console.warn(JSON.stringify({ msg: 'approval_close ignored' })); return false; }
    const r = this.row(frame.id);
    if (!r || r.host !== a.name || r.account !== account) { console.warn(JSON.stringify({ msg: 'approval_close ignored' })); return false; }
    if (r.closed_ms !== null) return true;
    this.sql.exec('UPDATE approvals SET status = ?, result = ?, closed_ms = ? WHERE id = ?', frame.reason, (frame.result as string) ?? null, now(), frame.id);
    ws.serializeAttachment({ ...a, approvalSeen: (a.approvalSeen ?? []).filter(id => id !== frame.id) });
    this.cacheRow(frame.id);
    this.broadcast(account); this.arm();
    return true;
  }
  async answer(actor: Actor, id: string, body: Record<string, unknown>): Promise<ApprovalAnswerResult> {
    const denied = { err: { code: 'approval_not_found', next: 'Approval not found.', status: 404 } };
    if (actor.kind !== 'human') return denied;
    // Membership is current, not the D1 index. Do not expose private topic or card existence.
    try { this.d.reader(actor); } catch { return denied; }
    const keys = await configKeys(this.d.env());
    try { this.d.reader(actor); } catch { return denied; }
    // All state reads after await: simultaneous HTTP answers cannot both dispatch a press.
    const r = this.row(id);
    if (!r || r.account !== actor.account) return denied;
    const card = this.view(r);
    if (r.status !== 'open') return { err: { code: 'already_answered', next: 'This card has already been answered.', status: 409, approval: card } };
    const invalid = approvalAnswerError(card, body, keys.keys);
    if (invalid) return { err: { code: 'bad_request', next: invalid, status: 400 } };
    const answer = approvalAnswer(card, body, keys.keys, actor.name)!;
    const socket = this.ctx.getWebSockets(`host:${r.host}`).filter(w => this.host(w.deserializeAttachment() as Host) === actor.account)
      .sort((a, b) => ((b.deserializeAttachment() as Host).approvalReconnect ?? 0) - ((a.deserializeAttachment() as Host).approvalReconnect ?? 0))[0];
    if (!socket) return { err: { code: 'host_offline', next: 'That computer is offline; the card waits until it is back.', status: 409 } };
    const { label, ...dispatch } = answer;
    this.sql.exec("UPDATE approvals SET status = 'answering', answer = ? WHERE id = ?", JSON.stringify(answer), id);
    try { socket.send(JSON.stringify({ type: 'approval_answer', id, ...dispatch, ts: now() })); }
    catch {
      this.sql.exec("UPDATE approvals SET status = 'open', answer = NULL WHERE id = ?", id);
      return { err: { code: 'host_offline', next: 'That computer is offline; the card waits until it is back.', status: 409 } }; }
    this.cacheRow(id);
    this.broadcast(actor.account);
    return { ok: { approval: this.view(this.row(id)!) } };
  }
  /** A host seat is gone: close its cards and retire its reconnect deadline together. */
  dropHost(host: string, at = now()) {
    const changed = new Set<string>();
    for (const r of this.sql.exec('SELECT id, account FROM approvals WHERE host = ? AND closed_ms IS NULL', host).toArray()) {
      this.sql.exec("UPDATE approvals SET status = 'gone', closed_ms = ? WHERE id = ?", at, r.id);
      this.cacheRow(r.id as string);
      changed.add(r.account as string);
    }
    const pending = this.ctx.storage.kv.get<Reconnect>(RECONNECT) ?? {};
    delete pending[host];
    if (Object.keys(pending).length) this.ctx.storage.kv.put(RECONNECT, pending); else this.ctx.storage.kv.delete(RECONNECT);
    for (const account of changed) this.broadcast(account);
    this.arm();
  }
  /** Presence writes the membership clock first, then arms the existing one-shot deadline. */
  hostOffline() { if (this.ctx.storage.kv.get(PRESENT)) this.arm(); }
  private offlineHosts() {
    const names = this.sql.exec('SELECT DISTINCT host FROM approvals WHERE closed_ms IS NULL').toArray().map(r => r.host as string);
    return this.d.hosts(names).map(h => ({ name: h.name as string, due: approvalHostDue(h as { status: string; offline_since?: number | null }) }));
  }
  /** Account removal deletes sensitive cards immediately, including ones whose host never returns. */
  dropAccount(account: string) {
    const hosts = this.sql.exec('SELECT DISTINCT host FROM approvals WHERE account = ?', account).toArray();
    this.sql.exec('DELETE FROM approvals WHERE account = ?', account);
    this.cache.delete(account);
    const pending = this.ctx.storage.kv.get<Reconnect>(RECONNECT) ?? {};
    for (const r of hosts) delete pending[r.host as string];
    if (Object.keys(pending).length) this.ctx.storage.kv.put(RECONNECT, pending); else this.ctx.storage.kv.delete(RECONNECT);
    if (!this.sql.exec('SELECT 1 FROM approvals LIMIT 1').toArray().length) this.ctx.storage.kv.delete(PRESENT);
    if (hosts.length) this.broadcast(account);
    this.arm();
  }
  closedAt(account: string, name: string): number {
    return Math.max(0, ...[...(this.cache.get(account)?.values() ?? [])].filter(r => r.name === name).map(r => r.closed_ms ?? 0));
  }
  blockedOf(account: string, names: string[]): string[] {
    if (!names.length) return [];
    const wanted = new Set(names);
    return [...new Set([...(this.cache.get(account)?.values() ?? [])].filter(r => r.closed_ms === null && wanted.has(r.name)).map(r => r.name))];
  }
  private arm() {
    const pending = this.ctx.storage.kv.get<Reconnect>(RECONNECT) ?? {};
    const expiry = this.sql.exec('SELECT MIN(closed_ms) AS oldest FROM approvals WHERE closed_ms IS NOT NULL').toArray()[0]?.oldest;
    const due = Math.min(...Object.values(pending).map(p => p.due), ...this.offlineHosts().map(h => h.due), expiry == null ? Infinity : (expiry as number) + DAY);
    this.ctx.storage.kv.delete(DUE);
    if (due !== Infinity) this.ctx.waitUntil(this.d.schedule(DUE, Math.max(0, due - now())));
  }
  nextDue() { return this.ctx.storage.kv.get<number>(DUE) ?? Infinity; }
  alarm(t: number) {
    if (this.nextDue() > t) return;
    for (const host of this.offlineHosts()) if (host.due <= t) this.dropHost(host.name, t);
    const pending = this.ctx.storage.kv.get<Reconnect>(RECONNECT) ?? {};
    const changed = new Set<string>();
    for (const [host, { due, connection }] of Object.entries(pending)) {
      if (due > t) continue;
      const seen = new Set(this.ctx.getWebSockets(`host:${host}`).filter(w => (w.deserializeAttachment() as Host).approvalConnection === connection).flatMap(w => (w.deserializeAttachment() as Host).approvalSeen ?? []));
      for (const r of this.sql.exec('SELECT id, account FROM approvals WHERE host = ? AND closed_ms IS NULL', host).toArray()) {
        if (seen.has(r.id as string)) continue;
        this.sql.exec("UPDATE approvals SET status = 'gone', closed_ms = ? WHERE id = ?", t, r.id);
        this.cacheRow(r.id as string);
        changed.add(r.account as string);
      }
      delete pending[host];
    }
    if (Object.keys(pending).length) this.ctx.storage.kv.put(RECONNECT, pending); else this.ctx.storage.kv.delete(RECONNECT);
    this.sql.exec('DELETE FROM approvals WHERE closed_ms <= ?', t - DAY);
    for (const cards of this.cache.values()) for (const [id, r] of cards) if (r.closed_ms !== null && r.closed_ms <= t - 600_000) cards.delete(id);
    if (!this.sql.exec('SELECT 1 FROM approvals LIMIT 1').toArray().length) this.ctx.storage.kv.delete(PRESENT);
    for (const account of changed) this.broadcast(account);
    this.arm();
  }
}
