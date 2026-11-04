// All reads are bounded and validated before any byte is sent to the viewer.
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { HOME } from './paths.mjs'
import { workspaceFor } from '../workspace.mjs'
import { WORKSPACE, WorkspaceError, relativeWorkspacePath, validateWorkspaceText } from '../workspace-protocol.mjs'

const refuse = (code, details) => { throw new WorkspaceError(code, details) }
const identity = (s) => `${s.dev}:${s.ino}`
const version = (s) => `${identity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
const contained = (root, target) => {
  const rel = path.relative(root, target)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}
const classify = (e) => {
  if (e instanceof WorkspaceError) throw e
  if (e?.code === 'ENOENT') refuse('workspace_file_missing')
  if (e?.code === 'ELOOP') refuse('workspace_link')
  refuse('workspace_read_failed')
}
export { validateWorkspaceText } from '../workspace-protocol.mjs'

/** HOME itself is trusted configuration; none of the topic descendants may be links. */
export function createWorkspaceFiles({ home = HOME, rootFor = workspaceFor, clock = () => performance.now() } = {}) {
  async function inspect(topicId, relative, { directory = false, metadata = false } = {}) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(topicId) ||
      !(metadata ? relativeWorkspacePath(relative.split('/').filter(p => p !== '.git').join('/'), true) : relativeWorkspacePath(relative, true))) refuse('workspace_path_denied')
    const trustedHome = await fs.realpath(home)
    const logicalRoot = path.resolve(rootFor(topicId))
    const relativeRoot = path.relative(path.resolve(home), logicalRoot)
    if (!contained(path.resolve(home), logicalRoot) || relativeRoot !== path.join('topics', topicId, 'workspace')) refuse('workspace_path_denied')
    let current = trustedHome
    const ancestors = []
    const components = [...relativeRoot.split(path.sep), ...relative.split('/').filter(Boolean)]
    for (let i = 0; i < components.length; i++) {
      current = path.join(current, components[i])
      const stat = await fs.lstat(current, { bigint: true })
      if (stat.isSymbolicLink()) refuse('workspace_link')
      if ((i < components.length - 1 || directory) && !stat.isDirectory()) refuse('workspace_path_denied')
      ancestors.push({ path: current, id: identity(stat), stat })
    }
    const root = path.join(trustedHome, relativeRoot), canonical = await fs.realpath(current)
    if (!contained(root, canonical)) refuse('workspace_path_denied')
    const stat = ancestors.at(-1).stat
    return { path: current, root, canonical, stat, ancestors }
  }
  async function recheck(snapshot, changed = 'workspace_file_changed') {
    try {
      for (const ancestor of snapshot.ancestors) {
        const stat = await fs.lstat(ancestor.path, { bigint: true })
        if (stat.isSymbolicLink() || identity(stat) !== ancestor.id) refuse(changed)
      }
      const canonical = await fs.realpath(snapshot.path)
      const stat = await fs.stat(canonical, { bigint: true })
      if (!contained(snapshot.root, canonical) || identity(stat) !== identity(snapshot.stat)) refuse(changed)
    } catch { refuse(changed) }
  }
  async function read(topicId, relative, options = {}) {
    let handle
    try {
      const snapshot = await inspect(topicId, relative, options)
      if (!snapshot.stat.isFile()) refuse('workspace_read_failed')
      if (snapshot.stat.size > BigInt(WORKSPACE.fileBytes)) refuse('workspace_too_large', { bytes: Number(snapshot.stat.size), limit: WORKSPACE.fileBytes })
      handle = await fs.open(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || version(before) !== version(snapshot.stat)) refuse('workspace_file_changed')
      await recheck(snapshot)
      const buffer = Buffer.alloc(WORKSPACE.fileBytes + 1)
      let n = 0
      while (n < buffer.length) {
        const result = await handle.read(buffer, n, buffer.length - n, n)
        if (result.bytesRead === 0) break
        n += result.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      await recheck(snapshot)
      if (version(before) !== version(after) || version(await fs.lstat(snapshot.path, { bigint: true })) !== version(before) || BigInt(n) !== after.size) refuse('workspace_file_changed')
      const bytes = buffer.subarray(0, n), textMeta = validateWorkspaceText(bytes)
      return { bytes, meta: { path: relative, size: n, mtime: Number(after.mtimeNs / 1_000_000n), ...textMeta } }
    } catch (e) { classify(e) } finally { await handle?.close().catch(() => {}) }
  }
  async function list(topicId, relative = '', cursor = null, computerId = '') {
    let dir
    try {
      let snapshot
      try { snapshot = await inspect(topicId, relative, { directory: true }) } catch (e) {
        if (e?.code === 'ENOENT' && relative === '') {
          // Absence never creates the workspace as a side effect of viewing it.
          return { path: '', entries: [], nextCursor: null, truncated: false, rootMissing: true, order: 'filesystem', readAt: Date.now() }
        }
        throw e
      }
      const binding = createHash('sha256').update(`${topicId}\0${computerId}\0${relative}\0${version(snapshot.stat)}`).digest('hex')
      let offset = 0
      if (cursor != null) {
        if (typeof cursor !== 'string' || Buffer.byteLength(cursor) > 512) refuse('workspace_directory_changed')
        try {
          const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
          if (value.binding !== binding || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 20_000) refuse('workspace_directory_changed')
          offset = value.offset
        } catch { refuse('workspace_directory_changed') }
      }
      dir = await fs.opendir(snapshot.path)
      const entries = [], started = clock()
      let scanned = 0, eof = false, truncated = false, hasMore = false, budget = 512
      while (true) {
        if (scanned >= 20_000 || clock() - started >= 5_000) { truncated = true; break }
        const entry = await dir.read()
        if (!entry) { eof = true; break }
        if (scanned++ < offset || entry.name === '.git') continue
        const itemPath = path.join(snapshot.path, entry.name), stat = await fs.lstat(itemPath, { bigint: true })
        const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special'
        const item = { name: entry.name, kind, ...(kind === 'file' ? { bytes: Number(stat.size) } : {}) }
        const size = Buffer.byteLength(JSON.stringify(item)) + 1
        if (entries.length === 200 || budget + size > WORKSPACE.jsonBytes - 1024) { scanned--; hasMore = true; break }
        entries.push(item); budget += size
      }
      await recheck(snapshot, 'workspace_directory_changed')
      if (version(await fs.lstat(snapshot.path, { bigint: true })) !== version(snapshot.stat)) refuse('workspace_directory_changed')
      return { path: relative, entries, nextCursor: !eof && !truncated && hasMore ? Buffer.from(JSON.stringify({ binding, offset: scanned })).toString('base64url') : null, truncated, order: 'filesystem', readAt: Date.now() }
    } catch (e) { classify(e) } finally { await dir?.close().catch(() => {}) }
  }
  return { inspect, recheck, read, list }
}
