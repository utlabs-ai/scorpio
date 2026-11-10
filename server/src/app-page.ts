// The signed-in shell (the site kit): the left column of topics on a computer, /app with
// the big box in the middle, the topic list on a phone, and the new-topic form. Every class is the kit's sx- one.

import { escapeHtml as e } from "./util";
import type { User } from "./auth";
import { S_LOCKUP } from "./marks";
import { layout, type Lang } from "./layout";
import { strings } from "./strings";
import type { PageTopic } from "./app-topics";

export interface ShellMe {
  handle: string;
  displayName: string | null;
  trialUntil: number | null;
}

const ICON = {
  search: '<svg class="sx-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  // Drawn, not typed: a typed + or ↑ sits where its font puts it, not in the middle of its box.
  plus: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9"/></svg>',
  up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.5V2.5M4.5 6 8 2.5 11.5 6"/></svg>',
};

/** What the column and the light theme's top bar need after a page's own stylesheets and scripts. */
export const SHELL_HEAD = `<link rel="stylesheet" href="/static/site.css"><link rel="stylesheet" href="/static/app-shell.css"><link rel="stylesheet" href="/static/bar-light.css"><script src="/static/bots.js" defer></script><script src="/static/app-shell.js" defer></script>`;
/** The same for the topic page, which has bots.js already. */
export const SHELL_HEAD_ROOM = `<link rel="stylesheet" href="/static/site.css"><link rel="stylesheet" href="/static/app-shell.css"><link rel="stylesheet" href="/static/room-composer.css"><link rel="stylesheet" href="/static/bar-light.css"><script src="/static/app-shell.js" defer></script>`;

/**
 * The left column: the brand, 「＋ 新主题」, 「搜索」, the list and me at the foot. app-shell.js fills the list and the foot
 * from what is given here (on /app) or from /app/topics.json (every other page), and keeps them fresh.
 */
export function shellSide(lang: Lang, p: { current?: string | null; topics?: PageTopic[] | null; me?: ShellMe | null; binAfterDays?: number | null; newOn?: boolean }): string {
  const t = strings(lang).shell;
  const boot = JSON.stringify({ lang, S: t, current: p.current || null, topics: p.topics || null, me: p.me || null, binAfterDays: p.binAfterDays ?? null }).replace(/</g, "\\u003c");
  const sideIcon = '<svg class="sx-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M9.5 5v14"/></svg>';
  return `<aside class="sx-side" id="sx-side"><div class="sx-head"><a class="sx-brand" href="/app">${S_LOCKUP}</a><button type="button" class="sx-side-collapse" data-sx-side-collapse aria-controls="sx-side" aria-expanded="true" aria-label="${e(t.sideCollapse)}" title="${e(t.sideCollapse)}">${sideIcon}</button></div>
<a class="sx-new${p.newOn ? " sx-on" : ""}" href="/app/new"><span class="sx-plus" aria-hidden="true">${ICON.plus}</span>${e(t.newTopic)}</a>
<button type="button" class="sx-find" data-sx-search>${ICON.search}${e(t.search)}</button>
<div class="sx-list" id="sx-list"></div>
<button type="button" class="sx-me" id="sx-me" data-sx-account aria-haspopup="menu" aria-label="${e(t.accountMenu)}"></button></aside>
<button type="button" class="sx-side-expand" data-sx-side-expand aria-controls="sx-side" aria-expanded="false" aria-label="${e(t.sideExpand)}" title="${e(t.sideExpand)}">${sideIcon}</button>
<script type="application/json" id="sx-boot">${boot}</script>`;
}

/** The new-topic form, the same on a computer (in the middle) and a phone (the whole page); prefix keeps ids apart. */
function newTopicForm(lang: Lang, prefix: string, code: string, phone: boolean): string {
  const t = strings(lang).shell;
  const id = (k: string) => `${prefix}-${k}`;
  const create = `<button type="submit" class="sx-btn sx-primary${phone ? " sx-wide sx-lg sx-gap8" : ""}">${e(t.create)}</button>`;
  return `<form class="sx-newform${phone ? "" : " sx-form"}" data-sx-newform novalidate>
${phone ? "" : `<h2>${e(t.formTitle)}</h2>`}<p class="sx-intro">${e(phone ? t.formIntro : t.formIntroDesk)}</p>
<div class="sx-fld"><label for="${id("name")}">${e(t.name)}</label><input class="sx-in" id="${id("name")}" name="name" maxlength="80" autocomplete="off" required><p class="sx-err" hidden></p></div>
<div class="sx-fld"><label for="${id("desc")}">${e(t.desc)}</label><p class="sx-hint">${e(t.descHint)}</p><textarea class="sx-in sx-ta" id="${id("desc")}" name="topic" placeholder="${e(t.descPlaceholder)}"></textarea><div class="sx-cnt"><span>${e(t.descLines)}</span><span data-sx-count>0 / 2000</span></div></div>
<div class="sx-fld" data-sx-codefld><label>${e(t.code)}</label><p class="sx-hint">${e(t.codeHint)}</p><div class="sx-in"><span class="sx-code" data-sx-code>${e(code)}</span><span class="sx-sp"></span><button type="button" class="sx-link" data-sx-newcode>${e(t.newCode)}</button></div></div>
<div class="sx-fld"><div class="sx-tog"><span class="sx-w"><b>${e(t.public)}</b><small>${e(t.publicHint)}</small></span><button type="button" class="sx-sw" role="switch" aria-checked="false" aria-label="${e(t.public)}" data-sx-public></button></div></div>
${phone ? `<p class="sx-err" data-sx-formerr hidden></p>${create}` : `<div class="sx-acts"><p class="sx-err" data-sx-formerr hidden></p><a class="sx-btn sx-line" href="/app">${e(t.cancel)}</a>${create}</div>`}
</form>`;
}

/** The middle of /app on a computer when no topic is open: one sentence makes a topic. */
function askBox(lang: Lang): string {
  const t = strings(lang).shell;
  return `<div class="sx-ask"><div class="sx-greet"><span data-sx-bot></span><h2>${e(t.askTitle)}</h2></div>
<form class="sx-box" data-sx-ask><textarea rows="2" aria-label="${e(t.askTitle)}" placeholder="${e(t.askPlaceholder)}"></textarea><button type="submit" class="sx-go sx-off" aria-label="${e(t.askGo)}">${ICON.up}</button></form>
<div class="sx-ideas">${t.ideas.split("|").map((x) => `<button type="button" data-sx-idea>${e(x)}</button>`).join("")}</div>
<p class="sx-err" data-sx-askerr hidden></p>
<p class="sx-note">${e(t.askNote)}<br>${e(t.askNoteNew).replace("{new}", `<b>＋ ${e(t.newTopic)}</b>`)}</p></div>`;
}

/**
 * /app: on a computer the column and, in the middle, the big box (or the form at /app/new); on a phone the topic list,
 * or the form for someone with no topic yet and at /app/new. CSS shows one of the two by width.
 */
export function appPage(lang: Lang, user: User, p: { topics: PageTopic[]; shell: ShellMe; binAfterDays: number; code: string; form: boolean }): Response {
  const t = strings(lang).shell;
  const none = !p.topics.length;
  const phoneForm = p.form || none;
  const initial = e((p.shell.displayName || user.handle).slice(0, 1).toLowerCase());
  const av = `<button type="button" class="sx-av" data-sx-account aria-haspopup="menu" aria-label="${e(t.accountMenu)}">${initial}</button>`;
  const phoneTop = phoneForm
    ? `<div class="sx-sky sx-ph-top">${p.form && !none ? `<a class="sx-back" href="/app" aria-label="${e(t.back)}">‹</a>` : ""}<span class="sx-tt">${e(t.formTitle)}</span><span class="sx-sp"></span>${av}</div>`
    : `<div class="sx-sky sx-ph-top">${S_LOCKUP}<span class="sx-sp"></span><button type="button" class="sx-icb" data-sx-search aria-label="${e(t.search)}">${ICON.search}</button>${av}</div>`;
  const phoneBody = phoneForm
    ? `<div class="sx-ph-form">${newTopicForm(lang, "m", p.code, true)}</div>`
    : `<div class="sx-ph-list" id="sx-ph-list"><a class="sx-new" href="/app/new"><span class="sx-plus" aria-hidden="true">${ICON.plus}</span>${e(t.newTopic)}</a><div id="sx-ph-groups"></div></div>`;
  return layout(lang, {
    title: p.form ? `${t.formTitle} · Scorpio` : "Scorpio",
    user,
    path: p.form ? "/app/new" : "/app",
    bodyClass: "sx appview",
    head: `<link rel="stylesheet" href="/static/room-tokens.css">${SHELL_HEAD}`,
    body: `<div class="sx-app">${shellSide(lang, { topics: p.topics, me: p.shell, binAfterDays: p.binAfterDays, newOn: p.form })}<main class="sx-main2">${p.form ? newTopicForm(lang, "d", p.code, false) : askBox(lang)}</main></div>
<div class="sx-phone-app">${phoneTop}${phoneBody}</div>`,
  });
}

/** The same full-page bar, account menu and theme as the signed-in home page. */
export function dataShell(lang: Lang, user: User, p: { title: string; path: string; shown: string; body: string; head: string; back?: string }): Response {
  // The settings page's 「‹ title」 bar with who I am under it, no avatar (the column has the
  // account), no footer. My data and the ops page; the ops page's own pages come back to it.
  const back = p.back || "/app";
  const label = back === "/app" ? (lang === "zh" ? "回首页" : "Home") : strings(lang).back;
  return layout(lang, {
    title: p.title, user, path: p.path, bodyClass: "homeview has-side",
    head: `<link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/room-status.css"><link rel="stylesheet" href="/static/room-ui.css"><link rel="stylesheet" href="/static/page-integration.css"><link rel="stylesheet" href="/static/data-shell.css">${p.head}${SHELL_HEAD}<link rel="stylesheet" href="/static/site-pages.css">`,
    body: `${shellSide(lang, {})}<div class="ui desk col home data-view"><header class="bar"><a class="back" href="${e(back)}" aria-label="${e(label)}">‹</a><div class="title"><b>${e(p.title.replace(/ · Scorpio$/, ""))}</b><span>${e(p.shown)}</span></div></header>
<div class="dcol"><main class="page"><div class="pagein">${p.body}</div></main></div></div>`,
  });
}
