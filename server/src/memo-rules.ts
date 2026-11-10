// Memo decisions from plain values, without storage, HTTP or domain dependencies.
export type SlotCandidate = { n: number; score: number; last_used_ms: number; entered_round: number };
export function referenceNumbers(text: string): number[] {
  return [...new Set([...text.matchAll(/\bM(\d+)\b/g)].map(m => Number(m[1])).filter(Number.isSafeInteger))].sort((a,b) => a-b);
}
export function memoRefs(text: string, existing: readonly number[]): number[] {
  const known = new Set(existing);
  return referenceNumbers(text).filter(n => known.has(n));
}
export function evictionPick(slots: readonly SlotCandidate[], round: number): SlotCandidate | null {
  const old = slots.filter(m => m.entered_round < round);
  return [...(old.length ? old : slots)].sort((a, b) => a.score - b.score || a.last_used_ms - b.last_used_ms || a.n - b.n)[0] ?? null;
}
export function promotable(state: string, entered: number, round: number, score: number): boolean { return state === 'slot' && round - entered >= 2 && score >= 3; }
export function longChange(previous: string, text: string, mergedEver: readonly number[], before: readonly number[], refs: readonly number[]) {
  const lost = before.filter(n => mergedEver.includes(n) && !refs.includes(n));
  const oldLength = Array.from(previous).length, length = Array.from(text).length;
  return { lost, big: (oldLength > 0 && length < oldLength * 0.75) || lost.length > 0, shorter: oldLength > length ? Math.round((1 - length / oldLength) * 100) : 0 };
}
export function halveScore(score: number): number { return Math.trunc(score / 2) || 0; }
export function countMemo(kind: 'cite' | 'misled', author: string, sender: string, countedToday: boolean) {
  if (kind === 'cite' && author === sender) return { counted: false, reason: 'own' as const, delta: 0 };
  if (countedToday) return { counted: false, reason: 'today' as const, delta: 0 };
  return { counted: true, delta: kind === 'cite' ? 1 : -2 };
}
export function voteDelta(previous: number, next: number): number { return next - previous; }

export function canWriteMemo(kind: string): boolean { return kind === 'human' || kind === 'agent'; }

export function shorterPercent(previous: string | null, text: string): number | null {
  if (previous === null) return null;
  const oldLength = Array.from(previous).length, length = Array.from(text).length;
  return oldLength > length ? Math.round((1 - length / oldLength) * 100) : 0;
}
