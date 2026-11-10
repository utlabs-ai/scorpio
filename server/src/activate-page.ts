import { escapeHtml as e } from "./util";
import type { User } from "./auth";
import type { Plan } from "./plans";
import type { Lang } from "./layout";
import { strings } from "./strings";
import { shellPage, msgCard } from "./shell-page";

export function activatePage(
  lang: Lang,
  user: User,
  p: {
    code?: string; device?: string; createdAt?: number; state: "form" | "confirm" | "approved" | "denied" | "invalid" | "limit";
    /** A relogin code: when the computer logged out (null when it is not this account's). */
    relogin?: { loggedOutAt: number | null };
    /** state "limit": computers already counted (n), the plan's cap, their names, and Pro's cap for Free. */
    n?: number; limit?: number; plan?: Plan; computers?: string[]; proLimit?: number | null;
  },
): Response {
  const t = strings(lang);
  const say = (zh: string, en: string) => lang === "zh" ? zh : en;
  // One card for every step; a bad code reddens the box with why under it (not at the card's top any more).
  const note = `<p class="sx-note">${e(t.activateWarn)}</p>`;
  let card: string;
  if (p.state === "confirm") {
    // A computer asking to come back says since when it is offline.
    const r = p.relogin;
    const back = r?.loggedOutAt ? `<dt>${e(say("掉线时间", "Logged out"))}</dt><dd><time data-ts="${r.loggedOutAt}"></time></dd>` : "";
    card = msgCard({
      icon: "computer", title: t.activateTitle, text: t.activateLead,
      inner: `<dl class="sx-kv"><dt>${e(t.codeLabel)}</dt><dd class="sx-mono">${e(p.code || "")}</dd><dt>${e(t.device)}</dt><dd>${e(p.device || "")}</dd><dt>${e(t.requested)}</dt><dd><time data-ts="${p.createdAt}"></time></dd>${back}</dl>${note}
<form method="post" action="/activate" class="sx-two"><input type="hidden" name="user_code" value="${e(p.code || "")}"><button class="sx-btn sx-line sx-lg" name="decision" value="deny">${e(t.deny)}</button><button class="sx-btn sx-primary sx-lg" name="decision" value="approve">${e(t.approve)}</button></form>`,
    });
  } else if (p.state === "limit") {
    // At the cap: not approved, the code stays; revoke one (k) and come back, or on Free upgrade. Every number from the server.
    // a computer's name never breaks at its hyphens; the 、 between names stays outside, so it never starts a line
    const n = p.n ?? 0, limit = p.limit ?? 1, k = Math.max(1, n - limit + 1), names = (p.computers || []).map((x) => `<span class="sx-nw">${e(x)}</span>`).join(say("、", ", "));
    const pcs = (x: number) => x === 1 ? "1 computer" : `${x} computers`;
    const free = p.plan !== "pro";
    const [before, after] = free
      ? [say(`免费版最多 ${limit} 台运行 agent 的电脑，你名下已有 ${n} 台：`, `The Free plan allows ${pcs(limit)} running agents, and you already have ${n}: `),
        say(`。先在「设置 → 设备」撤销 ${k} 台，再回来授权；或升级 Pro（最多 ${p.proLimit ?? 5} 台）。`, `. Revoke ${k} of them under Settings → Devices and come back to approve, or upgrade to Pro (up to ${p.proLimit ?? 5}).`)]
      : [say(`Pro 最多 ${limit} 台运行 agent 的电脑，你名下已有 ${n} 台：`, `Pro allows up to ${pcs(limit)} running agents, and you already have ${n}: `),
        say(`。先在「设置 → 设备」撤销 ${k} 台，再回来授权。`, `. Revoke ${k} of them under Settings → Devices and come back to approve.`)];
    const why = say("只算装了 Scorpio 命令行、跑 agent 的电脑，在网页上登录（手机、电脑都一样）不占名额。码过期了也不要紧，agent 重跑命令会拿到新码。",
      "Only computers with the Scorpio CLI running agents count; signing in on the website, on a phone or a computer, doesn't. If this code expires, your agent reruns the command and gets a new one.");
    const devices = `<a class="sx-btn sx-primary sx-lg${free ? "" : " sx-wide"}" href="/settings#devices">${e(say("前往设备页", "Go to Devices"))}</a>`;
    card = msgCard({
      icon: "computer", title: t.activateTitle, long: true, textHtml: e(before) + names + e(after),
      inner: `<p>${e(why)}</p>${free ? `<div class="sx-two"><a class="sx-btn sx-line sx-lg" href="/pricing">${e(say("升级 Pro", "Upgrade to Pro"))}</a>${devices}</div>` : devices}`,
    });
  } else if (p.state === "approved") card = msgCard({ icon: "ok", title: t.activateTitle, text: t.approved });
  else if (p.state === "denied") card = msgCard({ icon: "computer", title: t.activateTitle, text: t.denied });
  else {
    const bad = p.state === "invalid";
    card = msgCard({
      icon: "computer", title: t.activateTitle, text: t.activateLead,
      inner: `${note}<form method="get" action="/activate"><div class="sx-fld"><label for="act-code">${e(t.codeLabel)}</label><input id="act-code" class="sx-in sx-mono${bad ? " sx-bad" : ""}" name="code" required autocomplete="off" autocapitalize="characters" placeholder="WDJB-MJHT">${bad ? `<p class="sx-err">${e(t.codeInvalid)}</p>` : ""}</div><button class="sx-btn sx-primary sx-lg sx-wide">${e(t.continueBtn)}</button></form>`,
    });
  }
  return shellPage(lang, user, { title: t.activateTitle, path: "/activate", center: true, head: `<script src="/static/time.js" defer></script>`, body: card });
}
