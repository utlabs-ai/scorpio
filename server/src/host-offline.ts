// Since when the computer that delivers to a member has been offline: a daemon is its own computer; an agent
// goes offline with the daemon that carries it. Kept apart from room-do.ts, with no imports, so the node tests can load it.

/** The members a send reads (who is mentioned, who wakes, how each delivery went): offline_since is a daemon's own. */
export const SEND_MEMBERS_SQL = "SELECT name, kind, owner, status, host_id, offline_since FROM members";

type Seat = { kind?: unknown; offline_since?: unknown } | null | undefined;

/** When `m`'s computer went offline (ms), or null: it is online, never connected, or `m` is not on a computer. */
export function hostOfflineSince(m: Seat, host: Seat): number | null {
  const since = m?.kind === "host" ? m.offline_since : host?.offline_since;
  return typeof since === "number" && since > 0 ? since : null;
}
