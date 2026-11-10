// Reply-button and card input rules (docs/api/messages.md). Plain values only.
import { labelWidth } from "./room-label-width";
export { labelWidth } from "./room-label-width";

export type Button = { label: string; by: string[] };
export type Card = { kind: "html"; summary: string; html: string; size: number };
type Error = { code: string; next: string; status: number };
export const CARD_MAX = 256 * 1024;
const ONE_LINE = /[\p{Cc}\u2028\u2029]/u;
const NEXT = {
  bad_buttons: {
    zh: "按钮最多 4 个，每个最多 12 个汉字或 24 个英文字符、一行、互不相同；去掉多的或缩短后再发。",
    en: "Buttons: 1 to 4 per message, up to 12 CJK or 24 Latin characters each, on one line, all different. Trim them and send again.",
  },
  card_too_large: {
    zh: "卡片 HTML 超过 256 KB；把数据聚合、抽样或减少位数，去掉没用的部分再发。",
    en: "The card is over 256 KB. Aggregate or downsample the data, drop unused parts, and send again.",
  },
  card_summary_required: {
    zh: "卡片要带一句文字摘要（summary=，1 到 300 字、一行）：图说明什么、关键数是多少；搜索和看不到图的人读的就是它。",
    en: "A card needs summary= (1 to 300 characters, one line): what the chart shows and its key numbers. Search and anyone who cannot see the chart read that line.",
  },
};
export function validButtons(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 4 &&
    value.every(s => typeof s === "string" && labelWidth(s.trim()) >= 1 && labelWidth(s.trim()) <= 24 && !ONE_LINE.test(s)) && new Set(value.map(s => s.trim())).size === value.length;
}
export function richMessage(fromKind: string, buttons?: unknown, card?: unknown, lang: "en" | "zh" = "en"):
  { buttons?: Button[]; card?: Card; error?: undefined } | { error: Error; buttons?: undefined; card?: undefined } {
  const bad = (next: string) => ({ error: { code: "bad_request", next, status: 400 } });
  const error = (code: keyof typeof NEXT, status = 400) => ({ error: { code, next: NEXT[code][lang], status } });
  if ((buttons !== undefined || card !== undefined) && fromKind !== "agent") return bad("Only an agent message may carry buttons or a card.");
  if (buttons !== undefined && !validButtons(buttons)) return error("bad_buttons");
  let c: Card | undefined;
  if (card !== undefined) {
    if (!card || typeof card !== "object" || Array.isArray(card)) return bad("card must be {kind: html, summary, html}.");
    const input = card as Record<string, unknown>;
    if (input.kind !== "html" || typeof input.html !== "string") return bad("A card must have kind html and an HTML fragment as a string.");
    if (typeof input.summary !== "string" || !input.summary.trim() || Array.from(input.summary).length > 300 || ONE_LINE.test(input.summary)) return error("card_summary_required");
    const size = new TextEncoder().encode(input.html).byteLength;
    if (size > CARD_MAX) return error("card_too_large", 413);
    c = { kind: "html", summary: input.summary, html: input.html, size };
  }
  return { buttons: buttons === undefined ? undefined : (buttons as string[]).map(label => ({ label: label.trim(), by: [] })), card: c };
}
/** A press by name on buttons[index] of asker's message: its reply is `@<asker> <label>`, so only the asker gets it. */
export function pressDecision(buttons: Button[] | null | undefined, index: number, name: string, asker: string):
  { send: false; unchanged: true; moveFrom: number } | { send: true; unchanged: false; moveFrom: number; buttons: Button[]; text: string } | { error: Error } {
  if (!buttons || !Number.isSafeInteger(index) || index < 0 || index >= buttons.length) return { error: { code: "bad_request", next: "Choose an existing button by its zero-based index.", status: 400 } };
  const moveFrom = buttons.findIndex(b => b.by.includes(name));
  if (moveFrom === index) return { send: false, unchanged: true, moveFrom };
  return { send: true, unchanged: false, moveFrom, text: `@${asker} ${buttons[index].label}`, buttons: buttons.map((b, i) => ({ label: b.label, by: [...b.by.filter(n => n !== name), ...(i === index ? [name] : [])] })) };
}
