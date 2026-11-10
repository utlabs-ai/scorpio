// Files attached to messages (docs/api/files.md): private R2 objects, served only to room members. A file whose bytes
// are a jpg, png, gif or webp is an image and is shown; supported video bytes play inline; other files download.
// Keys are rooms/<roomId>/files/<sha256>: the same file uploaded twice to a room is stored once,
// and everything a room owns sits under one prefix that goes when the room goes.

import { ApiError, now } from "./util";
import { mb, type Limits, type Plan } from "./plans";
import { fileKey, isImage, isVideo } from "./file-kind";

export { fileKey, isImage };

export const MAX_FILES_PER_MESSAGE = 9;

export interface FileMeta {
  id: string;
  name: string;
  type: string;
  size: number;
}

/** Image type from the first bytes, or null: not an image we show (no SVG: it can carry script). */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

/** Video type from its container header, independent of the uploader's declared type. */
export function sniffVideo(b: Uint8Array): string | null {
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(?:heic|heix|hevc|heim|heis|hevx|mif1|msf1|avif|avis)$/.test(brand)) return null;
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

/**
 * Images and supported videos are recorded by content; otherwise keep a valid declared type that does not claim to
 * be an image or supported video, or use application/octet-stream.
 */
export function fileType(data: Uint8Array, declared: string | null): string {
  const image = sniffImage(data);
  if (image) return image;
  const video = sniffVideo(data);
  if (video) return video;
  const t = (declared || "").split(";")[0].trim().toLowerCase();
  return /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,99}$/.test(t) && !t.startsWith("image/") && !isVideo(t) ? t : "application/octet-stream";
}

export async function sha256Bytes(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read an upload body, refusing anything over the plan's limit for one file without buffering more than that. */
export async function readUpload(req: Request, plan: Plan, max: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new ApiError(
      "file_too_large",
      plan === "free" ? `A file can be at most ${mb(max)} on the free plan (25 MB on Pro).` : `A file can be at most ${mb(max)}.`,
      413,
    );
  if (Number(req.headers.get("content-length") || 0) > max) throw tooLarge();
  if (!req.body) throw new ApiError("bad_request", "The request has no file in its body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * A stored file's bytes, or null when they are gone. A deployment may run without file storage (no FILES binding):
 * then it has no files, and every read and delete here finds nothing instead of failing.
 */
export function storedObject(env: Env, key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
  return env.FILES ? env.FILES.get(key, options) : Promise.resolve(null);
}

/** Store unless this room already has the same bytes. Returns whether anything was written. */
export async function storeFile(files: R2Bucket, key: string, data: Uint8Array, type: string): Promise<boolean> {
  if (await files.head(key)) return false;
  await files.put(key, data, { httpMetadata: { contentType: isImage(type) ? type : "application/octet-stream" } });
  return true;
}

export async function unstoreFile(env: Env, key: string) {
  if (env.FILES) await env.FILES.delete(key);
}

/**
 * A video's Range header (bytes=a-b, a-, -n) against its size: the bytes to read, "unsatisfiable" (answer 416), or
 * undefined when there is no header (the whole file). Attachments and a deployment's own films share it.
 */
export function byteRange(header: string | null | undefined, size: number): { offset: number; length: number } | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return "unsatisfiable";
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[2] && match[1] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

/** The 416 answer for a range byteRange() calls unsatisfiable. */
export const rangeNotSatisfiable = (size: number) => new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });

export async function fileResponse(env: Env, key: string, meta: FileMeta, rangeHeader?: string | null): Promise<Response> {
  const video = isVideo(meta.type);
  const range = video ? byteRange(rangeHeader, meta.size) : undefined;
  if (range === "unsatisfiable") return rangeNotSatisfiable(meta.size);
  const obj = await storedObject(env, key, range ? { range } : undefined);
  if (!obj) throw new ApiError("file_not_found", "That file is gone.", 404);
  const ascii = meta.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // Images and videos are shown; other files remain downloads (nosniff, sandbox, octet-stream).
  const image = isImage(meta.type);
  return new Response(obj.body, {
    status: range ? 206 : 200,
    headers: {
      "content-type": image || video ? meta.type : "application/octet-stream",
      "content-length": String(range ? range.length : meta.size),
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": `${image || video ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      ...(video ? { "accept-ranges": "bytes" } : {}),
      ...(range ? { "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}` } : {}),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

// ---------- per-account limits (by the uploader's plan; the file space is space.ts) ----------

const today = () => new Date(now()).toISOString().slice(0, 10);

/** The account's daily upload limit (count and bytes, by the uploader's plan). A full file space refuses nothing. */
export async function checkUploadLimit(env: Env, userId: string, size: number, lim: Limits): Promise<void> {
  const row = await env.DB.prepare("SELECT count, bytes FROM upload_usage WHERE user_id = ? AND day = ?").bind(userId, today()).first<{ count: number; bytes: number }>();
  const count = row?.count ?? 0;
  const bytes = row?.bytes ?? 0;
  if (count + 1 > lim.uploadsPerDay || bytes + size > lim.uploadBytesPerDay) {
    throw new ApiError(
      "upload_limit",
      `This account has uploaded ${count} files (${mb(bytes)}) today, the daily limit of ${lim.uploadsPerDay} files / ${mb(lim.uploadBytesPerDay)}. It resets at 00:00 UTC.`,
      429,
    );
  }
}

/** The account a member name belongs to: a person is their account, an agent or seat role@account. */
export const accountOf = (member: string) => (member.includes("@") ? member.slice(member.lastIndexOf("@") + 1) : member);

/** Every object a room has in R2 (its purge): rooms/<roomId>/…, a page of 1000 at a time. */
export async function deleteRoomObjects(env: Env, roomId: string): Promise<number> {
  if (!env.FILES) return 0;
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: `rooms/${roomId}/`, cursor, limit: 1000 });
    if (page.objects.length) await env.FILES.delete(page.objects.map((o) => o.key));
    n += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}
