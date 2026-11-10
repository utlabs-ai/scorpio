// Memo owns its five tables and KV keys. Message-source reads and messages.memo writes go through Messages;
// task-source reads go through Tasks. No memo write is a message or a daily-quota event (docs/api/memo.md).
import { ApiError, now } from '../util';
import { memoText } from '../memo-text';
import { canWriteMemo, countMemo, evictionPick, longChange, promotable, voteDelta, referenceNumbers, memoRefs, shorterPercent } from '../memo-rules';
import { memoNext } from '../memo-errors';
import type { Lang } from '../layout';
import { rateStep } from '../room-items';
import { likeTerms, searchSnippet } from '../search';
import { remember, replay, toBrowsers, toHosts, tx, wrap } from './kernel';
import type { Actor, Result, Row } from './kernel';
import type { Memo, LongSlot, MemoLog, MemoState, MemoQuery, MemoOp, MemoIds, MemoReceipt } from '../memo-types';
import type { SearchPage, SearchQuery } from '../search';
import type { SendSteps } from './messages';
import type { SendOp } from './types';

type Route = { closers: string[] };
export interface MemoDeps {
  sql(): SqlStorage; ctx(): DurableObjectState;
  schedule(key: string, ms: number): Promise<void>;
  room: { requireWritable(): void; id(): string };
  members: { reader(actor: Actor): Row | null; require(actor: Actor): Row };
  messages: { exists(seq: number): boolean; writeMemo(seq: number, value: MemoReceipt): void };
  tasks: { exists(n: number): boolean };
}
const mid = (n: number) => `M${n}`;
const lid = (n: number) => `L${n}`;
const LONG_READ = 'SELECT *, LAG(text) OVER (PARTITION BY slot ORDER BY version) AS previous_text FROM memo_long';
const numbers = (s: SqlStorageValue | undefined): number[] => s ? JSON.parse(s as string) : [];
const ids = (ns: number[]) => ns.map(mid);

export class Memos implements SendSteps<MemoIds, Route, MemoReceipt> {
  constructor(private readonly d: MemoDeps) {}
  private get sql() { return this.d.sql(); }
  private get ctx() { return this.d.ctx(); }
  private get kv() { return this.ctx.storage.kv; }
  private round() { return this.kv.get<number>('memoRound') ?? 0; }
  // The page's language for this call's error next lines; agents always get en.
  private lang: Lang = 'en';
  private speaking<T>(lang: Lang, fn: () => T): T {
    this.lang = lang;
    try { return fn(); } finally { this.lang = 'en'; }
  }
  private error(code: keyof typeof import('../memo-errors').MEMO_NEXT, status: number, values: Record<string, string | number> = {}, extra?: Record<string, unknown>): never {
    throw new ApiError(code === 'long_too_long' ? 'memo_too_long' : code === 'memo_gone' || code === 'version_gone' ? 'memo_not_found' : code, memoNext(code, { topicId: this.d.room.id(), ...values }, this.lang), status, undefined, extra);
  }
  static migrate(sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        n INTEGER PRIMARY KEY, text TEXT NOT NULL, by_name TEXT NOT NULL, by_kind TEXT NOT NULL,
        source_seq INTEGER, source_item INTEGER, created_ms INTEGER NOT NULL, state TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0, last_used_ms INTEGER NOT NULL, entered_round INTEGER NOT NULL,
        replaces INTEGER, left_ms INTEGER, left_by TEXT, left_to TEXT, rounds INTEGER
      );
      CREATE INDEX IF NOT EXISTS memos_state ON memos(state, score, last_used_ms);
      CREATE TABLE IF NOT EXISTS memo_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, kind TEXT NOT NULL, delta INTEGER NOT NULL,
        by_name TEXT NOT NULL, by_account TEXT NOT NULL, seq INTEGER, day INTEGER NOT NULL, counted INTEGER NOT NULL, ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memo_scores_n ON memo_scores(n, id);
      CREATE INDEX IF NOT EXISTS memo_scores_day ON memo_scores(n, by_name, kind, day);
      CREATE TABLE IF NOT EXISTS memo_votes (n INTEGER NOT NULL, account TEXT NOT NULL, vote INTEGER NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY(n, account)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS memo_long (
        slot INTEGER NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, by_name TEXT NOT NULL, by_kind TEXT NOT NULL, ms INTEGER NOT NULL,
        refs TEXT NOT NULL DEFAULT '[]', merged TEXT NOT NULL DEFAULT '[]', restored_from INTEGER, big INTEGER NOT NULL DEFAULT 0, lost TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(slot, version)
      );
      CREATE TABLE IF NOT EXISTS memo_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL, by_name TEXT NOT NULL, by_kind TEXT NOT NULL,
        op TEXT NOT NULL, n INTEGER, slot INTEGER, version INTEGER, data TEXT
      );
    `);
  }
  private n(value: unknown): number {
    const match = typeof value === 'string' ? /^M([1-9]\d*)$/.exec(value) : null;
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new ApiError('bad_request', 'Name a short memo as M followed by its number.');
    return Number(match[1]);
  }
  private slot(value: unknown): number {
    if (value !== 'L1' && value !== 'L2') throw new ApiError('bad_request', 'slot must be L1 or L2.');
    return Number(value.slice(1));
  }
  private version(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ApiError('bad_request', 'version must be the nonnegative whole version number you read.');
    return value as number;
  }
  private rows(ns: number[]): Row[] {
    return ns.length ? this.sql.exec('SELECT * FROM memos WHERE n IN (SELECT value FROM json_each(?))',JSON.stringify(ns)).toArray() : [];
  }
  private row(n: number): Row {
    const row = this.sql.exec('SELECT * FROM memos WHERE n = ?', n).toArray()[0];
    if (!row) this.error(n <= (this.kv.get<number>('lastMemo') ?? 0) ? 'memo_gone' : 'memo_not_found', 404, { id: mid(n) });
    return row;
  }
  private inSlot(row: Row) {
    if (row.state !== 'slot') this.error('not_in_slot', 409, { id: mid(row.n as number), state: row.state as string });
  }
  private voteMap(ns: number[]) {
    const votes = new Map<number, Memo['votes']>();
    if (ns.length) for (const r of this.sql.exec('SELECT n, account, vote FROM memo_votes WHERE n IN (SELECT value FROM json_each(?)) ORDER BY account', JSON.stringify(ns)).toArray()) {
      const v = votes.get(r.n as number) ?? { good: [], bad: [] };
      v[r.vote === 2 ? 'good' : 'bad'].push(r.account as string); votes.set(r.n as number, v);
    }
    return votes;
  }
  private memos(rows: Row[]): Memo[] {
    const ns = rows.map(r => r.n as number), votes = this.voteMap(ns), round = this.round();
    const misled = new Map<number, number>();
    if (ns.length) for (const r of this.sql.exec("SELECT n,COUNT(*) AS count FROM memo_scores WHERE n IN (SELECT value FROM json_each(?)) AND kind='misled' AND counted=1 GROUP BY n",JSON.stringify(ns)).toArray()) misled.set(r.n as number,r.count as number);
    return rows.map(r => ({ id: mid(r.n as number), text: r.text as string, by: r.by_name as string, byKind: r.by_kind as string,
      from: r.source_seq != null ? `#${r.source_seq}` : `T${r.source_item}`, score: r.score as number, misled: misled.get(r.n as number) ?? 0,
      rounds: r.state === 'slot' ? round - (r.entered_round as number) : r.rounds as number,
      promotable: promotable(r.state as string, r.entered_round as number, round, r.score as number),
      lastUsedMs: r.last_used_ms as number, createdMs: r.created_ms as number, replaces: r.replaces == null ? null : mid(r.replaces as number),
      votes: votes.get(r.n as number) ?? {good: [], bad: []},
      ...(r.state === 'slot' ? {} : {state: r.state as string, leftMs: r.left_ms as number | null, leftBy: r.left_by as string | null, leftTo: r.left_to as string | null}),
    }));
  }
  private memo(n: number) { return this.memos([this.row(n)])[0]; }
  private current(slot: number): Row | undefined { return this.sql.exec(`SELECT * FROM (${LONG_READ}) WHERE slot = ? ORDER BY version DESC LIMIT 1`, slot).toArray()[0]; }
  private long(row: Row | undefined, slot: number): LongSlot {
    return { slot: lid(slot), version: row?.version as number ?? 0, text: row?.text as string ?? '', by: row?.by_name as string ?? null,
      byKind: row?.by_kind as string ?? null, ms: row?.ms as number ?? null, refs: ids(numbers(row?.refs)), merged: ids(numbers(row?.merged)), big: !!row?.big, restoredFrom: row?.restored_from as number ?? null, lost: ids(numbers(row?.lost)), shorter: shorterPercent(row?.previous_text as string ?? null,row?.text as string ?? '') };
  }
  private logs(rows: Row[]): MemoLog[] {
    return rows.map(r => ({ id: r.id as number, ms: r.ms as number, by: r.by_name as string, byKind: r.by_kind as string,
      op: r.op as string, m: r.n == null ? null : mid(r.n as number), slot: r.slot == null ? null : lid(r.slot as number), version: r.version as number | null,
      ...(r.data ? JSON.parse(r.data as string) : {}),
    }));
  }
  state(): MemoState {
    const short = this.memos(this.sql.exec("SELECT * FROM memos WHERE state = 'slot' ORDER BY n").toArray());
    const log = this.logs(this.sql.exec('SELECT * FROM memo_log ORDER BY id DESC LIMIT 50').toArray().reverse());
    return { nextId: mid((this.kv.get<number>('lastMemo') ?? 0)+1), long: [this.long(this.current(1),1), this.long(this.current(2),2)], short,
      retired: this.sql.exec("SELECT COUNT(*) AS n FROM memos WHERE state != 'slot'").one().n as number,
      pending: short.filter(m => m.promotable).map(m => m.id), round: this.round(), cites: this.kv.get<number>('memoCites') ?? 0,
      log, logLast: log.at(-1)?.id ?? 0 };
  }
  frame() { return JSON.stringify({ type: 'memo', ...this.state() }); }
  private changed() { this.ctx.waitUntil(this.d.schedule('memoDue', 1000)); }
  nextDue(): number { return this.kv.get<number>('memoDue') ?? Infinity; }
  alarm(at: number) {
    if (this.nextDue() > at) return;
    this.kv.delete('memoDue');
    const frame = this.frame(); toBrowsers(this.ctx, frame); toHosts(this.ctx, frame);
  }
  private trimLog() {
    this.sql.exec('DELETE FROM memo_log WHERE id <= (SELECT COALESCE(MAX(id),0)-500 FROM memo_log)');
  }
  private trimRetired() {
    const ns=this.sql.exec("SELECT n FROM memos WHERE state != 'slot' ORDER BY left_ms DESC,n DESC LIMIT -1 OFFSET 50").toArray().map(r => r.n);
    if (!ns.length) return;
    const list=JSON.stringify(ns);
    this.sql.exec('DELETE FROM memo_scores WHERE n IN (SELECT value FROM json_each(?))',list);
    this.sql.exec('DELETE FROM memo_votes WHERE n IN (SELECT value FROM json_each(?))',list);
    this.sql.exec('DELETE FROM memos WHERE n IN (SELECT value FROM json_each(?))',list);
  }
  private log(actor: Pick<Actor, 'name' | 'kind'>, op: string, n: number | null = null, slot: number | null = null, version: number | null = null, data: Record<string, unknown> = {}) {
    this.sql.exec('INSERT INTO memo_log (ms, by_name, by_kind, op, n, slot, version, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', now(), actor.name, actor.kind, op, n, slot, version, JSON.stringify(data));
  }
  private contains(ns: number[]) {
    return [1,2].flatMap(slot => {
      const refs = numbers(this.current(slot)?.refs).filter(n => ns.includes(n));
      return refs.length ? [{slot: lid(slot), memos: ids(refs)}] : [];
    });
  }
  private leave(row: Row, state: string, by: string, to: string | null) {
    this.sql.exec('UPDATE memos SET state = ?, left_ms = ?, left_by = ?, left_to = ?, rounds = ? WHERE n = ?', state, now(), by, to, this.round() - (row.entered_round as number), row.n);
  }
  private evict(actor: Actor, incoming: number): number | null {
    const slots = this.sql.exec("SELECT * FROM memos WHERE state = 'slot'").toArray();
    if (slots.length < 8) return null;
    const pick = evictionPick(slots as unknown as Parameters<typeof evictionPick>[0], this.round())!;
    this.leave(slots.find(r => r.n === pick.n)!, 'evicted', 'scorpio', null);
    this.kv.put('memoRound', this.round() + 1);
    this.log(actor, 'evict', pick.n, null, null, { for: mid(incoming), score: pick.score, contains: this.contains([pick.n]) });
    return pick.n;
  }
  private clean(value: unknown, short: boolean, slot = 1) {
    const out = memoText(value, short);
    if (out.invalid || (short && !out.text)) throw new ApiError('bad_request', 'Memo text must be text without control characters; a short memo cannot be empty.');
    if (out.length > (short ? 500 : 3500)) this.error(short ? 'memo_too_long' : 'long_too_long', 413, { slot: lid(slot), count: out.length.toLocaleString('en-US') });
    return out;
  }
  private source(value: unknown): { seq: number | null; item: number | null } {
    if (value == null || value === '') this.error('source_required', 400);
    const match = typeof value === 'string' ? /^([#T])([1-9]\d*)$/.exec(value) : null;
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw new ApiError('bad_request', 'from= must be a message (#123) or task (T45).');
    const n = Number(match[2]);
    if (!(match[1] === '#' ? this.d.messages.exists(n) : this.d.tasks.exists(n))) this.error('source_not_found', 404, {source: match[1] === '#' ? `${this.lang === 'zh' ? '消息' : 'message'} #${n}` : `${this.lang === 'zh' ? '任务' : 'task'} T${n}`});
    return { seq: match[1] === '#' ? n : null, item: match[1] === 'T' ? n : null };
  }
  private rate(long: boolean) {
    const at = now();
    for (const [key, period, max] of [['memoWrites',60_000,60], ...(long ? [['memoLongWrites',3_600_000,30] as const] : [])] as const) {
      const bucket = Math.floor(at / period);
      const step = rateStep(this.kv.get<{minute:number;n:number}>(key) ?? {minute:0,n:0}, bucket, max);
      if (step.over) { const seconds = Math.max(1, Math.ceil(((bucket + 1) * period - at) / 1000)); throw new ApiError('rate_limited', memoNext('rate_limited', {seconds}, this.lang), 429, seconds); }
      this.kv.put(key, step.state);
    }
  }
  async read(actor: Actor, p: MemoQuery = {}, lang: Lang = 'en'): Promise<Result<Record<string, unknown>>> {
    return this.speaking(lang, () => wrap(() => {
      this.d.members.reader(actor);
      if ([p.retired !== undefined, p.show !== undefined, p.versions !== undefined].filter(Boolean).length > 1) throw new ApiError('bad_request', 'Choose retired, show or versions.');
      if (p.show !== undefined) {
        const n = this.n(p.show), memo = this.memo(n);
        const scores = this.sql.exec('SELECT * FROM memo_scores WHERE n = ? ORDER BY id', n).toArray().map(r => ({kind:r.kind,delta:r.delta,by:r.by_name,seq:r.seq,counted:!!r.counted,
          ...(!r.counted ? {reason:r.kind === 'cite' && r.by_name === memo.by ? 'own' : 'today'} : {}),ms:r.ms}));
        return { memo, scores, halvings: this.logs(this.sql.exec("SELECT * FROM memo_log WHERE op = 'halve' AND ms >= ? ORDER BY id", memo.createdMs).toArray()), log: this.logs(this.sql.exec('SELECT * FROM memo_log WHERE n = ? OR (op = \'merge\' AND EXISTS (SELECT 1 FROM json_each(memo_log.data, \'$.merged\') WHERE value = ?)) ORDER BY id', n, mid(n)).toArray()) };
      }
      const pageLimit = (max: number, fallback: number) => {
        const n = p.limit === undefined ? fallback : Number(p.limit);
        if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ApiError('bad_request', `limit must be 1–${max}.`);
        return n;
      };
      if (p.retired !== undefined) {
        if (p.retired !== '1' && p.retired !== 'true') throw new ApiError('bad_request', 'retired must be 1.');
        const n = pageLimit(50,20), before = p.before ? this.row(this.n(p.before)) : null;
        if (before?.state === 'slot') throw new ApiError('bad_request', 'before must name a retired memo.');
        const rows = this.sql.exec(`SELECT * FROM memos WHERE state != 'slot'${before ? ' AND (left_ms < ? OR (left_ms = ? AND n < ?))' : ''} ORDER BY left_ms DESC, n DESC LIMIT ?`, ...(before ? [before.left_ms,before.left_ms,before.n] : []), n+1).toArray();
        return {memos:this.memos(rows.slice(0,n)),hasMore:rows.length>n};
      }
      if (p.versions !== undefined) {
        const slot = this.slot(p.versions), n = pageLimit(20,10), before = p.before === undefined ? undefined : Number(p.before);
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new ApiError('bad_request','before must be a positive version number.');
        const rows = this.sql.exec(`SELECT * FROM (${LONG_READ}) WHERE slot = ?${before === undefined ? '' : ' AND version < ?'} ORDER BY version DESC LIMIT ?`, slot, ...(before === undefined ? [] : [before]), n+1).toArray();
        return {versions:rows.slice(0,n).map(r => this.long(r,slot)),hasMore:rows.length>n};
      }
      if (p.before !== undefined || p.limit !== undefined) throw new ApiError('bad_request','limit and before require retired or versions.');
      const { log, logLast, ...state } = this.state();
      return {roomId:this.d.room.id(),...state};
    }));
  }
  async write(actor: Actor, p: MemoOp, page = false, lang: Lang = 'en'): Promise<Result<Record<string, unknown>>> {
    let wrote = false;
    const result = this.speaking(lang, () => wrap(() => {
      const member = this.d.members.require(actor);
      if (!canWriteMemo(member.kind as string)) throw new ApiError('forbidden', 'Only active people and agents write memos.', 403);
      this.d.room.requireWritable();
      if (p.op === 'vote' && (!page || actor.kind !== 'human' || member.kind !== 'human' || actor.name !== actor.account)) throw new ApiError('forbidden', 'Only a person on the topic page votes on a memo.',403);
      const sender = `memo:${actor.name}`, again = replay(this.sql, sender, p.nonce);
      if (again) return again;
      return tx(this.ctx, () => {
        this.rate(p.op === 'long' || (p.op === 'restore' && p.slot !== undefined));
        let answer: Record<string,unknown>;
        if (p.op === 'add') answer = this.add(actor,p);
        else if (p.op === 'retire') { const n=this.n(p.id), row=this.row(n); this.inSlot(row); this.leave(row,'retired',actor.name,null); this.log(actor,'retire',n,null,null,{contains:this.contains([n])}); answer={memo:this.memo(n)}; }
        else if (p.op === 'restore' && p.slot === undefined) answer=this.restoreShort(actor,p);
        else if (p.op === 'long' || p.op === 'restore') answer=this.writeLong(actor,p);
        else if (p.op === 'vote') answer=this.vote(actor,p);
        else throw new ApiError('bad_request','op must be add, retire, restore, long or vote.');
        this.trimRetired();
        this.trimLog();
        wrote = true;
        return remember(this.sql,sender,p.nonce,answer);
      });
    }));
    if ('ok' in result && wrote) this.changed();
    return result;
  }
  private add(actor: Actor,p: MemoOp) {
    const clean=this.clean(p.text,true), source=this.source(p.from), replaces=p.replaces === undefined ? null : this.row(this.n(p.replaces));
    if (replaces) this.inSlot(replaces);
    const n=(this.kv.get<number>('lastMemo') ?? 0)+1;
    const evicted=replaces ? null : this.evict(actor,n), score=replaces?.score ?? 0;
    if (replaces) this.leave(replaces,'replaced',actor.name,mid(n));
    this.sql.exec("INSERT INTO memos (n,text,by_name,by_kind,source_seq,source_item,created_ms,state,score,last_used_ms,entered_round,replaces) VALUES (?,?,?,?,?,?,?,'slot',?,?,?,?)",n,clean.text,actor.name,actor.kind,source.seq,source.item,now(),score,now(),this.round(),replaces?.n ?? null);
    this.kv.put('lastMemo',n);
    if (replaces) this.score(n,'carry',score as number,actor,null,true);
    this.log(actor,replaces ? 'replace' : 'add',n,null,null,{text:clean.text,from:p.from,...(replaces ? {replaces:mid(replaces.n as number),replacedBy:actor.name,replacedByKind:actor.kind,carried:score,contains:this.contains([replaces.n as number])} : {})});
    return {memo:this.memo(n),removed:clean.removed,evicted:evicted == null ? null : this.memo(evicted),replaced:replaces ? this.memo(replaces.n as number) : null};
  }
  private restoreShort(actor: Actor,p: MemoOp) {
    const n=this.n(p.id), row=this.row(n);
    if (row.state === 'slot') this.error('already_in_slot',409,{id:mid(n)});
    const evicted=this.evict(actor,n);
    this.sql.exec("UPDATE memos SET state='slot', score=?, entered_round=?, last_used_ms=?, left_ms=NULL, left_by=NULL, left_to=NULL, rounds=NULL WHERE n=?",row.state === 'replaced' ? 0 : row.score,this.round(),now(),n);
    this.log(actor,'restore',n,null,null,{text:row.text});
    return {memo:this.memo(n),evicted:evicted == null ? null : this.memo(evicted)};
  }
  private refs(text: string): number[] {
    const ns=referenceNumbers(text);
    const existing=ns.length ? this.sql.exec('SELECT n FROM memos WHERE n IN (SELECT value FROM json_each(?)) ORDER BY n',JSON.stringify(ns)).toArray().map(r => r.n as number) : [];
    return memoRefs(text,existing);
  }
  private list(value: unknown): number[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8) throw new ApiError('bad_request','merged, cite and misled take at most eight M numbers each.');
    return [...new Set(value.map(v => this.n(v)))];
  }
  private writeLong(actor: Actor,p: MemoOp) {
    const slot=this.slot(p.slot), previous=this.current(slot), version=this.version(p.version);
    const old=this.long(previous,slot);
    let restored: Row | undefined;
    if (p.op === 'restore') {
      restored=this.sql.exec('SELECT * FROM memo_long WHERE slot=? AND version=?',slot,version).toArray()[0];
      if (!restored) {
        if (version > 0 && version <= old.version) this.error('version_gone',404,{slot:lid(slot),version});
        this.error('memo_not_found',404,{id:`${lid(slot)} v${version}`});
      }
    } else if (version !== old.version) this.error('version_conflict',409,{slot:lid(slot),version:old.version,by:old.by ?? '',time:new Date(old.ms ?? 0).toISOString().slice(11,16)},{current:{slot:old.slot,version:old.version,text:old.text,by:old.by,ms:old.ms}});
    const clean=this.clean(restored?.text ?? p.text,false,slot), merged=p.op === 'restore' ? [] : this.list(p.merged), refs=this.refs(clean.text);
    const rows=merged.map(n => this.row(n)); rows.forEach(r => this.inSlot(r));
    const missing=merged.filter(n => !refs.includes(n));
    if (missing.length) this.error('merge_unnamed',400,{missing:ids(missing).join(', ')});
    const priorRefs=numbers(previous?.refs);
    const ever=priorRefs.length ? this.sql.exec('SELECT DISTINCT j.value AS n FROM memo_long, json_each(memo_long.merged) j WHERE slot=? AND version>? AND j.value IN (SELECT value FROM json_each(?))',slot,old.version+1-10,JSON.stringify(priorRefs)).toArray().map(r => r.n as number) : [];
    const change=longChange(old.text,clean.text,ever,priorRefs,refs), next=old.version+1;
    this.sql.exec('INSERT INTO memo_long (slot,version,text,by_name,by_kind,ms,refs,merged,restored_from,big,lost) VALUES (?,?,?,?,?,?,?,?,?,?,?)',slot,next,clean.text,actor.name,actor.kind,now(),JSON.stringify(refs),JSON.stringify(merged),restored ? version : null,change.big ? 1 : 0,JSON.stringify(change.lost));
    this.sql.exec('DELETE FROM memo_long WHERE slot=? AND version<=?',slot,next-10);
    rows.forEach(r => this.leave(r,'merged',actor.name,`${lid(slot)} v${next}`));
    this.log(actor,'long',null,slot,next,{big:change.big,shorter:change.shorter,lost:ids(change.lost)});
    if (merged.length) this.log(actor,'merge',null,slot,next,{merged:ids(merged)});
    return p.op === 'restore' ? {long:this.long(this.current(slot),slot)} : {long:this.long(this.current(slot),slot),removed:clean.removed,merged:this.memos(rows.map(r => this.row(r.n as number)))};
  }
  private score(n: number,kind: string,delta: number,actor: Actor,seq: number | null,counted: boolean) {
    this.sql.exec('INSERT INTO memo_scores(n,kind,delta,by_name,by_account,seq,day,counted,ms) VALUES(?,?,?,?,?,?,?,?,?)',n,kind,delta,actor.name,actor.account,seq,Math.floor(now()/86_400_000),counted ? 1 : 0,now());
    this.sql.exec(`DELETE FROM memo_scores WHERE n=? AND id < (SELECT id FROM memo_scores WHERE n=? ORDER BY id DESC LIMIT 1 OFFSET 99) AND NOT (day=? AND kind IN ('cite','misled'))`,n,n,Math.floor(now()/86_400_000));
  }
  private vote(actor: Actor,p: MemoOp) {
    const n=this.n(p.id), row=this.row(n); this.inSlot(row);
    if (!['good','bad','none'].includes(p.vote as string)) throw new ApiError('bad_request','vote must be good, bad or none.');
    const previous=(this.sql.exec('SELECT vote FROM memo_votes WHERE n=? AND account=?',n,actor.account).toArray()[0]?.vote as number) ?? 0;
    const next=p.vote === 'good' ? 2 : p.vote === 'bad' ? -2 : 0, delta=voteDelta(previous,next);
    if (delta) {
      if (next) this.sql.exec('INSERT OR REPLACE INTO memo_votes(n,account,vote,ms) VALUES(?,?,?,?)',n,actor.account,next,now());
      else this.sql.exec('DELETE FROM memo_votes WHERE n=? AND account=?',n,actor.account);
      this.sql.exec('UPDATE memos SET score=score+? WHERE n=?',delta,n);
      this.score(n,next === 0 ? 'unvote' : next === 2 ? 'good' : 'bad',delta,actor,null,true);
      if (next === -2) this.log(actor,'lower',n,null,null,{reason:'bad',delta,score:(row.score as number)+delta,contains:this.contains([n])});
    }
    return {memo:this.memo(n)};
  }

  // SendSteps: the existing task checks retain their original positions; memo checks run immediately after them.
  refuseSend(p: SendOp, scheduled = false) {
    if (scheduled && (p.cite !== undefined || p.misled !== undefined)) throw new ApiError('bad_request','A scheduled message cannot carry cite or misled.');
  }
  addressed(p: SendOp, actor: Actor) {
    if ((p.cite !== undefined || p.misled !== undefined) && !canWriteMemo(this.d.members.require(actor).kind as string)) throw new ApiError('forbidden','Only active people and agents score memos.',403);
  }
  route(): Route { return {closers:[]}; }
  prepare(p: SendOp): MemoIds {
    const cite=this.list(p.cite), misled=this.list(p.misled);
    if (cite.some(n => misled.includes(n))) throw new ApiError('bad_request','A memo cannot be both cited and misled in one message.');
    const known=new Set(this.rows([...cite,...misled]).map(r => r.n));
    for (const n of [...cite,...misled]) if (!known.has(n) && n > (this.kv.get<number>('lastMemo') ?? 0)) this.error('memo_not_found',404,{id:mid(n)});
    return {cite,misled};
  }
  attach(seq: number,actor: Actor,p: SendOp,prep: MemoIds): {added: MemoReceipt | null} {
    if (!prep.cite.length && !prep.misled.length) return {added:null};
    const out: MemoReceipt={cite:[],misled:[]}, day=Math.floor(now()/86_400_000);
    const ns=[...prep.cite,...prep.misled], memos=new Map(this.rows(ns).map(r => [r.n as number,r]));
    const today=new Set(this.sql.exec("SELECT n,kind FROM memo_scores WHERE n IN (SELECT value FROM json_each(?)) AND by_name=? AND day=? AND counted=1 AND kind IN ('cite','misled')",JSON.stringify(ns),actor.name,day).toArray().map(r => `${r.kind}:${r.n}`));
    // Both current long slots are read once, even when this message lowers several memos.
    const containing=this.contains(ns);
    const lowered: number[]=[];
    for (const kind of ['cite','misled'] as const) for (const n of prep[kind]) {
      const row=memos.get(n);
      if (!row) { out[kind].push({id:mid(n),counted:false,reason:'gone'}); continue; }
      const decision=countMemo(kind,row.by_name as string,actor.name,today.has(`${kind}:${n}`));
      if (decision.counted) {
        this.score(n,kind,decision.delta,actor,seq,true);
        this.sql.exec('UPDATE memos SET score=score+? WHERE n=?',decision.delta,n);
        if (kind === 'cite') {
          this.sql.exec('UPDATE memos SET last_used_ms=? WHERE n=?',now(),n);
          const cites=(this.kv.get<number>('memoCites') ?? 0)+1;
          if (cites === 32) { this.sql.exec('UPDATE memos SET score=score/2'); this.kv.put('memoCites',0); this.log(actor,'halve'); }
          else this.kv.put('memoCites',cites);
        } else lowered.push(n);
      }
      out[kind].push({id:mid(n),counted:decision.counted,score:0,...('reason' in decision ? {reason:decision.reason} : {})});
    }
    // A halving caused by a later cite in this message also affects earlier entries.
    const finalScores=new Map(this.rows(ns).map(r => [mid(r.n as number),r.score as number]));
    for (const part of [out.cite,out.misled]) for (const entry of part) if (entry.reason !== 'gone') entry.score=finalScores.get(entry.id)!;
    for (const n of lowered) this.log(actor,'lower',n,null,null,{reason:'misled',seq,delta:-2,score:finalScores.get(mid(n)),contains:containing.flatMap(c => c.memos.includes(mid(n)) ? [{slot:c.slot,memos:[mid(n)]}] : [])});
    this.trimLog();
    this.d.messages.writeMemo(seq,out);
    return {added:out};
  }
  after(_seq: number,_actor: Actor,p: SendOp) { if ((Array.isArray(p.cite) && p.cite.length) || (Array.isArray(p.misled) && p.misled.length)) this.changed(); }
  answer(_seq: number,_actor: Actor,_p: SendOp,_limits: unknown,out: Record<string,unknown>,added: MemoReceipt | null) { if (added) out.memo=added; }
  replay(row: Row,out: Record<string,unknown>) {
    if (!row.memo) return;
    out.memo=JSON.parse(row.memo as string);
  }
  search(p: SearchQuery): SearchPage {
    const match=likeTerms('m.text',p.terms), args: (string|number)[]=[...match.args], clauses=[match.sql];
    if (p.by?.length) { clauses.push(`m.by_name IN (${p.by.map(()=>'?').join(',')})`); args.push(...p.by); }
    if (p.since !== undefined) {clauses.push('m.ms >= ?');args.push(p.since);}
    if (p.until !== undefined) {clauses.push('m.ms < ?');args.push(p.until);}
    const direction=p.order === 'asc' ? 'ASC' : 'DESC';
    const rows=this.sql.exec(`SELECT m.* FROM (
      SELECT 'M'||n AS id,text,by_name,created_ms AS ms,source_seq AS seq,state FROM memos
      UNION ALL SELECT 'L'||l.slot,text,by_name,ms,NULL,'long' FROM memo_long l WHERE version=(SELECT MAX(version) FROM memo_long WHERE slot=l.slot)
    ) m WHERE ${clauses.join(' AND ')} ORDER BY m.ms ${direction}, m.id ${direction} LIMIT ?`,...args,p.limit+1).toArray();
    return {hits:rows.slice(0,p.limit).map(r => ({type:'memo',id:r.id as string,seq:r.seq as number|null,who:r.by_name as string,ts:r.ms as number,snippet:searchSnippet(r.text as string,p.terms),status:r.state as string})),hasMore:rows.length>p.limit};
  }
}
