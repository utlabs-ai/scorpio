// Alerts for the people running the service: an account at its daily message cap, a room's
// database over 1 GB. One per kind and subject a day: a row in D1 alerts, a log line, and a push to the accounts
// in OPS_ACCOUNTS.

import { utcDay } from "./plans";
import { notifyPerson } from "./push";

export type AlertKind = "account_day" | "room_db" | "room_index" | "email_send_80" | "email_send_100" | "email_send_failed";

export async function alert(env: Env, kind: AlertKind, subject: string, text: string, detail: Record<string, unknown> = {}): Promise<void> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO alerts (kind, subject, day, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(kind, subject, utcDay().day, JSON.stringify({ text, ...detail }), Date.now())
    .run();
  if (!r.meta.changes) return;
  console.warn(JSON.stringify({ msg: "alert", kind, subject, text, ...detail }));
  for (const handle of ((env as { OPS_ACCOUNTS?: string }).OPS_ACCOUNTS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    await notifyPerson(env, handle, { type: "alert", tag: `alert:${kind}:${subject}`, url: "/", text }).catch((e) =>
      console.error(JSON.stringify({ msg: "alert push failed", error: String(e) })),
    );
  }
}
