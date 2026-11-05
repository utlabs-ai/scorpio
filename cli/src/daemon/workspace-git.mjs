// Fixed Git commands inspect only verified metadata within the selected directory.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { WORKSPACE, WorkspaceError, relativeWorkspacePath } from '../workspace-protocol.mjs'
import { validateWorkspaceText } from './workspace-files.mjs'
const execute = promisify(execFile)
const unavailable = () => { throw new WorkspaceError('workspace_git_unavailable') }
const join = (a, b) => a ? `${a}/${b}` : b
const hex = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const baseArgs = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null']
const exists = async p => fs.lstat(p).catch(e => { if (e.code === 'ENOENT') return null; throw e })
const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
})
export function createWorkspaceGit(files, { clock = () => performance.now() } = {}) {
  async function repoSnapshot(topicId, repo, scope) {
    if (!relativeWorkspacePath(repo, true)) throw new WorkspaceError('workspace_path_denied')
    const snapshot = await files.inspect(topicId, repo, { directory: true, scope })
    const gitPath = path.join(snapshot.path, '.git'), stat = await exists(gitPath)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) unavailable()
    const started = clock(), stack = [join(repo, '.git')]
    const snapshots = [snapshot]
    let entries = 0
    while (stack.length) {
      if (entries > 10000 || clock() - started > 5000) unavailable()
      const rel = stack.pop(), item = await files.inspect(topicId, rel, { metadata: true, scope })
      snapshots.push(item); entries++
      if (item.stat.isDirectory()) {
        const dir = await fs.opendir(item.path)
        try {
          for await (const child of dir) {
            if (++entries > 10000) unavailable()
            stack.push(`${rel}/${child.name}`)
          }
        } finally { await dir.close().catch(() => {}) }
      } else if (!item.stat.isFile()) unavailable()
      const suffix = rel.slice(join(repo, '.git').length + 1)
      if (['commondir', 'objects/info/alternates', 'objects/info/http-alternates'].includes(suffix)) unavailable()
    }
    const configPath = join(repo, '.git/config')
    if (await exists(path.join(snapshot.path, '.git/config'))) {
      const config = (await files.read(topicId, configPath, { metadata: true, scope })).bytes.toString('utf8')
      // Git reads these configurations before any command-level override could stop their side effects.
      if (/^\s*\[\s*(?:include|includeif|filter)(?:[.\s]|\])/im.test(config) || /^\s*(?:worktree|bare)\s*=/im.test(config.replace(/^\s*bare\s*=\s*false\s*$/gim, '')) || /worktreeconfig\s*=\s*true/i.test(config)) unavailable()
    }
    const recheck = async () => {
      for (const s of snapshots) {
        await files.recheck(s)
        const current = await fs.lstat(s.path, { bigint: true })
        if (current.size !== s.stat.size || current.mtimeNs !== s.stat.mtimeNs || current.ctimeNs !== s.stat.ctimeNs) unavailable()
      }
    }
    return { snapshot, recheck, topicId, repo, scope }
  }
  async function run(verified, args, { maxBuffer = WORKSPACE.jsonBytes, signal } = {}) {
    await verified.recheck()
    let output
    try {
      output = await execute('git', [...baseArgs, ...args], {
        cwd: verified.snapshot.path, env: gitEnv(), encoding: 'buffer', timeout: 5000, maxBuffer, signal,
      })
    } catch { unavailable() }
    await verified.recheck()
    return output.stdout
  }
  async function status(verified, signal) {
    await verified.recheck()
    const result = await new Promise((resolve, reject) => {
      const child = spawn('git', [...baseArgs, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-renames'], {
        cwd: verified.snapshot.path, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'], signal,
      })
      let bytes = Buffer.alloc(0), truncated = false, timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 5000)
      child.stdout.on('data', chunk => {
        if (truncated) return
        const remaining = WORKSPACE.jsonBytes - bytes.length
        bytes = Buffer.concat([bytes, chunk.subarray(0, remaining)])
        let records = 0, end = -1
        for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) { records++; end = i; if (records > 500) break }
        if (records > 500 || chunk.length >= remaining) {
          truncated = true; bytes = end >= 0 ? bytes.subarray(0, end + 1) : Buffer.alloc(0); child.kill('SIGTERM')
        }
      })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => {
        clearTimeout(timer)
        if (timedOut || signal?.aborted || code !== 0 && !truncated) reject(new WorkspaceError('workspace_git_unavailable'))
        else resolve({ bytes, truncated })
      })
    }).catch(() => unavailable())
    await verified.recheck()
    return result
  }
  async function head(verified, signal) {
    // show-ref distinguishes an unborn HEAD without treating all other command failures as an empty repository.
    const bytes = await run(verified, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], { signal })
    const text = (await files.read(verified.topicId, join(verified.repo, '.git/HEAD'), { metadata: true, scope: verified.scope })).bytes.toString('utf8').trim()
    if (hex.test(text)) return text
    if (!text.startsWith('ref: refs/heads/') || /[\x00-\x20~^:?*\[\\]/.test(text.slice(5))) unavailable()
    const line = bytes.toString('utf8').split('\n').find(x => x.slice(x.indexOf(' ') + 1) === text.slice(5))
    if (!line) return null
    const oid = line.split(' ')[0]
    if (!hex.test(oid)) unavailable()
    return oid
  }
  async function changes(topicId, { signal, scope } = {}) {
    const repositories = [], unavailableRepos = []
    const stack = [{ repo: '', depth: 0 }], started = clock()
    let entries = 0, discoveryTruncated = false, changesTruncated = false, remaining = 500
    while (stack.length) {
      if (entries >= 10000 || clock() - started > 5000) { discoveryTruncated = true; break }
      const { repo, depth } = stack.pop()
      let snapshot, children
      try {
        snapshot = await files.inspect(topicId, repo, { directory: true, scope })
        const dir = await fs.opendir(snapshot.path); children = []
        try {
          for await (const child of dir) { if (++entries > 10000 || clock() - started > 5000) { discoveryTruncated = true; break }; children.push(child) }
        } finally { await dir.close().catch(() => {}) }
        await files.recheck(snapshot)
      } catch (e) {
        if (repo === '' && scope && !scope.missing) throw e
        if (repo === '' && e.code === 'ENOENT') return { repositories: [], discoveryTruncated: false, changesTruncated: false, unavailable: [], rootMissing: true, readAt: Date.now() }
        unavailableRepos.push({ repo, reason: 'workspace_git_unavailable' }); continue
      }
      const metadata = new Set()
      for (const child of children) if (child.name.toLowerCase() === '.git' && await files.isMetadataEntry(snapshot, child.name)) metadata.add(child.name)
      if (metadata.size) {
        try {
          const verified = await repoSnapshot(topicId, repo, scope)
          const headOid = await head(verified, signal)
          const output = await status(verified, signal)
          changesTruncated ||= output.truncated
          const records = new Map()
          for (const record of new TextDecoder('utf-8', { fatal: true }).decode(output.bytes).split('\0').filter(Boolean)) {
            if (record.length < 4 || record[2] !== ' ') unavailable()
            const file = record.slice(3)
            if (!relativeWorkspacePath(file)) unavailable()
            if (!records.has(file)) records.set(file, record.slice(0, 2))
          }
          const beforePaths = new Set(), candidates = [...records.keys()].slice(0, remaining)
          if (headOid && candidates.length) {
            let batch = [], budget = 0
            const collect = async () => {
              if (!batch.length) return
              const tree = await run(verified, ['ls-tree', '-z', headOid, '--', ...batch], { signal })
              for (const record of new TextDecoder('utf-8', { fatal: true }).decode(tree).split('\0').filter(Boolean)) {
                const tab = record.indexOf('\t'); if (tab < 0) unavailable()
                beforePaths.add(record.slice(tab + 1))
              }
              batch = []; budget = 0
            }
            for (const file of candidates) { const n = Buffer.byteLength(file) + 1; if (budget + n > 60_000) await collect(); batch.push(file); budget += n }
            await collect()
          }
          const list = []
          for (const [file, status] of records) {
            if (remaining === 0) { changesTruncated = true; break }
            const beforeExists = beforePaths.has(file)
            let afterExists
            try { await files.inspect(topicId, join(repo, file), { scope }); afterExists = true } catch (e) { if (e.code === 'ENOENT') afterExists = false; else if (e.code === 'workspace_link') afterExists = true; else throw e }
            const kind = status.includes('U') || ['AA', 'DD'].includes(status) ? 'conflict' : !beforeExists ? 'added' : !afterExists ? 'deleted' : 'modified'
            list.push({ path: file, status, kind, beforeExists, afterExists }); remaining--
          }
          repositories.push({ repo, headOid, changes: list })
        } catch { unavailableRepos.push({ repo, reason: 'workspace_git_unavailable' }) }
      }
      for (const child of children) {
        if (metadata.has(child.name) || child.name === 'node_modules' || !child.isDirectory() || child.isSymbolicLink()) continue
        if (depth === 4) { discoveryTruncated = true; continue }
        stack.push({ repo: join(repo, child.name), depth: depth + 1 })
      }
    }
    const result = { repositories, discoveryTruncated, changesTruncated, unavailable: unavailableRepos, readAt: Date.now() }
    if (Buffer.byteLength(JSON.stringify(result)) > WORKSPACE.jsonBytes) throw new WorkspaceError('workspace_result_too_large')
    return result
  }
  async function diff(topicId, repo, relative, { signal, scope } = {}) {
    if (!relativeWorkspacePath(relative)) throw new WorkspaceError('workspace_path_denied')
    const verified = await repoSnapshot(topicId, repo, scope), headOid = await head(verified, signal)
    let before = { exists: false, bytes: Buffer.alloc(0) }, after = { exists: false, bytes: Buffer.alloc(0) }
    if (headOid) {
      const raw = await run(verified, ['ls-tree', '-z', headOid, '--', relative], { signal })
      if (raw.length) {
        const record = new TextDecoder('utf-8', { fatal: true }).decode(raw)
        const match = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([\s\S]*)\0$/.exec(record)
        if (!match || match[3] !== relative) unavailable()
        const size = Number((await run(verified, ['cat-file', '-s', match[2]], { signal })).toString('utf8').trim())
        if (!Number.isSafeInteger(size) || size < 0) unavailable()
        if (size > WORKSPACE.fileBytes) throw new WorkspaceError('workspace_too_large', { bytes: size, limit: WORKSPACE.fileBytes })
        const bytes = await run(verified, ['cat-file', 'blob', match[2]], { maxBuffer: WORKSPACE.fileBytes + 1, signal })
        if (bytes.length !== size) unavailable()
        before = { exists: true, bytes, meta: validateWorkspaceText(bytes) }
      }
    }
    try { const result = await files.read(topicId, join(repo, relative), { scope }); after = { exists: true, ...result } } catch (e) { if (e.code !== 'workspace_file_missing') throw e }
    await verified.recheck()
    if (!before.exists && !after.exists) throw new WorkspaceError('workspace_file_missing')
    return { before, after, meta: { repo, path: relative, headOid } }
  }
  return { changes, diff }
}
