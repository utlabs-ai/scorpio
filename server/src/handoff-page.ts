// A seat's handoff page, /r/<id>/handoff?name=<role@account> (docs/api/files.md): the file page's
// bar (file-page.css) — the seat, when it was stored and on which computer, 「下载 .md」 and, for the seat's own person,
// 「删除」 — above the text, rendered on the page as messages are, by md.js: it escapes everything first
// and passes no HTML, and #1234 becomes a link to that message in the topic. No handoff, or no such seat any more: the
// page says so, with 200.

import { escapeHtml as e } from "./util";
import { layout, type Lang } from "./layout";
import type { User } from "./auth";
import type { HandoffView } from "./room-do";
import { ROOM_STRINGS } from "./strings";
import { roleOf } from "./handoff";

const S = {
  en: {
    title: "{role}'s handoff",
    kept: "Only the latest is kept; the next handoff replaces it",
    download: "Download .md",
    delete: "Delete",
    foot: "Everyone who can read this topic can read this handoff.",
    noneTitle: "{role} has no handoff in the cloud now",
    none: "It may have been deleted, or the last handoff was not uploaded.",
    seatGone: "{role} is no longer in this topic, and its handoff went with it.",
    confirm: "Delete {role}'s cloud handoff? The next takeover on another computer starts without one; files on your computers are not affected.",
    cancel: "Cancel",
    deleted: "Deleted",
    back: "Back to the topic",
  },
  zh: {
    title: "{role} 的交接",
    kept: "只留最新一份，下次交接会覆盖",
    download: "下载 .md",
    delete: "删除",
    foot: "主题里能看到聊天的人都能看到这份交接。",
    noneTitle: "{role} 现在没有云端交接",
    none: "可能被删了，或者上次交接没有上云。",
    seatGone: "{role} 已不在这个主题里，它的交接也一起没了。",
    confirm: "删掉 {role} 的云端交接？下次换电脑接班就没有交接了；各台电脑上的本机文件不受影响。",
    cancel: "取消",
    deleted: "已删除",
    back: "返回主题",
  },
} as const;

const IC = {
  down: '<svg class="fv-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/></svg>',
  jump: '<svg class="fv-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6"/></svg>',
};

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");
const MB = 1024 * 1024;
const sizeText = (n: number) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function handoffPage(lang: Lang, user: User, v: HandoffView, p: { name: string; mine: boolean }): Response {
  const s = S[lang];
  const r = ROOM_STRINGS[lang];
  const name = p.name; // as asked (role@account, checked by the room): the seat may be gone
  const role = roleOf(name);
  const h = v.seat ? v.handoff : null;
  const back = `/r/${v.room.id}`;
  const self = `/r/${v.room.id}/handoff?name=${encodeURIComponent(name)}`;
  // When it was stored (the server's time, as the member card says it), which computer, how big.
  const meta = h
    ? [`<time data-ts="${h.updatedAt}" data-fmt="handoff"></time>`, h.computer ? e(h.computer) : "", sizeText(h.size), e(s.kept)].filter(Boolean).join(" · ")
    : "";
  const empty = (note: string) =>
    `<div class="fv-center"><div class="fv-card"><div class="big md">MD</div><h2>${e(fill(s.noneTitle, { role }))}</h2><p>${e(note)}</p>` +
    `<a class="go" href="${e(back)}">${IC.jump}${e(s.back)}</a></div></div>`;
  const body = !v.seat ? empty(fill(s.seatGone, { role })) : !h ? empty(s.none) : `<article class="ho-doc md" id="ho-doc"></article>`;
  const boot = JSON.stringify({
    room: v.room.id,
    text: h ? h.body : null, // md.js renders it here (handoff-page.js)
    labels: { copy: r.copy, wrapOn: r.wrapOn, wrapOff: r.wrapOff, copied: r.copiedCode },
    // the delete
    seat: name,
    del: `/r/${v.room.id}/handoffDelete`,
    confirm: fill(s.confirm, { role }),
    ok: s.delete,
    cancel: s.cancel,
    deleted: s.deleted,
  }).replace(/</g, "\\u003c");
  return layout(lang, {
    title: `${fill(s.title, { role })} · ${v.room.name}`,
    user,
    path: self,
    bodyClass: "fv ho",
    head:
      `<link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/file-page.css"><script type="application/json" id="ho-boot">${boot}</script>` +
      `<script src="/static/time.js" defer></script><script src="/static/md.js" defer></script><script src="/static/handoff-page.js" defer></script>`,
    body:
      `<header class="fv-top"><div class="fv-bar"><a class="fv-back" href="${e(back)}" title="${e(s.back)}" aria-label="${e(s.back)}">‹</a>` +
      `<span class="fv-ext md">MD</span>` +
      `<div class="fv-t"><b class="fv-name">${e(fill(s.title, { role }))}</b>${meta ? `<span class="fv-meta" id="ho-meta">${meta}</span>` : ""}</div>` +
      (h
        ? `<div class="fv-acts" id="ho-acts"><a class="fv-btn pri" href="${e(self)}&amp;download=1" download="${e(role)}.md">${IC.down}${e(s.download)}</a>` +
          (p.mine ? `<button class="fv-btn ho-del" type="button" id="ho-del">${e(s.delete)}</button>` : "") +
          `</div>`
        : "") +
      `</div></header>` +
      `<main class="fv-body ho-main" id="ho-main">${body}</main>` +
      (h ? `<p class="ho-foot" id="ho-foot">${e(s.foot)}</p><template id="ho-empty">${empty(s.none)}</template>` : ""),
  });
}
