import { ApiError, readBody } from "../util";
import { origin, type User } from "../auth";
import { paidPage } from "../shell-page";
import { messagePage, pageError } from "../message-page";
import { type Lang } from "../layout";
import {
  creemWebhook,
  portalLink,
  startCheckout,
} from "../billing";
import { planOf } from "../plans";
import {
  redirect,
  type Route,
  type RouteBaseContext,
  type SignedRouteContext,
} from "./shared";

/** Paying failed: Creem's and our checks' reasons, in Chinese on a Chinese page. */
export function payFailed(
  lang: Lang,
  user: User,
  title: string,
  e: ApiError,
): Response {
  const code =
    e.code === "forbidden"
      ? "pay_closed"
      : e.code === "not_found"
        ? "no_subscription"
        : e.code;
  const pe = pageError(lang, code, e.next);
  return messagePage(lang, user, title, pe.text, e.status, pe.detail);
}

export const signedRoutes: Route<SignedRouteContext>[] = [
  // Paying for Pro: to Creem's checkout, back from it, and to its customer portal.
  {
    method: "POST",
    match: "/billing/checkout",
    handler: async (c) => {
      const { req, env, url, lang, t } = c;
      const user = c.user;

      const b = await readBody(req);
      try {
        return redirect(
          await startCheckout(
            env,
            user,
            b.period === "yearly" ? "yearly" : "monthly",
            env.PUBLIC_URL || url.origin,
          ),
        );
      } catch (e) {
        if (e instanceof ApiError) return payFailed(lang, user, t.payFailed, e);
        throw e;
      }
    },
  },
  {
    method: "GET",
    match: "/billing/portal",
    handler: async (c) => {
      const { env, lang, t } = c;
      const user = c.user;

      try {
        return redirect(await portalLink(env, user));
      } catch (e) {
        if (e instanceof ApiError) return payFailed(lang, user, t.payFailed, e);
        throw e;
      }
    },
  },
  {
    method: "GET",
    match: "/billing/done",
    handler: async (c) => {
      const { env, lang } = c;
      const user = c.user;

      return paidPage(lang, user, await planOf(env, user.id));
    },
  },
];

export const stageOneRoutes: Route<RouteBaseContext>[] = [
  {
    method: "POST",
    match: "/billing/creem/webhook",
    handler: async ({ req, env, ctx }) => creemWebhook(req, env, ctx),
  },
];
