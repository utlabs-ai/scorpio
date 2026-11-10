import { dataShell } from "./app-page";
import type { User } from "./auth";
import type { Lang } from "./layout";
import type { TrialBatch, TrialCode } from "./trial-codes";
import { escapeHtml as e } from "./util";

export function trialCodesSection(lang: Lang, batches: TrialBatch[]): string {
  const say = (zh: string, en: string) => lang === "zh" ? zh : en;
  return `<section class="ops-card"><h2>${say("Pro 体验码", "Pro trial codes")}</h2>
<form method="post" action="/admin/trial-codes" class="trial-batch-form">
<label>${say("数量", "Count")}<input class="sx-in" name="count" value="30" inputmode="numeric" pattern="[0-9]+" required></label>
<label>${say("天数", "Days")}<input class="sx-in" name="days" value="30" inputmode="numeric" pattern="[0-9]+" required></label>
<label>${say("备注", "Note")}<input class="sx-in" name="note" maxlength="1000"></label>
<button class="btn primary" type="submit">${say("生成", "Generate")}</button></form>
${batches.length ? `<div class="table-scroll"><table><thead><tr><th>${say("生成日", "Created")}</th><th>${say("备注", "Note")}</th><th>${say("天数", "Days")}</th><th>${say("用掉", "Used")}</th></tr></thead><tbody>${batches.map(b => `<tr><td><a href="/admin/trial-codes?batch=${e(b.id)}">${e(new Date(b.created_at).toISOString().slice(0, 10))}</a></td><td>${e(b.note || "—")}</td><td>${b.days}</td><td>${b.used} / ${b.count}</td></tr>`).join("")}</tbody></table></div>` : ""}</section>`;
}
export function trialCodesPage(lang: Lang, user: User, batch: TrialBatch, codes: TrialCode[], origin: string): Response {
  const say = (zh: string, en: string) => lang === "zh" ? zh : en;
  const link = (code: string) => `${origin.replace(/\/$/, "")}/trial/${code}`;
  const unused = codes.filter(c => c.used_by === null);
  return dataShell(lang, user, { title: say("Pro 体验码", "Pro trial codes"), path: "/admin", shown: user.handle, back: "/admin",
    head: '<link rel="stylesheet" href="/static/admin.css"><link rel="stylesheet" href="/static/trial-codes.css"><script src="/static/trial-codes.js" defer></script>',
    body: `<div class="ops"><section class="ops-card"><h2>${say("Pro 体验码", "Pro trial codes")}</h2><p>${batch.note ? `${e(batch.note)} · ` : ""}${batch.days} ${say("天", "days")} · ${batch.used} / ${batch.count}</p>
${[["links", say("复制所有未用的链接", "Copy all unused links"), unused.map(c => link(c.code))], ["codes", say("复制所有未用的码", "Copy all unused codes"), unused.map(c => c.code)]].map(([id, label, lines]) => `<label for="trial-${id}">${id === "links" ? say("未用的链接", "Unused links") : say("未用的码", "Unused codes")}</label><textarea class="sx-in trial-copy" id="trial-${id}" readonly rows="3">${e((lines as string[]).join("\n"))}</textarea><button class="btn line" type="button" data-copy-trial="trial-${id}" data-done="${say("已复制", "Copied")}">${label}</button>`).join("")}
<div class="table-scroll"><table><thead><tr><th>${say("码", "Code")}</th><th>${say("链接", "Link")}</th><th>${say("状态", "Status")}</th></tr></thead><tbody>${codes.map(c => `<tr><td>${e(c.code)}</td><td><a href="${e(link(c.code))}">${e(link(c.code))}</a></td><td>${c.used_by === null ? say("未用", "Unused") : `${e(c.handle || c.used_by)} · ${e(new Date(c.used_at!).toISOString().slice(0, 16).replace("T", " "))} UTC`}</td></tr>`).join("")}</tbody></table></div></section></div>`,
  });
}
