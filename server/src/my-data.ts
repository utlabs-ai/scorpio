/** Read-only account data assembled from each accessible room and the existing file index. */
export const DAY_MS = 86_400_000;
export const ROOM_DATA_TIMEOUT_MS = 8_000;
export const ROOM_DATA_CACHE_MS = 60_000;

export type RoomDay = { day: number; human: number; agents: number };
export type RoomData = { humanMessages: number; agentMessages: number; lastActive: number | null; daily: RoomDay[] };
export type MyRoom = { id: string; name: string; archived: boolean; fileBytes: number; data: RoomData | null };

const AGENT_OF_ACCOUNT = "from_kind = 'agent' AND instr(from_name, '@') > 0 AND substr(from_name, instr(from_name, '@') + 1) = ?";
export const ROOM_TOTALS_SQL = `SELECT
  COALESCE(SUM(CASE WHEN from_kind = 'human' AND from_name = ? THEN 1 ELSE 0 END), 0) AS human,
  COALESCE(SUM(CASE WHEN ${AGENT_OF_ACCOUNT} THEN 1 ELSE 0 END), 0) AS agents,
  MAX(CASE WHEN from_kind != 'system' THEN ts END) AS last_active
  FROM messages`;
export const ROOM_DAILY_SQL = `SELECT CAST(ts / 86400000 AS INTEGER) AS day,
  SUM(CASE WHEN from_kind = 'human' THEN 1 ELSE 0 END) AS human,
  SUM(CASE WHEN from_kind = 'agent' THEN 1 ELSE 0 END) AS agents
  FROM messages WHERE ts >= ? AND
  ((from_kind = 'human' AND from_name = ?) OR (${AGENT_OF_ACCOUNT}))
  GROUP BY day ORDER BY day`;
export const MY_FILES_SQL = "SELECT room_id, SUM(charged) AS bytes FROM account_files WHERE user_id = ? GROUP BY room_id";

export function thirtyDays(roomData: (RoomData | null)[], at: number): RoomDay[] {
  const last = Math.floor(at / DAY_MS);
  const sums = new Map<number, { human: number; agents: number }>();
  for (const room of roomData) for (const row of room?.daily || []) {
    const old = sums.get(row.day) || { human: 0, agents: 0 };
    sums.set(row.day, { human: old.human + row.human, agents: old.agents + row.agents });
  }
  return Array.from({ length: 30 }, (_, i) => {
    const day = last - 29 + i;
    return { day, ...(sums.get(day) || { human: 0, agents: 0 }) };
  });
}

export async function mapSix<T, U>(items: T[], visit: (item: T) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await visit(items[i]);
    }
  }));
  return out;
}

export async function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("room data timeout")), ms); })]);
  } finally {
    clearTimeout(timer!);
  }
}
