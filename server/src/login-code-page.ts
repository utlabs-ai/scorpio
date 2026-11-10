import { escapeHtml as e } from "./util";
import { S_LOCKUP } from "./marks";
import { strings } from "./strings";
import type { Lang } from "./layout";
import { pubPage } from "./snapshot-page";

export function loginCodePage(lang: Lang, p: { email: string; resendIn: number; state: "ready" | "expired" | "attempts"; accountDeleted: string }): Response {
  const t = strings(lang);
  const stateError = p.state === "expired" ? t.codeExpired : p.state === "attempts" ? t.codeTooManyTries : "";
  return pubPage(lang, null, {
    title: t.codeTitle,
    path: "/login/code",
    noEnter: true,
    head: `<meta name="robots" content="noindex"><script src="/static/email-login.js" defer></script>`,
    body: `<div class="sx-msg sx-login sx-code">${S_LOCKUP}<h2>${e(t.codeTitle)}</h2><p>${e(t.codeLead.replace("{email}", p.email))}</p>
<p id="code-error" class="sx-note sx-bad" ${stateError ? "" : "hidden"}>${e(stateError)}</p><p id="code-success" class="sx-note" hidden></p>
<form id="email-verify" data-state="${p.state}" data-wrong="${e(t.codeWrong)}" data-attempts="${e(t.codeTooManyTries)}" data-expired="${e(t.codeExpired)}" data-lost="${e(t.codeSessionLost)}" data-deleted="${e(p.accountDeleted)}" data-resent="${e(t.codeResent)}" data-cooldown="${e(t.codeResendWait)}" data-resend="${e(t.codeResend)}" data-rate="${e(t.emailTooMany)}" data-day="${e(t.emailDayLimit)}" data-limited="${e(t.emailTryLater)}" data-send-failed="${e(t.emailSendFailed)}" data-resend-in="${p.resendIn}">
<input class="sx-in sx-mono" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="${e(t.codePlaceholder)}" ${p.state === "ready" ? "" : "disabled"}>
<button class="sx-btn sx-primary sx-lg sx-wide" type="submit" ${p.state === "ready" ? "" : "disabled"}>${e(t.codeSignIn)}</button></form>
<small>${e(t.codeSpam)}</small><div class="sx-code-links"><button id="email-resend" type="button" class="sx-link">${e(t.codeResend)}</button><a class="sx-link" href="/login?change=1">${e(t.codeOtherEmail)}</a></div></div>`,
  });
}
