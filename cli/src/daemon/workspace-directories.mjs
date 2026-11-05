// Directory selection is immutable per request; shortcuts never grant access.
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { HOME } from './paths.mjs'
import { workspaceFor } from '../workspace.mjs'
import { WORKSPACE, WorkspaceError, absoluteWorkspacePath, workspaceDirectory } from '../workspace-protocol.mjs'

export const identity = s => `${s.dev}:${s.ino}`
const refuse = code => { throw new WorkspaceError(code) }
export async function metadataAlias(parent, name, stat) {
  if (name === '.git') return true
  if (name.toLowerCase() !== '.git') return false
  const git = await fs.lstat(path.join(parent, '.git'), { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  return git !== null && identity(git) === identity(stat)
}
const directoryError = error => {
  if (error instanceof WorkspaceError) throw error
  if (error.code === 'ENOENT') refuse('workspace_directory_missing')
  if (error.code === 'EACCES' || error.code === 'EPERM') refuse('workspace_directory_denied')
  if (error.code === 'ENOTDIR') refuse('workspace_not_directory')
  refuse('workspace_read_failed')
}
async function inspectAncestors(target) {
  let current = '/'
  const root = await fs.lstat(current, { bigint: true }), ancestors = [{ path: current, id: identity(root), stat: root }]
  for (const name of target.split('/').filter(Boolean)) {
    if (name === '.git') refuse('workspace_path_denied')
    const parent = current
    current = path.join(current, name)
    const stat = await fs.lstat(current, { bigint: true })
    if (await metadataAlias(parent, name, stat)) refuse('workspace_path_denied')
    ancestors.push({ path: current, id: identity(stat), stat })
  }
  return ancestors
}
export function createWorkspaceDirectories({ home = HOME, rootFor = workspaceFor, systemHome = () => os.homedir(), clock = () => performance.now() } = {}) {
  async function select(topicId, input) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(topicId)) refuse('workspace_path_denied')
    const directory = workspaceDirectory(input, false), defaultPath = path.resolve(rootFor(topicId))
    try {
      // Inspect both spellings: realpath alone loses a metadata alias in the candidate.
      const logical = await inspectAncestors(directory.path)
      const canonical = await fs.realpath(directory.path), ancestors = await inspectAncestors(canonical)
      const stat = ancestors.at(-1).stat
      if (!stat.isDirectory()) refuse('workspace_not_directory')
      if (directory.id !== undefined && directory.id !== identity(stat)) refuse('workspace_directory_changed')
      const dir = await fs.opendir(canonical)
      await dir.close()
      for (const previous of [...logical, ...ancestors]) {
        const now = await fs.lstat(previous.path, { bigint: true })
        if (identity(now) !== previous.id) refuse('workspace_directory_changed')
      }
      const actualDefault = await fs.realpath(defaultPath).catch(() => null)
      const defaultStat = actualDefault && await fs.stat(actualDefault, { bigint: true }).catch(() => null)
      return Object.freeze({ path: canonical, id: identity(stat), defaultWorkspace: !!defaultStat && identity(defaultStat) === identity(stat), ancestors: Object.freeze(ancestors), missing: false })
    } catch (error) {
      if (error.code === 'ENOENT' && directory.path === defaultPath && !directory.id) {
        return Object.freeze({ path: defaultPath, defaultWorkspace: true, ancestors: Object.freeze([]), missing: true })
      }
      directoryError(error)
    }
  }
  async function locations(topicId, account) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(topicId)) refuse('workspace_path_denied')
    const defaultPath = path.resolve(rootFor(topicId)), homePath = systemHome()
    if (!absoluteWorkspacePath(defaultPath) || !absoluteWorkspacePath(homePath)) refuse('workspace_read_failed')
    const entries = new Map(), started = clock()
    let truncated = false, scanned = 0, bytes = Buffer.byteLength(JSON.stringify({ defaultPath, homePath, entries: [], truncated: false }))
    const add = (candidate, kind, role) => {
      if (!absoluteWorkspacePath(candidate)) return
      const old = entries.get(candidate)
      if (!old && entries.size >= 200) { truncated = true; return }
      const value = old ? { ...old, kinds: [...old.kinds], ...(old.agents ? { agents: [...old.agents] } : {}) } : { path: candidate, kinds: [] }
      if (!value.kinds.includes(kind)) value.kinds.push(kind)
      const name = `${role}@${account}`
      if (role && /^[A-Za-z0-9_.-]{1,62}$/.test(role) && typeof account === 'string' && /^[a-z0-9-]{1,39}$/.test(account) && Buffer.byteLength(name) <= 128) {
        value.agents = [...new Set([...(value.agents || []), name])].sort()
        if (value.agents.length > 32) { value.agents.length = 32; truncated = true }
      }
      const previous = old ? Buffer.byteLength(JSON.stringify(old)) + 1 : 0
      let next = Buffer.byteLength(JSON.stringify(value)) + 1
      if (bytes + next - previous > WORKSPACE.jsonBytes - 64) {
        truncated = true
        if (old) return
        delete value.agents
        next = Buffer.byteLength(JSON.stringify(value)) + 1
        if (bytes + next > WORKSPACE.jsonBytes - 64) return
      }
      entries.set(candidate, value); bytes += next - previous
    }
    add(defaultPath, 'default'); add(homePath, 'home')
    let dir
    try {
      dir = await fs.opendir(path.join(home, 'spawns', topicId))
      for await (const record of dir) {
        if (scanned++ >= 10000 || clock() - started >= 5000) { truncated = true; break }
        if (!record.name.endsWith('.json') || !record.isFile() || record.isSymbolicLink()) continue
        const file = path.join(home, 'spawns', topicId, record.name)
        let handle
        try {
          // A corrupt record cannot consume unbounded memory or follow a replacement link.
          handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > WORKSPACE.jsonBytes) continue
          const buffer = Buffer.alloc(WORKSPACE.jsonBytes + 1)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          if (bytesRead > WORKSPACE.jsonBytes) continue
          let value
          try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) } catch { continue }
          add(value?.dir, 'agent', record.name.slice(0, -5))
        } catch (error) { if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error }
        finally { await handle?.close().catch(() => {}) }
      }
    } catch (error) { if (error.code !== 'ENOENT') refuse('workspace_read_failed') }
    finally { await dir?.close().catch(() => {}) }
    const all = [...entries.values()], first = all.filter(e => e.kinds.includes('default') || e.kinds.includes('home'))
    return { defaultPath, homePath, entries: [...first, ...all.filter(e => !first.includes(e)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)], truncated }
  }
  return { select, locations }
}
