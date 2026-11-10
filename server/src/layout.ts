import { escapeHtml as e, parseCookies } from "./util";
import type { User } from "./auth";
import { S_LOCKUP, UT_LOCKUP } from "./marks";
import { strings } from "./strings";
import cli from "../../cli/package.json";

export type Lang = "en" | "zh";

export function langOf(req: Request): Lang {
  const c = parseCookies(req).lang;
  if (c === "en" || c === "zh") return c;
  return /^zh\b/i.test(req.headers.get("accept-language") || "") ? "zh" : "en";
}

/** Every page but the room: with the website, what it costs, the terms and how to reach us; always the maker. */
export function footer(t: ReturnType<typeof strings>): string {
  const links = site.links ? `<a href="/pricing">${t.footPricing}</a><a href="/privacy">${t.footPrivacy}</a><a href="/terms">${t.footTerms}</a><a href="mailto:${SUPPORT}">${SUPPORT}</a>` : "";
  return `<footer class="site"><nav>${links}</nav><div class="by"><span>by</span>${UT_LOCKUP}</div></footer>`;
}
const SUPPORT = "support@utlabs.ai";

/**
 * The deployed version: every /static/*.css and *.js a page links carries it as ?v=, so those files are cached
 * for a year (web/public/_headers) and a deploy still shows at once. The Worker sets it from its version metadata on each
 * request; without one (unit tests) it is this isolate's start, which changes with every restart.
 */
let assetVersion = Date.now().toString(36);
export function setAssetVersion(id: string | undefined): void {
  if (id) assetVersion = id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || assetVersion;
}

/**
 * What the deployment wraps around this server (createWorker in index.ts): whether it has a website (pricing, terms,
 * changelog), so the pages link to them, the version the settings page shows, and the other domains whose links
 * md.js may show by their words alone. Set on each request, like the asset version; without a website, the version
 * is the CLI's, which is what a release of this repository is tagged with.
 */
let site = { links: false, version: cli.version, linkDomains: [] as string[] };
export function setSite(links: boolean, version: string | undefined, linkDomains: string[] = []): void {
  site = { links, version: version || cli.version, linkDomains };
}
export const siteLinks = (): boolean => site.links;
export const productVersion = (): string => site.version;
/** Our quoted src="/static/…" and href="/static/…" only: what people write is escaped, so it never has a bare quote. */
export function versioned(html: string): string {
  return html.replace(/(\s(?:src|href)="\/static\/[^"?#]+\.(?:css|js))"/g, `$1?v=${assetVersion}"`);
}

export function layout(lang: Lang, p: { title: string; body: string; user?: User | null; head?: string; first?: string; bodyClass?: string; path?: string; thirdParty?: string; frames?: string; top?: { light: string; dark: string } }): Response {
  const t = strings(lang);
  const other = lang === "zh" ? "en" : "zh";
  const fullView = /\b(room|homeview|settingsview|appview|landing|sx-pub)\b/.test(p.bodyClass || "") || /^fv\b/.test(p.bodyClass || ""); // fv: a file's own page
  const nav = p.user
    ? `<nav class="top"><a class="brand" href="/app">${S_LOCKUP}</a><span class="sp"></span><a href="/settings">${t.settings}</a><a href="/devices">${t.devices}</a><span class="who">${e(p.user.handle)}</span><form method="post" action="/logout"><button class="link">${t.signOut}</button></form><a href="/lang?to=${other}&amp;next=${encodeURIComponent(p.path || "/")}">${t.lang}</a></nav>`
    : `<nav class="top"><a class="brand" href="/">${S_LOCKUP}</a><span class="sp"></span><a href="/lang?to=${other}&amp;next=${encodeURIComponent(p.path || "/")}">${t.lang}</a></nav>`;
  const html = `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<title>${e(p.title)}</title>
${p.first || ""}<script src="/static/theme.js"></script>
<link rel="stylesheet" href="/static/app.css">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/static/icons/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png">
<meta name="theme-color" content="${p.top?.light || "#ffffff"}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${p.top?.dark || "#0b101d"}" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Scorpio">
<script src="/static/pwa.js" defer></script>
${p.user ? `<script src="/static/workspace-preference-cleanup.js" data-account="${e(p.user.handle)}" defer></script>` : ""}
${site.linkDomains.length ? `<meta name="link-domains" content="${e(site.linkDomains.join(" "))}">\n` : ""}${p.head || ""}
</head>
<body class="${p.bodyClass || ""}">
${fullView ? "" : nav}
${p.body}
${fullView ? "" : footer(t)}
</body>
</html>`;
  return new Response(versioned(html), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, no-transform", // no-transform: the edge must not inject scripts (e.g. Web Analytics) or rewrite our HTML
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      "content-security-policy":
        `default-src 'self'; script-src 'self'${p.thirdParty ? ` ${p.thirdParty}` : ""}; style-src 'self'; img-src 'self' data: blob: https:; media-src 'self'; connect-src 'self'${p.thirdParty || p.frames ? `; frame-src ${[p.thirdParty, p.frames].filter(Boolean).join(" ")}` : ""}; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com https://github.com https://creem.io https://*.creem.io`, // Creem: 按月付 posts to /billing/checkout, which redirects to its checkout (test mode: creem.io 308s to www; the live host is unseen, so any Creem subdomain)
    },
  });
}

/** A public page's own address, without its query, and what it is about, for search engines. */
export const seoHead = (origin: string, path: string, description: string) =>
  `<link rel="canonical" href="${e(origin + path)}">\n<meta name="description" content="${e(description)}">`;

const MB_ = 1024 * 1024;
export const sizeText = (n: number) => (n >= 1024 * MB_ ? `${(n / (1024 * MB_)).toFixed(1)} GB` : n >= MB_ ? `${(n / MB_).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
