// topic.md, the readable record in an export (docs/api/export.md): pure rendering from the shapes the room answers
// (ExportHead, the message pages), with its headings and labels from strings.ts in the export's language and its
// times in the export's time zone. Message texts, role cards, memos are written as they are: this file adds the
// frame around them, never a translation.
import { ROOM_STRINGS } from "./strings";
import { scheduleRuleText, type Rule } from "./schedules";
import type { Lang } from "./layout";
import type { ExportHead, ExportPart } from "./room/export";
import type { Member, Message } from "./room/types";

export type Labels = (typeof ROOM_STRINGS)["en"]["exportMd"];
export const labels = (lang: Lang): Labels => ROOM_STRINGS[lang].exportMd;

/** A wall-clock moment in a time zone: the fields the zip's DOS time and topic.md's lines need. */
export type Clock = { y: number; mo: number; d: number; h: number; mi: number; s: number };

export function wallClock(ms: number, tz: string): Clock {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: n("year"), mo: n("month"), d: n("day"), h: n("hour") % 24, mi: n("minute"), s: n("second") };
}

const two = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD` of a moment in a time zone: the export's file name. */
export const dateText = (c: Clock) => `${c.y}-${two(c.mo)}-${two(c.d)}`;
/** `YYYY-MM-DD HH:mm`: every time written in topic.md. */
export const timeText = (c: Clock) => `${dateText(c)} ${two(c.h)}:${two(c.mi)}`;

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export type MdContext = {
  lang: Lang;
  tz: string;
  time: (ms: number) => string; // timeText(wallClock(ms, tz))
  exportedAt: number;
  exportedBy: string;
  include: readonly ExportPart[];
  /** The zip path of an attachment that is in files/, by file id; undefined when it is not (not included, or gone). */
  filePath: (id: string) => string | undefined;
};

/** `label：value` in Chinese, `label: value` in English. */
const line = (lang: Lang, label: string, value: string) => `${label}${lang === "zh" ? "：" : ": "}${value}`;
const paren = (lang: Lang, s: string) => (lang === "zh" ? `（${s}）` : ` (${s})`);
/** A multi-line value under a list item: its first line on the item's line, the rest indented under it. */
const indented = (text: string) => text.split("\n").join("\n  ");

export function mdHead(head: ExportHead, c: MdContext): string {
  const t = labels(c.lang);
  const r = head.topic;
  const out = [`# ${r.name}`, ""];
  out.push(`- ${line(c.lang, t.topic, r.name)}`);
  if (r.topic.trim()) out.push(`- ${line(c.lang, t.description, "")}`.trimEnd(), `  ${indented(r.topic.trim())}`);
  out.push(`- ${r.public ? t.public : t.private}${r.status === "archived" ? ` · ${t.archived}` : ""}`);
  out.push(`- ${line(c.lang, t.creator, r.owner)}`);
  out.push(`- ${line(c.lang, t.exportedAt, `${c.time(c.exportedAt)}${paren(c.lang, c.tz)}`)}`);
  out.push(`- ${line(c.lang, t.exportedBy, c.exportedBy)}`);
  out.push(`- ${line(c.lang, t.includes, c.include.join(", "))}`);
  return out.join("\n") + "\n";
}

const kindWord = (t: Labels, kind: string) => (kind === "human" ? t.human : kind === "host" ? t.host : t.agent);

export function mdMembers(members: Member[], lang: Lang): string {
  const t = labels(lang);
  const out = [`## ${t.members}`, ""];
  for (const m of members) {
    const shown = m.displayName && m.displayName !== m.name ? paren(lang, m.displayName) : "";
    out.push(`- ${m.name}${shown} · ${kindWord(t, m.kind)} · ${m.status === "active" ? t.present : t.left}`);
    if (m.roleCard?.trim()) out.push(`  ${line(lang, t.roleCard, "")}`.trimEnd(), `  ${indented(m.roleCard.trim())}`);
  }
  return out.join("\n") + "\n";
}

export const mdMessagesHead = (lang: Lang) => `## ${labels(lang).messages}\n\n`;

/** One message: its line, what it replies to, the text as written, its attachments, card, buttons, and the schedule that sent it. */
export function mdMessage(m: Message, c: MdContext): string {
  const t = labels(c.lang);
  const out = [`#${m.seq} · ${c.time(m.ts)} · ${m.from}`];
  if (m.reply) out.push(`↩ #${m.reply.seq}${paren(c.lang, m.reply.from)}`);
  if (m.text) out.push(m.text);
  for (const f of m.files ?? []) {
    if (f.deleted != null) { out.push(`${line(c.lang, t.attachment, f.name)} · ${t.removed}`); continue; }
    const path = c.filePath(f.id);
    out.push(`${line(c.lang, t.attachment, `${f.name}${paren(c.lang, sizeText(f.size))}`)}${c.lang === "zh" ? "→ " : " → "}${path ?? f.link}`);
  }
  if (m.card) out.push(line(c.lang, t.card, m.card.summary));
  if (m.buttons?.length) out.push(line(c.lang, t.buttons, m.buttons.map((b) => (b.by.length ? `${b.label}${paren(c.lang, b.by.join(", "))}` : b.label)).join(c.lang === "zh" ? "、" : ", ")));
  if (m.scheduled) out.push(`${t.scheduled} ${m.scheduled.id} · ${line(c.lang, t.setBy, m.scheduled.by)}`);
  return out.join("\n") + "\n\n";
}

type TaskBody = { item: { id: string; title: string; status: string; assignee: string | null; createdBy: string; createdSeq: number | null; doneSeq: number | null }; history: { ms: number; by: string; op: string; from: Record<string, unknown> | null; to: Record<string, unknown> | null }[] };

const statusWord = (lang: Lang, status: string) => {
  const s = ROOM_STRINGS[lang];
  return status === "done" ? s.tl_done : status === "doing" ? s.searchStatusDoing : s.searchStatusWaiting;
};

const fields = (v: Record<string, unknown> | null) => (v ? Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`).join(", ") : "");

export function mdTasks(tasks: Record<string, unknown>[], c: MdContext): string {
  const t = labels(c.lang);
  const out = [`## ${t.tasks}`, ""];
  for (const raw of tasks as unknown as TaskBody[]) {
    const i = raw.item;
    const parts = [i.id, i.title, statusWord(c.lang, i.status), i.assignee ?? "—", i.createdBy];
    if (i.createdSeq != null) parts.push(`${t.opened} #${i.createdSeq}`);
    if (i.doneSeq != null) parts.push(`${t.delivered} #${i.doneSeq}`);
    out.push(`### ${parts.join(" · ")}`);
    if (raw.history.length) {
      out.push(`${t.changes}${c.lang === "zh" ? "：" : ":"}`);
      for (const h of raw.history) {
        const change = [fields(h.from), fields(h.to)].filter(Boolean).join(" → ");
        out.push(`- ${c.time(h.ms)} · ${h.by} · ${h.op}${change ? ` · ${change}` : ""}`);
      }
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

type ScheduleItem = { id: string; by: string; text: string; to: string[]; rule: Rule; calendar: boolean; on: boolean; stoppedBy: string | null; stoppedReason: string | null };

export function mdSchedules(items: Record<string, unknown>[], c: MdContext): string {
  const t = labels(c.lang);
  const s = ROOM_STRINGS[c.lang].sched;
  const out = [`## ${t.schedules}`, ""];
  for (const raw of items as unknown as ScheduleItem[]) {
    const tz = (raw.rule as { tz?: string }).tz ?? "UTC";
    const state = raw.on ? s.on : s.stopped.replace("{who}", raw.stoppedBy ?? raw.stoppedReason ?? "");
    const parts = [raw.id, scheduleRuleText(raw.rule, false), tz, raw.to.map((n) => `@${n}`).join(" ") || "—", raw.text.replace(/\s+/g, " ").trim()];
    if (raw.calendar) parts.push(t.inCalendar);
    parts.push(line(c.lang, t.status, state), line(c.lang, t.setBy, raw.by));
    out.push(`- ${parts.join(" · ")}`);
  }
  return out.join("\n") + "\n";
}

type MemoState = { long: { slot: string; version: number; text: string; by: string | null }[]; short: { id: string; text: string; by: string; from: string }[] };

export function mdMemo(memo: Record<string, unknown>, c: MdContext): string {
  const t = labels(c.lang);
  const m = memo as unknown as MemoState;
  const out = [`## ${t.memos}`, ""];
  // A long slot nobody has written yet (version 0, no text) is not a memo: left out.
  for (const l of (m.long ?? []).filter((l) => l.version > 0 || l.text.trim())) {
    out.push(`### ${l.slot} · v${l.version}${l.by ? ` · ${l.by}` : ""}`, "", l.text.trim() || "—", "");
  }
  for (const s of m.short ?? []) out.push(`- ${s.id} · ${s.by} · ${s.from} · ${indented(s.text.trim())}`);
  return out.join("\n") + "\n";
}

export function mdHandoffs(handoffs: { name: string; path: string }[], lang: Lang): string {
  const t = labels(lang);
  const out = [`## ${t.handoffs}`, ""];
  for (const h of handoffs) out.push(`- ${h.name} · ${t.bodyIn} ${h.path}`);
  return out.join("\n") + "\n";
}
