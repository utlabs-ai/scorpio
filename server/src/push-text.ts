import type { PushPayload } from "./push";

export type Shown = { title: string; body?: string };

/** Both browser languages travel with the push; the service worker chooses one. */
export function pushText(p: PushPayload): { en: Shown; zh: Shown } {
  const one = (zh: boolean): Shown => {
    let title = "Scorpio", body = "";
    if (p.type === "todo_assigned" && p.item) {
      title = (p.room && p.room.name) || title;
      const named = p.by && p.byDisplayName && p.byDisplayName !== p.by;
      const by = named ? p.byDisplayName + "（" + p.by + "）" : p.by;
      body = (zh ? "等你：" : "Waiting on you: ") + p.item.id + " " + p.item.title + (by ? (named ? " · " + by : (zh ? "（" + by + "）" : " (" + by + ")")) : "");
    } else if (p.type === "test") {
      body = zh ? "通知已开启：有任务挂到你名下时，会在这里提醒你。" : "Notifications are on: when something is put under your name, it shows up here.";
    } else if (p.type === "mention" && p.room) {
      title = p.room.name;
      body = zh ? "有人 @ 你" : "Someone mentioned you";
    } else if (p.type === "quota_warn" && p.room) {
      title = p.room.name;
      body = zh ? "今天已发 " + p.used + " 条，免费版每个主题每天 " + p.limit + " 条，即将用完。" : p.used + " of today's " + p.limit + " messages used in this topic (free plan).";
    } else if (p.type === "agent_blocked" && p.room) {
      title = p.room.name;
      const who = String(p.name || "").split("@")[0] || "agent", why = String(p.reason || "");
      const at = /^approval/.test(why) ? (zh ? "审批" : "an approval") : /^question/.test(why) ? (zh ? "提问" : "a question") : (zh ? "终端提示" : "a prompt");
      const detail = why && !/^(approval|question|prompt)$/.test(why) ? why.replace(/^\w+: /, "") : "";
      body = p.approval
        ? (zh ? who + " 在等你确认" + (detail ? "（" + detail + "）" : "") + "，点开就能答。"
          : who + " is waiting for your approval" + (detail ? " (" + detail + ")" : "") + ". Tap to answer.")
        : zh
        ? who + " 停在" + at + "上" + (detail ? "（" + detail + "）" : "") + "，请到那台电脑查看。"
        : who + " is stuck at " + at + (detail ? " (" + detail + ")" : "") + "; have a look on that computer.";
    } else if (p.type === "device_logged_out") {
      // an unexpected logout: sent to every browser of the person; a tap opens the approval page with the code filled in
      body = zh ? p.name + " 意外掉线了，点一下让它重新上线。" : p.name + " logged out unexpectedly. Tap to bring it back online.";
    } else if (p.type === "alert") {
      title = zh ? "Scorpio 告警" : "Scorpio alert";
      return { title };
    }
    return { title, body };
  };
  return { en: one(false), zh: one(true) };
}
