import { ApiError } from "./util";
import { filterList } from "./search";
import type { Member } from "./room/types";
export type MemberFilters = { q?: string; kind?: string[]; status?: string; mine?: boolean; online?: boolean };
export function memberFilters(input: Record<string, string | undefined>): MemberFilters {
  const p: MemberFilters = { q: input.q, kind: filterList(input.kind, "kind", ["human", "agent", "host"]), status: input.status };
  if (p.status !== undefined && !["active", "left", "all"].includes(p.status)) throw new ApiError("bad_request", "status= is active, left or all.");
  for (const key of ["mine", "online"] as const) if (input[key] !== undefined) {
    if (!["true", "false"].includes(input[key]!)) throw new ApiError("bad_request", `${key}= is true or false.`);
    p[key] = input[key] === "true";
  }
  if ((p.q?.length ?? 0) > 200) throw new ApiError("bad_request", "q= is at most 200 characters.");
  return p;
}
export function filterMembers(members: Member[], p: MemberFilters, account: string): Member[] {
  const terms = (p.q ?? "").trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return members.filter(m => (!p.kind || p.kind.includes(m.kind)) && (!p.status || p.status === "all" || m.status === p.status)
    && (!p.mine || m.owner === account) && (!p.online || m.online)
    && terms.every(t => `${m.name} ${m.displayName ?? ""} ${m.roleCard ?? ""}`.toLowerCase().includes(t)));
}
