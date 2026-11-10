/** Phone approval values and decisions (docs/api/daemon.md). No terminal or transport access. */
export type ApprovalStatus = 'open' | 'answering' | 'answered' | 'answered_here' | 'changed' | 'expired' | 'gone';
export interface ApprovalMenu {
  question: string[];
  options: { n: number; label: string; note?: string }[];
  hints: string[];
}
export interface ApprovalOpen {
  id: string; name: string; cli: 'claude' | 'codex';
  detail: { tool: string | null; input: unknown; cwd: string | null; description: string | null } | null;
  menu: ApprovalMenu | null; screen: string | null; ts: number;
}
export interface Approval extends Omit<ApprovalOpen, 'ts'> {
  status: ApprovalStatus;
  answer: { n?: number; key?: string; label: string; message?: string; by: string } | null;
  result: 'ok' | 'failed' | null;
  opened_ms: number; closed_ms: number | null;
}
export type ApprovalAnswerResult = { ok: { approval: Approval } } | {
  err: { code: string; next: string; status: number; approval?: Approval }
};
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
export function validApproval(v: unknown, account: string): v is ApprovalOpen {
  if (!v || typeof v !== 'object') return false;
  const a = v as ApprovalOpen;
  if (!/^[A-Za-z0-9]{16}$/.test(a.id) || typeof a.name !== 'string' ||
      !a.name.endsWith(`@${account}`) || !/^[A-Za-z0-9_.-]{1,62}$/.test(a.name.slice(0, -account.length - 1)) ||
      !['claude', 'codex'].includes(a.cli) || !Number.isFinite(a.ts) ||
      !(a.screen === null || typeof a.screen === 'string') || (a.menu === null && !a.screen)) return false;
  const m = a.menu;
  return m === null || (!!m && strings(m.question) && strings(m.hints) && Array.isArray(m.options) &&
    m.options.length > 0 && m.options.every(o => o && Number.isInteger(o.n) && o.n > 0 && typeof o.label === 'string' &&
      (o.note === undefined || typeof o.note === 'string')) && new Set(m.options.map(o => o.n)).size === m.options.length);
}
export function normalizeApproval(input: ApprovalOpen): ApprovalOpen {
  const detail = input.detail && typeof input.detail === 'object' && !Array.isArray(input.detail) ? input.detail : null;
  return { ...input, detail: detail ? { tool: detail.tool ?? null, input: detail.input ?? null, cwd: detail.cwd ?? null, description: detail.description ?? null } : null };
}
export function approvalAnswerError(a: Approval, body: Record<string, unknown>, keys: { name: string; herdr?: string }[]): string | null {
  if ((body.n === undefined) === (body.key === undefined)) return 'n/key: supply exactly one.';
  if (body.n !== undefined && (!a.menu || !Number.isInteger(body.n) || !a.menu.options.some(o => o.n === body.n))) return 'n: choose an option on this card.';
  if (body.key !== undefined && (a.menu || !keys.some(k => k.name === body.key && k.herdr))) return 'key: choose an available key on a screen-only card.';
  if (body.message !== undefined && (typeof body.message !== 'string' || [...body.message].length > 2000 || !a.menu || a.menu.options.at(-1)?.n !== body.n || !a.menu.options.at(-1)!.label.startsWith('No'))) return 'message: use a string of at most 2000 characters with the last option only, when its label starts with No.';
  return null;
}
export function approvalAnswer(a: Approval, body: Record<string, unknown>, keys: { name: string; label: string; herdr?: string }[], by: string): Approval['answer'] {
  if (approvalAnswerError(a, body, keys)) return null;
  const option = a.menu?.options.find(o => o.n === body.n);
  const key = a.menu ? undefined : keys.find(k => k.name === body.key && k.herdr);
  return { ...(option ? { n: option.n } : { key: key!.name }), label: option?.label ?? key!.label,
    ...(body.message === undefined ? {} : { message: body.message as string }), by };
}
export function approvalViewer(a: { kind?: string; account?: string; viewer?: boolean; tokenId?: string } | null, account: string): boolean {
  return a?.kind === 'human' && !a.tokenId && a.account === account;
}
export const approvalClosed = (s: unknown): s is Exclude<ApprovalStatus, 'open' | 'answering'> =>
  ['answered', 'answered_here', 'changed', 'expired', 'gone'].includes(s as string);

/** Offline retention uses the membership clock, never the card's age. */
export function approvalHostDue(host: { status: string; offline_since?: number | null }): number {
  return host.status === 'active' && host.offline_since != null ? host.offline_since + 86_400_000 : Infinity;
}
