// A file's own page and the content domain its Markdown, plain text and HTML are shown from (docs/api/files.md).
// The page /v/<fileId> is ours: the session cookie says who it is, the room says whether they may see the file.
// What the file holds is shown in a frame on <label>.<CONTENT_DOMAIN> (e.g. example-content.com): another site, where
// no cookie is ever set, and a new origin each time a file is opened. The page asks for a ticket first (60 s, this
// one file, sealed with VIEW_TICKET_KEY: view-ticket.ts); the host's label is signed with it, so a ticket opens only on
// its own host and nobody can make up a host or a ticket.

import { cardWrapper } from "./card-wrapper";
import { roomStub } from "./room-stub";
import MarkdownIt from "markdown-it";
import { fileKey, PREVIEW_MAX, type FrameKind } from "./file-kind";
import { storedObject } from "./files";
import { readTicket, ticketKey } from "./view-ticket";

// ---------- the content domain ----------

/** Where HTML may load scripts, styles and fonts from (the list Claude's artifacts allow, and Plotly). */
const CDN_SCRIPTS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://cdn.tailwindcss.com https://code.jquery.com https://cdn.plot.ly";
const CDN_STYLES = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://fonts.googleapis.com";
const CDN_FONTS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://fonts.gstatic.com";

/**
 * HTML runs with its own origin (a new one each opening, so allow-same-origin gives it nothing of anyone else's):
 * localStorage, frames of its own, workers. It cannot reach the network (no fetch, no forms, no outside images),
 * open windows, or move its parent; scripts only inline or from the CDNs above.
 */
export const htmlCsp = (parent: string) =>
  `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDN_SCRIPTS}; style-src 'unsafe-inline' ${CDN_STYLES}; font-src data: ${CDN_FONTS}; ` +
  `img-src data: blob:; media-src data: blob:; frame-src data: blob:; worker-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; ` +
  `frame-ancestors ${parent}; sandbox allow-scripts allow-same-origin`;

/** Markdown, plain text and SVG: no script at all; a link opens in a new tab of its own (outside the sandbox). */
export const docCsp = (parent: string) =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors ${parent}; sandbox allow-popups allow-popups-to-escape-sandbox`;

/**
 * The same, for the iframe's `csp` attribute (CSP Embedded Enforcement, Chrome): every document
 * that frame ever holds must take it, and the content host says it does (Allow-CSP-From), so whatever the frame
 * navigates to elsewhere is refused. frame-ancestors and sandbox are the response's and the iframe's own business.
 */
export const FRAME_CSP: Record<FrameKind, string> = {
  html: htmlCsp("x").replace(/; frame-ancestors .*$/, ""),
  markdown: docCsp("x").replace(/; frame-ancestors .*$/, ""),
  text: docCsp("x").replace(/; frame-ancestors .*$/, ""),
  svg: docCsp("x").replace(/; frame-ancestors .*$/, ""),
};

/** The frame's sandbox flags, matching the CSP above (the page sets them on the iframe too). */
export const FRAME_SANDBOX: Record<FrameKind, string> = {
  html: "allow-scripts allow-same-origin",
  markdown: "allow-popups allow-popups-to-escape-sandbox",
  text: "allow-popups allow-popups-to-escape-sandbox",
  svg: "",
};

const PERMISSIONS = "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=()";

/**
 * A link the HTML follows is not followed: its page is told (scorpio:open) and asks the person first.
 * And the page asks after every load whether this is still the file it opened (scorpio:ping, answered with the same n):
 * a document that does not answer is somewhere else, and the page takes the frame down.
 */
const linkBridge = (parent: string) =>
  `<script>(function(){var P=${JSON.stringify(parent).replace(/</g, "\\u003c")};var W=parent;` +
  `addEventListener("message",function(e){var d=e.data;if(e.source===W&&e.origin===P&&d&&d.type==="scorpio:ping")W.postMessage({type:"scorpio:pong",n:d.n},P)});` +
  `function tell(h){var u;try{u=new URL(h,location.href)}catch(e){return}` +
  `if(/^https?:$/.test(u.protocol))parent.postMessage({type:"scorpio:open",url:u.href},P)}` +
  `document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;` +
  `var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();tell(a.href)},true);` +
  `window.open=function(h){if(h)tell(String(h));return null}})()</script>`;

// The topic page's tokens (room-tokens.css, light and dark) and the file page's styles (fv.css): the
// frame is another site and loads nothing of ours, so what it needs is written here.
const LIGHT = "--bg:#eef1f7;--surface:#ffffff;--fg:#131927;--muted:#5c6374;--line:rgba(19,25,39,.09);--code-bg:#edf0f6;--link:#344da2;--add:#007852;--del:#ba2c22";
const DARK = "--bg:#070b15;--surface:#121a2c;--fg:#e9edf5;--muted:#9ca5b8;--line:rgba(150,170,220,.13);--code-bg:#1a2338;--link:#a7c0f9;--add:#62d8a6;--del:#f97165";
const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace`;
const DOC_CSS =
  `*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--fg);font:16px/1.6 ${FONT};-webkit-font-smoothing:antialiased}` +
  // Markdown: one readable column
  `.doc{max-width:780px;margin:0 auto;padding:40px 32px 64px;line-height:1.75;overflow-wrap:break-word}.doc>:first-child{margin-top:0}` +
  `.doc h1,.doc h2,.doc h3,.doc h4,.doc h5,.doc h6{font-weight:800;line-height:1.35;margin:1.4em 0 .5em}.doc h1{font-size:1.75em}.doc h2{font-size:1.4em}.doc h3{font-size:1.15em}` +
  `.doc p{margin:.6em 0}.doc ul,.doc ol{padding-left:1.4em;margin:.5em 0}.doc li>p{margin:.2em 0}` +
  `.doc blockquote{margin:.8em 0;padding:0 1em;color:var(--muted);border-left:3px solid var(--line)}` +
  `.doc code{font:.88em ${MONO};padding:.08em .35em;border-radius:5px;background:var(--code-bg)}` +
  `.doc pre{padding:12px 14px;border-radius:10px;background:var(--code-bg);overflow-x:auto;font:13px/1.6 ${MONO}}.doc pre code{background:none;padding:0;font-size:inherit}` +
  `.doc a{color:var(--link);text-decoration:underline;text-underline-offset:3px}` +
  `.doc table{border-collapse:collapse;font-size:14.5px;margin:.8em 0;display:block;overflow-x:auto;max-width:100%}.doc th,.doc td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left}` +
  `.doc img{max-width:100%}.doc hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}` +
  // plain text: monospaced, line numbers; a diff's lines in colour
  `.text table{border-collapse:collapse;font:13px/1.65 ${MONO};width:100%;margin-top:14px}` +
  `.text td.n{width:1%;padding:0 14px 0 20px;text-align:right;color:var(--muted);opacity:.6;user-select:none;-webkit-user-select:none;vertical-align:top}` +
  `.text td.l{padding:0 20px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.text tr.add td.l{color:var(--add)}.text tr.del td.l{color:var(--del)}.text tr.hd td.l{color:var(--link)}` +
  // SVG: the picture on the page's ground
  `body.pic{background:var(--bg)}.pic main{display:flex;align-items:flex-start;justify-content:center;padding:28px}` +
  `.pic img{display:block;max-width:100%;max-height:calc(100vh - 56px);width:auto;height:auto;border-radius:10px;box-shadow:0 0 0 1px var(--line),0 20px 40px -24px rgba(0,0,0,.45)}` +
  `.note{color:var(--muted);padding:28px 20px;text-align:center}` +
  `@media (max-width:760px){.doc{padding:22px 18px 48px;font-size:15.5px}.text td.n{padding:0 10px 0 12px}.text td.l{padding-right:12px}.pic main{padding:14px}}`;

const md = new MarkdownIt({ html: false, linkify: true });
// Links only to the web and to mail (not markdown-it's every scheme but javascript:, vbscript:, file:, data:, which lets
// ms-msdt: or search-ms: through); they open in a new tab of their own, telling the other site
// nothing about where they came from.
md.validateLink = (url: string) => /^(https?:|mailto:|#)/i.test(url.trim());
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

/** Markdown and plain text rendered once per file (its bytes never change), kept in this colo's cache; bump to drop old renders. */
const RENDER_VERSION = "4";

/**
 * Markdown in pieces of about 32 KB, cut at a blank line outside a code fence, so markdown-it never holds the tokens of
 * a whole file at once (2 MB of short paragraphs would be millions of them: more memory than a Worker has). A piece
 * with no blank line to cut at is cut at a line at 64 KB, a line longer than that at 64 KB.
 */
export function mdChunks(text: string, soft = 32 * 1024, hard = 64 * 1024): string[] {
  const out: string[] = [];
  let start = 0;
  let at = 0;
  let fence = "";
  while (at < text.length) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    if (end - at > hard) end = at + hard; // a line longer than a piece is cut
    const head = text.slice(at, Math.min(end, at + 200));
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(head);
    if (f && (!fence || f[1][0] === fence)) fence = fence ? "" : f[1][0];
    const blank = end - at <= 200 && head.trim() === "";
    const size = end + 1 - start;
    if ((size >= soft && blank && !fence) || size >= hard) {
      out.push(text.slice(start, end + 1));
      start = end + 1;
    }
    at = end + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

export const renderMarkdown = (text: string) => mdChunks(text).map((c) => md.render(c)).join("");

/** The text in a file: UTF-8, or GB18030 when it is not valid UTF-8 (common for Chinese text); null for binary. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {}
  try {
    return new TextDecoder("gb18030").decode(bytes);
  } catch {}
  return new TextDecoder("utf-8").decode(bytes);
}

const docPage = (theme: "light" | "dark", cls: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">` +
  `<meta name="color-scheme" content="${theme}"><style>:root{${theme === "dark" ? DARK : LIGHT}}${DOC_CSS}</style></head><body class="${cls}">${body}</body></html>`;

/** Plain text shown up to this many lines (each is a row; 2 MB of empty lines would be millions), the rest a download. */
export const TEXT_LINES = 20_000;

/** Plain text as numbered lines; a diff's added, removed and hunk lines marked. */
export function textTable(text: string, diff: boolean, max = TEXT_LINES): string {
  const rows: string[] = [];
  let at = 0;
  while (at < text.length && rows.length < max) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    const l = text.slice(at, end > at && text[end - 1] === "\r" ? end - 1 : end);
    const c = !diff ? "" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") || l.startsWith("diff ") ? "hd" : "";
    rows.push(`<tr${c ? ` class="${c}"` : ""}><td class="n">${rows.length + 1}</td><td class="l">${md.utils.escapeHtml(l) || " "}</td></tr>`);
    at = end + 1;
  }
  const more = at < text.length ? `<p class="note">Only the first ${max.toLocaleString("en")} lines are shown. Download the file to see the rest. · 仅显示前 ${max.toLocaleString("en")} 行，完整内容请下载文件查看。</p>` : "";
  return `<table>${rows.join("")}</table>${more}`;
}

const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The first bytes of a file as characters, one per byte (enough to find a doctype or a <meta charset>). */
const headOf = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(0, 2048));

/** Where the link bridge goes in HTML: after a doctype (before it, the page would fall into quirks mode). */
export function bridgeAt(head: Uint8Array): number {
  return /^(\xEF\xBB\xBF)?\s*(<!doctype[^>]*>)?/i.exec(headOf(head))![0].length; // a UTF-8 BOM, spaces, the doctype
}

/**
 * HTML as it comes from R2, the link bridge put in after its first bytes: streamed, never the whole file in memory
 * (up to 25 MB each, and a Worker serves several at once).
 */
async function htmlStream(body: ReadableStream<Uint8Array>, parent: string): Promise<{ stream: ReadableStream<Uint8Array>; head: Uint8Array }> {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  while (head.length < 2048) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = new Uint8Array(head.length + value.length);
    next.set(head);
    next.set(value, head.length);
    head = next;
  }
  const at = bridgeAt(head);
  const parts = [head.subarray(0, at), new TextEncoder().encode(linkBridge(parent)), head.subarray(at)];
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      const part = parts.shift();
      if (part) return c.enqueue(part);
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(why) {
      return reader.cancel(why);
    },
  });
  return { stream, head };
}

/** The charset to declare: UTF-8, unless the file says in a <meta> it is something else (then the browser follows it). */
export function htmlType(bytes: Uint8Array): string {
  const declared = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/i.exec(headOf(bytes))?.[1];
  return declared && !/^utf-?8$/i.test(declared) ? "text/html" : "text/html; charset=utf-8";
}

/** Every answer on the content domain that is not a file: plain text, and a CSP of nothing, so no page there can lean on it. */
export const BARE_CSP = "default-src 'none'; form-action 'none'; base-uri 'none'; sandbox"; // stricter than FRAME_CSP: a frame may show it

/**
 * An answer of the content host's own (expired, gone, refused): a few lines, read in the frame where they land, so a
 * page (English, then 中文: it cannot know the viewer's language) with no background of its own, on the frame's ground.
 * The bare policy, styles inline only: still stricter than the frame's.
 */
export function plain(status: number, text: string, theme?: "light" | "dark"): Response {
  const lines = text.split(" · ").map((l) => `<p>${md.utils.escapeHtml(l)}</p>`).join("");
  const page =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">` +
    `<style>body{margin:0;padding:28px 20px;font:15px/1.6 ${FONT};text-align:center}p{margin:0 auto .4em;max-width:560px}` +
    // The theme of the page it lands in, from the ticket; with none (a page opened on its own), the system's.
    (theme === "dark" ? `body{color:#9ca5b8;background:#121a2c}` : `body{color:#5c6374;background:#ffffff}`) +
    (theme ? "" : `@media (prefers-color-scheme:dark){body{color:#9ca5b8;background:#121a2c}}`) +
    `</style>` +
    `</head><body>${lines}</body></html>`;
  return new Response(page, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, no-transform", "x-content-type-options": "nosniff", "x-robots-tag": "noindex", "content-security-policy": `${BARE_CSP}; style-src 'unsafe-inline'` },
  });
}

/**
 * A request to the content domain. Only GET /<ticket> on the ticket's own host is answered; everything else there is
 * a 404, so no page of Scorpio's is ever served from it. No cookie is read here. GET checks current read access
 * and consumes the ticket in its topic DO.
 */
export async function contentHost(req: Request, env: Env, url: URL, label: string, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Method not allowed.");
  // Only ever as a frame: a browser that says what it is loading must be loading an iframe.
  const dest = req.headers.get("sec-fetch-dest");
  if (dest && dest !== "iframe") return plain(403, "This content can only be viewed inside Scorpio. Open the file from Scorpio. · 此内容只能在 Scorpio 中查看，请从 Scorpio 打开该文件。");
  const token = url.pathname.slice(1);
  const secret = ticketKey(env.VIEW_TICKET_KEY);
  if (!label || !secret || !token || token.includes("/")) return plain(404, "Not found. · 未找到。");
  const t = await readTicket(secret, label, token, Date.now(), true);
  if (!t) return plain(403, "Not found. · 未找到。");
  const expired = () => plain(403, "For your security, this view has expired. Open the file again from Scorpio. · 为保护你的账号，此查看链接已过期，请从 Scorpio 重新打开该文件。", t.t);
  if (!t.a || t.e * 1000 <= Date.now()) return expired();
  // A browser's preliminary HEAD must neither expose bytes nor spend its following GET.
  if (req.method === "HEAD") return new Response(null, { headers: { "cache-control": "no-store, no-transform" } });
  const stub = await roomStub(env, t.r).catch(() => null);
  if (!stub) return plain(404, "This file is no longer available. · 该文件已不存在。", t.t);
  const headers: Record<string, string> = {
    // no-transform: the edge must not add to what a file holds (Web Analytics injects its beacon into HTML otherwise).
    "cache-control": "no-store, no-transform",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
    "permissions-policy": PERMISSIONS,
    "allow-csp-from": t.o, // the page's iframe csp attribute (FRAME_CSP), taken as it is
  };
  if (t.c !== undefined) {
    const card = await stub.consumeCardTicket(t, label);
    if ("err" in card) return ["card_not_found", "room_deleted", "room_not_found"].includes(card.err.code)
      ? plain(404, "This card is no longer available. · 该卡片已不存在。", t.t) : expired();
    if (!card.ok) return expired();
    return new Response(cardWrapper(card.ok.html, t.o, t.t), { headers: {
      ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": htmlCsp(t.o),
    } });
  }
  const access = await stub.consumeViewTicket(t, label);
  if ("err" in access) {
    if (["file_not_found", "room_deleted", "room_not_found"].includes(access.err.code))
      return plain(404, "This file is no longer available. · 该文件已不存在。", t.t);
    return expired();
  }
  if (!access.ok) return expired();
  const gone = () => plain(404, "This file is no longer available. · 该文件已不存在。", t.t);
  if (t.k === "html") {
    const obj = await storedObject(env, fileKey(t.r, t.h));
    if (!obj) return gone();
    const { stream, head } = await htmlStream(obj.body, t.o);
    return new Response(stream, { headers: { ...headers, "content-type": htmlType(head), "content-security-policy": htmlCsp(t.o) } });
  }
  let body: string | undefined;
  let cached = false;
  if (t.k === "svg") {
    // A picture: as an <img> (no script in it ever runs), from a data: URL (the only images this page may load).
    const obj = await storedObject(env, fileKey(t.r, t.h));
    if (!obj) return gone();
    if (obj.size <= PREVIEW_MAX) body = `<main><img alt="" src="data:image/svg+xml;base64,${base64(new Uint8Array(await obj.arrayBuffer()))}"></main>`;
    else await obj.body.cancel();
  } else {
    // Markdown and plain text: rendered once, then from this colo's cache (theme apart: it is only the page's CSS). The
    // cache is asked first: R2 is read only for a render not there yet.
    const key = new Request(`https://${env.CONTENT_DOMAIN}/__render/${RENDER_VERSION}/${t.k}${t.d ? "-diff" : ""}/${t.h}`);
    const hit = await caches.default.match(key).catch(() => undefined);
    if (hit) {
      body = await hit.text();
      cached = true;
    } else {
      const obj = await storedObject(env, fileKey(t.r, t.h));
      if (!obj) return gone();
      let text: string | null = null;
      if (obj.size <= PREVIEW_MAX) text = textOf(new Uint8Array(await obj.arrayBuffer()));
      else await obj.body.cancel();
      if (text != null) body = t.k === "markdown" ? `<main class="doc">${renderMarkdown(text)}</main>` : textTable(text, t.d === 1);
      if (body) ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { "cache-control": "public, max-age=2592000" } })).catch(() => {}));
    }
  }
  if (!body) body = `<p class="note">This file can't be displayed as text. Please download it. · 该文件无法以文本形式显示，请下载后查看。</p>`;
  const cls = t.k === "svg" ? "pic" : t.k === "text" ? "text" : "";
  return new Response(docPage(t.t, cls, body), {
    headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": docCsp(t.o), ...(t.k === "svg" ? {} : { "x-render": cached ? "cache" : "fresh" }) },
  });
}
