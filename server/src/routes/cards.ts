import * as actions from "../room-actions";
import { ApiError, json, readBody } from "../util";
import { signTicket, ticketKey } from "../view-ticket";
import { roomStub } from "../room-stub";
import type { Route, SignedRouteContext } from "./shared";

export const signedRoutes: Route<SignedRouteContext>[] = [{
  method: "POST", match: /^\/r\/([A-Za-z0-9_-]{22})\/cards\/([0-9]+)\/ticket$/, errors: "json",
  handler: async ({ req, env, url, user }, m) => {
    const roomId = m![1], seq = Number(m![2]);
    const { message } = await actions.message(await roomStub(env, roomId), { kind: "human", account: user.handle, name: user.handle }, seq);
    if (!message.card) throw new ApiError("card_not_found", `There is no card on message #${seq}.`, 404);
    const key = ticketKey(env.VIEW_TICKET_KEY);
    if (!key || !env.CONTENT_DOMAIN) throw new ApiError("not_shown", "This card cannot be shown; read its summary instead.", 409);
    const b = await readBody(req);
    const { label, token } = await signTicket(key, {
      u: user.id, a: user.handle, r: roomId, c: seq, f: "", h: "", k: "html",
      t: b.theme === "dark" ? "dark" : "light", o: url.origin,
    });
    return json({ url: `${url.protocol}//${label}.${env.CONTENT_DOMAIN}${url.port ? `:${url.port}` : ""}/${token}` });
  },
}];
