// A file's own page, /v/<fileId> (docs/api/files.md): the topic page's dark
// bar (what the file is, who sent it where, back to its message, download, the other files of that message) above
// the file. Images are shown here; Markdown, plain text, SVG and HTML in a frame on the content domain
// (file-view.ts); supported videos play here; anything else, or what is too large to show, is a card to download it.

import { escapeHtml as e } from "./util";
import { layout, type Lang } from "./layout";
import type { User } from "./auth";
import type { FileView } from "./room-do";
import { FRAME_CSP, FRAME_SANDBOX } from "./file-view";
import { PREVIEW_MAX, isVideo, viewKind, type ViewKind } from "./file-kind";

const S = {
  en: {
    meta: "Uploaded by <b>{who}</b> · in “{room}” · {size} · {time}",
    backTitle: "Back to the message",
    backTo: "Back to #{seq}",
    backRoom: "Back to the topic",
    download: "Download",
    fold: "Collapse",
    unfold: "Expand",
    filesIn: "{n} files in this message",
    whoRuns: "Running a web page made by <b>{who}</b> in an isolated environment",
    whoLimits: "It cannot read your Scorpio sign-in or open new windows, and it asks you before opening any outside link. It can see your IP address.",
    sand: "Isolated page content",
    runTitle: "Run the web page made by {who}?",
    runNote: "This web page was uploaded by another member. It runs on a separate domain isolated from Scorpio, and only after you confirm. Once it runs, its author and the public CDNs and Google Fonts it loads may see your IP address.",
    can: "It can run its own scripts and display text, charts and other content",
    cannot1: "It cannot read your Scorpio sign-in",
    cannot2: "It cannot open new windows or submit forms, and it asks you before opening any outside link",
    run: "Run page",
    source: "Only want the source? Use Download at the top right.",
    linkQ: "This page wants to open an outside website in a new tab:",
    open: "Open in new tab",
    no: "Cancel",
    other: "{size} · This type of file can't be previewed in the browser. Download it and open it on your computer.",
    tooLarge: "{size} · Too large to preview in the browser. Download it to open it.",
    from: "Uploaded by {who} · “{room}”",
    goneTitle: "This file has been removed",
    gone: "The uploader's storage was full, so the oldest files were removed first. If you still need it, ask the uploader to send it again.",
    failed: "The file could not be opened. Reload the page to try again.",
    moved: "This page tried to go to another address and was blocked. Reload this page to open the file again.",
    linkRisk: "Outside websites are not controlled by Scorpio. They will see your IP address and may be impersonating a site you know. Open it only if you trust the address, and don't enter any account password there.",
  },
  zh: {
    meta: "<b>{who}</b> 上传 · 主题「{room}」 · {size} · {time}",
    backTitle: "返回这条消息",
    backTo: "返回 #{seq}",
    backRoom: "返回主题",
    download: "下载",
    fold: "收起",
    unfold: "展开",
    filesIn: "这条消息中的 {n} 个文件",
    whoRuns: "正在隔离环境中运行 <b>{who}</b> 制作的网页",
    whoLimits: "它无法读取你的 Scorpio 登录信息，不能弹出新窗口；打开外部链接前会先征得你的确认。它可以看到你的 IP 地址。",
    sand: "隔离运行的网页内容",
    runTitle: "运行 {who} 制作的网页？",
    runNote: "这是其他成员上传的网页。它在与 Scorpio 隔离的单独域名中运行，只有你确认后才会运行。运行后，网页作者以及它加载的公共 CDN、Google Fonts 可能看到你的 IP 地址。",
    can: "可以运行它自带的脚本，显示文字、图表等内容",
    cannot1: "无法读取你的 Scorpio 登录信息",
    cannot2: "不能弹出新窗口或提交表单；打开外部链接前会先征得你的确认",
    run: "确认运行",
    source: "只想查看源代码？请使用右上角的「下载」。",
    linkQ: "该网页请求在新标签页打开外部网站：",
    open: "在新标签页打开",
    no: "取消",
    other: "{size} · 此类文件无法在网页中预览，请下载后在你的电脑上打开。",
    tooLarge: "{size} · 文件过大，无法在网页中预览，请下载后打开。",
    from: "{who} 上传 · 主题「{room}」",
    goneTitle: "该文件已被清理",
    gone: "上传者的存储空间已满，系统按规则从最早的文件开始清理。如仍需要，请联系上传者重新发送。",
    failed: "文件未能打开，请刷新页面重试。",
    moved: "该网页试图跳转到其他地址，已被拦截。刷新本页可重新打开这个文件。",
    linkRisk: "外部网站不受 Scorpio 控制，会看到你的 IP 地址，也可能是仿冒的网站。请确认网址可信再打开，不要在其中输入任何账号密码。",
  },
} as const;

const IC = {
  down: '<svg class="fv-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/></svg>',
  jump: '<svg class="fv-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6"/></svg>',
  up: '<svg class="fv-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
  play: '<svg class="fv-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
  ext: '<svg class="fv-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

const MB = 1024 * 1024;
const sizeText = (n: number) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The type block: the extension as written (up to five characters), else the kind's; its colour goes by kind. */
const EXT_BY_KIND: Record<ViewKind, [string, string]> = { markdown: ["MD", "md"], html: ["HTML", "html"], text: ["TXT", "txt"], svg: ["SVG", "png"], image: ["IMG", "png"], other: ["FILE", "zip"] };
function extOf(name: string, kind: ViewKind): { label: string; cls: string } {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return { label: m ? m[1].toUpperCase() : EXT_BY_KIND[kind][0], cls: EXT_BY_KIND[kind][1] };
}

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

export function filePage(
  lang: Lang,
  user: User,
  v: FileView,
  p: { kind: ViewKind; framed: boolean; mine: boolean; contentOrigin: string | null },
): Response {
  const s = S[lang];
  const f = v.file;
  const room = v.room;
  // A person by their display name (the handle beside it); an agent by its full name, as the room shows them.
  const who = f.byDisplay ? (lang === "zh" ? `${f.byDisplay}（${f.by}）` : `${f.byDisplay} (${f.by})`) : f.by;
  const back = f.seq != null ? `/r/${room.id}?jump=${f.seq}` : `/r/${room.id}`;
  const raw = `/f/${room.id}/${f.id}`;
  const ext = extOf(f.name, p.kind);
  const size = sizeText(f.size);
  const card = (title: string, note: string, action: string, small: string) =>
    `<div class="fv-center"><div class="fv-card"><div class="big ${ext.cls}">${e(ext.label)}</div><h2>${title}</h2><p>${note}</p>${action}${small ? `<small>${small}</small>` : ""}</div></div>`;
  const from = e(fill(s.from, { who, room: room.name })) + (f.seq != null ? ` #${f.seq}` : "");

  let body: string;
  if (f.deleted != null) body = card(e(s.goneTitle), e(s.gone), `<a class="go" href="${e(back)}">${IC.jump}${e(s.backTitle)}</a>`, from);
  else if (p.kind === "image") body = `<div class="fv-img"><img src="${e(raw)}" alt="${e(f.name)}"></div>`;
  else if (isVideo(f.type)) body = `<div class="fv-video"><video src="${e(raw)}" controls playsinline preload="metadata"></video></div>`;
  else if (p.framed && p.kind === "html" && !p.mine) {
    // Someone else's page runs only once the viewer asks for it.
    body = card(
      e(fill(s.runTitle, { who })),
      e(s.runNote),
      `<ul><li><b>✓</b><span>${e(s.can)}</span></li><li><b>✕</b><span>${e(s.cannot1)}</span></li><li><b>✕</b><span>${e(s.cannot2)}</span></li></ul>` +
        `<button id="fv-run" class="go" type="button">${IC.play}${e(s.run)}</button>`,
      e(s.source),
    );
  } else if (p.framed) body = `<div class="fv-frame" id="fv-frame">${p.kind === "html" ? `<span class="fv-sand">${e(s.sand)}</span>` : ""}</div>`;
  else body = card(e(f.name), e(fill(p.kind !== "other" && p.kind !== "html" && f.size > PREVIEW_MAX ? s.tooLarge : s.other, { size })), `<a class="go" href="${e(raw)}" download="${e(f.name)}">${IC.down}${e(s.download)}</a>`, from);

  const files =
    v.siblings.length > 1
      ? `<nav class="fv-files"><span class="lbl">${e(fill(s.filesIn, { n: String(v.siblings.length) }))}</span>${v.siblings
          .map((x) => {
            const label = `<i>${e(extOf(x.name, viewKind(x.name, x.type)).label)}</i>${e(x.name)}`;
            if (x.id === f.id) return `<span class="fv-f on" aria-current="page">${label}</span>`;
            return x.deleted ? `<span class="fv-f gone">${label}</span>` : `<a class="fv-f" href="/v/${e(x.id)}">${label}</a>`;
          })
          .join("")}</nav>`
      : "";
  const meta = fill(s.meta, { who: e(who), room: e(room.name), size, time: `<time data-ts="${f.ts}"></time>` });
  const boot = JSON.stringify({
    kind: p.kind,
    framed: p.framed && f.deleted == null,
    ticket: `/v/${f.id}/ticket`,
    sandbox: p.framed && p.kind in FRAME_SANDBOX ? FRAME_SANDBOX[p.kind as keyof typeof FRAME_SANDBOX] : null,
    csp: p.framed && p.kind in FRAME_CSP ? FRAME_CSP[p.kind as keyof typeof FRAME_CSP] : null,
    moved: s.moved,
    name: f.name,
    failed: s.failed,
    fold: s.fold,
    unfold: s.unfold,
  }).replace(/</g, "\\u003c");
  return layout(lang, {
    title: `${f.name} · ${room.name}`,
    user,
    path: `/v/${f.id}`,
    bodyClass: `fv fv-${p.kind}`,
    frames: p.contentOrigin || undefined,
    head: `<link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/file-page.css"><script type="application/json" id="fv-boot">${boot}</script><script src="/static/time.js" defer></script><script src="/static/file-page.js" defer></script>`,
    body:
      `<header class="fv-top"><div class="fv-bar"><a class="fv-back" href="${e(back)}" title="${e(s.backTitle)}" aria-label="${e(s.backTitle)}">‹</a>` +
      `<span class="fv-ext ${ext.cls}">${e(ext.label)}</span>` +
      `<div class="fv-t"><b class="fv-name">${e(f.name)}</b><span class="fv-meta">${meta}</span></div>` +
      `<button class="fv-fold" type="button" aria-label="${e(s.fold)}" aria-expanded="true">${IC.up}</button>` +
      `<div class="fv-acts"><a class="fv-btn" href="${e(back)}">${IC.jump}${e(f.seq != null ? fill(s.backTo, { seq: String(f.seq) }) : s.backRoom)}</a>` +
      (f.deleted == null ? `<a class="fv-btn pri" href="${e(raw)}" download="${e(f.name)}">${IC.down}${e(s.download)}</a>` : "") +
      `</div></div>${files}</header>` +
      (p.framed && p.kind === "html" && f.deleted == null
        ? `<div class="fv-strip who" id="fv-who"${p.mine ? "" : " hidden"}><span>${fill(s.whoRuns, { who: e(f.by) })}</span><span class="sp"></span><small>${e(s.whoLimits)}</small></div>`
        : "") +
      // The link strip floats over the file, so it never moves what is under the pointer.
      `<div class="fv-stage"><div class="fv-strip link" id="fv-link" hidden role="group" aria-labelledby="fv-link-q" aria-describedby="fv-link-risk"><span class="q" id="fv-link-q">${e(s.linkQ)}</span><code class="fv-url"></code><p class="risk" id="fv-link-risk">${e(s.linkRisk)}</p>` +
      `<a class="b go fv-open" target="_blank" rel="noopener noreferrer">${IC.ext}${e(s.open)}</a><button class="b no fv-cancel" type="button">${e(s.no)}</button></div>` +
      `<main class="fv-body" id="fv-content">${body}</main></div>`,
  });
}
