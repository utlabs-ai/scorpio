// A complete bounded snapshot is required before a sorted continuation can be applied.
import fs from 'node:fs/promises'
import path from 'node:path'
import { WORKSPACE, WorkspaceError } from '../workspace-protocol.mjs'
import { metadataAlias } from './workspace-directories.mjs'

export const DIRECTORY_ORDER = 'directories-first-name'
export const DIRECTORY_ORDER_VERSION = 'directories-first-name:utf16-v1'
export async function sortedWorkspaceList(snapshot, relative, { offset, binding, continuing, clock }) {
  const items = [], started = clock()
  let dir, scanned = 0, truncated = false
  try {
    dir = await fs.opendir(snapshot.path)
    while (true) {
      // Reserve one second of the existing no-progress deadline for recheck, sorting and delivery.
      if (scanned >= 20000 || clock() - started >= 4000) { truncated = true; break }
      const entry = await dir.read()
      if (!entry) break
      scanned++
      if (entry.name === '.git') continue
      const stat = await fs.lstat(path.join(snapshot.path, entry.name), { bigint: true })
      if (await metadataAlias(snapshot.path, entry.name, stat)) continue
      const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special'
      items.push({ name: entry.name, kind, ...(kind === 'file' ? { bytes: Number(stat.size) } : {}) })
    }
  } finally { await dir?.close().catch(() => {}) }
  if (truncated && continuing) throw new WorkspaceError('workspace_result_too_large')
  items.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (offset > items.length) throw new WorkspaceError('workspace_directory_changed')
  const result = { path: relative, entries: [], nextCursor: null, truncated, order: DIRECTORY_ORDER, readAt: Date.now() }
  const cursor = index => !truncated && index < items.length ? Buffer.from(JSON.stringify({ binding, offset: index })).toString('base64url') : null
  for (let index = offset; index < items.length && result.entries.length < 200; index++) {
    const next = { ...result, entries: [...result.entries, items[index]], nextCursor: cursor(index + 1) }
    if (Buffer.byteLength(JSON.stringify(next)) > WORKSPACE.jsonBytes) {
      if (!result.entries.length) throw new WorkspaceError('workspace_result_too_large')
      break
    }
    result.entries = next.entries; result.nextCursor = next.nextCursor
  }
  return result
}
