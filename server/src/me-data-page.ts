import { type User } from "./auth";
import { displayNameOf } from "./accounts";
import { dataShell } from "./app-page";
import type { Lang } from "./layout";
import { escapeHtml as e } from "./util";
import { chartY, integerTicks } from "./chart-scale";
import { DAY_MS, MY_FILES_SQL, ROOM_DATA_TIMEOUT_MS, mapSix, thirtyDays, within, type MyRoom, type RoomData, type RoomDay } from "./my-data";
import type { Actor, Result } from "./room-do";

const say = (lang: Lang, zh: string, en: string) => lang === "zh" ? zh : en;
const dayText = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const sizeText = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

function chart(days: RoomDay[], lang: Lang): string {
  const left = 48, right = 866, top = 22, bottom = 232, height = bottom - top;
  const max = Math.max(1, ...days.flatMap((d) => [d.human, d.agents]));
  const step = (right - left) / days.length;
  const bar = Math.min(9, step * 0.34);
  const bars = days.map((d, i) => {
    const x = left + i * step + step / 2;
    const humanY = chartY(d.human, max, bottom, height), agentY = chartY(d.agents, max, bottom, height);
    return `<rect class="human" x="${(x - bar - 1).toFixed(1)}" y="${humanY.toFixed(1)}" width="${bar.toFixed(1)}" height="${(bottom - humanY).toFixed(1)}"><title>${e(dayText(d.day))} · ${say(lang, "我", "Me")}: ${d.human}</title></rect>` +
      `<rect class="agents" x="${(x + 1).toFixed(1)}" y="${agentY.toFixed(1)}" width="${bar.toFixed(1)}" height="${(bottom - agentY).toFixed(1)}"><title>${e(dayText(d.day))} · ${say(lang, "我的 agent", "My agents")}: ${d.agents}</title></rect>`;
  }).join("");
  const ticks = [0, 6, 12, 18, 24, 29].map((i) => `<text class="tick date" x="${(left + i * step + step / 2).toFixed(1)}" y="264" text-anchor="middle">${e(dayText(days[i].day).slice(5))}</text>`).join("");
  const guide = integerTicks(max).map((value) => {
    const y = chartY(value, max, bottom, height).toFixed(1);
    return `<line class="guide" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text class="tick value" x="8" y="${(Number(y) + 4).toFixed(1)}">${value}</text>`;
  }).join("");
  const label = say(lang, "最近 30 天每日消息数：我和我的 agent", "Daily messages over the last 30 days: me and my agents");
  return `<svg viewBox="0 0 900 280" role="img" aria-label="${e(label)}">${guide}${bars}${ticks}</svg>`;
}

export async function meDataPage(env: Env, user: User, lang: Lang): Promise<Response> {
  const at = Date.now();
  const since = (Math.floor(at / DAY_MS) - 29) * DAY_MS;
  const [{ results: visible }, { results: files }, displayName] = await Promise.all([
    env.DB.prepare(
      `SELECT DISTINCT r.id, r.name, r.status FROM rooms r
       LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?1
       WHERE (r.owner_id = ?1 OR rm.active = 1) AND r.status IN ('active', 'archived')
       ORDER BY r.created_at DESC`,
    ).bind(user.id).all<{ id: string; name: string; status: string }>(),
    env.DB.prepare(MY_FILES_SQL).bind(user.id).all<{ room_id: string; bytes: number }>(),
    displayNameOf(env, user.id),
  ]);
  const fileBytes = new Map(files.map((row) => [row.room_id, row.bytes]));
  const actor: Actor = { kind: "human", account: user.handle, name: user.handle };
  const results = await mapSix(visible, async (room): Promise<MyRoom | null> => {
    let data = null;
    try {
      const call = (async (): Promise<Result<RoomData>> => env.ROOMS.getByName(room.id).myData(actor, since))();
      const response = await within(call, ROOM_DATA_TIMEOUT_MS);
      if ("err" in response && response.err.code === "not_member") return null;
      if ("ok" in response) data = response.ok;
    } catch { /* Keep this room visible with an explicit unavailable state. */ }
    return { id: room.id, name: room.name, archived: room.status === "archived", fileBytes: fileBytes.get(room.id) ?? 0, data };
  });
  const rooms = results.filter((r): r is MyRoom => r !== null);
  const days = thirtyDays(rooms.map((r) => r.data), at);
  const incomplete = rooms.some((r) => r.data === null);
  const rows = rooms.length ? rooms.map((room) => {
    const data = room.data;
    const last = data?.lastActive ?? null;
    return `<tr data-name="${e(room.name.toLocaleLowerCase())}" data-human="${data?.humanMessages ?? -1}" data-agents="${data?.agentMessages ?? -1}" data-files="${room.fileBytes}" data-active="${last ?? -1}">
      <td><a href="/r/${e(room.id)}">${e(room.name)}</a>${room.archived ? `<small class="archived">${say(lang, "已归档", "Archived")}</small>` : ""}${!data ? `<small class="unavailable">${say(lang, "暂时无法统计", "Not available yet")}</small>` : ""}</td>
      <td data-label="${say(lang, "我发的", "Mine")}">${data ? data.humanMessages : "—"}</td><td data-label="${say(lang, "agent 发的", "Agents")}">${data ? data.agentMessages : "—"}</td>
      <td data-label="${say(lang, "文件占用", "My files")}">${sizeText(room.fileBytes)}</td><td data-label="${say(lang, "最近活跃", "Last activity")}">${last == null ? "—" : `<time data-ts="${last}">${e(new Date(last).toISOString().slice(0, 10))}</time>`}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="empty">${say(lang, "还没有主题", "No topics yet")}</td></tr>`;
  const shown = displayName && displayName !== user.handle ? `${displayName}（${user.handle}）` : user.handle;
  return dataShell(lang, user, {
    title: `${say(lang, "我的数据", "My data")} · Scorpio`, path: "/me/data", shown,
    head: `<link rel="stylesheet" href="/static/me-data.css"><script src="/static/time.js" defer></script><script src="/static/me-data.js" defer></script>`,
    body: `<div class="me-data">
      <section class="data-chart"><h2>${say(lang, "最近 30 天的消息", "Messages in the last 30 days")}</h2>
        <div class="legend"><span class="human-key">${say(lang, "我发的", "Sent by me")}</span><span class="agent-key">${say(lang, "我的 agent 发的", "Sent by my agents")}</span></div>
        <div class="chart-scroll">${chart(days, lang)}</div><div class="chart-range" aria-hidden="true"><span>${dayText(days[0].day)}</span><span>${dayText(days[29].day)}</span></div>
        ${incomplete ? `<p class="partial">${say(lang, "部分主题暂时无法统计，图表暂不包含。", "Some topics are unavailable; the chart does not include them yet.")}</p>` : ""}</section>
      <section class="data-rooms"><h2>${say(lang, "我所在的主题", "My topics")}</h2><div class="table-scroll"><table id="me-data-table"><thead><tr>
        <th aria-sort="none"><button type="button" data-sort="name">${say(lang, "主题", "Topic")}</button></th>
        <th aria-sort="none"><button type="button" data-sort="human">${say(lang, "我发的", "Mine")}</button></th>
        <th aria-sort="none"><button type="button" data-sort="agents">${say(lang, "agent 发的", "Agents")}</button></th>
        <th aria-sort="none"><button type="button" data-sort="files">${say(lang, "文件占用", "My files")}</button></th>
        <th aria-sort="none"><button type="button" data-sort="active">${say(lang, "最近活跃", "Last activity")}</button></th>
      </tr></thead><tbody>${rows}</tbody></table></div></section></div>`,
  });
}
