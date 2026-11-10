// The Worker: web pages, sign-in, device authorization, the agent API, and the hand-off of
// WebSocket upgrades to the room objects.
import { RoomDO } from "./room-do";
import { ApiError, errorResponse, json } from "./util";
import { repairRoomIndex, roomsChanged } from "./room-index";
import { getSession, origin, sameOrigin } from "./auth";
import { cleanupDeviceCodes } from "./device";
import { evictAll } from "./space";
import { messagePage, pageError } from "./message-page";
import { langOf, setAssetVersion, setSite } from "./layout";
import { strings } from "./strings";
import { purgeDeletedAccounts } from "./account-delete";
import { pruneEmailLogin } from "./email-login";
import { sweepPasscodeFailures } from "./room-passcode-sweep";
import { activityBackfillTick, proSnapshot } from "./ops-jobs";
import { lapseExpired } from "./billing";
import { retentionDays, runRetention } from "./retention";
import { contentHost, plain } from "./file-view";
import { contentLabel } from "./view-ticket";
import { compressed, noindexResponse } from "./seo";
import { inviteDaily } from "./invite";
import { withInviteCookie, redirect, runRoutes, wantsJsonBody, type Route, type RouteBaseContext, type RouteContext, type SignedRouteContext } from './routes/shared';
import { agentApi } from './routes/agent-rooms';
import { preGuardRoutes, publicRoutes as adminPublic } from './routes/admin';
import { publicRoutes as accountPublic, signedRoutes as accountSigned } from './routes/account';
import { signedRoutes as billingSigned, stageOneRoutes as billingStageOne } from './routes/billing';
import { publicRoutes as staticPublic, notFound } from './routes/static';
import { publicRoutes as trialPublic, signedRoutes as trialSigned } from './routes/trial-codes';
import { publicRoutes as calendarPublic } from './routes/calendar';
import { signedRoutes as invitesSigned } from './routes/invites';
import { snapshotRoutes, signedRoutes as roomSigned } from './routes/room-page';
import { appRoutes, createTopicRoutes } from './routes/home';
import { signedRoutes as approvalsSigned } from './routes/approvals';
import { signedRoutes as pushSigned } from './routes/push';
import { activationRoutes, signedRoutes as devicesSigned, stageOneRoutes as devicesStageOne } from './routes/devices';
import { signedRoutes as settingsSigned } from './routes/settings';
import { signedRoutes as cardsSigned } from './routes/cards';
import { signedRoutes as filesSigned } from './routes/files';
import { signedRoutes as workspaceSigned } from './routes/workspace';
import { purgeRoomNow, deleteTopicForGood, purgeExpired } from './room-purge';
import { errorModeOf } from './routes/error-mode';
const signedRoutes: Route<SignedRouteContext>[] = [...approvalsSigned, ...accountSigned, ...appRoutes, ...billingSigned, ...pushSigned, ...createTopicRoutes, ...activationRoutes, ...settingsSigned, ...invitesSigned, ...trialSigned, ...devicesSigned, ...filesSigned, ...cardsSigned, ...workspaceSigned, ...roomSigned];

export { RoomDO };

/**
 * What a deployment adds around this server, all optional. stageOne: routes answered before the session is read and on
 * every host (large files fetched in ranges); routes: public pages, tried where this server's own public pages are;
 * version: what the settings page shows; linkDomains: other domains (with their subdomains) whose https links in messages
 * may show only their words, as the deployment's own pages do. The pages link to pricing, the terms and the changelog
 * only when routes are given.
 */
export type Site = { stageOne?: Route<RouteBaseContext>[]; routes?: Route[]; version?: string; linkDomains?: string[] };
/** A Site with this server's own public routes around its pages. */
type Deployment = { stageOne: Route<RouteBaseContext>[]; publicRoutes: Route[]; links: boolean; version?: string; linkDomains: string[] };

/** The 10-minute cron (wrangler.jsonc): the ops page's activity backfill; the daily one does everything else. */
const TEN_MINUTE_CRON = "*/10 * * * *";

async function fetchRequest(req: Request, env: Env, ctx: ExecutionContext, d: Deployment): Promise<Response> {
    // Content-domain HEAD keeps its method so probing cannot consume a preview ticket.
    // Other routes treat HEAD as GET without the body, preserving the same status and headers
    // instead of falling through to sign-in with 303 even for / and /pricing.
    if (req.method === "HEAD" && contentLabel(env.CONTENT_DOMAIN, new URL(req.url).hostname) === null) {
      const res = await fetchRequest(new Request(req, { method: "GET" }), env, ctx, d);
      return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    setAssetVersion(env.CF_VERSION_METADATA?.id); // the ?v= on the pages' CSS and JS
    setSite(d.links, d.version, d.linkDomains);
    const url = new URL(req.url);
    const path = url.pathname;
    const errorMode = errorModeOf(path);
    // The content domain: what files hold, by ticket, and nothing else of ours, ever.
    const label = contentLabel(env.CONTENT_DOMAIN, url.hostname); // the name only: a port must not take a host out of it
    if (label !== null) return contentHost(req, env, url, label, ctx).catch((e) => {
      console.error(JSON.stringify({ msg: "content host failed", error: String((e as Error)?.stack || e) }));
      return plain(500, "Something went wrong. Open the file again from Scorpio. · 出现错误，请从 Scorpio 重新打开该文件。");
    });
    try {
      // Files are served by Cloudflare before the Worker runs (run_worker_first: false); one that is missing lands here.
      if (path.startsWith("/static/") || path.startsWith("/dl/") || path === "/favicon.ico") return env.ASSETS.fetch(req);
      const early = await runRoutes({ req, env, ctx, url, path, isPost: req.method === "POST" }, d.stageOne);
      if (early) return early;
      if (path.startsWith("/api/v1/")) return await agentApi(req, env, ctx, path.slice("/api/v1".length));
      const device = await runRoutes({ req, env, ctx, url, path, isPost: req.method === "POST" }, devicesStageOne);
      if (device) return device;
      // Creem's server, not a browser: signed, no session, no Origin.
      const billing = await runRoutes({ req, env, ctx, url, path, isPost: req.method === "POST" }, billingStageOne);
      if (billing) return billing;
      // People's pages live on one origin (sessions and OAuth callbacks are per host); other hosts
      // that reach this Worker send browsers there. The agent API above answers on every host.
      const canonical = env.PUBLIC_URL ? new URL(env.PUBLIC_URL) : null;
      if (canonical && url.host !== canonical.host && (req.method === "GET" || req.method === "HEAD") && req.headers.get("upgrade") !== "websocket") {
        return Response.redirect(`${canonical.origin}${path}${url.search}`, 301);
      }
      return compressed(req, await withInviteCookie(req, env, url, await web(req, env, url, ctx, d)));
    } catch (e) {
      const wantsJson = errorMode === "json" || wantsJsonBody(req);
      if (wantsJson) return errorResponse(e);
      const lang = langOf(req);
      if (e instanceof ApiError) {
        const title = e.code.startsWith("oauth_") ? strings(lang).signInFailed : strings(lang).error;
        const pe = pageError(lang, e.code, e.next); // English for agents: a Chinese page says it in Chinese
        return messagePage(lang, null, title, pe.text, e.status, pe.detail);
      }
      console.error(JSON.stringify({ msg: "unhandled", path, error: String((e as Error)?.stack || e) }));
      return messagePage(lang, null, strings(lang).error, lang === "zh" ? "出错了，请重试。" : "Something went wrong. Try again.", 500);
    }
}

/** The Worker for a deployment: createWorker() is this server on its own; a deployment with a website passes its pages. */
export function createWorker(site: Site = {}) {
  const d: Deployment = {
    stageOne: site.stageOne ?? [],
    publicRoutes: [...adminPublic, ...accountPublic, ...snapshotRoutes, ...(site.routes ?? []), ...trialPublic, ...calendarPublic, ...staticPublic],
    links: Boolean(site.routes),
    version: site.version,
    linkDomains: site.linkDomains ?? [],
  };
  return {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const response = await fetchRequest(req, env, ctx, d);
      return env.NOINDEX === "true" && req.headers.get("upgrade") !== "websocket" ? noindexResponse(response) : response;
    },
    scheduled: cron.scheduled,
  } satisfies ExportedHandler<Env>;
}

/** The scheduled jobs (wrangler.jsonc triggers), the same for every deployment. */
const cron = {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // Every 10 minutes: a few rooms put what they said before activity_daily existed into it (once each; the ops page's activity chart).
    if (event.cron === TEN_MINUTE_CRON) {
      await activityBackfillTick(env).catch((e) => console.error(JSON.stringify({ msg: "activity backfill tick failed", error: String(e) })));
      return;
    }
    await cleanupDeviceCodes(env).catch((e) => console.error(JSON.stringify({ msg: "device code cleanup failed", error: String(e) })));
    await pruneEmailLogin(env).catch((e) => console.error(JSON.stringify({ msg: "email login prune failed", error: String(e) })));
    await sweepPasscodeFailures(env).catch((e) => console.error(JSON.stringify({ msg: "passcode failure sweep failed", error: String(e) })));
    // The retention clock: quiet rooms archived, long-archived ones purged.
    try {
      const days = await retentionDays(env);
      for (const owner of await runRetention(env, days, (id) => purgeRoomNow(env, id))) await roomsChanged(env, owner, "");
    } catch (e) {
      console.error(JSON.stringify({ msg: "retention run failed", error: String(e) }));
    }
    await purgeExpired(env).catch((e) => console.error(JSON.stringify({ msg: "purge expired failed", error: String(e) })));
    await evictAll(env).catch((e) => console.error(JSON.stringify({ msg: "evict all failed", error: String(e) }))); // accounts over their file space (missed runs, lapsed Pro after 30 days)
    await purgeDeletedAccounts(env, (roomId, owner) => deleteTopicForGood(env, roomId, owner)).catch((e) => console.error(JSON.stringify({ msg: "deleted accounts purge failed", error: String(e) }))); // 7 days after the deletion
    await lapseExpired(env).catch((e) => console.error(JSON.stringify({ msg: "lapse expired failed", error: String(e) }))); // a Creem Pro whose period ran out with no webhook: its rooms downgrade once
    await repairRoomIndex(env).catch((e) => console.error(JSON.stringify({ msg: "room index repair failed", error: String(e) })));
    await inviteDaily(env).catch((e) => console.error(JSON.stringify({ msg: "invite self-check failed", error: String(e) })));
    await proSnapshot(env).catch((e) => console.error(JSON.stringify({ msg: "pro snapshot failed", error: String(e) }))); // the ops page's Pro chart
  },
};

export default createWorker();

// Web routes run in the same stages as before the split.
async function web(req: Request, env: Env, url: URL, ctx: ExecutionContext, d: Deployment): Promise<Response> {
  const path = url.pathname;
  const lang = langOf(req);
  const t = strings(lang);
  const user = await getSession(req, env);
  const isPost = req.method === "POST";
  const c: RouteContext = { req, env, ctx, url, path, lang, t, user, isPost };
  const admin = await runRoutes(c, preGuardRoutes);
  if (admin) return admin;
  if (isPost && !sameOrigin(req, env)) {
    if (/^\/r\/[^/]+\/workspace\/request$/.test(path)) return json({ error: "forbidden", next: "Cross-site request refused." }, 403, { "Cache-Control": "private, no-store, no-transform" });
    if (path.startsWith("/auth/email/")) return json({ error: "forbidden", next: "Cross-site request refused." }, 403);
    if (/^\/rooms\/[^/]+\/approvals\/[^/]+\/answer$/.test(path) || /^\/r\/[^/]+\/(?:schedules|press|cards\/[0-9]+\/ticket)$/.test(path)) return json({ error: "forbidden", next: "Cross-site request refused." }, 403);
    return messagePage(lang, user, lang === "zh" ? "提交被拒绝" : "Forbidden", lang === "zh" ? "跨站提交已被拒绝。回到 Scorpio 页面重新操作。" : "Cross-site request refused.", 403);
  }
  const publicResult = await runRoutes(c, d.publicRoutes);
  if (publicResult) return publicResult;
// Everything below needs a signed-in person.
  if (!user) {
    if (/^\/r\/[^/]+\/workspace\/(?:hosts|ws|request)$/.test(path)) return json({ error: "not_logged_in", next: "Sign in again." }, 401, { "Cache-Control": "private, no-store, no-transform" });
    if (/^\/rooms\/[^/]+\/approvals\/[^/]+\/answer$/.test(path)) return json({ error: "approval_not_found", next: "Approval not found." }, 404);
    if (isPost || path.endsWith("/ws") || path.startsWith("/f/")) return json({ error: "not_logged_in", next: "Sign in again." }, 401);
    return redirect(`/login?next=${encodeURIComponent(path + url.search)}`);
  }
  const signedResult = await runRoutes({ ...c, user }, signedRoutes);
  if (signedResult) return signedResult;
  return notFound(c);
}
