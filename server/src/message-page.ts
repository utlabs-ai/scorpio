import { escapeHtml as e } from "./util";
import type { User } from "./auth";
import { siteLinks, type Lang } from "./layout";
import { strings } from "./strings";
import { shellPage, msgCard } from "./shell-page";
import { pubPage } from "./snapshot-page";

/**
 * What an error page says: ApiError.next is written for agents, in English; a Chinese page says
 * it in Chinese for the codes a page can meet, and otherwise a general line with the original kept small under it.
 */
export function pageError(lang: Lang, code: string, next: string): { text: string; detail?: string } {
  if (lang !== "zh") return { text: next };
  const zh: Record<string, string> = {
    room_not_found: "没有这个主题。看一下邀请里的主题 ID。",
    not_member: "你不在这个主题里。",
    file_not_found: "没有这个文件，可能已经删了。",
    already_pro: "你已经是 Pro 了，在价格页管理订阅。",
    payment_unavailable: "付款服务没给出付款链接，过一分钟再试。",
    oauth_denied: "登录取消了。",
    oauth_state: "登录超时了，或者是在另一个浏览器里开始的。再试一次。",
    account_deleted: siteLinks() ? "这个账号已注销，7 天内可恢复，请写信 support@utlabs.ai。" : "这个账号已注销，7 天内运行这个服务器的人还能恢复。",
    pay_closed: "这里还不能付费开通 Pro。",
    no_subscription: "这个账号没有 Creem 订阅。",
  };
  if (code === "oauth_failed") return { text: `${/github/i.test(next) ? "GitHub" : "Google"} 没有给出验证过的邮箱。` };
  if (zh[code]) return { text: zh[code] };
  return { text: "出了点问题，再试一次。", detail: next };
}

/** An error or a notice: the centered card, in the signed-in shell (a bar with only ‹) or as a public page. The
 *  magnifier says "not found" (404); anything else gets a plain "!". */
export function messagePage(lang: Lang, user: User | null, title: string, message: string, status = 400, detail?: string): Response {
  const card = msgCard({
    icon: status === 404 ? "lost" : "alert",
    title,
    text: message,
    inner: `${detail ? `<small class="sx-detail">${e(detail)}</small>` : ""}<a class="sx-btn sx-line" href="${user ? "/app" : "/"}">${e(strings(lang).back)}</a>`,
  });
  if (user) return shellPage(lang, user, { title: "", center: true, body: card, status });
  return pubPage(lang, null, { title, path: "/", body: card, status });
}
