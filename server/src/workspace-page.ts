import { escapeHtml as e } from "./util";
import { versioned, type Lang } from "./layout";
import { S_LOCKUP } from "./marks";
import { strings } from "./strings";
import type { WorkspaceComputer } from "./room/workspace";

export function workspacePage(lang: Lang, data: { viewerAccount: string; computer: WorkspaceComputer; topic: { id: string; name: string } }, embed: boolean): Response {
  const t = strings(lang).workspace;
  const payload = JSON.stringify({ ...data, embed, lang, strings: t }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return new Response(versioned(`<!doctype html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(data.topic.name)} · ${e(t.title)}</title>
<script src="/static/theme.js"></script><link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/workspace-assets/view.css"><link rel="stylesheet" href="/static/workspace-view.css"><link rel="stylesheet" href="/static/workspace-navigation.css">
<script src="/static/room-socket.js"></script><script type="module" src="/static/workspace-assets/view.js"></script></head><body class="wv ${embed ? "wv-embed" : "wv-standalone"}">
<div id="workspace-data" hidden data-json="${e(payload)}"></div>
<header class="wv-header">${embed ? "" : `<a class="wv-brand" href="/app" aria-label="Scorpio">${S_LOCKUP}</a>`}<strong class="wv-title">${e(t.title)}</strong><span id="wv-topic">${e(data.topic.name)}</span><span class="wv-dot">·</span><div class="wv-host"><button id="wv-computer" class="wv-button" type="button" aria-expanded="false"><b id="wv-computer-label">${e(data.computer.name)}</b><span id="wv-online"></span></button><div id="wv-computers" class="wv-menu" hidden role="listbox"></div></div><span class="wv-readonly">${e(t.readOnly)}</span><span class="wv-spacer"></span><span id="wv-read-at"></span><button id="wv-refresh" type="button" class="wv-button"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 4a5 5 0 1 0 1 5M13 1v4H9"/></svg>${e(t.refresh)}</button></header>
<nav id="wv-navigation" class="wv-navigation" aria-label="${e(t.currentDirectory)}"><span class="wv-navigation-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M1 5V3h5l2 2h7v9H1Z"/></svg></span><div id="wv-breadcrumbs" class="wv-breadcrumbs"></div><button id="wv-directory-toggle" type="button" class="wv-directory-toggle" aria-expanded="false" disabled>${e(t.switchDirectory)} <span aria-hidden="true">⌄</span></button><div id="wv-locations" class="wv-menu wv-locations" role="listbox" hidden></div><div id="wv-ancestors" class="wv-menu wv-ancestors" hidden></div></nav>
<div id="wv-banner" class="wv-banner" role="status" hidden></div><main class="wv-main"><aside class="wv-sidebar"><section class="wv-files"><button id="wv-up" type="button" class="wv-up" disabled><span aria-hidden="true">↑</span>${e(t.up)}<small id="wv-root-note" hidden>${e(t.atRoot)}</small></button><h2>${e(t.files)}</h2><div id="wv-tree" role="tree"></div></section><section class="wv-changes"><h2>${e(t.git)}</h2><div id="wv-changes"></div></section></aside><section class="wv-document"><div id="wv-document-top" hidden><span id="wv-path"></span><div class="wv-segment"><button id="wv-file" type="button">${e(t.file)}</button><button id="wv-diff" type="button">${e(t.changes)}</button></div></div><div id="wv-diff-headings" hidden><span>${e(t.before)}</span><span>${e(t.after)}</span></div><div id="wv-editor"></div><div id="wv-empty" class="wv-empty">${e(t.choose)}</div></section></main></body></html>`), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store, no-transform", "referrer-policy": "same-origin",
      "x-frame-options": embed ? "SAMEORIGIN" : "DENY",
      "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-src 'none'; object-src 'none'; frame-ancestors ${embed ? "'self'" : "'none'"}` },
  });
}
