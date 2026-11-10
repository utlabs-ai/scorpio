import { escapeHtml as e } from "./util";
import { S_LOCKUP } from "./marks";
import { strings } from "./strings";
import type { Lang } from "./layout";
import { pubPage } from "./snapshot-page";

/** A new identity back from OAuth, before its account exists: Turnstile. */
export function signupPage(lang: Lang, p: { email: string; siteKey: string; error?: string }): Response {
  const t = strings(lang);
  // The sign-in card, the human check in the middle of it.
  return pubPage(lang, null, {
    title: t.signupTitle,
    path: "/signup",
    noEnter: true,
    head: `<script src="/static/email-login.js" defer></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" defer></script>`,
    thirdParty: "https://challenges.cloudflare.com",
    body: `<div class="sx-msg sx-login">${S_LOCKUP}<h2>${t.signupTitle}</h2><p>${e(t.signupLead.replace("{email}", p.email))}</p>
${p.error ? `<p class="sx-note sx-bad">${e(p.error)}</p>` : ""}
<form id="signup" method="post" action="/signup" data-site-key="${e(p.siteKey)}" data-language="${lang === "zh" ? "zh-cn" : "en"}" data-verifying="${e(t.verifying)}" data-challenge-failed="${e(t.signupFailed)}"><div id="signup-turnstile" class="sx-check" hidden></div><p id="signup-turnstile-error" class="sx-note sx-bad" hidden></p>
<button class="sx-btn sx-primary sx-lg sx-wide">${e(t.signupBtn)}</button></form></div>`,
  });
}
