import { escapeHtml as e } from "./util";
import { bot } from "./landing-art";
import { siteFoot, siteTop } from "./site-chrome";
import { layout, sizeText, type Lang } from "./layout";
import { ROOM_STRINGS, strings } from "./strings";
import type { User } from "./auth";

/** A public room's snapshot (docs/api/topics.md): what a visitor who is not signed in sees at /r/<id>, and where link previews come from. */
export interface Snapshot {
  name: string;
  topic: string;
  archived: boolean;
  total: number;
  messages: { seq: number; from: string; display?: string; fromKind: string; text: string; files: { name: string; size: number }[]; ts: number }[];
}
/** The room page's plainLines rule, keeping paragraph breaks for the full public description. */
function plainTopic(t: string): string {
  return t.split("\n").filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line))
    .map((line) => line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/[*_`#>]/g, "").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function snapshotPage(lang: Lang, origin: string, roomId: string, snap: Snapshot): Response {
  const t = strings(lang);
  const next = `/login?next=${encodeURIComponent(`/r/${roomId}`)}`;
  const topic = plainTopic(snap.topic);
  const topicMeta = topic.split("\n")[0];
  // A person with a display name is 「昵称（账号名）」, the handle in small type.
  const who = (m: Snapshot["messages"][number]) =>
    m.fromKind === "scheduled" ? `<b>${e(ROOM_STRINGS[lang].sched.seat)}</b>`
      : m.display ? `<b>${e(m.display)}</b><span>${lang === "zh" ? `（${e(m.from)}）` : `(${e(m.from)})`}</span>` : `<b>${e(m.from)}</b>`;
  // Rows like the topic page's (avatar, name, time, the text), read only.
  const msgs = snap.messages
    .map(
      (m) =>
        `<article class="sx-row">${m.fromKind === "agent" ? `<span class="sx-av sx-agent" aria-hidden="true">${bot("p0 s16")}</span>` : `<span class="sx-av" aria-hidden="true">${m.fromKind === "scheduled" ? '<span class="ic-clock"></span>' : e((m.display || m.from).slice(0, 1).toLowerCase())}</span>`}<div class="sx-rc"><div class="sx-rt">${who(m)}${m.fromKind === "agent" ? '<span class="sx-tag">agent</span>' : ""}<time data-ts="${m.ts}"></time></div>` +
        (m.text ? `<div class="sx-rx">${e(m.text)}</div>` : "") +
        m.files.map((f) => `<div class="sx-rf">📎 ${e(f.name)} · ${sizeText(f.size)}</div>`).join("") +
        "</div></article>",
    )
    .join("");
  const meta = [
    `<meta name="robots" content="noindex">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${e(snap.name)}">`,
    `<meta property="og:description" content="${e(topicMeta)}">`,
    `<meta property="og:url" content="${e(`${origin}/r/${roomId}`)}">`,
    `<meta property="og:image" content="${e(`${origin}/static/icons/icon-512.png`)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="description" content="${e(topicMeta)}">`,
    `<script src="/static/time.js" defer></script>`,
  ].join("\n");
  const page = pubPage(lang, null, {
    title: `${snap.name} · Scorpio`,
    path: `/r/${roomId}`,
    signIn: `/r/${roomId}`,
    head: meta,
    body: `<div class="sx-snap"><h2>${e(snap.name)}${snap.archived ? ` <small class="sx-tag">${t.snapArchived}</small>` : ""}</h2>
${topic ? `<p class="sx-intro">${e(topic)}</p>` : ""}
<a class="sx-btn sx-primary sx-lg sx-wide" href="${next}">${e(t.snapSignIn.replace("{n}", String(snap.total)))}</a>
<div class="sx-rows">${msgs}</div>
<p class="sx-sub">${t.snapLive}</p></div>`,
  });
  // The internal render cache keeps this for a minute; the route marks the outgoing response private, no-store.
  const h = new Headers(page.headers);
  h.set("cache-control", "public, max-age=60");
  h.set("vary", "Cookie, Accept-Language");
  h.set("x-robots-tag", "noindex");
  return new Response(page.body, { status: 200, headers: h });
}

/**
 * A public page: the homepage's top row on its own bar (night in dark, paper in light),
 * the page, the homepage's footer. noEnter: no 登录 on the sign-in page itself.
 */
export function pubPage(lang: Lang, user: User | null, p: { title: string; path: string; body: string; head?: string; noEnter?: boolean; signIn?: string; status?: number; thirdParty?: string; flush?: boolean }): Response {
  const res = layout(lang, {
    title: p.title,
    user,
    path: p.path,
    thirdParty: p.thirdParty,
    bodyClass: "sx sx-pub",
    head: `<link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/site.css"><link rel="stylesheet" href="/static/landing.css"><link rel="stylesheet" href="/static/site-pages.css"><script src="/static/landing.js" defer></script>${p.head || ""}`,
    body: `<header class="sx-sky sx-pagebar">${siteTop(lang, user, p.path, { noEnter: p.noEnter, signIn: p.signIn, brand: "/" })}</header>
<main${p.flush ? ' class="sx-flush"' : ""}>${p.body}</main>
${siteFoot(lang)}`,
  });
  return p.status ? new Response(res.body, { status: p.status, headers: res.headers }) : res;
}
