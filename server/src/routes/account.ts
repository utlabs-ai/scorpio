import {
  ApiError,
  cookie,
  errorResponse,
  json,
  parseCookies,
  randomId,
  readBody,
  safeEqual,
  str,
} from "../util";
import {
  accountDeletedText,
  createSession,
  destroySession,
  dropSignup,
  finishOAuth,
  heldSignup,
  holdSignupClaim,
  origin,
  providerConfigured,
  signIn,
  signInOrHold,
  startOAuth,
  turnstileOn,
  turnstilePassed,
  type Provider,
  type SignupClaim,
} from "../auth";
import { loginPage } from "../login-page";
import { loginCodePage } from "../login-code-page";
import { emailFlow, emailLoginConfigured, flowView, resendEmail, startEmail, verifyEmail } from "../email-login";
import { signupPage } from "../signup-page";
import { messagePage, pageError } from "../message-page";
import { meDataPage } from "../me-data-page";
import { driveConnected } from "../drive";
import { localNext } from "../safe-next";
import {
  clearInvite,
  redirect,
  type Route,
  type SignedRouteContext,
} from "./shared";

/** Keep a new sign-in for 15 minutes and send the person to the sign-up check. */
export async function holdSignup(
  env: Env,
  url: URL,
  claim: SignupClaim,
  next: string,
  clear: string | string[],
) {
  const sid = randomId(32);
  await holdSignupClaim(env, sid, { ...claim, next });
  return redirect(
    "/signup",
    [clear, cookie("signup", sid, 900, url.protocol === "https:")].flat(),
  );
}

/** Google refuses to sign anyone in inside WeChat's browser (links are often opened there). */
export const inWeChat = (req: Request) =>
  /MicroMessenger/i.test(req.headers.get("user-agent") || "");

const emailError = (e: unknown) => e instanceof ApiError && e.retryAfter
  ? json({ error: e.code, next: e.next, retryAfter: e.retryAfter }, e.status, { "retry-after": String(e.retryAfter) })
  : errorResponse(e);

export const publicRoutes: Route[] = [
  {
    method: "*",
    match: "/lang",
    handler: async (c) => {
      const { url } = c;

      const to = url.searchParams.get("to") === "zh" ? "zh" : "en";
      return redirect(
        localNext(url.searchParams.get("next"), url.origin),
        cookie("lang", to, 365 * 86400, url.protocol === "https:").replace(
          "HttpOnly; ",
          "",
        ),
      );
    },
  },
  // --- sign-in ---
  {
    method: "*",
    match: "/login",
    handler: async (c) => {
      const { req, env, url, lang, t } = c;
      const user = c.user;

      // Signing in with nowhere named lands on /app: "/" is the public homepage now.
      const old = url.searchParams.get("change") === "1" ? await emailFlow(env, parseCookies(req).email_login) : null;
      const next = localNext(url.searchParams.get("next") || old?.next || "/app", url.origin);
      if (user) return redirect(next);
      return loginPage(lang, {
        google: providerConfigured(env, "google"),
        github: providerConfigured(env, "github"),
        email: emailLoginConfigured(env),
        siteKey: env.TURNSTILE_SITE_KEY,
        prefill: old?.email,
        next,
        error: url.searchParams.get("error") === "session_lost" ? t.codeSessionLost : undefined,
        wechat: inWeChat(req),
      });
    },
  },
  {
    method: "GET",
    match: "/login/code",
    handler: async (c) => {
      const { req, env, lang } = c;
      const flow = emailLoginConfigured(env) ? await emailFlow(env, parseCookies(req).email_login) : null;
      if (!flow) {
        const res = redirect("/login?error=session_lost");
        res.headers.set("cache-control", "no-store");
        return res;
      }
      return loginCodePage(lang, { ...flowView(flow), accountDeleted: pageError(lang, "account_deleted", accountDeletedText()).text });
    },
  },
  {
    method: "POST",
    match: "/auth/email/start",
    errors: "json",
    handler: async (c) => {
      const { req, env, url, lang } = c;
      try {
        const b = await readBody(req);
        const r = await startEmail(req, env, b.email, b.next, b.turnstileToken, parseCookies(req).email_login, lang);
        const res = json({ next: "/login/code", expiresIn: r.expiresIn, resendIn: r.resendIn });
        if (!r.reused) res.headers.append("set-cookie", cookie("email_login", r.flowId, 1800, url.protocol === "https:"));
        return res;
      } catch (e) { return emailError(e); }
    },
  },
  {
    method: "POST",
    match: "/auth/email/resend",
    errors: "json",
    handler: async (c) => {
      const { req, env, url, lang } = c;
      try {
        const r = await resendEmail(req, env, parseCookies(req).email_login, lang);
        const res = json({ expiresIn: r.expiresIn, resendIn: r.resendIn });
        res.headers.append("set-cookie", cookie("email_login", r.flowId, 1800, url.protocol === "https:"));
        return res;
      } catch (e) { return emailError(e); }
    },
  },
  {
    method: "POST",
    match: "/auth/email/verify",
    errors: "json",
    handler: async (c) => {
      const { req, env, url } = c;
      try {
        const b = await readBody(req);
        const r = await verifyEmail(env, parseCookies(req).email_login, b.code, parseCookies(req).inv || null);
        const res = json({ next: r.next });
        res.headers.append("set-cookie", cookie("email_login", "", 0, url.protocol === "https:"));
        for (const value of clearInvite(req, url)) res.headers.append("set-cookie", value);
        res.headers.append("set-cookie", await createSession(req, env, r.user));
        return res;
      } catch (e) { return emailError(e); }
    },
  },
  {
    method: "GET",
    match: /^\/auth\/(google|github)(\/callback)?$/,
    handler: async (c, m) => {
      const { req, env, url, lang, t } = c;
      const user = c.user;
      const oauth = m!;
      const p = oauth[1] as Provider;
      if (!providerConfigured(env, p))
        return messagePage(
          lang,
          user,
          t.signInFailed,
          `${p}: ${t.notConfigured}`,
          404,
        );
      if (!oauth[2]) return startOAuth(req, env, p);
      if (url.searchParams.get("error"))
        return redirect(
          /"drive"/.test(parseCookies(req).oauth || "")
            ? "/settings?drive=cancelled#drive"
            : "/login",
        );
      const {
        user: u,
        signup,
        drive,
        next,
        clear,
      } = await finishOAuth(req, env, p);
      // Connecting a Drive: the person who started it, still signed in, gets it; nobody is signed in by it.
      if (drive) {
        if (!user || user.id !== drive.userId)
          return messagePage(lang, user, t.signInFailed, t.driveWrongUser, 403);
        if (!drive.scoped || !drive.refreshToken)
          return redirect(
            `/settings?drive=${drive.scoped ? "nooffline" : "noscope"}#drive`,
            clear,
          );
        await driveConnected(env, user, {
          refreshToken: drive.refreshToken,
          accessToken: drive.accessToken,
          email: drive.email,
        });
        return redirect(next, clear);
      }
      if (signup) return holdSignup(env, url, signup, next, clear);
      return redirect(next, [
        clear,
        ...clearInvite(req, url),
        await createSession(req, env, u!),
      ]);
    },
  },
  // A new account waits here until the person passes Turnstile; existing ones never see it.
  {
    method: "*",
    match: "/signup",
    handler: async (c) => {
      const { req, env, url, lang, t, isPost } = c;

      const sid = parseCookies(req).signup || "";
      const held =
        sid.length >= 20
          ? await heldSignup(env, sid)
          : null;
      if (!held || !turnstileOn(env))
        return messagePage(lang, null, t.signupTitle, t.signupExpired, 410);
      if (!isPost)
        return signupPage(lang, {
          email: held.email,
          siteKey: env.TURNSTILE_SITE_KEY!,
        });
      const b = await readBody(req);
      if (
        !(await turnstilePassed(
          env,
          str(b["cf-turnstile-response"], 4096),
          req.headers.get("cf-connecting-ip"),
        ))
      ) {
        return signupPage(lang, {
          email: held.email,
          siteKey: env.TURNSTILE_SITE_KEY!,
          error: t.signupFailed,
        });
      }
      await dropSignup(env, sid);
      const u = await signIn(env, held);
      return redirect(held.next, [
        cookie("signup", "", 0, url.protocol === "https:"),
        ...clearInvite(req, url),
        await createSession(req, env, u),
      ]);
    },
  },
  // Key-protected sign-in for this deployment's own test scripts. Nothing on any page links to it;
  // without the key it answers like any unknown path. Keep DEV_LOGIN_KEY unset in production;
  // set it only on a deployment used for testing.
  {
    method: "POST",
    match: "/auth/dev",
    handler: async (c) => {
      const { req, env, url, lang } = c;
      const user = c.user;

      if (!env.DEV_LOGIN_KEY) return null;
      const b = await readBody(req);
      const email = str(b.email, 200).trim().toLowerCase();
      if (
        !safeEqual(str(b.key, 200), env.DEV_LOGIN_KEY) ||
        !/^[^@\s]+@[^@\s]+$/.test(email)
      )
        return messagePage(
          lang,
          user,
          "404",
          lang === "zh" ? "没有这个页面。" : "Not found.",
          404,
        );
      const claim = {
        provider: "dev",
        subject: email,
        email,
        suggestedHandle: str(b.handle, 39) || email.split("@")[0],
        invite: parseCookies(req).inv || null,
      };
      const to = localNext(str(b.next, 500), url.origin);
      // signup=1: a new account goes through the sign-up check as it would from OAuth (to test that page).
      if (b.signup === "1") {
        const r = await signInOrHold(env, claim);
        if (r.signup) return holdSignup(env, url, r.signup, to, []);
        return redirect(to, [
          ...clearInvite(req, url),
          await createSession(req, env, r.user!),
        ]);
      }
      const u = await signIn(env, claim);
      return redirect(to, [
        ...clearInvite(req, url),
        await createSession(req, env, u),
      ]);
    },
  },
  {
    method: "POST",
    match: "/logout",
    handler: async (c) => {
      const { req, env } = c;

      return redirect("/login", await destroySession(req, env));
    },
  },
];

export const signedRoutes: Route<SignedRouteContext>[] = [
  {
    method: "GET",
    match: "/me/data",
    handler: async (c) => {
      const { env, lang } = c;
      const user = c.user;

      return meDataPage(env, user, lang);
    },
  },
];
