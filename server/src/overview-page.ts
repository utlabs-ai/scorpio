// The topic's overview page, /r/<id>/view (docs/api/topics.md "The overview"): the file page's bar (file-page.css) with
// 「返回主题」, the title and the four counts, over the map gv.js draws from the overview booted here and keeps live from
// the topic's own frames. Desktop only: the same page on a phone, not re-laid out.

import { escapeHtml as e } from "./util";
import { layout, type Lang } from "./layout";
import type { User } from "./auth";
import type { RoomInfo } from "./room-do";
import type { Overview } from "./room/overview";
import { ROOM_STRINGS } from "./strings";

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

export function overviewPage(lang: Lang, user: User, room: RoomInfo, p: { me: string; member: boolean; overview: Overview }): Response {
  const S = ROOM_STRINGS[lang];
  const g = S.gv;
  const back = `/r/${room.id}`;
  const title = fill(g.title, { topic: room.name });
  // The bar: the title's last part (最近 7 天 / Last 7 days) is the subtitle, a step smaller and muted.
  const cut = title.lastIndexOf(" · ");
  const [head, sub] = cut > 0 ? [title.slice(0, cut), title.slice(cut + 3)] : [title, ""];
  const boot = JSON.stringify({
    roomId: room.id,
    me: p.me,
    member: p.member, // false: a viewer of a public topic, read only
    lang,
    S,
    room: { id: room.id, name: room.name, owner: room.owner, public: room.public, archived: room.archived },
    overview: p.overview,
  }).replace(/</g, "\\u003c");
  const count = (id: string, label: string, cls = "") => `<span class="gv-count"><b id="gv-${id}"${cls ? ` class="${cls}"` : ""}></b><span>${e(label)}</span></span>`;
  return layout(lang, {
    title,
    user,
    path: `/r/${room.id}/view`,
    bodyClass: "fv gv",
    head:
      `<link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/room-ui.css"><link rel="stylesheet" href="/static/room-cards.css"><link rel="stylesheet" href="/static/file-page.css"><link rel="stylesheet" href="/static/gv.css">` +
      `<script type="application/json" id="boot">${boot}</script>` +
      `<script src="/static/md.js" defer></script><script src="/static/bots.js" defer></script><script src="/static/daemon.js" defer></script><script src="/static/room-store.js" defer></script><script src="/static/room-socket.js" defer></script><script src="/static/room-members.js" defer></script><script src="/static/gv.js" defer></script>`,
    body:
      `<header class="fv-top"><div class="fv-bar"><a class="fv-back" href="${e(back)}" title="${e(g.back)}" aria-label="${e(g.back)}">‹</a>` +
      `<div class="fv-t"><b class="fv-name">${e(head)}${sub ? `<span class="gv-sub">${e(sub)}</span>` : ""}</b></div>` +
      `<div class="gv-counts">${count("lanes", g.lanes)}${count("working", g.working, "live")}${count("onyou", g.onYou, "you")}${count("messages", g.messages)}</div>` +
      `</div></header>` +
      `<main class="gv-desk ui" id="gv-desk"><div class="gv-mapcol" id="gv-mapcol"><div class="gv-map" id="gv-map"><svg class="gv-lines" id="gv-lines" aria-hidden="true"></svg><div class="gv-board" id="gv-board"></div><svg class="gv-fly" id="gv-fly" aria-hidden="true"></svg></div><p class="gv-legend" id="gv-legend">${e(g.legend)}</p></div>` +
      `<aside class="gv-side" id="gv-side"></aside>` +
      `<div id="item-scrim" class="scrim up hidden"></div><section id="item-panel" class="sheet mid up hidden"></section><div id="toast" class="toast hidden" role="status"></div></main>`,
  });
}
