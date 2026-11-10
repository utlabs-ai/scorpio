import { type Actor } from "../room-do";
import { unwrap } from "../room-actions";
import * as actions from "../room-actions";
import { ApiError, json, str } from "../util";
import { inRoom } from "../room-index";
import { type User } from "../auth";
import { displayNameOf } from "../accounts";
import { enterPage } from "../enter-page";
import { messagePage, pageError } from "../message-page";
import { langOf } from "../layout";
import { strings } from "../strings";
import { readCapped, roleOf } from "../handoff";
import { handoffPage } from "../handoff-page";
import { redirect, type RoomStub } from "./shared";

/**
 * A seat's handoff page, /r/<id>/handoff?name=<role@account> (docs/api/files.md), and its download (&download=1). Read as the
 * topic's messages are (a member; in a public topic any signed-in person); a signed-in non-member of a private topic
 * gets its passcode form, which brings them back here. The text is rendered on the page as messages are (md.js). No
 * handoff, or no such seat: the page says so with 200 (old takeover messages link here), never a 404 page.
 */
export async function handoffRoute(
  req: Request,
  env: Env,
  url: URL,
  user: User,
  stub: RoomStub,
  roomId: string,
): Promise<Response> {
  const lang = langOf(req);
  const t = strings(lang);
  const name = str(url.searchParams.get("name"), 200);
  const actor: Actor = {
    kind: "human",
    account: user.handle,
    name: user.handle,
  };
  let r = await stub.viewHandoff(actor, name);
  if ("err" in r && r.err.code === "not_member") {
    const info = await stub.info();
    if ("err" in info)
      return messagePage(
        lang,
        user,
        t.error,
        pageError(lang, info.err.code, info.err.next).text,
        info.err.status,
      );
    // As a file's page: a topic with no passcode to ask (or one's own) lets them in at once.
    if (info.ok.hasCode && info.ok.owner !== user.handle)
      return enterPage(
        lang,
        user,
        info.ok.id,
        undefined,
        `/r/${roomId}/handoff?name=${encodeURIComponent(name)}`,
      );
    unwrap(
      await stub.enterHuman(
        actor,
        undefined,
        await displayNameOf(env, user.id),
      ),
    );
    await inRoom(env, roomId, user.id, true);
    r = await stub.viewHandoff(actor, name);
  }
  if ("err" in r) {
    if (r.err.code === "room_deleted")
      return messagePage(lang, user, t.roomDeletedTitle, t.roomDeleted, 410);
    const pe = pageError(lang, r.err.code, r.err.next);
    return messagePage(lang, user, t.error, pe.text, r.err.status, pe.detail);
  }
  const v = r.ok;
  if (url.searchParams.get("download") === "1") {
    if (!v.handoff)
      return redirect(`/r/${roomId}/handoff?name=${encodeURIComponent(name)}`);
    const full = unwrap(await stub.getHandoff(actor, name));
    return new Response(full.body, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${roleOf(name)}.md"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return handoffPage(lang, user, v, {
    name,
    mine: v.member && v.seat?.owner === user.handle,
  });
}

export async function putAgentHandoff(
  req: Request,
  stub: RoomStub,
  actor: Actor,
  local: boolean,
  computer: () => Promise<string | null>,
): Promise<Response> {
  await actions.handoffWriter(stub, actor, local);
  const bytes = await readCapped(req.body, req.headers.get("content-length"));
  if (!(bytes instanceof Uint8Array))
    throw new ApiError(bytes.code, bytes.next, bytes.status);
  return json(
    await actions.putHandoff(
      stub,
      actor,
      bytes,
      await computer(),
    ),
  );
}

export async function getAgentHandoff(
  stub: RoomStub,
  actor: Actor,
  name: string | null,
): Promise<Response> {
  return json(await actions.getHandoff(stub, actor, name));
}

export async function deleteWebHandoff(
  stub: RoomStub,
  actor: Actor,
  name: unknown,
): Promise<Response> {
  return json(await actions.deleteHandoff(stub, actor, name));
}
