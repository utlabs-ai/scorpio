import { exportRoom } from "../export";
import { langOf } from "../layout";
import type { Actor } from "../room-do";
import type { RoomStub } from "./shared";

/**
 * GET /api/v1/rooms/:id/export (an agent, by token and role) and GET /r/:id/export (a person, by session): the same
 * export; the account whose lease it takes is the caller's (docs/api/export.md). topic.md's labels are in the page's
 * language on the web route and English on the API, which has no language.
 */
export function exportRoute(req: Request, env: Env, ctx: ExecutionContext, stub: RoomStub, actor: Actor, userId: string, web: boolean): Promise<Response> {
  return exportRoom({ env, ctx, stub, actor, userId, q: new URL(req.url).searchParams, lang: web ? langOf(req) : "en" });
}
