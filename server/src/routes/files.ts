import { type Actor } from "../room-do";
import { unwrap } from "../room-actions";
import { ApiError, errorResponse, json, randomId, readBody } from "../util";
import { inRoom } from "../room-index";
import { origin, type User } from "../auth";
import { displayNameOf } from "../accounts";
import {
  accountOf,
  checkUploadLimit,
  fileKey,
  fileResponse,
  fileType,
  readUpload,
  sha256Bytes,
  storeFile,
  unstoreFile,
} from "../files";
import {
  evictOldest,
  indexed,
  indexFiles,
  recordUpload,
  roomOfFile,
  spaceField,
  spaceNow,
} from "../space";
import { enterPage } from "../enter-page";
import { messagePage, pageError } from "../message-page";
import { langOf } from "../layout";
import { strings } from "../strings";
import { limitsFor, planOf } from "../plans";
import { framed, viewKind } from "../file-kind";
import { signTicket, ticketKey } from "../view-ticket";
import { filePage } from "../file-page";
import { type Route, type SignedRouteContext, type RoomStub } from "./shared";
import { roomStub } from "../room-stub";

/**
 * Store one uploaded file and record it in the room (docs/api/files.md). Checks, in order: room membership,
 * size, the account's daily limit (by the uploader's plan). Any kind of file; whether it is an image is decided by
 * its bytes. Identical bytes in the same room are stored once. A full file space refuses nothing: once answered,
 * the uploader's oldest files go (space.ts). Uploads not sent within minutes are swept by the room.
 */
export async function upload(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  stub: RoomStub,
  actor: Actor,
  roomId: string,
  userId: string,
): Promise<Response> {
  const files = env.FILES;
  if (!files)
    throw new ApiError(
      "no_file_storage",
      "This server has no file storage, so it takes no files. Send the message without them.",
      501,
    );
  const seen = unwrap(await stub.peek(actor));
  if (!seen.member)
    throw new ApiError(
      "not_member",
      "Join the topic before uploading to it.",
      403,
    );
  const plan = await planOf(env, userId);
  const lim = await limitsFor(env, plan);
  const data = await readUpload(req, plan, lim.fileBytes);
  const type = fileType(data, req.headers.get("content-type"));
  await checkUploadLimit(env, userId, data.byteLength, lim);
  let name = "";
  try {
    name = decodeURIComponent(req.headers.get("x-file-name") || "");
  } catch {}
  name =
    name
      .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
      .trim()
      .slice(0, 200) || (type.startsWith("image/") ? "image" : "file");
  const hash = await sha256Bytes(data);
  const key = fileKey(roomId, hash);
  const stored = await storeFile(files, key, data, type);
  const charged = stored ? data.byteLength : 0;
  const r = await stub.addFile(actor, {
    id: randomId(22),
    name,
    type,
    size: data.byteLength,
    hash,
    charged,
  });
  if ("err" in r && stored) await unstoreFile(env, key);
  const file = unwrap(r);
  await recordUpload(env, {
    userId,
    roomId,
    fileId: file.id,
    size: data.byteLength,
    charged,
    at: Date.now(),
    hash,
    name,
  });
  const space = await spaceNow(env, userId);
  const user = { id: userId, handle: actor.account };
  // The first uploads after the index arrived build it from the rooms (the daily job would too); eviction waits for it.
  if (!(await indexed(env)))
    ctx.waitUntil(
      indexFiles(env).catch((e) =>
        console.error(
          JSON.stringify({ msg: "file index failed", error: String(e) }),
        ),
      ),
    );
  else if (space.used > space.limit)
    ctx.waitUntil(
      evictOldest(env, user).catch((e) =>
        console.error(
          JSON.stringify({ msg: "evict run failed", error: String(e) }),
        ),
      ),
    );
  return json({ ...file, ...spaceField(space) });
}

/** A send that carried files answers with the sender's file space from 80% on. */
export async function withSpace(
  env: Env,
  userId: string,
  files: string[] | undefined,
  out: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!files?.length || out.seq == null) return out;
  return { ...out, ...spaceField(await spaceNow(env, userId)) };
}

export async function fileResponseFor(
  env: Env,
  stub: RoomStub,
  actor: Actor,
  roomId: string,
  fileId: string,
  req: Request,
): Promise<Response> {
  const meta = unwrap(await stub.fileMeta(actor, fileId));
  return fileResponse(
    env,
    fileKey(roomId, meta.hash),
    meta,
    req.headers.get("range"),
  );
}

/**
 * A file's own page, /v/<fileId>, and its tickets. Who may see it is who may download it: a member,
 * in a public room any signed-in person; anyone else in a private room gets its passcode form, which brings them back.
 */
export async function fileRoutes(
  req: Request,
  env: Env,
  url: URL,
  user: User,
  fileId: string,
  sub: string,
): Promise<Response> {
  const lang = langOf(req);
  const t = strings(lang);
  const missing = () =>
    sub
      ? json({ error: "file_not_found", next: "There is no such file." }, 404)
      : messagePage(lang, user, t.fileMissingTitle, t.fileMissing, 404);
  const roomId = await roomOfFile(env, fileId);
  if (!roomId) return missing();
  let stub: RoomStub;
  try {
    stub = await roomStub(env, roomId);
  } catch {
    return missing();
  }
  const actor: Actor = {
    kind: "human",
    account: user.handle,
    name: user.handle,
  };
  let r = await stub.viewFile(actor, fileId);
  if ("err" in r && r.err.code === "not_member") {
    const info = await stub.info();
    if ("err" in info) return missing();
    // As the room page: a room with no passcode to ask (or one's own) lets them in at once.
    if (info.ok.hasCode && info.ok.owner !== user.handle)
      return sub
        ? errorResponse(new ApiError(r.err.code, r.err.next, 403))
        : enterPage(lang, user, info.ok.id, undefined, `/v/${fileId}`);
    unwrap(
      await stub.enterHuman(
        actor,
        undefined,
        await displayNameOf(env, user.id),
      ),
    );
    await inRoom(env, roomId, user.id, true);
    r = await stub.viewFile(actor, fileId);
  }
  if ("err" in r) {
    if (r.err.code === "room_deleted" && !sub)
      return messagePage(lang, user, t.roomDeletedTitle, t.roomDeleted, 410);
    if (
      r.err.code === "room_deleted" ||
      r.err.code === "room_not_found" ||
      r.err.code === "file_not_found"
    )
      return missing();
    if (sub)
      return errorResponse(new ApiError(r.err.code, r.err.next, r.err.status));
    const pe = pageError(lang, r.err.code, r.err.next);
    return messagePage(lang, user, t.error, pe.text, r.err.status, pe.detail);
  }
  const v = r.ok;
  const kind = viewKind(v.file.name, v.file.type);
  const key = ticketKey(env.VIEW_TICKET_KEY);
  const canFrame =
    framed(kind, v.file.size) &&
    v.file.deleted == null &&
    !!key &&
    !!env.CONTENT_DOMAIN;
  // The content domain on this request's scheme and port (the port only ever in local tests).
  const content = (label: string) =>
    `${url.protocol}//${label}.${env.CONTENT_DOMAIN}${url.port ? `:${url.port}` : ""}`;
  if (sub === "ticket") {
    // A ticket for one opening of the frame: the page asks right before it loads it (and again after a click to run).
    if (req.method !== "POST")
      throw new ApiError("bad_request", "A ticket is asked for with POST.");
    if (!canFrame || !framed(kind, v.file.size))
      throw new ApiError(
        "not_shown",
        "This file is not shown in a page (an image, a download, or too large to show); download it.",
        409,
      );
    const b = await readBody(req);
    const { label, token } = await signTicket(key!, {
      u: user.id,
      a: user.handle,
      r: v.room.id,
      f: v.file.id,
      h: v.file.hash!,
      k: kind,
      t: b.theme === "dark" ? "dark" : "light",
      o: url.origin,
      ...(/\.(diff|patch)$/i.test(v.file.name) ? { d: 1 as const } : {}),
    });
    return json({ url: `${content(label)}/${token}`, kind });
  }
  if (req.method !== "GET")
    throw new ApiError("bad_request", "Unknown endpoint.", 404);
  return filePage(lang, user, v, {
    kind,
    framed: canFrame,
    mine: accountOf(v.file.by) === user.handle,
    contentOrigin: canFrame ? content("*") : null,
  });
}

export const signedRoutes: Route<SignedRouteContext>[] = [
  // --- attachment bytes (a member's browser; agents use /api/v1/rooms/:id/files/:fileId) ---
  {
    method: "GET",
    match: /^\/f\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{1,64})$/,
    handler: async (c, m) => {
      const { req, env } = c;
      const user = c.user;
      const fm = m!;
      return fileResponseFor(
        env,
        await roomStub(env, fm[1]),
        { kind: "human", account: user.handle, name: user.handle },
        fm[1],
        fm[2],
        req,
      );
    },
  },
  // --- a file's own page ---
  {
    method: "*",
    match: /^\/v\/([A-Za-z0-9_-]{22})$/,
    handler: async (c, m) => {
      const { req, env, url } = c;
      return fileRoutes(req, env, url, c.user, m![1], "");
    },
  },
  {
    method: "*",
    match: /^\/v\/([^/]+)\/ticket$/,
    errors: "json",
    handler: async (c, m) => {
      const { req, env, url } = c;
      if (!/^[A-Za-z0-9_-]{22}$/.test(m![1])) return null;
      return fileRoutes(req, env, url, c.user, m![1], "ticket");
    },
  },
];
