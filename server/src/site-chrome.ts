// The public pages' top row and footer: the sign-in, sign-up and message pages, public topic snapshots, and the
// website's own pages when the deployment has them.

import { escapeHtml as e } from "./util";
import type { User } from "./auth";
import { S_LOCKUP, UT_LOCKUP } from "./marks";
import { siteLinks, type Lang } from "./layout";

const L = {
  zh: {
    pricing: "价格",
    signIn: "登录",
    openApp: "进入工作台",
    langNames: ["中文", "English"],
    langLabel: "语言",
    privacy: "隐私政策",
    changelog: "更新日志",
    terms: "服务条款",
  },
  en: {
    pricing: "Pricing",
    signIn: "Sign in",
    openApp: "Open app",
    langNames: ["中文", "English"],
    langLabel: "Language",
    privacy: "Privacy",
    changelog: "Changelog",
    terms: "Terms",
  },
};

const SUPPORT = "support@utlabs.ai";
const GLOBE = `<svg class="sx-ic hx-globe" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.5 3.9 5.5 3.9 9s-1.3 6.5-3.9 9c-2.6-2.5-3.9-5.5-3.9-9s1.3-6.5 3.9-9Z"/></svg>`;
const CARET = `<svg class="hx-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>`;
const CHECK = `<svg class="hx-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

/**
 * The site's top row (the kit's .sx-top), on the homepage and on the other public pages: the wordmark, then
 * 价格 · 登录 (signed in: 进入工作台) · the language menu; on a phone 登录 · the menu. It sits on the sky: the caller's container
 * is .sx-sky. `next`: where switching the language comes back to. opts.noEnter: no 登录 / 进入工作台 (the sign-in page
 * itself); opts.signIn: where signing in lands (default /app); opts.brand: the wordmark links there (the homepage's does not).
 */
export function siteTop(lang: Lang, user: User | null, next = "/", opts: { noEnter?: boolean; signIn?: string; brand?: string } = {}): string {
  const t = L[lang];
  // The language menu: a globe (a computer adds the current language and ▾) that opens the
  // languages in a fixed order, each in its own writing. The current one is bold and checked, not a link; the other is
  // /lang, which sets the cookie. A <details>, so it opens without script; landing.js adds hx-open, Esc and outside clicks.
  const langMenu = (iconOnly: boolean) => {
    const items = (["zh", "en"] as const).map((l, i) => {
      const tag = l === "zh" ? "zh-CN" : l;
      return l === lang
        ? `<a role="menuitemradio" aria-checked="true" class="hx-on" lang="${tag}">${t.langNames[i]}${CHECK}</a>`
        : `<a role="menuitemradio" aria-checked="false" href="/lang?to=${l}&amp;next=${e(encodeURIComponent(next))}" hreflang="${tag}" lang="${tag}">${t.langNames[i]}</a>`;
    });
    const current = iconOnly ? "" : `<span>${t.langNames[lang === "zh" ? 0 : 1]}</span>${CARET}`;
    return `<details class="hx-langwrap"><summary class="hx-lang${iconOnly ? " hx-icononly" : ""}" aria-haspopup="menu" aria-expanded="false" aria-label="${e(t.langLabel)}">${GLOBE}${current}</summary><div class="hx-langmenu" role="menu">${items.join("")}</div></details>`;
  };
  const login = `/login?next=${e(encodeURIComponent(opts.signIn || "/app"))}`;
  const enter = opts.noEnter ? "" : user ? `<a href="/app">${e(t.openApp)}</a>` : `<a href="${login}">${e(t.signIn)}</a>`;
  const enterBtn = opts.noEnter ? "" : user ? `<a class="sx-btn sx-sm sx-line" href="/app">${e(t.openApp)}</a>` : `<a class="sx-btn sx-sm sx-line" href="${login}">${e(t.signIn)}</a>`;
  const brand = opts.brand ? `<a href="${e(opts.brand)}" aria-label="Scorpio">${S_LOCKUP}</a>` : S_LOCKUP;
  return `<div class="sx-top">${brand}<span class="sx-sp"></span><nav class="sx-only-m">${enter}${langMenu(true)}</nav><nav class="sx-only-d">${siteLinks() ? `<a href="/pricing">${e(t.pricing)}</a>` : ""}${enterBtn}${langMenu(false)}</nav></div>`;
}

/** The site's footer (the kit's .sx-foot), on the homepage and the other public pages. The website's links only when the deployment
 * has its website (siteLinks); GitHub always, where the source of this server is. */
export function siteFoot(lang: Lang): string {
  const t = L[lang];
  return `<div class="sx-sky sx-foot"><div class="sx-wrap">${UT_LOCKUP}<span>© ut labs</span><span class="sx-sp"></span>${siteLinks() ? `<a href="/changelog">${e(t.changelog)}</a><a href="/privacy">${e(t.privacy)}</a><a href="/terms">${e(t.terms)}</a>` : ""}<a href="https://github.com/utlabs-ai/scorpio">GitHub</a>${siteLinks() ? `<a href="mailto:${SUPPORT}">${SUPPORT}</a>` : ""}</div></div>`;
}
