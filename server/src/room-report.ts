// RoomDO's exits to account storage, public snapshots, objects, notifications and ops.
import { ACTIVITY_INSERT_SQL } from "./ops-data";
import { alert, type AlertKind } from "./ops";
import { notifyPerson, type PushPayload } from "./push";
import { fileGone as recordFileGone } from "./space";
import { deleteRoomObjects as removeRoomObjects } from "./files";
import { limitsFor, planOfHandle } from "./plans";
import type { Snapshot } from "./snapshot-page";
import { setVisibilityRow } from "./room-index";

export function markActive(env: Env, roomId: string, nowMs: number) {
  return env.DB.prepare("UPDATE rooms SET active_at = MAX(COALESCE(active_at, 0), ?) WHERE id = ?").bind(nowMs, roomId).run();
}

export function markSender(env: Env, day: string, kind: string, account: string) {
  return env.DB.prepare(ACTIVITY_INSERT_SQL).bind(day, kind, account).run();
}

export async function addUsage(env: Env, day: string, delta: number, owner: string): Promise<number | null> {
  const r = await env.DB.prepare(
    `INSERT INTO usage_daily (user_id, day, msgs) SELECT id, ?, ? FROM users WHERE handle = ?
           ON CONFLICT (user_id, day) DO UPDATE SET msgs = msgs + excluded.msgs RETURNING msgs`,
  )
    .bind(day, delta, owner)
    .first<{ msgs: number }>();
  return r?.msgs ?? null;
}

export function alertOps(env: Env, kind: AlertKind, key: string, text: string, extra: Record<string, unknown>, deps = { alert }) {
  return deps.alert(env, kind, key, text, extra);
}

export function opsConfig(env: Env) {
  return env.KV.get<{ roomDbAlertBytes?: number }>("config:ops", { type: "json", cacheTtl: 300 }).catch(() => null);
}

export function notify(env: Env, to: string, payload: PushPayload, deps = { notifyPerson }) {
  return deps.notifyPerson(env, to, payload);
}

export function publicSnapshotDelete(env: Env, id: string) {
  return env.KV.delete(`public:${id}`);
}

export function publicSnapshotSize(env: Env) {
  return env.KV.get("config:public_snapshot", { cacheTtl: 300 });
}

export function publicSnapshotPut(env: Env, id: string, snap: unknown) {
  return env.KV.put(`public:${id}`, JSON.stringify(snap), { expirationTtl: 86400 });
}

export function repairPrivateSnapshotIndex(env: Env, id: string) {
  return setVisibilityRow(env, id, "private");
}

export function readPublicSnapshot(env: Env, roomId: string) {
  // 30 s is the least KV allows; authorization is checked separately against D1.
  return env.KV.get<Snapshot>(`public:${roomId}`, { type: "json", cacheTtl: 30 });
}

export function fileGone(env: Env, roomId: string, fileId: string, heirId: string | null, deps = { fileGone: recordFileGone }) {
  return deps.fileGone(env, roomId, fileId, heirId);
}

export async function deleteObject(env: Env, key: string) {
  if (env.FILES) await env.FILES.delete(key);
}

export function deleteRoomObjects(env: Env, roomId: string, deps = { deleteRoomObjects: removeRoomObjects }) {
  return deps.deleteRoomObjects(env, roomId);
}

export async function ownerPlan(env: Env, owner: string, deps = { planOfHandle, limitsFor }) {
  const plan = await deps.planOfHandle(env, owner);
  return { plan, limits: await deps.limitsFor(env, plan) };
}
