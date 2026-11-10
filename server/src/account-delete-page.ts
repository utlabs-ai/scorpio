// The ops page's account deletion: what will go, the confirm form (retype the handle), the result, and the
// undo within the 7 days. Only OPS_ACCOUNTS reach it (index.ts).

import type { User } from "./auth";
import type { DeletionPreview } from "./account-delete";
import { dataShell } from "./app-page";
import type { Lang } from "./layout";
import { escapeHtml as e } from "./util";

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function accountDeletePage(
  lang: Lang,
  user: User,
  p: { handle: string; preview: DeletionPreview | null; done?: "deleted" | "already" | "in_progress" | "finishing" | "restored" | "not_restored"; error?: string; restoreDays: number },
): Response {
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const v = p.preview;
  const notices: Record<NonNullable<typeof p.done>, string> = {
    deleted: say("已注销：登录、令牌和设备已经撤了。它建的主题、在别人主题里的位置和 Drive 在后台处理，过一会儿刷新这页看。", "Deleted: sign-in, tokens and devices are gone. Its topics, its places in other topics and Drive are being handled in the background; reload in a moment."),
    already: say("这个账号已经注销了（这次是重复提交，没有再做一遍）。下面是它现在的状态。", "This account was deleted already (a repeated submit; nothing was done twice). Its state now is below."),
    in_progress: say("这个账号正在注销（刚才那次提交还在做）。过一会儿刷新这页。", "This account is being deleted (the earlier submit is still at it). Reload in a moment."),
    finishing: say("剩下的步骤在后台做，过一会儿刷新这页看。", "What is left is being done in the background; reload in a moment."),
    restored: say("已撤销，可以重新登录了。", "Undone; they can sign in again."),
    not_restored: say("撤销不了：已经过了期限或清完了。", "Cannot undo: past the restore window, or purged."),
  };
  const done = p.done ? notices[p.done] : "";
  // Right after a deletion its steps are running: what is left shows once they had their go (a reload).
  const working = p.done === "deleted" || p.done === "in_progress" || p.done === "finishing";
  const notice = done ? `<p class="here">${done}</p>` : "";
  // The site kit's field and buttons; the real deletion keeps settings' danger button.
  const form = `<form method="get" action="/admin/accounts/delete" class="del-find"><div class="sx-fld"><label for="del-handle">${say("账号名", "Handle")}</label><input id="del-handle" class="sx-in" name="handle" value="${e(p.handle)}" required autocomplete="off"></div><button class="sx-btn sx-line sx-lg sx-wide">${say("看会删什么", "Show what will be deleted")}</button></form>`;
  let body: string;
  if (!p.handle) body = form;
  else if (!v) body = `${form}<p class="muted">${say(`没有 ${e(p.handle)} 这个账号。`, `There is no account ${e(p.handle)}.`)}</p>`;
  else if (v.deletedAt) {
    const until = v.deletedAt + p.restoreDays * 86_400_000;
    const status = v.purgedAt
      ? say(`${day(v.deletedAt)} 注销，${day(v.purgedAt)} 已清完，撤销不了了。`, `Deleted ${day(v.deletedAt)}, purged ${day(v.purgedAt)}; it cannot be undone.`)
      : say(`${day(v.deletedAt)} 注销。${day(until)} 之前还能撤销：恢复登录和他传的文件（他建的主题、令牌和订阅回不来）。`, `Deleted ${day(v.deletedAt)}. Until ${day(until)} it can be undone: sign-in and their files come back (the topics they created, tokens and subscription do not).`);
    const undo = v.purgedAt ? "" : `<form method="post" action="/admin/accounts/restore" data-once="${say("撤销中…", "Undoing…")}"><input type="hidden" name="handle" value="${e(v.handle)}"><button class="sx-btn sx-line sx-lg sx-wide">${say("撤销注销", "Undo the deletion")}</button></form>`;
    // A step that failed: what is left, done again by the daily job or now.
    const l = working ? null : v.left;
    const left = l
      ? `<p class="error">${say("还没做完：", "Not finished yet: ")}${[
          l.topics.length ? say(`${l.topics.length} 个他建的主题没删掉`, `${l.topics.length} topic(s) they created not deleted`) : "",
          l.joined.length ? say(`${l.joined.length} 个别人的主题没移出`, `still listed in ${l.joined.length} other topic(s)`) : "",
          l.drive ? say("Google Drive 没断开", "Google Drive not disconnected") : "",
        ].filter(Boolean).join(say("；", "; "))}${say("。每天的任务会再做一次，也可以现在再试。", ". The daily job tries again; or try now.")}</p>
<form method="post" action="/admin/accounts/finish" data-once="${say("处理中…", "Working…")}"><input type="hidden" name="handle" value="${e(v.handle)}"><button class="sx-btn sx-danger sx-lg sx-wide">${say("把剩下的做完", "Finish the deletion")}</button></form>`
      : "";
    body = `${form}<h2>${e(v.handle)}</h2>${notice}${p.error ? `<p class="error">${e(p.error)}</p>` : ""}<p>${status}</p>${left}${undo}`;
  } else {
    const rows: [string, string][] = [
      [say("邮箱、注册于", "E-mail, signed up"), `${e(v.email)} · ${day(v.createdAt)}`],
      [say("他建的主题（马上删）", "Topics they created (deleted now)"), v.topics.length ? `${v.topics.length}：${v.topics.map((t) => e(t.name)).join("、")}` : "0"],
      [say("文件空间", "File space"), `${v.files.n} ${say("个", "files")}，${mb(v.files.bytes)}；${say(`其中 ${v.files.elsewhere} 个在别人的主题里（${p.restoreDays} 天后删）`, `${v.files.elsewhere} of them in other people's topics (deleted after ${p.restoreDays} days)`)}`],
      [say("别人的主题（移出名单，消息和名字留着）", "Other people's topics (taken off the list; messages and name stay)"), String(v.joined.length)],
      [say("agent 令牌、设备", "Agent tokens, devices"), `${v.tokens}、${v.devices}`],
      [say("推送订阅", "Push subscriptions"), String(v.push)],
      [say("Google Drive", "Google Drive"), v.drive ? `${e(v.drive.email)}${v.drive.connected ? say("（先撤销授权）", " (its authorization is revoked first)") : ""}` : "—"],
      // One row, so it cannot read as "cancel at Creem yourself first".
      [say("订阅", "Subscription"), v.creem
        ? say(`有正式 Creem 订阅${v.creem.periodEnd ? `，付到 ${day(v.creem.periodEnd)}` : ""}；注销第一步会立刻停掉；不会自动退款，要退在 Creem 后台办`, `active Creem subscription${v.creem.periodEnd ? `, paid through ${day(v.creem.periodEnd)}` : ""}; stopped at once as the first step; not refunded automatically (refunds are done in the Creem dashboard)`)
        : say("没有正式 Creem 订阅", "no live Creem subscription")],
      [say("留着", "Kept"), say("付款记录；账号名永久保留，不再给别人", "payment records; the handle, never given to anyone else")],
    ];
    body = `${form}<h2>${e(v.handle)}</h2>${notice}${p.error ? `<p class="error">${e(p.error)}</p>` : ""}
<div class="del-table"><table><tbody>${rows.map(([k, x]) => `<tr><th>${k}</th><td>${x}</td></tr>`).join("")}</tbody></table></div>
<form method="post" action="/admin/accounts/delete" data-once="${say("注销中…", "Deleting…")}"><input type="hidden" name="handle" value="${e(v.handle)}">
<div class="sx-fld"><label for="del-confirm">${say(`确认：再输一遍账号名 ${e(v.handle)}`, `To confirm, type the handle ${e(v.handle)} again`)}</label><input id="del-confirm" class="sx-in" name="confirm" required autocomplete="off"></div>
<button class="sx-btn sx-danger sx-lg sx-wide">${say("注销这个账号", "Delete this account")}</button></form>`;
  }
  return dataShell(lang, user, {
    title: `${say("注销账号", "Delete an account")} · Scorpio`,
    // Its forms send once: the button turns into "working" at the first tap.
    head: `<link rel="stylesheet" href="/static/admin.css"><script src="/static/submit-once.js" defer></script>`,
    path: "/admin",
    shown: user.handle,
    back: "/admin",
    body: `<div class="ops ops-del">${body}</div>`,
  });
}
