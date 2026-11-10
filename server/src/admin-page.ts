// The ops page /admin: only the accounts in OPS_ACCOUNTS. Three tabs, each one chart, one table and
// one prompt for an agent to fetch the raw data (the shape for data pages; no summary line, no big-number cards):
// 用户 (signups, 7-day activity, Pro), 成本 (Cloudflare usage against Workers Paid), 收入 (Creem payments).

import { type User } from "./auth";
import { displayNameOf } from "./accounts";
import { dataShell } from "./app-page";
import type { Lang } from "./layout";
import { escapeHtml as e } from "./util";
import { PLAN_USD, billingPeriod, cloudflareUsage, estimate, type Estimate, type Fmt } from "./cf-usage";
import {
  ACCOUNTS_SQL, ACTIVITY_SQL, DAY_MS, DAEMON_VERSIONS_SQL, PAYMENTS_SQL, PRO_DAILY_SQL, RECENT_ROLLBACKS_SQL, activeSeries, creemFee, creemFeeOf, dayLabel, dayOf, lastDays, planLabel, proNow, proSeries, signupSeries,
  type AccountRow,
} from "./ops-data";
import { OPS_ALERTS_SQL, OPS_INVITERS_SQL, OPS_MACHINES_SQL, inviteConfig, monthStart } from "./invite";
import { batches } from "./trial-codes";
import { trialCodesSection } from "./trial-codes-page";
import { emailOps } from "./email-login";

export const isOps = (env: Env, handle: string) =>
  ((env as { OPS_ACCOUNTS?: string }).OPS_ACCOUNTS || "").split(",").map((s) => s.trim()).filter(Boolean).includes(handle);

// ---------- numbers ----------

const short = (x: number) => String(x >= 100 ? Math.round(x) : x >= 10 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100);
function count(n: number, lang: Lang): string {
  const a = Math.abs(n);
  if (lang === "zh") return a >= 1e8 ? `${short(n / 1e8)} 亿` : a >= 1e4 ? `${short(n / 1e4)} 万` : Math.round(n).toLocaleString("en-US");
  return a >= 1e9 ? `${short(n / 1e9)}B` : a >= 1e6 ? `${short(n / 1e6)}M` : a >= 1e4 ? `${short(n / 1e3)}K` : Math.round(n).toLocaleString("en-US");
}
const bytes = (b: number) => (b >= 1e9 ? `${short(b / 1e9)} GB` : b >= 1e6 ? `${short(b / 1e6)} MB` : b >= 1e3 ? `${short(b / 1e3)} KB` : `${Math.round(b)} B`);
function amount(fmt: Fmt, v: number, lang: Lang): string {
  if (fmt === "bytes") return bytes(v);
  if (fmt === "ms") return v >= 1000 ? `${count(v / 1000, lang)} ${lang === "zh" ? "秒" : "s"}` : `${short(v)} ms`;
  if (fmt === "gbs") return `${count(v, lang)} GB-s`;
  return count(v, lang);
}
function unitPrice(it: Estimate, lang: Lang): string {
  const per = lang === "zh" ? { M: "百万", GB: "GB-月" } : { M: "M", GB: "GB-month" };
  if (it.store) return `$${it.price}/${per.GB}`;
  return `$${it.price}/${per.M}${it.fmt === "ms" ? " ms" : it.fmt === "gbs" ? " GB-s" : ""}`;
}
const share = (p: number) => (p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${Math.round(p * 10) / 10}%` : p >= 0.1 ? `${Math.round(p * 100) / 100}%` : "<0.1%");
const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

// ---------- one chart: bars and a line on one scale, the line's latest value at its end ----------

function niceMax(v: number): number {
  if (v <= 0) return 1;
  if (v <= 5 && Number.isInteger(v)) return v;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function chart(p: { days: string[]; bars?: number[]; line?: (number | null)[]; mark?: number; markLabel?: string; fmt: (v: number) => string; label: string }): string {
  const W = 720, L = 70, R = 640, T = 30, B = 210, n = p.days.length, step = (R - L) / n;
  const x = (i: number) => L + step * (i + 0.5);
  const top = niceMax(Math.max(0, ...(p.bars || []), ...((p.line || []).filter((v) => v != null) as number[])));
  const y = (v: number) => B - (v / top) * (B - T);
  const ticks = top <= 5 && Number.isInteger(top) ? Array.from({ length: top + 1 }, (_, i) => i) : [0, top / 2, top];
  const grid = ticks.map((v) => `<line class="axis" x1="${L}" y1="${y(v).toFixed(1)}" x2="${R}" y2="${y(v).toFixed(1)}"/><text class="tick" x="${L - 8}" y="${(y(v) + 5).toFixed(1)}" text-anchor="end">${e(p.fmt(v))}</text>`).join("");
  const bw = Math.max(3, step * 0.62);
  const bars = (p.bars || []).map((v, i) => (v > 0 ? `<rect class="bar" x="${(x(i) - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(B - y(v)).toFixed(1)}"><title>${p.days[i]}: ${e(p.fmt(v))}</title></rect>` : "")).join("");
  let line = "";
  const pts = (p.line || []).map((v, i) => [i, v] as const).filter((q): q is readonly [number, number] => q[1] != null);
  if (pts.length) {
    const [li, lv] = pts[pts.length - 1];
    line = `<path class="ln" d="${pts.map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/><circle class="pt" cx="${x(li).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="5"/><text class="endv" x="${(x(li) + 10).toFixed(1)}" y="${(y(lv) + 5).toFixed(1)}">${e(p.fmt(lv))}</text>`;
  }
  let mark = "";
  if (p.mark != null && p.mark > 0) {
    const mx = (L + step * p.mark).toFixed(1);
    mark = `<line class="mark" x1="${mx}" y1="${T - 24}" x2="${mx}" y2="${B}"/><text class="marklabel" x="${(L + step * p.mark + 6).toFixed(1)}" y="${T - 12}">${e(p.markLabel || "")}</text>`;
  }
  const mid = Math.floor((n - 1) / 2);
  const dates = [...new Set([0, mid, n - 1])].map((i) => `<text class="tick" x="${x(i).toFixed(1)}" y="${B + 26}" text-anchor="middle">${p.days[i].slice(5)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} 250" role="img" aria-label="${e(p.label)}">${grid}${mark}${bars}${line}${dates}</svg>`;
}

const empty = (text: string) => `<div class="chart-empty">${text}</div>`;
const prompt = (lang: Lang, text: string, code: string) =>
  `<section class="ops-card ops-prompt"><button type="button" class="copy" data-copy>${lang === "zh" ? "复制" : "Copy"}</button><p>${text}</p><pre><code>${e(code)}</code></pre></section>`;
const th = (key: string, label: string, type: "text" | "num", sorted?: "ascending" | "descending") =>
  `<th aria-sort="${sorted || "none"}"><button type="button" data-sort="${key}" data-type="${type}">${e(label)}</button></th>`;

// ---------- the page ----------

export async function adminPage(env: Env, user: User, lang: Lang): Promise<Response> {
  const at = Date.now();
  const say = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const days = lastDays(30, at);
  const period = billingPeriod(at, Number((env as { CF_BILLING_DAY?: string }).CF_BILLING_DAY) || 1);
  const periodStart = Date.parse(`${period.start}T00:00:00Z`);
  const periodLabel = `${period.start.slice(5)} → ${dayOf(Date.parse(`${period.end}T00:00:00Z`) - DAY_MS).slice(5)}`;
  const [accounts, activity, snapshots, pending, payments, usage, creem, displayName, inviters, machines, alerts, invCfg, email, daemonVersions, rollbacks] = await Promise.all([
    env.DB.prepare(ACCOUNTS_SQL).all<AccountRow>(),
    env.DB.prepare(ACTIVITY_SQL).bind(dayOf(Date.parse(`${days[0]}T00:00:00Z`) - 6 * DAY_MS)).all<{ user_id: string; day: string; kind: string }>(),
    env.DB.prepare(PRO_DAILY_SQL).all<{ day: string; paid: number; trial: number; comp: number; invite: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE activity_backfilled_at IS NULL AND status IN ('active', 'archived')").first<{ n: number }>(),
    env.DB.prepare(PAYMENTS_SQL).bind(periodStart).all<{ id: string; created_at: number; handle: string | null; kind: string; product: string | null; amount: number; currency: string }>(),
    cloudflareUsage(env, at),
    env.KV.get<{ monthly?: string; yearly?: string; fee?: { percent?: number; fixedCents?: number } }>("config:creem", { type: "json", cacheTtl: 60 }).catch(() => null),
    displayNameOf(env, user.id),
    env.DB.prepare(OPS_INVITERS_SQL).bind(monthStart(at)).all<{ handle: string; month: number; balance: number }>(),
    env.DB.prepare(OPS_MACHINES_SQL).all<{ h: string; n: number }>(),
    env.DB.prepare(OPS_ALERTS_SQL).bind(at - 14 * DAY_MS).all<{ kind: string; subject: string; day: string; detail: string | null }>(),
    inviteConfig(env),
    emailOps(env),
    env.DB.prepare(DAEMON_VERSIONS_SQL).bind(at - 7 * DAY_MS).all<{ version: string; computers: number }>(),
    env.DB.prepare(RECENT_ROLLBACKS_SQL).bind(at - 7 * DAY_MS).all<{ handle: string; computer: string; bad_version: string; rollback_at: number }>(),
  ]);
  const trialBatches = await batches(env);
  const rows = accounts.results;

  // ----- 用户 -----
  const signups = signupSeries(rows, days);
  const active = activeSeries(activity.results, days);
  const pro = proNow(rows, at);
  const proDays = proSeries(snapshots.results, days, pro);
  const n = (v: number) => count(v, lang);
  const fillingNote = pending?.n ? `<p class="ops-cap">${say(`还有 ${pending.n} 个房在补最近 30 天的发言记录，每 10 分钟补一批。`, `${pending.n} rooms are still filling in the last 30 days of senders, a batch every 10 minutes.`)}</p>` : "";
  const accountRows = rows
    .map((r) => {
      const plan = planLabel(r, lang, at);
      return `<tr data-handle="${e(r.handle)}" data-created="${r.created_at}" data-plan="${plan.sort}" data-human="${e(r.last_human || "")}" data-agent="${e(r.last_agent || "")}"><td data-label="${say("账号", "Handle")}">${e(r.handle)}</td><td data-label="${say("注册", "Registered")}">${dayOf(r.created_at)}</td><td data-label="${say("套餐", "Plan")}">${e(plan.label)}</td><td data-label="${say("本人最近发言", "Last said (self)")}">${dayLabel(r.last_human, at, lang)}</td><td data-label="${say("agent 最近发言", "Last said (agents)")}">${dayLabel(r.last_agent, at, lang)}</td></tr>`;
    })
    .join("");
  const usersTab = `<section class="ops-card">
<div class="ops-seg" data-views="users">
  <button type="button" class="on" data-view="signups">${say("注册", "Signups")}</button><button type="button" data-view="active">${say("7 天活跃", "Active, 7 days")}</button><button type="button" data-view="pro">Pro</button>
</div>
<div data-view-of="users" data-name="signups">
  <div class="legend"><span class="bar-key">${say("每天新注册", "Signups a day")}</span><span class="line-key">${say("累计真人", "Real accounts")} <b>${signups.total[signups.total.length - 1]}</b></span></div>
  ${chart({ days, bars: signups.daily, line: signups.total, fmt: n, label: say("每天新注册与累计真人", "Signups a day and real accounts") })}
</div>
<div data-view-of="users" data-name="active" hidden>
  <div class="legend"><span class="line-key">${say("7 天里亲自发过消息的人", "People who sent a message in 7 days")} <b>${active.human[active.human.length - 1]}</b></span><span class="bar-key">${say("7 天里 agent 发过消息的账号", "Accounts whose agents did")} <b>${active.agent[active.agent.length - 1]}</b></span></div>
  ${active.human.some((v) => v > 0) || active.agent.some((v) => v > 0) ? chart({ days, bars: active.agent, line: active.human, fmt: n, label: say("7 天活跃", "Active in 7 days") }) : empty(say("这 30 天还没有发言记录。", "No one has said anything in these 30 days."))}
  ${fillingNote}
</div>
<div data-view-of="users" data-name="pro" hidden>
  <div class="legend"><span class="bar-key">${say("Pro 账号（含试用、赠送）", "Pro accounts (trials and comps too)")} <b>${pro.paid + pro.trial + pro.comp + pro.invite}</b></span><span class="line-key">${say("付费", "Paid")} <b>${pro.paid}</b></span></div>
  ${chart({ days, bars: proDays.total, line: proDays.paid, fmt: n, label: say("Pro 账号与付费", "Pro accounts and paid") })}
  <p class="ops-cap">${say("现在", "Now")}: ${say("付费", "paid")} <b>${pro.paid}</b> · ${say("试用", "trial")} <b>${pro.trial}</b> · ${say("赠送", "comp")} <b>${pro.comp}</b> · ${say("邀请", "invite")} <b>${pro.invite}</b></p>
</div>
</section>
<section class="ops-card"><h2>${say("真人账号", "Real accounts")}</h2><div class="table-scroll"><table data-sortable>
<thead><tr>${th("handle", say("账号", "Handle"), "text")}${th("created", say("注册", "Registered"), "num", "ascending")}${th("plan", say("套餐", "Plan"), "num")}${th("human", say("本人最近发言", "Last said (self)"), "text")}${th("agent", say("agent 最近发言", "Last said (agents)"), "text")}</tr></thead>
<tbody>${accountRows}</tbody></table></div></section>
<section class="ops-card"><h2>${say("邀请", "Invites")}</h2>${inviters.results.length ? `<div class="table-scroll"><table>
<thead><tr><th>${say("邀请人", "Inviter")}</th><th>${say("本月名额", "Used this month")}</th><th>${say("余额（天）", "Balance (days)")}</th></tr></thead>
<tbody>${inviters.results.map((r) => `<tr><td>${e(r.handle)}</td><td>${r.month} / ${invCfg.monthCap}</td><td>${r.balance}</td></tr>`).join("")}</tbody></table></div>` : empty(say("还没有人凭邀请注册。", "Nobody has signed up with an invite yet."))}
${machines.results.length ? `<p class="ops-cap">${say("一台电脑上有几个账号（2 个及以上）", "Computers with more than one account")}: ${machines.results.map((m) => `${e(m.h)}… <b>${m.n}</b>`).join(" · ")}</p>` : ""}</section>
${trialCodesSection(lang, trialBatches)}
<section class="ops-card"><h2>${say("最近提醒（14 天）", "Recent alerts (14 days)")}</h2>${alerts.results.length ? `<div class="table-scroll"><table>
<thead><tr><th>${say("日子", "Day")}</th><th>${say("类别", "Kind")}</th><th>${say("对象", "Subject")}</th><th>${say("说明", "Detail")}</th></tr></thead>
<tbody>${alerts.results.map((a) => { let text = ""; try { text = (JSON.parse(a.detail || "{}") as { text?: string }).text || ""; } catch {} return `<tr><td>${e(a.day)}</td><td>${e(a.kind)}</td><td>${e(a.subject)}</td><td>${e(text)}</td></tr>`; }).join("")}</tbody></table></div>` : empty(say("这 14 天没有提醒。", "No alerts in 14 days."))}</section>
<section class="ops-card"><h2>${say("邮箱验证码 · 今日 UTC", "Email codes · today UTC")}</h2><p class="ops-cap">${say("已接受发送", "Accepted sends")} <b>${email.accepted}</b> / ${email.cap} · ${say("同步失败", "Synchronous failures")} <b>${email.failed}</b></p></section>
<section class="ops-card"><h2>${say("最近 7 天报告过的版本", "Versions reported in the last 7 days")}</h2>${daemonVersions.results.length ? `<div class="table-scroll"><table><thead><tr><th>${say("版本", "Version")}</th><th>${say("电脑数", "Computers")}</th></tr></thead><tbody>${daemonVersions.results.map((r) => `<tr><td>${e(r.version)}</td><td>${r.computers}</td></tr>`).join("")}</tbody></table></div>` : empty(say("最近 7 天没有版本报告。", "No version reports in the last 7 days."))}</section>
<section class="ops-card"><h2>${say("最近 7 天被退回过的电脑", "Computers rolled back in the last 7 days")}</h2>${rollbacks.results.length ? `<div class="table-scroll"><table><thead><tr><th>${say("账号", "Account")}</th><th>${say("电脑", "Computer")}</th><th>${say("失败版本", "Failed version")}</th><th>${say("时间 UTC", "Time UTC")}</th></tr></thead><tbody>${rollbacks.results.map((r) => `<tr><td>${e(r.handle)}</td><td>${e(r.computer)}</td><td>${e(r.bad_version)}</td><td>${e(new Date(r.rollback_at).toISOString())}</td></tr>`).join("")}</tbody></table></div>` : empty(say("最近 7 天没有退回记录。", "No rollback reports in the last 7 days."))}</section>
${prompt(lang, say("让 agent 在 Scorpio 的 D1 只读执行下面的 SQL，取每个真人账号的注册日期、套餐和最近发言的日子，复核上面的图和表（7 天活跃 = activity_daily 里最近 7 天有记录的账号）。", "Ask an agent to run this read-only SQL in Scorpio's D1 for each real account's signup date, plan and last days it spoke, to check the chart and table (active in 7 days = accounts with a row in activity_daily in the last 7 days)."), `${ACCOUNTS_SQL};`)}`;

  // ----- 成本 -----
  let costTab: string;
  let cloudflareTotal: number | null = null;
  if ("err" in usage) {
    costTab = `<section class="ops-card">${empty(
      usage.err === "no_token"
        ? say("还没接 Cloudflare：要一个只读令牌（只勾 Account Analytics: Read），填进 Worker 的密钥 CF_ANALYTICS_TOKEN，这页就有数。", "Not connected to Cloudflare yet: a token with Account Analytics: Read only, in the Worker secret CF_ANALYTICS_TOKEN.")
        : `${say("Cloudflare 这次没回，过几分钟再刷新。", "Cloudflare did not answer; reload in a few minutes.")}<br><small>${e(usage.detail || "")}</small>`,
    )}</section>`;
  } else {
    const u = usage.ok;
    const est = estimate(u.series, u.days, period);
    cloudflareTotal = est.total;
    const mark = u.days.indexOf(period.start);
    const views = est.items
      .map((it, i) => {
        const fmt = (v: number) => amount(it.fmt, v, lang);
        let line: (number | null)[] | undefined;
        if (!it.store) {
          let sum = 0;
          line = it.daily.map((v, d) => (u.days[d] >= period.start ? (sum += v) : null));
        }
        return `<div data-view-of="cost" data-name="${it.key}"${i ? " hidden" : ""}>
  <div class="legend"><span class="bar-key">${it.store ? say("每天存量", "Stored each day") : say("每天用量", "Used each day")}</span>${it.store ? "" : `<span class="line-key">${say("本计费周期累计", "This billing period")}</span>`}</div>
  ${chart({ days: u.days, bars: it.daily, line, mark, markLabel: say("本周期 →", "period →"), fmt, label: lang === "zh" ? it.zh : it.en })}
  <p class="ops-cap">${say("本周期已用", "Used so far")} <b>${fmt(it.used)}</b> · ${say("月底预计", "By period end")} <b>${fmt(it.projected)}</b> · ${say("含额度", "Included")} ${fmt(it.included)}（<b>${share(it.share)}</b>）</p>
</div>`;
      })
      .join("");
    const chips = est.items.map((it, i) => `<button type="button" data-view="${it.key}"${i ? "" : ' class="on"'}>${e(lang === "zh" ? it.zh : it.en)}<b>${share(it.share)}</b></button>`).join("");
    const row = (it: Estimate) => {
      const fmt = (v: number) => amount(it.fmt, v, lang);
      return `<tr data-share="${it.share}" data-cost="${it.cost}" data-name="${e(lang === "zh" ? it.zh : it.en)}"><td data-label="${say("计费项", "Item")}">${e(lang === "zh" ? it.zh : it.en)} <span class="muted">${share(it.share)}</span></td><td data-label="${say("本周期已用", "Used so far")}">${fmt(it.used)}</td><td data-label="${say("月底预计", "By period end")}">${fmt(it.projected)}</td><td data-label="${say("含额度", "Included")}">${fmt(it.included)}</td><td data-label="${say("超出单价", "Beyond, per unit")}">${unitPrice(it, lang)}</td><td data-label="${say("预计费用", "Cost")}">$${it.cost.toFixed(2)}</td></tr>`;
    };
    const head = `<thead><tr>${th("name", say("计费项", "Item"), "text")}<th>${say("本周期已用", "Used so far")}</th><th>${say("月底预计", "By period end")}</th><th>${say("含额度", "Included")}</th><th>${say("超出单价", "Beyond, per unit")}</th>${th("cost", say("预计费用", "Cost"), "num")}</tr></thead>`;
    const big = est.items.filter((it) => it.share >= 1), small = est.items.filter((it) => it.share < 1);
    costTab = `<section class="ops-card"><div class="ops-chips" data-views="cost">${chips}</div>${views}</section>
<section class="ops-card"><h2>${say("本计费周期", "This billing period")} · ${periodLabel}</h2>
<div class="table-scroll"><table data-sortable>${head}<tbody>${big.map(row).join("")}</tbody></table></div>
${small.length ? `<details class="ops-more"><summary>${say(`其余 ${small.length} 项都用不到含额度的 1%`, `${small.length} more under 1% of what is included`)}</summary><div class="table-scroll"><table>${head.replace(/<button[^>]*>|<\/button>/g, "")}<tbody>${small.map(row).join("")}</tbody></table></div></details>` : ""}
<dl class="ops-sum"><div><dt>${say("Workers Paid 月费", "Workers Paid, a month")}</dt><dd>$${PLAN_USD.toFixed(2)}</dd></div><div><dt>${say("超出含额度的部分", "Beyond what is included")}</dt><dd>$${(est.total - PLAN_USD).toFixed(2)}</dd></div><div class="total"><dt>${say("本周期预计", "This period, estimated")}</dt><dd>$${est.total.toFixed(2)}</dd></div></dl>
<p class="ops-src">${say("整个 Cloudflare 账号的用量（含同一账号下的其他服务）。月底预计 = 已用 + 近 7 个整天的日均 × 剩下的天数；存储按整个周期的平均。单价出自 Cloudflare 官方定价页（2026-10-02 更新）：", "The whole Cloudflare account, other services on it included. By period end = used so far + the last 7 whole days' average for each day left; storage as the period's average. Prices from Cloudflare's pricing pages (updated 2026-10-02): ")}<a href="https://developers.cloudflare.com/workers/platform/pricing/">Workers · KV · D1 · Durable Objects</a> · <a href="https://developers.cloudflare.com/r2/pricing/">R2</a>${say("。不含税。", ". Before tax.")}</p></section>
${prompt(lang, say(`让 agent 用 Cloudflare GraphQL 分析接口（Account Analytics 只读令牌）取 ${period.start} 起每天的用量，按页里的单价复核这张表。`, `Ask an agent to fetch each day's usage since ${period.start} from Cloudflare's GraphQL Analytics API (an Account Analytics: Read token) and check this table at the prices on this page.`), costPromptCode(period.start))}`;
  }

  // ----- 收入 -----
  const product = (id: string | null) => (id && id === creem?.monthly ? say("月付", "Monthly") : id && id === creem?.yearly ? say("年付", "Yearly") : id || "—");
  const pays = payments.results;
  const fee = creemFeeOf(creem); // config:creem.fee, or 3.9% + 40¢
  const net = (p: { amount: number; kind: string }) => p.amount - (p.kind === "paid" ? creemFee(p.amount, fee) : 0);
  // The whole billing period along the bottom: the days still to come are empty, the line stops at today.
  const revDays = Array.from({ length: period.days }, (_, i) => dayOf(periodStart + i * DAY_MS));
  const today = dayOf(at);
  const revDaily = revDays.map((d) => pays.filter((p) => dayOf(p.created_at) === d).reduce((s, p) => s + net(p), 0) / 100);
  let revSum = 0;
  const revLine = revDaily.map((v, i) => (revDays[i] <= today ? (revSum += v) : null));
  const gross = pays.reduce((s, p) => s + p.amount, 0);
  const fees = pays.reduce((s, p) => s + (p.kind === "paid" ? creemFee(p.amount, fee) : 0), 0);
  const payRows = pays
    .map((p) => `<tr><td data-label="${say("时间", "When")}">${new Date(p.created_at).toISOString().slice(5, 16).replace("T", " ")}</td><td data-label="${say("账号", "Account")}">${e(p.handle || "—")}</td><td data-label="${say("产品", "Product")}">${e(p.kind === "refund" ? say("退款", "Refund") : product(p.product))}</td><td data-label="${say("金额", "Amount")}">${usd(p.amount)}${p.currency !== "USD" ? ` ${e(p.currency)}` : ""}</td><td data-label="${say("手续费", "Fee")}">${usd(p.kind === "paid" ? -creemFee(p.amount, fee) : 0)}</td><td data-label="${say("到手", "Net")}">${usd(net(p))}</td></tr>`)
    .join("");
  const revTab = `<section class="ops-card">
  <div class="legend"><span class="bar-key">${say("每天到手", "Net a day")}</span><span class="line-key">${say("本周期累计", "This period")}</span></div>
  ${pays.length ? chart({ days: revDays, bars: revDaily, line: revLine, fmt: (v) => `$${short(v)}`, label: say("每天到手与本周期累计", "Net a day and this period") }) : empty(say("这个计费周期还没有正式收款。", "No live payments in this billing period yet."))}
</section>
<section class="ops-card"><h2>${say("Creem 收款", "Creem payments")} · ${periodLabel}</h2>
${pays.length ? `<div class="table-scroll"><table><thead><tr><th>${say("时间", "When")}</th><th>${say("账号", "Account")}</th><th>${say("产品", "Product")}</th><th>${say("金额", "Amount")}</th><th>${say("手续费", "Fee")}</th><th>${say("到手", "Net")}</th></tr></thead><tbody>${payRows}</tbody></table></div>` : `<p class="muted">${say("还没有。", "None yet.")}</p>`}
<dl class="ops-sum"><div><dt>${say("收款合计", "Paid in")}</dt><dd>${usd(gross)}</dd></div><div><dt>${say(`Creem 手续费（每笔 ${fee.percent}% + $${(fee.fixedCents / 100).toFixed(2)}，估）`, `Creem fees (${fee.percent}% + $${(fee.fixedCents / 100).toFixed(2)} each, estimated)`)}</dt><dd>${usd(-fees)}</dd></div>${cloudflareTotal != null ? `<div><dt>${say("减 Cloudflare 本周期预计", "Less Cloudflare, this period")}</dt><dd>${usd(-Math.round(cloudflareTotal * 100))}</dd></div><div class="total"><dt>${say("本周期净额", "This period, net")}</dt><dd>${usd(gross - fees - Math.round(cloudflareTotal * 100))}</dd></div>` : ""}</dl>
<p class="ops-src">${say("金额是产品标价（美分记账），不含 Creem 测试模式和测试号。手续费出自", "Amounts are product prices; test-mode payments and test accounts are left out. Fees from")} <a href="https://www.creem.io/pricing">creem.io/pricing</a>${say("。", ".")}</p></section>
${prompt(lang, say("让 agent 在 Scorpio 的 D1 只读执行下面的 SQL，取本计费周期每一笔 Creem 正式收款，复核上面的图和表。", "Ask an agent to run this read-only SQL in Scorpio's D1 for each live Creem payment this billing period, to check the chart and table."), `${PAYMENTS_SQL.replace("?", String(periodStart))};`)}`;

  const shown = displayName && displayName !== user.handle ? `${displayName}（${user.handle}）` : user.handle;
  return dataShell(lang, user, {
    title: `${say("运营", "Operations")} · Scorpio`,
    shown,
    path: "/admin",
    head: `<link rel="stylesheet" href="/static/admin.css"><link rel="stylesheet" href="/static/trial-codes.css"><script src="/static/admin.js" defer></script>`,
    body: `<div class="ops">
<nav class="ops-tabs" role="tablist"><a href="#users" data-tab="users" class="on" role="tab">${say("用户", "Users")}</a><a href="#cost" data-tab="cost" role="tab">${say("成本", "Cost")}</a><a href="#revenue" data-tab="revenue" role="tab">${say("收入", "Revenue")}</a></nav>
<div data-panel="users">${usersTab}</div>
<div data-panel="cost">${costTab}</div>
<div data-panel="revenue">${revTab}</div>
<p class="ops-src"><a href="/admin/accounts/delete">${say("注销一个账号 ›", "Delete an account ›")}</a></p>
</div>`,
  });
}

function costPromptCode(start: string): string {
  return `POST https://api.cloudflare.com/client/v4/graphql
accountTag = the Scorpio Cloudflare account; ${start}T00:00:00Z until now, by date:
- workersInvocationsAdaptive: sum.requests, sum.cpuTimeUs
- durableObjectsInvocationsAdaptiveGroups: sum.requests by type (hibernation = incoming WebSocket messages, 20 count as 1)
- durableObjectsPeriodicGroups: sum.duration (GB-s), rowsRead, rowsWritten
- durableObjectsSqlStorageGroups: max.storedBytes
- d1AnalyticsAdaptiveGroups: sum.rowsRead, rowsWritten
- d1StorageAdaptiveGroups: max.databaseSizeBytes
- r2OperationsAdaptiveGroups: sum.requests by actionType (class A / B)
- r2StorageAdaptiveGroups: max.payloadSize + metadataSize, all buckets
- kvOperationsAdaptiveGroups: sum.requests by actionType
- kvStorageAdaptiveGroups: max.byteCount
Prices: https://developers.cloudflare.com/workers/platform/pricing/
        https://developers.cloudflare.com/r2/pricing/`;
}
