// Web Push: VAPID (RFC 8292) and the aes128gcm payload (RFC 8291), WebCrypto only.
import { isAllowedPushEndpoint, removePushSubscription } from "./push-preferences";
import { pushText, type Shown } from "./push-text";
// One secret, VAPID_PRIVATE_JWK (an ECDSA P-256 private key as JWK); the public key browsers subscribe with is
// derived from it. Only the person an event is about is told, and only on the browsers where they turned it on.

const enc = new TextEncoder();

export const b64u = {
  encode(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s: string): Uint8Array {
    const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(t, (c) => c.charCodeAt(0));
  },
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** RFC 8291: one aes128gcm record carrying the payload, readable only by the browser that subscribed. */
export async function encryptPayload(payload: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = b64u.decode(p256dh);
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: ua } as unknown as SubtleCryptoDeriveKeyAlgorithm, as.privateKey, 256),
  );
  const ikm = await hkdf(b64u.decode(auth), shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // The last (only) record ends with the delimiter 0x02; no padding.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

function vapidKey(env: Env): JsonWebKey | null {
  if (!env.VAPID_PRIVATE_JWK) return null;
  try {
    return JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey;
  } catch {
    return null;
  }
}

/** The application server key browsers subscribe with (uncompressed P-256 point), or null when push is not set up. */
export function vapidPublicKey(env: Env): string | null {
  const jwk = vapidKey(env);
  if (!jwk?.x || !jwk.y) return null;
  return b64u.encode(concat(new Uint8Array([4]), b64u.decode(jwk.x), b64u.decode(jwk.y)));
}

/** RFC 8292: a JWT for the push service of this endpoint, signed with our key. */
async function vapidAuth(endpoint: string, env: Env): Promise<string> {
  const jwk = vapidKey(env)!;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: object) => b64u.encode(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || env.PUBLIC_URL || undefined,
  })}`;
  // WebCrypto signs as r||s (64 bytes), which is what ES256 in a JWS is.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.encode(sig)}, k=${vapidPublicKey(env)}`;
}

/** What a notification carries. The service worker shows it and opens url on a tap. */
export interface PushPayload {
  type: "todo_assigned" | "mention" | "quota_warn" | "test" | "alert" | "agent_blocked" | "device_logged_out";
  room?: { id: string; name: string };
  seq?: number | null;
  item?: { id: string; title: string };
  tag: string;
  url: string;
  by?: string;
  byDisplayName?: string; // human sender's nickname; by remains the account handle
  silent?: boolean; // sound off on this browser; the service worker still shows the notification
  used?: number; // quota_warn: messages so far today, of limit
  limit?: number;
  text?: string; // alert: what happened, in a sentence
  name?: string; // agent_blocked: the agent; device_logged_out: the computer
  approval?: string; // phone approval card id; no prompt content in notifications
  reason?: string | null; // agent_blocked: what it is stopped at (Member.workReason)
  shown?: { en: Shown; zh: Shown }; // the words to show, both languages
}

interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  sound: number;
}

/** Send to one browser; the push service's status (201 sent, 404 / 410 the subscription is gone). */
async function sendOne(env: Env, sub: Subscription, payload: PushPayload): Promise<number> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  // A topic per tag: a newer push for the same thing replaces one still waiting at the push service.
  const topic = b64u.encode(await crypto.subtle.digest("SHA-256", enc.encode(payload.tag))).slice(0, 32);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, env),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(24 * 3600),
      Urgency: "normal",
      Topic: topic,
    },
    body,
  });
  return res.status;
}

/** Tell one person on every browser where they turned notifications on; dead subscriptions are dropped. */
export async function notifyPerson(env: Env, handle: string, payload: PushPayload): Promise<number> {
  if (!vapidKey(env)) return 0;
  const shown = pushText(payload);
  const roomId = payload.room?.id ?? null;
  const { results } = await env.DB.prepare(
    `SELECT s.endpoint, s.p256dh, s.auth, s.sound FROM push_subscriptions s JOIN users u ON u.id = s.user_id
     WHERE u.handle = ? AND (? != 'todo_assigned' OR s.todo_assigned = 1) AND (? != 'quota_warn' OR s.quota_warn = 1)
       AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM push_muted_rooms m WHERE m.endpoint = s.endpoint AND m.room_id = ?))`,
  )
    .bind(handle, payload.type, payload.type, roomId, roomId)
    .all<Subscription>();
  let sent = 0;
  for (const sub of results) {
    try {
      if (!isAllowedPushEndpoint(sub.endpoint)) {
        await removePushSubscription(env, sub.endpoint);
        continue;
      }
      const status = await sendOne(env, sub, { ...payload, shown, ...(sub.sound ? {} : { silent: true }) });
      if (status === 404 || status === 410) {
        await removePushSubscription(env, sub.endpoint);
      } else if (status >= 200 && status < 300) {
        sent++;
        await env.DB.prepare("UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?").bind(Date.now(), sub.endpoint).run();
      } else {
        console.warn(JSON.stringify({ msg: "push refused", status, host: new URL(sub.endpoint).host }));
        await env.DB.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?").bind(sub.endpoint).run();
      }
    } catch (e) {
      console.error(JSON.stringify({ msg: "push failed", error: String(e) }));
    }
  }
  return sent;
}
