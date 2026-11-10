// The content domain's tickets: one per opening of a file's frame, 60 s, sealed with the Worker
// secret VIEW_TICKET_KEY (AES-GCM: what is in one, its room and file among them, is not readable by the page it opens).
// The host's label is the first 128 bits of an HMAC of the sealed ticket, so a ticket opens only
// on its own host and nobody can make up either. No imports, so node tests load it as it is.

import type { FrameKind } from "./file-kind";

/** How long a ticket opens its host for. The frame loads at once; a reload inside it later needs a new one. */
export const TICKET_SECONDS = 60;

/** The secret, when it is one: shorter than 32 characters counts as not set (files are then only downloaded). */
export const ticketKey = (secret: string | undefined): string | null => (secret && secret.length >= 32 ? secret : null);

export interface Ticket {
  a?: string; // signed account handle; older tickets without it cannot be consumed
  u: string; // who it was given to (the account's id)
  r: string; // room
  c?: number; // card message seq; absent for a file ticket (f and h then identify its bytes)
  f: string; // file (empty for a card)
  h: string; // empty for a card; otherwise its bytes (rooms/<r>/files/<h>)
  k: FrameKind;
  t: "light" | "dark"; // the page's theme, for Markdown, plain text and SVG
  d?: 1; // plain text that is a diff (.diff, .patch): its lines in colour
  o: string; // the page's origin: the only one that may frame it, and where the frame's links are reported
  e: number; // expires (s since epoch)
  n: string; // random: every opening a host of its own
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

let keyCache: { secret: string; mac: Promise<CryptoKey>; seal: Promise<CryptoKey> } | null = null;
/** Two keys from the one secret: one to sign the host label, one to seal the ticket. */
function keys(secret: string) {
  if (keyCache?.secret !== secret) {
    const enc = new TextEncoder();
    keyCache = {
      secret,
      mac: crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      seal: crypto.subtle
        .digest("SHA-256", enc.encode(`view-ticket-seal:${secret}`))
        .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])),
    };
  }
  return keyCache;
}

async function labelOf(secret: string, token: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await keys(secret).mac, new TextEncoder().encode(`view-ticket:${token}`)));
  return hex(sig.slice(0, 16));
}

/** A ticket for one opening: the host label it works on and the token in its path. */
export async function signTicket(secret: string, t: Omit<Ticket, "e" | "n">, nowMs = Date.now()): Promise<{ label: string; token: string }> {
  const full: Ticket = { ...t, e: Math.floor(nowMs / 1000) + TICKET_SECONDS, n: hex(crypto.getRandomValues(new Uint8Array(8))) };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keys(secret).seal, new TextEncoder().encode(JSON.stringify(full))));
  const bytes = new Uint8Array(iv.length + sealed.length);
  bytes.set(iv);
  bytes.set(sealed, iv.length);
  const token = b64url(bytes);
  return { label: await labelOf(secret, token), token };
}

/** The ticket, when this host was made for this token and it has not expired (or, `expired`, even when it has); else null. */
export async function readTicket(secret: string, label: string, token: string, nowMs = Date.now(), expired = false): Promise<Ticket | null> {
  if (!/^[0-9a-f]{32}$/.test(label) || !/^[A-Za-z0-9_-]{20,2000}$/.test(token)) return null;
  const want = await labelOf(secret, token);
  let diff = 0; // in constant time: both are 32 hex characters
  for (let i = 0; i < 32; i++) diff |= want.charCodeAt(i) ^ label.charCodeAt(i);
  if (diff !== 0) return null;
  let t: Ticket;
  try {
    const bytes = unb64url(token);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, await keys(secret).seal, bytes.subarray(12));
    t = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
  return t && typeof t.e === "number" && (expired || t.e * 1000 > nowMs) ? t : null;
}

/**
 * The label of a host on the content domain: a 32-character label; "" for any other host there (answered with
 * nothing, never with Scorpio's pages); null when the host is not on the content domain at all.
 */
export function contentLabel(contentDomain: string | undefined, host: string): string | null {
  if (!contentDomain) return null;
  const h = host.toLowerCase();
  const d = contentDomain.toLowerCase();
  if (h !== d && !h.endsWith(`.${d}`)) return null;
  const label = h === d ? "" : h.slice(0, -d.length - 1);
  return /^[0-9a-f]{32}$/.test(label) ? label : "";
}
