import { json, readBody } from "../util";
import { origin } from "../auth";
import {
  enterInviteCode,
  inviteView,
} from "../invite";
import { hosted } from "../plans";
import { type Route, type SignedRouteContext } from "./shared";

export const signedRoutes: Route<SignedRouteContext>[] = [
  // Invites: the settings page's block, and a code entered within 7 days of signing up. They give Pro days, so a
  // deployment without plans (PLANS) has no such routes (null falls through to 404).
  {
    method: "GET",
    match: "/settings/invite",
    handler: async (c) => {
      const { env, url } = c;
      const user = c.user;
      if (!hosted(env)) return null;

      return json(
        await inviteView(
          env,
          user,
          (env.PUBLIC_URL || url.origin).replace(/\/$/, ""),
        ),
      );
    },
  },
  {
    method: "POST",
    match: "/settings/invite-code",
    handler: async (c) => {
      const { req, env, url } = c;
      const user = c.user;
      if (!hosted(env)) return null;

      const r = await enterInviteCode(env, user.id, (await readBody(req)).code);
      if (r === "ok")
        return json({
          ok: true,
          invite: await inviteView(
            env,
            user,
            (env.PUBLIC_URL || url.origin).replace(/\/$/, ""),
          ),
        });
      const next = {
        unknown: "There is no such invite code; check it with whoever sent it.",
        self: "That is your own code.",
        already:
          "This account cannot take an invite code (it has one already, or it does not count as new).",
        late: "An invite code can only be entered in the first 7 days after signing up.",
        used: "This invite code has already been used; ask for a new one.",
        full: "Whoever sent this code has no invites left this month; ask again next month.",
      }[r];
      const error = {
        unknown: "invite_unknown",
        self: "invite_self",
        late: "invite_late",
        used: "invite_used",
        full: "invite_full",
        already: "invite_taken",
      }[r];
      return json({ error, next }, 400);
    },
  },
];
