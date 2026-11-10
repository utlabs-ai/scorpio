// The calendar as a read-only CalDAV account (docs/api/schedules.md, Into a calendar; the contract in the private arch notes):
// /dav/ in Radicale's layout, HTTP Basic with the handle and the calendar token, PROPFIND and REPORT over the same events as the
// feed, one resource per run, and 403 to every change. No session, no new storage; the event list is cached 5 minutes per
// account beside the feed's copy, so one sync (PROPFIND, then a multiget) builds it once. XML in is read by the small parser
// below (no dependency): the names it looks at do not collide across the DAV, CalDAV and CalendarServer namespaces.

import { userByCalendarToken } from "./accounts";
import { origin } from "./auth";
import { calendarEvents, eventText, type CalendarTopic } from "./calendar";
import { CACHE_MS, calendarTopics, feedOf } from "./calendar-feed";

export const DAV_ROOT = "/dav/";
const CALENDAR = "scorpio";
export const DISPLAY_NAME = "Scorpio";
export const BODY_MAX = 65_536;
const EVENT_MS = 15 * 60_000; // EVENT_DURATION in calendar.ts

const NS = { d: "DAV:", c: "urn:ietf:params:xml:ns:caldav", cs: "http://calendarserver.org/ns/" } as const;

// ---------- XML in ----------

export interface XmlNode {
  /** The namespace URI the element is in ("" when none is declared). */
  ns: string;
  /** The local name, without its prefix. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
  if (e[0] === "#") return String.fromCodePoint(parseInt(e[1] === "x" ? e.slice(2) : e.slice(1), e[1] === "x" ? 16 : 10));
  return ENTITIES[e] ?? m;
});

/**
 * A document's root element, or null when the text is not one well-formed element (then the request is a 400). Prolog,
 * comments and CDATA are skipped; namespaces are resolved from xmlns declarations so an answer can name an unknown
 * property in its own namespace; text is the element's own character data, trimmed.
 */
export function parseXml(text: string): XmlNode | null {
  const TAG = /<(\/)?([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>/y;
  const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const stack: { node: XmlNode; scope: Record<string, string>; qname: string }[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  const scopeOf = () => stack.length ? stack[stack.length - 1].scope : {};
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i && stack.length) stack[stack.length - 1].node.text += unescapeXml(text.slice(i, lt));
    if (text.startsWith("<?", lt)) { const end = text.indexOf("?>", lt); if (end < 0) return null; i = end + 2; continue; }
    if (text.startsWith("<!--", lt)) { const end = text.indexOf("-->", lt); if (end < 0) return null; i = end + 3; continue; }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt);
      if (end < 0 || !stack.length) return null;
      stack[stack.length - 1].node.text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith("<!", lt)) return null; // a DOCTYPE: nothing a client sends
    TAG.lastIndex = lt;
    const m = TAG.exec(text);
    if (!m) return null;
    i = TAG.lastIndex;
    const [, closing, qname, attrText, selfClosing] = m;
    if (closing) {
      const top = stack.pop();
      if (!top || top.qname !== qname) return null;
      if (!stack.length) root = top.node; // anything but whitespace after it fails the next tag
      continue;
    }
    if (root) return null; // text after the root element
    const scope = { ...scopeOf() };
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(ATTR)) {
      const value = unescapeXml(a[2] ?? a[3] ?? "");
      if (a[1] === "xmlns") scope[""] = value;
      else if (a[1].startsWith("xmlns:")) scope[a[1].slice(6)] = value;
      else attrs[a[1].includes(":") ? a[1].slice(a[1].indexOf(":") + 1) : a[1]] = value;
    }
    const colon = qname.indexOf(":");
    const prefix = colon < 0 ? "" : qname.slice(0, colon);
    if (colon >= 0 && !(prefix in scope)) return null; // an undeclared prefix
    const node: XmlNode = { ns: scope[prefix] ?? "", name: colon < 0 ? qname : qname.slice(colon + 1), attrs, children: [], text: "" };
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    if (selfClosing) { if (!stack.length) root = node; continue; }
    stack.push({ node, scope, qname });
  }
  if (!root || stack.length) return null;
  const trim = (n: XmlNode) => { n.text = n.text.trim(); n.children.forEach(trim); };
  trim(root);
  return root;
}

const child = (n: XmlNode | null | undefined, name: string) => n?.children.find((c) => c.name === name);

// ---------- XML out ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const href = (path: string) => `<d:href>${esc(path)}</d:href>`;
const privileges = "<d:privilege><d:read/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege>";

/** A property asked for: its namespace and name, for the 404 propstat when the resource has no such property. */
type Prop = { ns: string; name: string };

/** The element for a property we do not have, in its own namespace so the client recognises it. */
function unknownProp(p: Prop): string {
  const prefix = (Object.keys(NS) as (keyof typeof NS)[]).find((k) => NS[k] === p.ns);
  if (prefix) return `<${prefix}:${p.name}/>`;
  return p.ns ? `<x:${p.name} xmlns:x="${esc(p.ns)}"/>` : `<${p.name} xmlns=""/>`;
}

/** One multistatus response: the properties found (200) and, when any, the ones not found (404). */
function response(path: string, found: string[], missing: Prop[]): string {
  let out = `<d:response>${href(path)}`;
  if (found.length || !missing.length) out += `<d:propstat><d:prop>${found.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
  if (missing.length) out += `<d:propstat><d:prop>${missing.map(unknownProp).join("")}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`;
  return out + "</d:response>";
}

const multistatus = (responses: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="${NS.d}" xmlns:c="${NS.c}" xmlns:cs="${NS.cs}">${responses.join("")}</d:multistatus>`;

// ---------- the resources ----------

/** One event as the account serves it: the resource name (`<name>.ics`), its ETag and its calendar text. */
export interface DavEvent { name: string; etag: string; start: number; body: string }

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The ETag of a body: the first 32 hex digits of its SHA-256, quoted. */
export const etagOf = async (body: string): Promise<string> => `"${(await sha256Hex(body)).slice(0, 32)}"`;

/** The calendar's ctag: the ETag rule over the sorted `name etag` lines of every event, so it changes exactly when any event does. */
export const ctagOf = (events: DavEvent[]): Promise<string> => etagOf(events.map((e) => `${e.name} ${e.etag}`).sort().join("\n"));

/** Every run as a resource, stamped with its item's modification time (calendar.ts), with its ETag. */
export async function davEvents(topics: CalendarTopic[], p: { now: number; origin: string; host: string }): Promise<DavEvent[]> {
  return Promise.all(calendarEvents(topics, p).map(async (ev) => {
    const body = eventText(ev);
    return { name: ev.name, etag: await etagOf(body), start: ev.start, body };
  }));
}

type Target =
  | { kind: "root" }
  | { kind: "principal" }
  | { kind: "calendar" }
  | { kind: "event"; name: string };

/** What a path under /dav/ names for this account (`<handle>` compared case-insensitively), or null. A collection may be asked with or without its trailing slash. */
export function targetOf(path: string, handle: string): Target | null {
  const parts = path.replace(/\/+$/, "").split("/").slice(2); // "", "dav", ...
  if (parts.length === 0) return { kind: "root" };
  if (parts[0].toLowerCase() !== handle.toLowerCase()) return null;
  if (parts.length === 1) return { kind: "principal" };
  if (parts[1] !== CALENDAR) return null;
  if (parts.length === 2) return { kind: "calendar" };
  const m = /^([A-Za-z0-9_-]+-S\d+-\d+)\.ics$/.exec(parts[2]);
  return parts.length === 3 && m ? { kind: "event", name: m[1] } : null;
}

const paths = (handle: string) => ({
  root: DAV_ROOT,
  principal: `${DAV_ROOT}${handle}/`,
  calendar: `${DAV_ROOT}${handle}/${CALENDAR}/`,
  event: (name: string) => `${DAV_ROOT}${handle}/${CALENDAR}/${name}.ics`,
});

const EVENT_TYPE = "text/calendar; charset=utf-8; component=VEVENT";

/** The properties of one resource: those asked that it has (as XML) and those it has not. */
function propsOf(target: Target, asked: Prop[] | "all", ctx: { handle: string; ctag: string; event?: DavEvent }): { found: string[]; missing: Prop[] } {
  const at = paths(ctx.handle);
  const all: Record<string, string> = {};
  const set = (ns: string, name: string, xml: string) => { all[`${ns} ${name}`] = xml; };
  set(NS.d, "resourcetype", target.kind === "event" ? "<d:resourcetype/>" : `<d:resourcetype><d:collection/>${target.kind === "principal" ? "<d:principal/>" : target.kind === "calendar" ? "<c:calendar/>" : ""}</d:resourcetype>`);
  if (target.kind === "root" || target.kind === "principal") set(NS.d, "current-user-principal", `<d:current-user-principal>${href(at.principal)}</d:current-user-principal>`);
  if (target.kind === "principal") {
    set(NS.d, "displayname", `<d:displayname>${esc(ctx.handle)}</d:displayname>`);
    set(NS.d, "principal-URL", `<d:principal-URL>${href(at.principal)}</d:principal-URL>`);
    set(NS.c, "calendar-home-set", `<c:calendar-home-set>${href(at.principal)}</c:calendar-home-set>`);
    set(NS.d, "current-user-privilege-set", `<d:current-user-privilege-set>${privileges}</d:current-user-privilege-set>`);
  }
  if (target.kind === "calendar") {
    set(NS.d, "displayname", `<d:displayname>${DISPLAY_NAME}</d:displayname>`);
    set(NS.c, "supported-calendar-component-set", '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>');
    set(NS.cs, "getctag", `<cs:getctag>${esc(ctx.ctag)}</cs:getctag>`);
    set(NS.d, "getetag", `<d:getetag>${esc(ctx.ctag)}</d:getetag>`);
    set(NS.d, "supported-report-set", "<d:supported-report-set><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set>");
    set(NS.d, "current-user-privilege-set", `<d:current-user-privilege-set>${privileges}</d:current-user-privilege-set>`);
  }
  if (target.kind === "event" && ctx.event) {
    set(NS.d, "getetag", `<d:getetag>${esc(ctx.event.etag)}</d:getetag>`);
    set(NS.d, "getcontenttype", `<d:getcontenttype>${EVENT_TYPE}</d:getcontenttype>`);
  }
  if (asked === "all") return { found: Object.values(all), missing: [] };
  const found: string[] = [];
  const missing: Prop[] = [];
  for (const p of asked) {
    const xml = all[`${p.ns} ${p.name}`];
    if (xml) found.push(xml); else missing.push(p);
  }
  return { found, missing };
}

/** The properties a PROPFIND or REPORT body asks for: the `prop` element's children; `allprop`, `propname` or no body means every one. */
function askedProps(doc: XmlNode | null): Prop[] | "all" {
  if (!doc) return "all";
  const prop = child(doc, "prop");
  if (!prop) return "all";
  return prop.children.map((c) => ({ ns: c.ns, name: c.name }));
}

// ---------- the request ----------

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "dav": "1, calendar-access", ...headers } });
const xml = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store", "dav": "1, calendar-access" } });
const davError = (status: number, element: string) => xml(status, `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="${NS.d}" xmlns:c="${NS.c}">${element}</d:error>`);
const forbidden = () => davError(403, "<d:need-privileges/>");
const unauthorized = () => text(401, "Sign in with your account name and your calendar password (Settings → Calendar subscription).", { "www-authenticate": 'Basic realm="Scorpio", charset="UTF-8"' });
const notFound = () => text(404, "Not found");

/** `/.well-known/caldav`, any method: where the account lives. */
export const wellKnown = (): Response => new Response(null, { status: 301, headers: { location: DAV_ROOT, "cache-control": "no-store" } });

/** The account and password of a Basic header, or null. */
export function basicAuth(header: string | null): { user: string; password: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!m) return null;
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return null; }
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** The account's event list, built once per 5 minutes (the same Cache API as the feed, its own key, JSON). */
async function eventsOf(req: Request, env: Env, ctx: ExecutionContext, user: { id: string; handle: string }): Promise<DavEvent[]> {
  const key = new Request(`https://cal-cache.invalid/dav/${user.id}`);
  const cache = (globalThis as { caches?: CacheStorage }).caches?.default;
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) return hit.json<DavEvent[]>();
  const site = origin(req, env);
  const events = await davEvents(await calendarTopics(env, user), { now: Date.now(), origin: site, host: new URL(site).hostname });
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(events), { headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_MS / 1000}` } })).catch(() => undefined));
  return events;
}

/** The request's XML body, null when there is none; a 413 or 400 Response when it is too long or not XML. */
async function readXml(req: Request): Promise<XmlNode | null | Response> {
  const body = await req.text();
  if (body.length > BODY_MAX) return text(413, "Request body too large");
  if (!body.trim()) return null;
  const doc = parseXml(body);
  return doc ?? text(400, "The request body is not well-formed XML");
}

/** Every request under /dav/. */
export async function caldav(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (req.method === "OPTIONS") return text(200, "", { allow: "OPTIONS, GET, HEAD, PROPFIND, REPORT" });
  const auth = basicAuth(req.headers.get("authorization"));
  const user = auth ? await userByCalendarToken(env, auth.password) : null;
  if (!auth || !user || user.handle.toLowerCase() !== auth.user.toLowerCase()) return unauthorized();
  if (!["PROPFIND", "REPORT", "GET"].includes(req.method)) return forbidden(); // every change, LOCK, POST, anything unknown
  const target = targetOf(path, user.handle);
  if (!target) return notFound();
  const at = paths(user.handle);
  const events = await eventsOf(req, env, ctx, user);
  const event = target.kind === "event" ? events.find((e) => e.name === target.name) : undefined;
  if (target.kind === "event" && !event) return notFound();
  const ctag = await ctagOf(events);
  const props = { handle: user.handle, ctag };

  if (req.method === "GET") {
    if (event) return new Response(event.body, { status: 200, headers: { "content-type": "text/calendar; charset=utf-8", etag: event.etag, "cache-control": "no-store", dav: "1, calendar-access" } });
    if (target.kind === "calendar") return feedOf(req, env, ctx, user);
    return forbidden();
  }

  const doc = await readXml(req);
  if (doc instanceof Response) return doc;

  if (req.method === "PROPFIND") {
    const asked = askedProps(doc);
    const depth = req.headers.get("depth") === "0" ? 0 : 1;
    const one = (t: Target, p: string, e?: DavEvent) => { const { found, missing } = propsOf(t, asked, { ...props, event: e }); return response(p, found, missing); };
    const out: string[] = [];
    if (target.kind === "root") out.push(one(target, at.root));
    if (target.kind === "principal") { out.push(one(target, at.principal)); if (depth) out.push(one({ kind: "calendar" }, at.calendar)); }
    if (target.kind === "calendar") { out.push(one(target, at.calendar)); if (depth) for (const e of events) out.push(one({ kind: "event", name: e.name }, at.event(e.name), e)); }
    if (target.kind === "event") out.push(one(target, at.event(target.name), event));
    return xml(207, multistatus(out));
  }

  // REPORT: on the calendar only
  if (target.kind !== "calendar" || !doc || doc.ns !== NS.c || !["calendar-multiget", "calendar-query"].includes(doc.name)) return davError(403, "<d:supported-report/>");
  const asked = askedProps(doc);
  const withData = asked === "all" || asked.some((p) => p.ns === NS.c && p.name === "calendar-data");
  const propList = asked === "all" ? "all" : asked.filter((p) => !(p.ns === NS.c && p.name === "calendar-data"));
  const one = (e: DavEvent) => {
    const { found, missing } = propsOf({ kind: "event", name: e.name }, propList, { ...props, event: e });
    if (withData) found.push(`<c:calendar-data>${esc(e.body)}</c:calendar-data>`);
    return response(at.event(e.name), found, missing);
  };
  if (doc.name === "calendar-multiget") {
    const out: string[] = [];
    for (const h of doc.children.filter((c) => c.name === "href")) {
      let p: string;
      try { p = decodeURIComponent(new URL(h.text, "https://x.invalid").pathname); } catch { p = h.text; }
      const t = targetOf(p, user.handle);
      const e = t?.kind === "event" ? events.find((x) => x.name === t.name) : undefined;
      out.push(e ? one(e) : `<d:response>${href(h.text)}<d:status>HTTP/1.1 404 Not Found</d:status></d:response>`);
    }
    return xml(207, multistatus(out));
  }
  // calendar-query: comp-filter VCALENDAR › comp-filter VEVENT › time-range; nothing else is understood
  const filter = child(doc, "filter");
  let range: { start: number; end: number } = { start: -Infinity, end: Infinity };
  if (filter) {
    const vcal = filter.children.length === 1 ? filter.children[0] : undefined;
    if (!vcal || vcal.name !== "comp-filter" || vcal.attrs.name !== "VCALENDAR") return davError(403, "<c:supported-filter/>");
    const vevent = vcal.children.length <= 1 ? vcal.children[0] : undefined;
    if (vcal.children.length && (!vevent || vevent.name !== "comp-filter" || vevent.attrs.name !== "VEVENT")) return davError(403, "<c:supported-filter/>");
    const tr = vevent?.children.length === 1 ? vevent.children[0] : undefined;
    if (vevent?.children.length && (!tr || tr.name !== "time-range")) return davError(403, "<c:supported-filter/>");
    if (tr) {
      const start = tr.attrs.start ? icsDateMs(tr.attrs.start) : -Infinity;
      const end = tr.attrs.end ? icsDateMs(tr.attrs.end) : Infinity;
      if (Number.isNaN(start) || Number.isNaN(end)) return text(400, "time-range: UTC times like 20261102T090000Z");
      range = { start, end };
    }
  }
  const hits = events.filter((e) => e.start < range.end && e.start + EVENT_MS > range.start);
  return xml(207, multistatus(hits.map(one)));
}

/** 20261102T090000Z → ms; NaN for anything else. */
export function icsDateMs(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
