import { DEFAULT_SPAWN, type PermOption } from "./spawn-config";
import type { SpawnPerm } from "./spawn-perm";
import { escapeHtml as e } from "./util";
import type { User } from "./auth";
import type { DriveState } from "./drive";
import type { Limits, Plan } from "./plans";
import type { Space } from "./space";
import type { Paid } from "./billing-state";
import { SHELL_HEAD, shellSide } from "./app-page";
import { footer, layout, productVersion, siteLinks, sizeText, type Lang } from "./layout";
import { strings, ROOM_STRINGS } from "./strings";

/**
 * Settings: notification preferences, appearance, devices and account. Drive backup is off the page until it is open to
 * everyone: its code, routes and switch stay, and `drive` / `done` are still passed in.
 * The language row is a GET form to the existing /lang, which sets this browser's lang cookie and comes back here.
 */
/** What GET /settings/invite answers (invite.ts inviteView). */
export type InviteView = {
  /** The current single-use invite; null once this month's invites are all used. */
  code: string | null;
  url: string | null;
  /** Invites used this month: friends who signed up with one of my codes since the 1st (UTC). */
  monthCount: number;
  monthCap: number;
  bankedDays: number;
  activeUntil: number | null;
  invitees: { name: string; status: "registered" | "rewarded" | "connected"; at: number }[];
  canEnterCode: boolean;
  invitedBy?: string | null;
};

/**
 * Settings → 邀请朋友: under the plan card and drawn like it — the rule in one
 * line, the link with 复制, this month's n / cap, the days saved up (or the gifted Pro in use), whom you invited, the small
 * print; within 7 days of signing up, a row to enter someone's code. Why a friend did not count is never shown.
 * A link works once: when it is used the next one is here; when the month's are all
 * used, a sentence takes the link's place.
 */
function inviteCard(lang: Lang, v: InviteView, usage: (label: string, used: number, limit: number | null, display: string, note?: string) => string): string {
  const say = (zh: string, en: string) => lang === "zh" ? zh : en;
  const day = (ms: number) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(ms);
  const status = { rewarded: say("已连接电脑 · +7 天", "Up and running · +7 days"), connected: say("已连接电脑", "Up and running"), registered: say("已注册，尚未连接电脑", "Signed up, no computer yet") };
  const saved = v.bankedDays > 0 ? `<div class="use inv-days"><span>${e(say("待生效的 Pro", "Pro saved up"))}</span><b>${e(say(`${v.bankedDays}\u00a0天`, v.bankedDays === 1 ? "1\u00a0day" : `${v.bankedDays}\u00a0days`))}</b><small>${e(say("当前 Pro 到期后生效", "starts when your current Pro ends"))}</small></div>` : "";
  const gifted = v.activeUntil ? `<div class="use inv-days"><span>${e(say(`送的 Pro 到 ${day(v.activeUntil)}`, `Gifted Pro until ${day(v.activeUntil)}`))}</span></div>` : "";
  const people = v.invitees.length ? `<ul class="inv-people">${v.invitees.map((x) => `<li><b>${e(x.name)}</b><span class="${x.status === "registered" ? "" : "ok"}">${e(status[x.status] || status.registered)}</span></li>`).join("")}</ul>` : "";
  const card = `<div class="plan inv" id="invite"><div class="l1"><b>${e(say("邀请朋友，双方各得 7 天 Pro", "Invite friends: you both get 7 days of Pro"))}</b></div>
<p class="renew">${e(say(`这个链接只能用一次：朋友用它注册，多得 7 天 Pro；他 30 天内在自己的电脑上让 agent 进了主题，你也得 7 天。被用了，这里自动换下一个，每月最多 ${v.monthCap} 个。`, `This link works once: a friend who signs up with it gets 7 extra days of Pro. Once their agent joins a topic from their own computer within 30 days, you get 7 days too. When it has been used, the next one appears here, up to ${v.monthCap} a month.`))}</p>
${v.url ? `<div class="inv-link"><span class="u">${e(v.url.replace(/^https?:\/\//, ""))}</span><button type="button" class="btn sm" data-copy-invite="${e(v.url)}" data-done="${e(say("已复制", "Copied"))}">${e(say("复制", "Copy"))}</button></div>`
    : `<div class="inv-link inv-out">${e(say(`本月的 ${v.monthCap} 个邀请都用了，下月再有。`, `All ${v.monthCap} invites for this month are used; more next month.`))}</div>`}
${usage(say("本月已用", "Used this month"), v.monthCount, v.monthCap, `${v.monthCount} / ${v.monthCap}`)}${saved}${gifted}${people}
<p class="inv-note">${e(say("一个链接只对一个人有效：第二个用它注册的人不计入，请另复制新链接。朋友完成注册即占用一个名额，之后是否连接电脑不影响。朋友的电脑若曾在其他账号下登记，你不获得 7 天。", "One link, one person: if two people get it, the second to sign up does not count — copy the new one for them. A friend's sign-up uses one of your invites, whether or not they connect a computer. A computer already registered under another account does not count for your 7 days."))}</p></div>`;
  const enter = v.canEnterCode ? `<ul class="rows"><li class="row name-row"><details class="name-setting" id="invite-code-setting"><summary><span class="t">${e(say("有人邀请你？填写对方的邀请码", "Invited by someone? Enter their code"))}</span><span class="sp"></span><span class="chev">›</span></summary><form id="invite-code-form" data-by="${e(say("邀请人 · {name}", "Invited by {name}"))}"><input id="invite-code" name="code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${e(say("6 位邀请码", "6-character code"))}"><button type="submit" class="btn sm">${e(say("确定", "OK"))}</button></form><small id="invite-code-result" class="muted" role="status">${e(say("注册后 7 天内可填写，效果与打开对方的链接相同。", "Within 7 days of signing up; same as opening their link."))}</small></details></li></ul>` : "";
  // once invited (by the link or a code), who it was, and nothing to open
  const by = !v.canEnterCode && v.invitedBy ? `<ul class="rows"><li class="row"><span class="t" id="invited-by">${e(say(`邀请你的人 · ${v.invitedBy}`, `Invited by ${v.invitedBy}`))}</span></li></ul>` : "";
  return card + enter + by;
}

export function settingsPage(lang: Lang, user: User, p: {
  drive: DriveState | null;
  done: string;
  displayName: string | null;
  devices: { id: string; name: string; hostname: string; note: string | null; device_name: string; created_at: number; last_used_at: number | null; revoked_at: number | null; online: boolean | null; idleHandoffMinutes: number | null; clis?: { kind: string; installed: boolean; version: string | null; at: number }[] | null;
    /** Logged out unexpectedly: since when, and the relogin code to approve (null when none is pending). */
    loggedOut?: { at: number; code: string | null } | null }[];
  providers: string[];
  plan: Plan;
  trialUntil: number | null;
  /** A paid Pro (Creem): the day it is paid through, and whether it was canceled. */
  paid: Paid | null;
  limits: Limits;
  space: Space;
  activeRooms: number;
  messagesToday: number | null;
  visibleRooms: { id: string; name: string }[];
  /** Invites (inviteView), or null when it could not be read or the deployment has no plans. */
  invite?: InviteView | null;
  /** 「交接只存在 agent 的电脑上」: D1 users.handoff_local; changed with POST /settings/handoff. */
  handoffLocal?: boolean;
  autoCallBack?: boolean;
  spawnPerm?: SpawnPerm;
  permOptions?: PermOption[];
  /**
   * Computers running agents: how many count now, this plan's cap (null: no limit), and Free's and Pro's
   * caps for the devices lead (null on a self-hosted server).
   */
  computers?: { n: number; limit: number | null; free: number | null; pro: number | null };
}): Response {
  const t = strings(lang);
  const say = (zh: string, en: string) => lang === "zh" ? zh : en;
  const trialDay = p.trialUntil == null ? null : new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(p.trialUntil);
  const planLabel = trialDay ? say(`Pro 试用，到 ${trialDay}`, `Pro trial until ${trialDay}`) : p.plan === "pro" ? "Pro" : p.plan === "free" ? say("免费版", "Free") : say("自建", "Self-hosted");
  const planAction = trialDay ? say("升级 Pro", "Upgrade Pro") : p.plan === "pro" ? say("管理订阅", "Manage plan") : say("查看 Pro", "See Pro");
  const paidDay = p.paid ? new Date(p.paid.until).toISOString().slice(0, 10) : "";
  // A paid subscription can be cancelled any time; deleting the account is a mail, and cancels it too.
  const mail = `<a href="mailto:support@utlabs.ai">support@utlabs.ai</a>`;
  const cancelNote = !p.paid ? ""
    : !p.paid.canceled
      ? `<p class="renew">${e(say("可随时取消，Pro 保留至当期结束。要注销账号，用账号邮箱写信至 ", "You can cancel any time and keep Pro until the end of the period. To delete your account, email "))}${mail}${e(say("，订阅会一并取消。", " from your account's address; we will cancel your subscription at the same time."))}</p>`
      : `<p class="renew">${e(say("要注销账号，用账号邮箱写信至 ", "To delete your account, email "))}${mail}${e(say("。", " from your account's address."))}</p>`; // already cancelled: only the deletion half
  // With a carried trial, when Pro ends and when the next charge is, apart.
  const carry = p.paid?.carryDays || 0;
  const renewsDay = p.paid?.renewsOn ? new Date(p.paid.renewsOn).toISOString().slice(0, 10) : paidDay;
  const trialN = lang === "zh" ? `${carry}\u00a0天` : carry === 1 ? "1\u00a0trial day" : `${carry}\u00a0trial days`;
  const paidNote = !p.paid ? ""
    : carry
      ? p.paid.canceled
        ? say(`已取消，Pro 到 ${paidDay}（含试用 ${trialN}），不再续费`, `Canceled: ends on ${paidDay} (incl. ${trialN}), will not renew`)
        : say(`Pro 到 ${paidDay}（含试用 ${trialN}）· 下次扣费 ${renewsDay}`, `Pro through ${paidDay} (incl. ${trialN}), next charge ${renewsDay}`)
      : p.paid.canceled ? say(`已取消，${paidDay} 到期后不再续费`, `Canceled: ends on ${paidDay}, will not renew`) : say(`已付到 ${paidDay}`, `Paid through ${paidDay}`);
  const shown = p.displayName ? `${p.displayName}（${user.handle}）` : user.handle;
  const providers = p.providers.map((name) => name === "google" ? "Google" : name === "github" ? "GitHub" : name === "email" ? t.providerEmail : name === "dev" ? say("测试登录", "Test sign-in") : name).join(" · ") || say("未记录", "Not recorded");
  const usage = (label: string, used: number, limit: number | null, display: string, note = "") => `<div class="use"><span>${e(label)}</span>${limit == null ? "" : `<i class="pb"><b data-pct="${Math.min(100, Math.round(used / Math.max(1, limit) * 100))}"></b></i>`}<b>${e(display)}</b>${note ? `<small>${e(note)}</small>` : ""}</div>`;
  const roomUse = usage(say("活跃主题", "Active topics"), p.activeRooms, p.limits.activeRooms, `${p.activeRooms} / ${p.limits.activeRooms ?? say("不限", "unlimited")}`);
  const msgLimit = p.plan === "pro" ? p.limits.msgsPerAccountDay : p.limits.msgsPerRoomDay;
  const messageUse = p.messagesToday == null ? `<div class="use"><span>${e(say("今天", "Today"))}</span><b>${e(say("暂时无法获取用量", "Usage unavailable"))}</b></div>` :
    usage(say("今天", "Today"), p.messagesToday, msgLimit,
      `${p.messagesToday} / ${msgLimit ?? say("不限", "unlimited")}${lang === "zh" ? " 条" : ""}`,
      p.plan === "free" ? say("按主题计", "per topic") : say("现有主题合计", "retained topics"));
  const spaceUse = usage(say("文件空间", "File space"), p.space.used, p.space.limit, `${sizeText(p.space.used)} / ${sizeText(p.space.limit)}`);
  const pc = p.computers;
  const computerUse = pc ? usage(say("运行 agent 的电脑", "Computers running agents"), pc.n, pc.limit, `${pc.n} / ${pc.limit ?? say("不限", "unlimited")}`) : "";
  // under Devices: what a computer here is, and how many a plan has (the numbers from limits; none on a self-hosted server)
  const caps = pc && pc.free != null && pc.pro != null
    ? t.devicesCaps.replace(/\{free\}/g, String(pc.free)).replace("{pro}", String(pc.pro)).replace("{kept}", pc.free === 1 ? "only the most recently used one stays" : `only the ${pc.free} most recently used stay`)
    : say("网页登录不占名额。", "Signing in on the website doesn't count.");
  const devicesLead = `<p class="sec-lead">${e(t.devicesLead + (lang === "zh" ? "" : " ") + caps)}</p>`;
  const activeDevices = p.devices.filter((device) => !device.revoked_at);
  // What the computer's daemon detected: 「Claude Code 2.1.301 · Codex 未安装 · 检测于 1 小时前」; nothing for a daemon that never reported.
  const cliNames: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
  const agoText = (ms: number) => {
    const min = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    return min < 1 ? say("刚刚", "just now") : min < 60 ? say(`${min}\u00a0分钟前`, `${min}\u00a0min ago`) : min < 1440 ? say(`${Math.floor(min / 60)}\u00a0小时前`, `${Math.floor(min / 60)}\u00a0h ago`) : say(`${Math.floor(min / 1440)}\u00a0天前`, `${Math.floor(min / 1440)}\u00a0d ago`);
  };
  const detectedLine = (clis: NonNullable<(typeof p.devices)[number]["clis"]> | null | undefined) => {
    if (!clis?.length) return "";
    const found = clis.map((c) => c.installed ? `${cliNames[c.kind] || c.kind}${c.version ? ` ${c.version}` : ` (${say("版本未知", "version unknown")})`}` : `${cliNames[c.kind] || c.kind} ${say("未安装", "not installed")}`);
    const parts = clis.some((c) => c.installed) ? found : [say("未检测到支持的 agent", "No supported agent detected")];
    return [...parts, say(`检测于 ${agoText(Math.max(...clis.map((c) => c.at)))}`, `detected ${agoText(Math.max(...clis.map((c) => c.at)))}`)].join(" · ");
  };
  const deviceRows = activeDevices.map((device) => {
    const out = device.loggedOut;
    const status = out ? say("已掉线 · 等待重新授权", "Logged out · waiting for authorization") : device.online === true ? say("在线", "Online") : device.online === false ? say("离线", "Offline") : say("未知", "Unknown");
    const dot = out ? "offline" : device.online === true ? "online" : device.online === false ? "offline" : "unknown";
    const back = out?.code ? `<a class="btn xs" href="/activate?code=${encodeURIComponent(out.code)}">${e(say("重新上线", "Bring back online"))}</a>` : "";
    const idle = device.idleHandoffMinutes == null ? say("闲置交接由电脑端设置", "Idle handoff is set on the computer") : device.idleHandoffMinutes === 0 ? say("闲置交接已关闭", "Idle handoff is off") : say(`闲置 ${device.idleHandoffMinutes} 分钟后交接`, `Handoff after ${device.idleHandoffMinutes} idle minutes`);
    const label = `${device.name} (${device.hostname})${device.note ? ` · ${device.note}` : ""}`;
    return `<li class="row dev"><span class="sd ${dot}"></span><div class="w"><div class="l1"><b>${e(label)}</b><span class="st${device.online === true && !out ? " live" : ""}">${e(status)}</span></div><div class="l2">${e(idle)} · ${e(t.lastUsed)} ${device.last_used_at ? `<time data-ts="${device.last_used_at}"></time>` : e(t.never)}</div>${device.clis?.length ? `<div class="l2 clis">${e(detectedLine(device.clis))}</div>` : ""}<details class="device-rename"><summary>${e(say("改名", "Rename"))}</summary><form method="post" action="/devices/${e(device.id)}/name"><label>${e(say("名字", "Name"))}<input name="name" value="${e(device.name)}" maxlength="24" pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" autocapitalize="none" spellcheck="false"></label><small>${e(say("1–24 个字符：小写字母、数字、横线；用于席位名", "1–24 characters: lowercase letters, digits, hyphens; part of the seat name"))}</small><label>${e(say("备注", "Note"))}<input name="note" value="${e(device.note || "")}" maxlength="60"></label><button class="btn xs" type="submit">${e(say("保存", "Save"))}</button></form></details>${back}</div><form method="post" action="/devices/${e(device.id)}/revoke?next=settings" data-confirm-revoke><button type="submit" class="btn xs line">${e(say("撤销", "Revoke"))}</button></form></li>`;
  }).join("");
  const s = ROOM_STRINGS[lang];
  const permOptions = p.permOptions ?? DEFAULT_SPAWN.perm;
  const permRows = ["all", "ask", "auto"].flatMap((id) => {
    const option = permOptions.find((o) => o.id === id);
    if (!option) return [];
    const hint = e(option.about?.[lang] || "").replace(/--[a-z-]+(?: [a-z-]+)?/g, (flag) => `<code>${flag}</code>`);
    return [`<li class="row"><label class="spawn-perm-choice"><input type="radio" name="spawn-perm" value="${e(option.id)}"${option.id === (p.spawnPerm ?? "all") ? " checked" : ""}><span class="w"><b>${e(option.label[lang])}</b><small>${hint}</small></span><span class="perm-check" aria-hidden="true"></span></label></li>`];
  }).join("");
  const bootJson = JSON.stringify({ S: {
    settingsInviteWhy: s.settingsInviteWhy,
    settingsMutedEmpty: s.settingsMutedEmpty,
    settingsUnmute: s.settingsUnmute,
    settingsAccountOpen: s.settingsAccountOpen,
    settingsAccountClose: s.settingsAccountClose,
    settingsNameSaved: s.settingsNameSaved,
    setSpawnPermSaved: s.setSpawnPermSaved,
    setSpawnPermFailed: s.setSpawnPermFailed,
    revokeTitle: s.revokeTitle,
    revokeBody: s.revokeBody,
    revokeOk: s.revokeOk,
    cancel: s.cancel,
  } }).replace(/</g, "\\u003c");
  return layout(lang, {
    title: t.settings,
    user,
    bodyClass: "settingsview has-side",
    path: "/settings",
    head: `<script type="application/json" id="boot">${bootJson}</script><link rel="stylesheet" href="/static/room-tokens.css"><link rel="stylesheet" href="/static/room-status.css"><link rel="stylesheet" href="/static/room-ui.css"><link rel="stylesheet" href="/static/page-integration.css"><link rel="stylesheet" href="/static/trial-codes.css"><script src="/static/time.js" defer></script><script src="/static/push-preferences.js" defer></script><script src="/static/settings.js" defer></script>${SHELL_HEAD}`,
    body: `${shellSide(lang, {})}<div class="ui desk col settings"><header class="bar"><a class="back" href="/app" aria-label="${e(say("首页", "Home"))}">‹</a><div class="title"><b>${e(t.settings)}</b><span id="settings-subtitle">${e(shown)} · ${e(providers)}</span></div></header>
<div class="dcol"><main class="page"><div class="pagein two">
<section class="sec" id="notifications"><h2 class="hh">${e(say("通知", "Notifications"))}</h2>
<ul class="rows"><li class="row push-master"><button type="button" disabled aria-pressed="false"><span class="t">${e(say("这台设备的推送", "Push on this device"))}</span><span class="sp"></span><span class="sw dis" aria-hidden="true"></span></button></li><li class="row hint push-hint hidden"><small>${e(say("先开启推送，再选择以下选项", "Turn on notifications first to choose the options below"))}</small></li></ul>
<div id="push" class="pushcard hidden" data-account="${e(user.handle)}" data-s="${e(JSON.stringify(t.push))}"><span class="txt"></span><span class="btns"></span></div><div class="guide"><b>${e(say("先添加到主屏幕", "Add to Home Screen first"))}</b><ol><li>${e(say("在 Safari 中点「分享」", "In Safari, tap Share"))}</li><li>${e(say("选「添加到主屏幕」", "Choose Add to Home Screen"))}</li><li>${e(say("从主屏幕打开 Scorpio，再开启推送", "Open Scorpio from there, then turn on notifications"))}</li></ol></div>
<ul class="rows"><li class="row pref"><button type="button" data-push-pref="todoAssigned" disabled><span class="t">${e(say("挂到我名下的任务", "Assigned to me"))}</span><span class="sp"></span><span class="sw dis" aria-hidden="true"></span></button></li><li class="row pref"><button type="button" data-push-pref="quotaWarn" disabled><span class="t">${e(say("额度将满", "Quota nearly full"))}</span><span class="sp"></span><span class="sw dis" aria-hidden="true"></span></button></li><li class="row pref"><button type="button" data-push-pref="sound" disabled><span class="t">${e(say("提示音", "Notification sound"))}</span><span class="sp"></span><span class="sw dis" aria-hidden="true"></span></button></li><li class="row sound-note hidden"><small>${e(say("提示音在系统设置中控制", "Control notification sound in system settings"))}</small></li><li class="row pref"><button type="button" data-muted-rooms disabled><span class="t">${e(say("静音的主题", "Muted topics"))}</span><small>${e(say("按设备保存", "Saved per device"))}</small><span class="sp"></span><span class="v" id="muted-count">…</span><span class="chev">›</span></button></li></ul>
<p id="push-prefs-error" class="error hidden" role="status"></p><div id="muted-rooms" class="hidden" data-rooms="${e(JSON.stringify(p.visibleRooms))}"></div>
<ul class="rows"><li class="row name-row"><details class="name-setting" id="calendar-setting"><summary><span class="t">${e(say("日历订阅", "Calendar subscription"))}</span><span class="sp"></span><span class="chev">›</span></summary><div class="cal-link"><input id="calendar-url" readonly aria-label="${e(say("日历订阅地址", "Calendar subscription address"))}"><span class="cal-btns"><a class="btn sm" id="calendar-add" href="#" aria-disabled="true">${e(say("加到日历", "Add to calendar"))}</a><button type="button" class="btn sm" id="calendar-copy" data-copy-of="calendar-url" data-done="${e(say("已复制", "Copied"))}" disabled>${e(say("复制", "Copy"))}</button></span></div><small class="muted">${e(say("iPhone 和 Mac 点「加到日历」。Android 等其他日历：在手机日历里添加 CalDAV 帐号，填下面三项。Google 日历只能在电脑网页上加订阅地址，一天同步一两次，不响提醒。地址和密码泄露了就重置。", "On iPhone and Mac, tap Add to calendar. Android and other calendars: add a CalDAV account in your phone calendar with the three items below. Google Calendar adds the address only on the web, syncs once or twice a day and does not sound reminders. If the address or password leaks, reset."))}</small><b class="cal-sub">${e(say("CalDAV 帐号", "CalDAV account"))}</b>${(["server", "account", "password"] as const).map((k) => `<div class="cal-link cal-item"><label for="caldav-${k}">${e(say({ server: "服务器", account: "账号", password: "密码" }[k], { server: "Server", account: "Account", password: "Password" }[k]))}</label><input id="caldav-${k}" readonly><button type="button" class="btn sm" data-copy-of="caldav-${k}" data-done="${e(say("已复制", "Copied"))}" disabled>${e(say("复制", "Copy"))}</button></div>`).join("")}<div class="cal-reset"><button type="button" class="link" id="calendar-reset" data-done="${e(say("已重置，旧地址和旧密码已失效", "Reset; the old address and password no longer work"))}" disabled>${e(say("重置", "Reset"))}</button><small class="muted" id="calendar-result" role="status"></small></div></details></li></ul></section>
<section class="sec" id="spawn-perm"><h2 class="hh">${e(s.setSpawnPerm)}</h2><p class="sec-lead">${e(s.setSpawnPermHint)}</p><ul class="rows" role="radiogroup" aria-label="${e(s.setSpawnPerm)}">${permRows}</ul><p id="spawn-perm-result" class="sec-lead" role="status" aria-live="polite" hidden></p></section>
<section class="sec" id="appearance"><h2 class="hh">${e(say("外观", "Appearance"))}</h2><ul class="rows"><li class="row"><span class="t">${e(say("深浅色", "Theme"))}</span><span class="sp"></span><div class="seg sm" id="theme-switch"><button type="button" data-theme-choice="system">${e(say("跟随系统", "System"))}</button><button type="button" data-theme-choice="light">${e(say("浅色", "Light"))}</button><button type="button" data-theme-choice="dark">${e(say("深色", "Dark"))}</button></div></li>
<li class="row"><span class="t">${e(say("语言", "Language"))}</span><span class="sp"></span><form class="seg sm" id="lang-switch" method="get" action="/lang"><input type="hidden" name="next" value="/settings#appearance">${(["zh", "en"] as const).map((to) => `<button type="submit" name="to" value="${to}" lang="${to}"${to === lang ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${to === "zh" ? "中文" : "English"}</button>`).join("")}</form></li></ul></section>
<section class="sec" id="devices"><h2 class="hh">${e(t.devices)}</h2>${devicesLead}<ul class="rows">${deviceRows || `<li class="row"><small>${e(t.noDevices)}</small></li>`}</ul></section>
<section class="sec" id="account"><h2 class="hh">${e(say("账号与订阅", "Account and subscription"))}</h2>
<ul class="rows"><li class="row name-row"><details class="name-setting"><summary><span class="t">${e(say("昵称", "Display name"))}</span><span class="sp"></span><span class="v" id="name-current">${e(p.displayName || user.handle)}</span><span class="chev">›</span></summary><form id="name-form" data-account="${e(user.handle)}"><input id="display-name" name="displayName" value="${e(p.displayName || "")}" maxlength="256" placeholder="${e(user.handle)}"><button type="submit" class="btn sm">${e(say("保存", "Save"))}</button></form><small id="name-result" class="muted" role="status">${e(say("最多 20 个字；留空则显示账号名。", "Up to 20 characters; leave empty to show your account name."))}</small></details></li></ul>
<div class="plan"><div class="l1"><b>${e(planLabel)}</b><span class="sp"></span>${siteLinks() ? `<a class="btn sm" href="/pricing">${e(planAction)}</a>` : ""}</div>${paidNote ? `<p class="renew">${e(paidNote)}</p>` : ""}${cancelNote}${messageUse}${spaceUse}${roomUse}${computerUse}</div>
${p.invite ? inviteCard(lang, p.invite, usage) : ""}
${p.plan === "self" ? "" : `<ul class="rows"><li class="row name-row" id="trial-code"><details class="name-setting" id="trial-code-setting"><summary><span class="t">${e(say("有 Pro 体验码？", "Have a Pro trial code?"))}</span><span class="sp"></span><span class="chev">›</span></summary><form id="trial-code-form"><input id="trial-code-input" name="code" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="${e(say("Pro 体验码", "Pro trial code"))}"><button type="submit" class="btn sm">${e(say("确定", "OK"))}</button></form><small id="trial-code-result" class="muted" role="status">${e(say("兑换后立刻生效；已经在 Pro 里的，天数接在后面。", "Takes effect at once; if you are on Pro already, the days are added after it."))}</small></details></li></ul>`}
<ul class="rows"><li class="row pref handoff-pref"><button type="button" id="auto-call-back" aria-pressed="${p.autoCallBack !== false ? "true" : "false"}"><span class="t">${e(s.setAutoCallBack)}</span><span class="sp"></span><span class="sw${p.autoCallBack !== false ? " on" : ""}" aria-hidden="true"></span></button><small class="muted">${e(s.setAutoCallBackHint)}</small></li></ul>
<ul class="rows"><li class="row pref handoff-pref"><button type="button" id="handoff-local" aria-pressed="${p.handoffLocal ? "true" : "false"}"><span class="t">${e(say("交接只存在 agent 的电脑上", "Keep handoffs on agents' computers"))}</span><span class="sp"></span><span class="sw${p.handoffLocal ? " on" : ""}" aria-hidden="true"></span></button><small class="muted">${e(say("交接默认保存到 Scorpio，换一台电脑也能接班。开启后，新的交接只保留在写下它的那台电脑上。已保存到 Scorpio 的不会删除；要删除，到成员卡上的「交接」操作。", "Handoffs are saved to Scorpio by default, so an agent can be taken over on another computer. When this is on, new handoffs stay on the computer that wrote them. Handoffs already in Scorpio are kept; delete them from the member card."))}</small></li></ul>
<ul class="rows"><li class="row"><a class="t" href="/me/data">${e(say("我的数据", "My data"))}</a><small>${e(say("只包含你自己的", "Only your own"))}</small><span class="sp"></span><span class="chev">›</span></li></ul>
<ul class="rows"><li class="row"><span class="t">${e(say("登录方式", "Sign-in"))}</span><span class="sp"></span><span class="v">${e(providers)} · ${e(user.email)}</span></li><li class="row danger"><form method="post" action="/logout"><button type="submit" class="t">${e(say("退出登录", "Sign out"))}</button></form></li></ul>

</section>
<section class="sec" id="about"><h2 class="hh">${e(say("关于", "About"))}</h2><ul class="rows">
<li class="row"><span class="t">${e(say("版本", "Version"))}</span><span class="sp"></span><span class="v">${e(productVersion())}</span></li>
${siteLinks() ? `<li class="row"><a class="t" href="/changelog">${e(say("更新日志", "Changelog"))}</a><span class="sp"></span><span class="chev">›</span></li>
` : ""}</ul></section>
${footer(t)}
</div></main></div></div>`,
  });
}
