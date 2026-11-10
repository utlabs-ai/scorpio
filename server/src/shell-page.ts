import { escapeHtml as e } from "./util";
import type { User } from "./auth";
import { SHELL_HEAD, shellSide } from "./app-page";
import { layout, type Lang } from "./layout";
import { strings } from "./strings";

/** The centered card's icons: the file page's download card, in site kit names. */
const MSG_ICON = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
  computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7.5 9l2.5 2-2.5 2M12 13h4M9 20h6"/></svg>',
  lost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.6v5.2M12 16.3v.2"/></svg>',
};
/**
 * The centered card: an icon, a title, what to know, then whatever the page asks or offers (inner, already HTML).
 * textHtml: the text already as HTML, in place of text; long: paragraphs read left-aligned.
 */
export function msgCard(p: { icon: keyof typeof MSG_ICON; title: string; text?: string; textHtml?: string; inner?: string; long?: boolean }): string {
  const text = p.textHtml ?? (p.text ? e(p.text) : "");
  return `<div class="sx-msg${p.long ? " sx-long" : ""}"><div class="sx-mi${p.icon === "ok" ? " sx-ok" : ""}">${MSG_ICON[p.icon]}</div><h2>${e(p.title)}</h2>${text ? `<p>${text}</p>` : ""}${p.inner || ""}</div>`;
}

/**
 * A signed-in page in the settings page's shell: the column from 1024 px, a 「‹ title」 bar
 * (‹ back to /app unless said), no footer; center puts a card in the middle of the page.
 */
export function shellPage(lang: Lang, user: User, p: { title: string; pageTitle?: string; sub?: string; back?: string; path?: string; body: string; head?: string; center?: boolean; status?: number }): Response {
  const back = p.back || "/app";
  const label = back === "/app" ? (lang === "zh" ? "首页" : "Home") : strings(lang).back;
  const res = layout(lang, {
    title: p.pageTitle ?? (p.title ? `${p.title} · Scorpio` : "Scorpio"),
    user,
    path: p.path,
    bodyClass: "settingsview has-side",
    head: `<link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/room-status.css"><link rel="stylesheet" href="/static/room-ui.css"><link rel="stylesheet" href="/static/page-integration.css">${p.head || ""}${SHELL_HEAD}<link rel="stylesheet" href="/static/site-pages.css">`,
    body: `${shellSide(lang, {})}<div class="ui desk col settings"><header class="bar"><a class="back" href="${e(back)}" aria-label="${e(label)}">‹</a><div class="title"><b>${e(p.title)}</b>${p.sub ? `<span>${e(p.sub)}</span>` : ""}</div></header>
<div class="dcol"><main class="page"><div class="pagein${p.center ? " sx-center" : ""}">${p.body}</div></main></div></div>`,
  });
  return p.status ? new Response(res.body, { status: p.status, headers: res.headers }) : res;
}

/** Back from Creem's checkout: Pro is on as soon as its webhook arrived (usually before the person gets here). */
export function paidPage(lang: Lang, user: User, plan: string): Response {
  const t = strings(lang);
  return shellPage(lang, user, {
    title: lang === "zh" ? "付款完成" : "Payment done",
    path: "/billing/done",
    center: true,
    body: msgCard({ icon: "ok", title: t.paidTitle, text: plan === "pro" ? t.paidNow : t.paidSoon, inner: `<a class="sx-btn sx-primary sx-lg" href="/app">${e(t.toRooms)}</a>` }),
  });
}
