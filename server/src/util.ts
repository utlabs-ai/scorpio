// Small helpers shared by the Worker and the room object.

import { charCount, cleanLines } from "./text";

export const now = () => Date.now();

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Random URL-safe id: `len` chars, 6 bits each. */
export function randomId(len = 22): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += B64URL[b & 63];
  return s;
}

/** Random string over `alphabet`, without modulo bias. */
export function randomFrom(alphabet: string, len: number): string {
  const out: string[] = [];
  const limit = 256 - (256 % alphabet.length);
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < limit && out.length < len) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings of hex or ASCII. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Error with a protocol error code and a `next` hint (docs/api/errors.md); retryAfter (s) becomes Retry-After. */
export class ApiError extends Error {
  constructor(
    public code: string,
    public next: string,
    public status = 400,
    public retryAfter?: number,
    /** More fields of the error answer, such as an unauthorized token's `reason` (docs/api/auth.md). */
    public extra?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return json({ error: e.code, ...e.extra, next: e.next }, e.status, e.retryAfter ? { "retry-after": String(e.retryAfter) } : {});
  console.error(JSON.stringify({ msg: "unhandled", error: String((e as Error)?.stack || e) }));
  return json({ error: "server_error", next: "Something broke on the server. Retry in a minute; if it keeps failing, tell your person." }, 500);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** Read a JSON or form-encoded body into a plain object. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      const v = await req.json();
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      throw new ApiError("bad_request", "The request body is not valid JSON.");
    }
  }
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await req.formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of form) if (typeof v === "string") out[k] = v;
    return out;
  }
  return {};
}

export const str = (v: unknown, max = 10_000): string => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max));

/**
 * Several lines a person or an agent writes for others to read (a role card, a room's topic), cleaned as
 * cleanLines does. Longer than `max` characters is refused, not cut, so nothing is lost silently.
 */
export function multiline(v: unknown, max: number, what: string): string {
  const s = cleanLines(v);
  const n = charCount(s);
  if (n > max) throw new ApiError("bad_request", `${what} can be at most ${max} characters; this one has ${n}. Shorten it and send it again.`);
  return s;
}
