// The person's calendar (docs/api/schedules.md, Into a calendar): from the schedules each topic returned, the runs ahead and
// their iCalendar text (RFC 5545), hand-written: the server has no runtime dependency. The feed (/cal/<token>.ics) and the
// CalDAV account (caldav.ts) are two outputs of this one builder, so they never drift. Pure: no env, no SQL.

import { nextScheduleAt, type Rule } from "./schedules";

/** One schedule as the topic object returns it for the feed (room/schedules.ts calendarItems): filtered, not expanded. */
export interface CalendarItem {
  id: string; // S3
  text: string;
  rule: Rule;
  by: string;
  updatedAt: number;
  nextAt: number | null;
}

export interface CalendarTopic {
  roomId: string;
  name: string;
  items: CalendarItem[];
}

const DAY = 86_400_000;
/** daily and weekly: the runs in the next 60 days; every: the next 24 hours; once: its moment, when still ahead. */
export const WINDOW_MS: Record<Rule["kind"], number> = { once: Infinity, daily: 60 * DAY, weekly: 60 * DAY, every: DAY };
export const MAX_RUNS_PER_SCHEDULE = 200;
export const MAX_EVENTS = 2_000;
export const EVENT_DURATION = "PT15M";
export const SUMMARY_MAX = 120;

/** The run times of a schedule from `now` on, within its rule's window, at most MAX_RUNS_PER_SCHEDULE. */
export function expandRuns(rule: Rule, nextAt: number | null, now: number): number[] {
  if (rule.kind === "once") return rule.at > now ? [rule.at] : [];
  const until = now + WINDOW_MS[rule.kind];
  const runs: number[] = [];
  // The stored next run when it is still ahead (an `every` beat is anchored on it), else the first run after now.
  let at = nextAt != null && nextAt > now ? nextAt : nextScheduleAt(rule, now, nextAt ?? undefined);
  while (at <= until && runs.length < MAX_RUNS_PER_SCHEDULE) {
    runs.push(at);
    at = nextScheduleAt(rule, at, at);
  }
  return runs;
}

/** A text value: backslash, semicolon and comma escaped, line breaks written as \n (RFC 5545 §3.3.11). */
export function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();
/** A content line folded at 75 octets (RFC 5545 §3.1): CRLF and one space start each continuation; multi-byte characters are never split. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      out.push(current);
      current = " ";
      bytes = 1;
      limit = 75;
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join("\r\n");
}

/** UTC time in the form 20261102T090000Z. */
export function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** The event's title: the text's first line without the @ names it starts with, cut to SUMMARY_MAX characters; the topic's name when nothing is left. */
export function summaryOf(text: string, topicName: string): string {
  const first = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  const stripped = first.replace(/^(?:@[A-Za-z0-9_.@-]+[\s,，、;；:：]*)+/, "").trim();
  const chars = [...stripped];
  const cut = chars.length > SUMMARY_MAX ? chars.slice(0, SUMMARY_MAX).join("").trimEnd() : stripped;
  return cut || topicName;
}

/** One run of one schedule, as both the feed and CalDAV put it out: `name` is the UID's part before `@` (the CalDAV resource name), `lines` the unfolded VEVENT lines. */
export interface CalendarEvent {
  name: string;
  uid: string;
  start: number;
  updatedAt: number;
  lines: string[];
}

/**
 * Every run of every item as a VEVENT. `origin` is the deployment's public origin (the topic links); `host` names the UIDs
 * (`<roomId>-<S>-<runMs>@<host>`), so a UID stays the same across fetches and an edit that keeps a run's time replaces its event in place.
 * `stamp` is every event's DTSTAMP (the feed: the fetch time); without it each event is stamped with its item's modification time,
 * so a CalDAV resource's body changes only when the event does.
 */
export function calendarEvents(topics: CalendarTopic[], p: { now: number; origin: string; host: string; stamp?: number }): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const topic of topics) {
    const link = `${p.origin}/r/${topic.roomId}`;
    for (const item of topic.items) {
      const summary = icsText(summaryOf(item.text, topic.name));
      const description = icsText(`${item.text}\n\n${topic.name}\n${link}\nSet by ${item.by}`);
      for (const at of expandRuns(item.rule, item.nextAt, p.now)) {
        if (out.length >= MAX_EVENTS) return out;
        const name = `${topic.roomId}-${item.id}-${at}`;
        out.push({
          name, uid: `${name}@${p.host}`, start: at, updatedAt: item.updatedAt,
          lines: [
            "BEGIN:VEVENT",
            `UID:${name}@${p.host}`,
            `DTSTAMP:${icsDate(p.stamp ?? item.updatedAt)}`,
            `LAST-MODIFIED:${icsDate(item.updatedAt)}`,
            `SEQUENCE:${Math.floor(item.updatedAt / 1000)}`,
            `DTSTART:${icsDate(at)}`,
            `DURATION:${EVENT_DURATION}`,
            `SUMMARY:${summary}`,
            `DESCRIPTION:${description}`,
            `URL:${link}`,
            "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0S", `DESCRIPTION:${summary}`, "END:VALARM",
            "END:VEVENT",
          ],
        });
      }
    }
  }
  return out;
}

const HEADER = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Scorpio//Calendar//EN", "CALSCALE:GREGORIAN"];

/** Content lines folded and joined with CRLF, as a calendar file is written. */
const icsFile = (lines: string[]): string => lines.map(foldLine).join("\r\n") + "\r\n";

/** The whole feed: every event, stamped with the fetch time, with the refresh hints calendar programs read from a subscription. */
export function calendarText(topics: CalendarTopic[], p: { now: number; origin: string; host: string }): string {
  const lines = [...HEADER, "METHOD:PUBLISH", "X-WR-CALNAME:Scorpio", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  for (const event of calendarEvents(topics, { ...p, stamp: p.now })) lines.push(...event.lines);
  lines.push("END:VCALENDAR");
  return icsFile(lines);
}

/** One CalDAV resource: a calendar around one event, without the subscription-only header lines. */
export function eventText(event: CalendarEvent): string {
  return icsFile([...HEADER, "X-WR-CALNAME:Scorpio", ...event.lines, "END:VCALENDAR"]);
}
