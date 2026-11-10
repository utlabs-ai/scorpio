import { batches, codesOf, createBatch } from "../trial-codes";
import { trialCodesPage } from "../trial-codes-page";
import { ApiError, readBody, str } from "../util";
import { adminPage, isOps } from "../admin-page";
import {
  deleteAccount,
  deletionPreview,
  finishAccount,
  restoreAccount,
  restoreMs,
} from "../account-delete";
import { accountDeletePage } from "../account-delete-page";
import { DAY_MS } from "../retention";
import { redirect, type Route } from "./shared";
import { deleteTopicForGood } from "../room-purge";

export const preGuardRoutes: Route[] = [
  {
    method: "*",
    match: /^\/admin(?:\/stats)?$/,
    handler: async (c) => {
      const { req, env, path, lang } = c;
      const user = c.user;

      // The ops page: only the accounts in OPS_ACCOUNTS; anyone else sees no such page. /admin/stats was its first form.
      if (req.method !== "GET" || !user || !isOps(env, user.handle))
        return new Response("Not found", { status: 404 });
      if (path === "/admin/stats") return redirect("/admin");
      return adminPage(env, user, lang);
    },
  },
];

export const publicRoutes: Route[] = [
  { method: "*", match: "/admin/trial-codes", handler: async ({ req, env, user, url, lang }) => {
    if (!user || !isOps(env, user.handle)) return new Response("Not found", { status: 404 });
    if (req.method === "POST") {
      const b = await readBody(req);
      const { batch } = await createBatch(env, user.id, { count: Number(b.count), days: Number(b.days), note: b.note });
      return redirect(`/admin/trial-codes?batch=${encodeURIComponent(batch.id)}`);
    }
    if (req.method !== "GET") return new Response("Not found", { status: 404 });
    const batch = (await batches(env)).find(b => b.id === url.searchParams.get("batch"));
    if (!batch) return new Response("Not found", { status: 404 });
    return trialCodesPage(lang, user, batch, await codesOf(env, batch.id), env.PUBLIC_URL || url.origin);
  } },
  // Deleting an account: the ops accounts only, from the ops page, after seeing what goes; no /api/v1 route.
  {
    method: "*",
    match: /^\/admin\/accounts\/(?:delete|restore|finish)$/,
    handler: async (c) => {
      const { req, env, ctx, url, path, lang, isPost } = c;
      const user = c.user;

      if (!user || !isOps(env, user.handle))
        return new Response("Not found", { status: 404 });
      const restoreDays = Math.round((await restoreMs(env)) / DAY_MS);
      if (path === "/admin/accounts/delete" && req.method === "GET") {
        const handle = str(url.searchParams.get("handle"), 39).trim();
        return accountDeletePage(lang, user, {
          handle,
          preview: handle ? await deletionPreview(env, handle) : null,
          restoreDays,
        });
      }
      if (!isPost) return new Response("Not found", { status: 404 });
      const b = await readBody(req);
      const handle = str(b.handle, 39).trim();
      if (path === "/admin/accounts/restore") {
        const done = (await restoreAccount(env, handle))
          ? "restored"
          : "not_restored";
        return accountDeletePage(lang, user, {
          handle,
          preview: await deletionPreview(env, handle),
          done,
          restoreDays,
        });
      }
      if (path === "/admin/accounts/finish") {
        // What a deletion left: its own action, refused for an account that is not deleted now.
        const error = await finishAccount(
          env,
          handle,
          (roomId, owner) => deleteTopicForGood(env, roomId, owner),
          (w) => ctx.waitUntil(w),
        ).then(
          () => undefined,
          (e) => {
            if (!(e instanceof ApiError)) throw e;
            return `${e.code}: ${e.next}`;
          },
        );
        return accountDeletePage(lang, user, {
          handle,
          preview: await deletionPreview(env, handle),
          error,
          done: error ? undefined : "finishing",
          restoreDays,
        });
      }
      if (str(b.confirm, 39).trim() !== handle) {
        return accountDeletePage(lang, user, {
          handle,
          preview: await deletionPreview(env, handle),
          error: "The handle typed again does not match; nothing was deleted.",
          restoreDays,
        });
      }
      let done: Awaited<ReturnType<typeof deleteAccount>>;
      try {
        // Access goes before the answer; the slow steps go on after it, whatever the tab does.
        done = await deleteAccount(
          env,
          handle,
          (roomId, owner) => deleteTopicForGood(env, roomId, owner),
          (h) => isOps(env, h),
          (w) => ctx.waitUntil(w),
        );
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        return accountDeletePage(lang, user, {
          handle,
          preview: await deletionPreview(env, handle),
          error: `${e.code}: ${e.next}`,
          restoreDays,
        });
      }
      return accountDeletePage(lang, user, {
        handle,
        preview: await deletionPreview(env, handle),
        done,
        restoreDays,
      });
    },
  },
];
