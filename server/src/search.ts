import { ApiError } from "./util";
export { likeTerms, trigramCandidate } from "./search-match";

export type SearchGroup = "messages" | "todo" | "files" | "memo";
export type SearchFilters = {
  by?: string[]; kind?: string[]; at?: string[]; peopleAt?: string[]; seatsAt?: string[];
  replyTo?: number; has?: "files"; task?: number; status?: string[]; to?: string[];
  since?: number; until?: number; from?: number; before?: number; order?: "asc" | "desc";
};
export type SearchQuery = SearchFilters & { q: string; terms: string[]; in?: SearchGroup; limit: number; groups?: SearchGroup[] };
export type SearchHit = {
  type: "message" | "todo" | "file" | "memo";
  id: string; // #seq for messages/files, Tn for TODO
  seq: number | null; // the message to jump to (source message for an item, containing message for a file)
  who: string;
  displayName?: string | null; // human nickname; who remains the account or agent name
  ts: number;
  snippet: string;
  title?: string;
  status?: string;
  assignee?: string | null;
  fileId?: string;
  size?: number;
};
export type SearchResults = {
  roomId: string;
  q: string;
  groups: Record<SearchGroup, SearchHit[]>;
  hasMore: Record<SearchGroup, boolean>;
};
/** One group's answer, as each domain's search function gives it to the composer (room/search.ts). */
export type SearchPage = { hits: SearchHit[]; hasMore: boolean };

type FilterInput = Record<string, string | number | null | undefined>;
const MESSAGE_FILTERS = ["kind", "at", "replyTo", "has", "task"];
const TASK_FILTERS = ["status", "to"];
export function filterList(value: unknown, key: string, allowed?: string[]): string[] | undefined {
  if (value == null) return undefined;
  const values = String(value).split(",").map(v => v.trim());
  if (!values.length || values.length > 20 || values.some(v => !v || (allowed && !allowed.includes(v)))) {
    throw new ApiError("bad_request", `${key}= takes ${allowed?.join(", ") ?? "topic member names or me"} (at most 20 values).`);
  }
  return [...new Set(values)];
}
export function filterNumber(value: unknown, key: string, minimum = 0): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (String(value).trim() === "" || !Number.isSafeInteger(n) || n < minimum) throw new ApiError("bad_request", `${key}= must be a whole number >= ${minimum}.`);
  return n;
}
export function searchFilters(input: FilterInput, scope: "search" | "messages" | "files" | "mentions" = "search"): SearchFilters {
  const p: SearchFilters = {};
  for (const key of ["by", "at", "to"] as const) p[key] = filterList(input[key], key);
  p.kind = filterList(input.kind, "kind", ["human", "agent", "host", "system", "scheduled"]);
  p.status = filterList(input.status, "status", ["todo", "doing", "done"]);
  for (const key of ["since", "until", "from", "before", "replyTo"] as const) p[key] = filterNumber(input[key], key, ["from", "before", "replyTo"].includes(key) ? 1 : 0);
  if (input.task != null) p.task = filterNumber(String(input.task).replace(/^T/, ""), "task", 1);
  if (input.has != null) {
    if (input.has !== "files") throw new ApiError("bad_request", "has= is files.");
    p.has = "files";
  }
  if (input.order != null) {
    if (input.order !== "asc" && input.order !== "desc") throw new ApiError("bad_request", "order= is desc or asc.");
    p.order = input.order;
  }
  const keys = scope === "messages" ? TASK_FILTERS : scope === "files" ? [...MESSAGE_FILTERS, ...TASK_FILTERS, "order", "from"] : scope === "mentions" ? ["by", "at", "replyTo", "has", "task", ...TASK_FILTERS, "since", "until", "order", "from"] : [];
  for (const key of keys) if (input[key] != null) throw new ApiError("bad_request", `${key}= does not apply to ${scope}.`);
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
}
export function resolveFilters<T extends SearchFilters>(p: T, caller: string, get: (name: string) => { kind?: unknown } | undefined): T {
  const out = { ...p };
  for (const key of ["by", "at", "to"] as const) if (p[key]) {
    out[key] = p[key]!.map(value => {
      const name = value === "me" ? caller : value;
      if (value !== "me" && !get(name)) throw new ApiError("bad_request", `${key}= requires topic members; scorpio members q=${name} finds a name.`);
      return name;
    });
  }
  if (out.at) {
    out.peopleAt = out.at.filter(n => get(n)?.kind === "human" || (n === caller && !n.includes("@")));
    out.seatsAt = out.at.filter(n => !out.peopleAt!.includes(n));
  }
  return out;
}
/** One Han character or two other visible characters start a search; filters also work without text. */
export function searchQuery(input: FilterInput): SearchQuery {
  const filters = searchFilters(input);
  const q = String(input.q ?? "").trim().replace(/\s+/gu, " ");
  const letters = Array.from(q.replace(/\s/gu, ""));
  if ((!q && !Object.keys(filters).length && !input.in) || (q && !/\p{Script=Han}/u.test(q) && letters.length < 2)) throw new ApiError("bad_request", "Search q= needs at least one Chinese character or two other characters, or give a filter or in=.");
  if (q.length > 200) throw new ApiError("bad_request", "Search q= is at most 200 characters.");
  if (input.in && !["messages", "todo", "files", "memo"].includes(String(input.in))) throw new ApiError("bad_request", "in= is messages, todo, files or memo.");
  const limit = input.limit == null || input.limit === "" ? 20 : filterNumber(input.limit, "limit", 1)!;
  const groups = (["messages", "todo", "files", "memo"] as SearchGroup[]).filter(g =>
    !MESSAGE_FILTERS.some(k => input[k] != null && g !== "messages") && !TASK_FILTERS.some(k => input[k] != null && g !== "todo") && !(g === "memo" && (input.before != null || input.from != null)));
  if (!groups.length || (input.in && !groups.includes(input.in as SearchGroup))) throw new ApiError("bad_request", "in= does not support the given filters; message filters apply to messages, status/to to todo.");
  return { q, terms: q ? q.split(" ") : [], in: (input.in || undefined) as SearchGroup | undefined, limit: Math.min(limit, input.in === "memo" ? 60 : 20), ...filters, groups };
}

/** SQL conditions shared by full messages and snippets; callers supply only their own columns. */
export function filterSql(p: SearchFilters, group: SearchGroup): { sql: string; args: (string | number)[] } {
  const clauses: string[] = [], args: (string | number)[] = [];
  const add = (sql: string, values: (string | number)[]) => { clauses.push(sql); args.push(...values); };
  const list = (column: string, values?: string[]) => { if (values?.length) add(`${column} IN (${values.map(() => "?").join(",")})`, values); };
  const seq = group === "messages" ? "m.seq" : group === "todo" ? "i.created_seq" : "f.seq";
  const ts = group === "todo" ? "i.created_ms" : "m.ts";
  list(group === "messages" ? "m.from_name" : group === "todo" ? "i.created_by" : "f.uploaded_by", p.by);
  if (p.from !== undefined) add(`${seq} >= ?`, [p.from]);
  if (p.since !== undefined) add(`${ts} >= ?`, [p.since]);
  if (p.until !== undefined) add(`${ts} < ?`, [p.until]);
  if (group === "messages") {
    list("m.from_kind", p.kind);
    if (p.replyTo !== undefined) add("m.reply_to = ?", [p.replyTo]);
    if (p.task !== undefined) add("m.seq IN (SELECT seq FROM item_messages_v WHERE n = ?)", [p.task]);
    if (p.has) clauses.push("json_array_length(m.files) > 0");
    const at: string[] = [], names: string[] = [];
    for (const [table, values] of [["message_notifies", p.peopleAt], ["message_mentions", p.seatsAt]] as const) if (values?.length) {
      at.push(`m.seq IN (SELECT seq FROM ${table} WHERE name IN (${values.map(() => "?").join(",")}))`); names.push(...values);
    }
    if (at.length) add(`(${at.join(" OR ")})`, names);
  }
  if (group === "todo") { list("i.status", p.status); list("i.assignee", p.to); }
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", args };
}


/** A short plain-text window around the first hit; the client highlights the query terms. */
export function searchSnippet(value: string, terms: string[]): string {
  const text = value.replace(/\s+/gu, " ").trim();
  const lower = text.toLocaleLowerCase();
  const at = terms.reduce((first, term) => {
    const i = lower.indexOf(term.toLocaleLowerCase());
    return i < 0 ? first : Math.min(first, i);
  }, Number.POSITIVE_INFINITY);
  const start = Number.isFinite(at) ? Math.max(0, at - 45) : 0;
  const end = Math.min(text.length, start + 160);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** A group's page: its query asks for limit + 1 rows, and a row past the limit only says there are more. */
export function page<T>(rows: T[], limit: number): { rows: T[]; hasMore: boolean } {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}
