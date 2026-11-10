import { escapeHtml as e } from "./util";
import type { User } from "./auth";
import { S_LOCKUP } from "./marks";
import { SHELL_HEAD_ROOM, shellSide } from "./app-page";
import { layout, type Lang } from "./layout";
import { strings, ROOM_STRINGS } from "./strings";

/** While the first frame is on its way: the shape of a few message rows, so the feed is not blank. room.js's
 * first renderAll replaces it; nothing old is drawn first. */
const FEED_SKELETON = `<div class="fsk" aria-hidden="true">${["w38 w92 w64", "w30 w80", "w44 w96 w88 w40", "w34 w72", "w40 w90 w56"]
  .map((ws) => `<div class="fsk-row"><i class="fsk-av"></i><div class="fsk-col">${ws.split(" ").map((w, i) => `<i class="fsk-l ${i ? "" : "fsk-who "}${w}"></i>`).join("")}</div></div>`)
  .join("")}</div>`;

/** frames: the content domain the page may frame (chart cards), when cards can be shown. */
export function roomPage(lang: Lang, user: User, room: { id: string; name: string; topic: string }, boot: Record<string, unknown>, frames?: string): Response {
  const bootJson = JSON.stringify({ ...boot, lang, workspaceStrings: strings(lang).workspace, S: ROOM_STRINGS[lang] }).replace(/</g, "\\u003c");
  return layout(lang, {
    title: room.name,
    user,
    bodyClass: "room has-side",
    frames: ["'self'", frames].filter(Boolean).join(" "),
    path: `/r/${room.id}`,
    first: `<script src="/static/room-early.js" async></script>`, // the socket opens before anything else loads
    head: `<link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/room-status.css"><link rel="stylesheet" href="/static/room-ui.css"><link rel="stylesheet" href="/static/room-integration.css"><link rel="stylesheet" href="/static/room-search.css"><link rel="stylesheet" href="/static/room-schedules.css"><link rel="stylesheet" href="/static/room-export.css"><link rel="stylesheet" href="/static/lightbox.css"><link rel="stylesheet" href="/static/daemon.css"><link rel="stylesheet" href="/static/room-messages.css"><link rel="stylesheet" href="/static/room-cards.css"><link rel="stylesheet" href="/static/room-invite.css"><script type="application/json" id="boot">${bootJson}</script><script src="/static/md.js" defer></script><script src="/static/bots.js" defer></script><script src="/static/daemon.js" defer></script><script src="/static/room-store.js" defer></script><script src="/static/room-search.js" defer></script><script src="/static/push-preferences.js" defer></script><script src="/static/room-overlay-history.js" defer></script><script src="/static/room-shell.js" defer></script><script src="/static/room-socket.js" defer></script><script src="/static/room-feed.js" defer></script><script src="/static/room-files.js" defer></script><script src="/static/room-memo.js" defer></script><script src="/static/room-tasks.js" defer></script><script src="/static/room-at.js" defer></script><script src="/static/room-mention-feed.js" defer></script><script src="/static/room-members.js" defer></script><script src="/static/room-export.js" defer></script><script src="/static/room-settings.js" defer></script><script src="/static/room-schedule-time.js" defer></script><script src="/static/room-schedules.js" defer></script><script src="/static/room-spawn-steps.js" defer></script><script src="/static/room-composer.js" defer></script><script src="/static/room-approvals.js" defer></script><script src="/static/room-ai-cards.js" defer></script><script src="/static/workspace-panel.js" defer></script><script src="/static/room.js" defer></script><script src="/static/lightbox.js" defer></script>${SHELL_HEAD_ROOM}<link rel="stylesheet" href="/static/spawn-card.css"><link rel="stylesheet" href="/static/room-approvals.css"><link rel="stylesheet" href="/static/room-ai-cards.css"><link rel="stylesheet" href="/static/room-memo.css"><link rel="stylesheet" href="/static/workspace-panel.css">`,
    body: `${shellSide(lang, { current: room.id })}<div class="ui desk"><header class="roombar bar">
<a class="back" href="/app" aria-label="Home">‹</a>
<div class="crumbs"><a class="brand" href="/app">${S_LOCKUP}</a><span class="sep" aria-hidden="true"></span>
<div class="title" role="button" tabindex="0"><b><span id="room-name">${e(room.name)}</span><small id="room-pub" class="tag hidden"></small></b><span id="room-topic">${e(room.topic)}</span></div>
</div>
<button id="btn-workspace" hidden type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V4h7l3 3h8v13H3Z"/></svg>${e(strings(lang).workspace.title)}</button>
<button id="btn-plan" class="todochip" type="button"></button>
<button id="btn-search" class="icon" type="button" aria-label="${e(ROOM_STRINGS[lang].search)}" aria-controls="panel"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.6"></circle><path d="m16 16 4.3 4.3"></path></svg></button>
<button id="btn-more" class="icon" type="button" aria-label="More" aria-haspopup="menu" aria-expanded="false">⋯</button>
</header>
<div class="main">
<div id="status" class="status hidden" role="status"></div>
${boot.member === false ? "" : '<div class="feed-filters"><button id="mention-only" type="button" aria-pressed="false" aria-controls="feed"></button></div>'}
<main id="feed" class="feed" aria-live="polite" aria-busy="true">${FEED_SKELETON}</main>
<div class="jumps"><div><button id="back" class="jump back hidden" type="button"></button><button id="jump-unread" class="jump hidden" type="button"></button><button id="jump" class="jump hidden" type="button"></button><button id="jump-at" class="jump you hidden" type="button"></button></div></div>
<div id="toast" class="toast hidden" role="status"></div>
<div id="msgmenu-scrim" class="scrim lite msgmenu-scrim hidden"></div>
<div id="msgmenu" class="msgmenu hidden" role="menu"></div>
<div id="linkmenu" class="msgmenu linkmenu hidden" role="menu"></div>
<div id="room-menu-scrim" class="scrim lite hidden"></div>
<div id="room-menu" class="pop roommenu hidden" role="menu"></div>
<div id="panel-scrim" class="scrim hidden"></div>
<aside id="panel" class="panel hidden"></aside>
<div id="item-scrim" class="scrim up hidden"></div>
<section id="item-panel" class="sheet mid up hidden"></section>
<div id="schedule-scrim" class="scrim up hidden"></div>
<section id="schedule-sheet" class="sheet tall up schedule-sheet hidden" role="dialog" aria-modal="true"></section>
<div id="export-scrim" class="scrim up hidden"></div>
<section id="export-sheet" class="sheet up export-sheet hidden" role="dialog" aria-modal="true"></section>
<div id="memo-scrim" class="scrim up mm-scrim hidden"></div>
<section id="memo-sheet" class="sheet tall up mmed hidden" role="dialog" aria-modal="true"></section>
<div id="dialog" class="dialog hidden" role="dialog" aria-modal="true"></div>
<div id="readonly" class="readonly hidden"></div>
<div id="approvals" class="apv-dock" hidden></div>
<footer class="composer cmp" id="composer">
<div id="quotanote" class="quotanote hidden"></div>
<div id="spacenote" class="quotanote spacenote hidden"></div>
<div class="tallbar"><b id="tall-title"></b><span class="sp"></span><button id="btn-shrink" class="btn" type="button"></button></div>
<div id="replying" class="replying bar2 hidden"></div>
<div id="strip" class="strip hidden"></div>
<div id="schedule-edit" class="sched-edit bar2 hidden"></div>
<div class="row">
${boot.fileStorage === false ? "" : `<button id="btn-pic" class="ib pic" type="button"><span class="ic-img" aria-hidden="true"></span></button>
<button id="btn-file" class="ib file" type="button"><span class="ic-clip" aria-hidden="true"></span></button>
<input id="pic-input" type="file" accept="image/*" multiple hidden>
<input id="file-input" type="file" multiple hidden>
`}<div class="inwrap ta"><textarea id="input" rows="1" enterkeyhint="enter"></textarea><button id="btn-grow" class="grow" type="button"><span class="ic-grow" aria-hidden="true"></span></button></div>
<button id="btn-schedule" class="ib sched-clock" type="button" aria-label="${e(ROOM_STRINGS[lang].sched.title)}" title="${e(ROOM_STRINGS[lang].sched.title)}"><span class="ic-clock" aria-hidden="true"></span></button>
<button id="btn-send" class="send" type="button"></button>
</div>
<div id="picker" class="picker atpop hidden"></div>
</footer></div><aside id="desktop-side" class="side"></aside></div>`,
  });
}
