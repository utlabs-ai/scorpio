type SnapshotRow = Record<string, unknown>;

export function isPublic(row: SnapshotRow | undefined): boolean {
  return !!row && !!row.public && row.deleted_at == null;
}

export function snapshotOf(roomRow: SnapshotRow, members: SnapshotRow[], messages: SnapshotRow[], n: number) {
  const shown = new Map<string, string>(members.map((x) => [x.name as string, x.display_name as string]));
  return {
    name: roomRow.name as string,
    topic: roomRow.topic as string,
    archived: roomRow.archived_at != null,
    total: n,
    messages: messages.map((m) => ({
      seq: m.seq as number,
      from: m.from_name as string,
      ...(m.from_kind === "human" && shown.has(m.from_name as string) ? { display: shown.get(m.from_name as string)! } : {}),
      fromKind: m.from_kind as string,
      ...(m.scheduled ? { scheduled: JSON.parse(m.scheduled as string) } : {}),
      text: m.text as string,
      files: m.files ? (JSON.parse(m.files as string) as { name: string; size: number; deleted?: number }[]).filter((f) => !f.deleted).map((f) => ({ name: f.name, size: f.size })) : [],
      ts: m.ts as number,
    })),
  };
}
