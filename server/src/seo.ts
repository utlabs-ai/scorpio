// What search engines and other clients are given whatever the deployment: the pages' HTML compressed by the Worker
// itself, and noindex where the deployment asks for it.

/** A test deployment's Worker responses are not indexed (NOINDEX); assets served directly by Cloudflare use web/public/_headers. */
export function noindexResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Robots-Tag", "noindex");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Our HTML says no-transform so the edge injects nothing (pages.ts layout), and that also stops the edge compressing it
 * (the homepage went out as 140 KB). The Worker does it instead: with content-encoding set, the runtime encodes the body.
 * Always gzip, never br: the edge asks us with "br, gzip" whatever the visitor sent, and passes our encoding on only to a
 * visitor that takes it; anyone else gets it unpacked, never re-packed (no-transform). Brotli left a gzip-only client
 * (some crawlers) with the 140 KB; gzip reaches every client that compresses at all (~14 KB against ~12).
 */
export function compressed(req: Request, res: Response): Response {
  if (!res.body || res.headers.has("content-encoding") || !/^text\/html\b/.test(res.headers.get("content-type") || "")) return res;
  const h = new Headers(res.headers);
  h.append("vary", "Accept-Encoding");
  if (/\bgzip\b/.test(req.headers.get("accept-encoding") || "")) {
    h.set("content-encoding", "gzip");
    h.delete("content-length");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
