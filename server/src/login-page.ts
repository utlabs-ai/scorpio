import { escapeHtml as e } from "./util";
import { S_LOCKUP } from "./marks";
import { strings } from "./strings";
import { siteLinks, type Lang } from "./layout";
import { pubPage } from "./snapshot-page";

const GOOGLE_MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
const GITHUB_MARK = `<svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

const EMAIL_MARK = `<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>`;

export function loginPage(lang: Lang, p: { google: boolean; github: boolean; email: boolean; siteKey?: string; prefill?: string; next: string; error?: string; wechat?: boolean }): Response {
  const t = strings(lang);
  // The providers' own marks, as their sign-in branding guidelines ask (Google "G", GitHub Invertocat).
  const mark = { google: GOOGLE_MARK, github: GITHUB_MARK };
  const btn = (prov: "google" | "github", label: string, on: boolean) =>
    on
      ? `<a class="sx-btn sx-line sx-lg sx-wide" href="/auth/${prov}?next=${encodeURIComponent(p.next)}">${mark[prov]}<span>${label}</span></a>`
      : `<span class="sx-btn sx-line sx-lg sx-wide sx-off" aria-disabled="true">${mark[prov]}<span>${label} <small>(${t.notConfigured})</small></span></span>`;
  // A public page; the card has the wordmark for its icon; no 登录 on its own bar.
  return pubPage(lang, null, {
    title: "Scorpio",
    path: "/login",
    noEnter: true,
    head: `<meta name="robots" content="noindex"><script src="/static/workspace-preference-cleanup.js" defer></script><script src="/static/email-login.js" defer></script>${p.email && p.siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>' : ''}`,
    thirdParty: p.email && p.siteKey ? "https://challenges.cloudflare.com" : undefined,
    body: `<div class="sx-msg sx-login">${S_LOCKUP}<p>${t.tagline}</p>
${p.wechat ? `<p class="sx-note">${e(p.email ? t.wechatOpen : t.wechatOpenUnavailable)}</p>` : ""}<p id="email-error" class="sx-note sx-bad" ${p.error ? "" : "hidden"}>${e(p.error || "")}</p>
${btn("google", t.signInGoogle, p.google)}${btn("github", t.signInGithub, p.github)}
${p.email ? `<div class="sx-or"><span>${e(t.loginOr)}</span></div><form id="email-start" novalidate data-next="${e(p.next)}" data-site-key="${e(p.siteKey || "")}" data-challenge-failed="${e(t.signupFailed)}" data-verifying="${e(t.verifying)}" data-invalid="${e(t.emailInvalid)}" data-cooldown="${e(t.emailJustSent)}" data-rate="${e(t.emailTooMany)}" data-day="${e(t.emailDayLimit)}" data-limited="${e(t.emailTryLater)}" data-send-failed="${e(t.emailSendFailed)}"><div id="email-turnstile" class="sx-check" hidden></div><input class="sx-in" type="email" name="email" autocomplete="email" placeholder="${e(t.emailPlaceholder)}" value="${e(p.prefill || "")}" required><button class="sx-btn sx-line sx-lg sx-wide" type="submit">${EMAIL_MARK}<span>${e(t.signInEmail)}</span></button></form>` : ""}
${siteLinks() ? `<small><a class="sx-link" href="/pricing">${t.loginPricing} ›</a></small>` : ""}</div>`,
  });
}
