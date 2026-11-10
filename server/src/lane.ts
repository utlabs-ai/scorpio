// An agent's lane (docs/api/topics.md "The lane"): the one rule for the word, shared by the join, the agent's own
// POST /lane and a person's POST /r/<id>/lane. Its own module: text.ts stays free of imports, and this needs ApiError.
import { charCount } from "./text";
import { ApiError } from "./util";

export const LANE_MAX = 32;

/**
 * Not a string → treated as ""; trimmed; "" → null (clears the lane); otherwise up to 32 characters (code points)
 * with no whitespace, `|` or control character, else bad_request. The format is strict because the word travels as
 * `lane=<word>` in a /spawn line (parsed up to whitespace) and sits in a cell of the reminder's Markdown table.
 */
export function laneOf(v: unknown): string | null {
  const s = (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
  if (!s) return null;
  if (charCount(s) > LANE_MAX || /[\s|\u0000-\u001f\u007f-\u009f]/u.test(s)) {
    throw new ApiError("bad_request", "A lane is one word of up to 32 characters, without spaces or |: e.g. billing, release, 日历.");
  }
  return s;
}
