/** A ticket never revives a removed file or opens different bytes, even from the render cache. */
export function ticketFileAvailable(file: { hash?: unknown; deleted_at?: unknown } | undefined, hash: string): boolean {
  return !!file && file.deleted_at == null && file.hash === hash;
}
