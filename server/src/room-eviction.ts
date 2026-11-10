import { accountOf } from "./files";

export function classifyFile(f: Record<string, unknown> | undefined, account: string): "missing" | "trashed" | "gone" {
  if (!f || accountOf(f.uploaded_by as string) !== account) return "missing";
  return f.deleted_at != null ? "trashed" : "gone";
}

export function isShown(f: Record<string, unknown>): boolean {
  return f.deleted_at == null && f.seq != null;
}
