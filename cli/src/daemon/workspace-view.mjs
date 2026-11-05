// Workspace jobs are attached to a physical host socket, never to an agent pane.
import { performance } from 'node:perf_hooks'
import { WORKSPACE, WorkspaceError, WORKSPACE_OPS, workspaceHostRequest, workspaceJsonResult, isWorkspaceId, wireBytes, ackWorkspace, beginWorkspace, chunkWorkspace, endWorkspace } from '../workspace-protocol.mjs'
import { createWorkspaceFiles } from './workspace-files.mjs'
import { createWorkspaceGit } from './workspace-git.mjs'

export function createWorkspaceHost({ account, computerId, files = createWorkspaceFiles(), git = createWorkspaceGit(files), clock = () => performance.now(), log = () => {} }) {
  const links = new WeakMap()
  const send = (link, socket, frame) => {
    if (!link.isOpen || link.ws !== socket) throw new WorkspaceError('workspace_cancelled')
    const data = JSON.stringify(frame)
    if (wireBytes(data) > WORKSPACE.frameBytes) throw new WorkspaceError('workspace_protocol_error')
    socket.send(data)
  }
  const cancel = (job, code = 'workspace_cancelled') => {
    if (job.finished) return
    job.finished = true; job.controller.abort(); clearTimeout(job.timer)
    job.waiter?.reject(new WorkspaceError(code)); job.waiter = null
    job.state.jobs.delete(job.frame.transferId)
  }
  const cancelState = (state) => { if (state) for (const job of [...state.jobs.values()]) cancel(job) }
  const advertise = link => send(link, link.ws, { type: 'workspace_capabilities', v: 1, ops: WORKSPACE_OPS, directoryNavigation: 1 })
  function validRequest(link, state, frame) {
    try { workspaceHostRequest(frame) } catch { return false }
    return state.socket === link.ws && frame.epoch === state.epoch && frame.topicId === link.roomId && frame.owner === account() && frame.computerId === computerId()
  }
  async function execute(link, job) {
    const { frame, state } = job, signal = job.controller.signal
    const base = { v: 1, topicId: link.roomId, epoch: frame.epoch, transferId: frame.transferId }
    const check = () => {
      if (job.finished || signal.aborted || clock() >= job.deadline || link.ws !== state.socket) throw new WorkspaceError('workspace_cancelled')
    }
    const write = payload => { check(); send(link, state.socket, { ...base, ...payload }) }
    function arm() {
      clearTimeout(job.timer)
      job.timer = setTimeout(() => {
        if (job.finished) return
        try { send(link, state.socket, { ...base, type: 'workspace_error', code: 'workspace_expired' }) } catch {}
        cancel(job, 'workspace_expired')
      }, Math.max(0, Math.min(job.deadline - clock(), WORKSPACE.progressMs)))
    }
    function wait() { return new Promise((resolve, reject) => { job.waiter = { resolve, reject } }) }
    job.arm = arm; arm()
    try {
      let streams, meta
      const scope = frame.directory ? await files.selectDirectory(link.roomId, frame.directory) : undefined
      const directoryMeta = scope ? { directory: { path: scope.path, ...(scope.id ? { id: scope.id } : {}) }, defaultWorkspace: scope.defaultWorkspace } : null
      if (frame.op === 'read') {
        const file = await files.read(link.roomId, frame.path, { scope })
        streams = [{ name: 'file', exists: true, bytes: file.bytes }]; meta = file.meta
      } else if (frame.op === 'diff') {
        const result = await git.diff(link.roomId, frame.repo, frame.path, { signal, scope })
        streams = [{ name: 'before', ...result.before }, { name: 'after', ...result.after }]; meta = result.meta
      } else {
        const result = frame.op === 'locations' ? await files.locations(link.roomId, account()) : frame.op === 'list' ? await files.list(link.roomId, frame.path, frame.cursor, computerId(), scope) : await git.changes(link.roomId, { signal, scope })
        const bytes = Buffer.from(JSON.stringify(workspaceJsonResult(frame.op, result, frame.path)))
        if (bytes.byteLength > WORKSPACE.jsonBytes) throw new WorkspaceError('workspace_result_too_large')
        streams = [{ name: 'json', exists: true, bytes }]
      }
      if (directoryMeta) meta = { ...meta, ...directoryMeta }
      check()
      const declarations = streams.map(s => ({ name: s.name, exists: s.exists, bytes: s.bytes.byteLength, encoding: 'utf-8' }))
      job.counts = beginWorkspace(frame.op, declarations)
      write({ type: 'workspace_begin', streams: declarations, ...(meta ? { meta } : {}) }); arm()
      let seq = 0
      for (const stream of streams) {
        for (let offset = 0; offset < stream.bytes.length; offset += WORKSPACE.chunkBytes) {
          while (job.counts.seq - job.counts.ack >= WORKSPACE.window) { await wait(); check() }
          const chunk = { type: 'workspace_chunk', seq: seq++, stream: stream.name, offset, data: stream.bytes.subarray(offset, offset + WORKSPACE.chunkBytes).toString('base64') }
          chunkWorkspace(job.counts, chunk); write(chunk)
        }
      }
      while (job.counts.ack !== job.counts.seq) { await wait(); check() }
      const ends = job.counts.streams.map(s => ({ name: s.name, bytes: s.bytes, chunks: s.chunks }))
      endWorkspace(job.counts, ends)
      write({ type: 'workspace_end', streams: ends, readAt: Date.now() })
      log({ op: frame.op, requestId: frame.requestId, bytes: streams.reduce((n, s) => n + s.bytes.length, 0), durationMs: Math.round(clock() - job.started) })
    } catch (error) {
      if (!job.finished) {
        const code = error instanceof WorkspaceError ? error.code : 'workspace_read_failed'
        try { send(link, state.socket, { ...base, type: 'workspace_error', code, ...(error instanceof WorkspaceError && error.details ? { details: error.details } : {}) }) } catch {}
      }
    } finally { cancel(job) }
  }
  function handle(link, frame) {
    if (!link.host) return false
    if (frame.type === 'closed' || frame.type === 'removed' || frame.type === 'open') {
      cancelState(links.get(link)); links.delete(link); return false
    }
    if (frame.type === 'ready') { advertise(link); return false }
    if (typeof frame.type !== 'string' || !frame.type.startsWith('workspace_')) return false
    if (frame.type === 'workspace_reset') { cancelState(links.get(link)); links.delete(link); advertise(link); return true }
    if (frame.type === 'workspace_host_ready') {
      cancelState(links.get(link))
      if (frame.v === 1 && isWorkspaceId(frame.epoch) && frame.computerId === computerId()) links.set(link, { epoch: frame.epoch, socket: link.ws, jobs: new Map() })
      return true
    }
    const state = links.get(link)
    if (!state || state.socket !== link.ws || frame.epoch !== state.epoch || frame.topicId !== link.roomId) return true
    if (frame.type === 'workspace_request') {
      if (!validRequest(link, state, frame)) return true
      if (state.jobs.has(frame.transferId) || state.jobs.size >= WORKSPACE.accountPending) {
        send(link, state.socket, { type: 'workspace_error', v: 1, topicId: link.roomId, epoch: state.epoch, transferId: frame.transferId, code: 'workspace_busy' }); return true
      }
      const job = { frame, state, started: clock(), deadline: clock() + frame.timeoutMs, controller: new AbortController(), finished: false }
      state.jobs.set(frame.transferId, job)
      void execute(link, job)
    } else if (frame.type === 'workspace_cancel' || frame.type === 'workspace_ack') {
      const job = state.jobs.get(frame.transferId)
      if (!job) return true
      if (frame.type === 'workspace_cancel') cancel(job)
      else {
        try {
          if (!job.counts) throw new WorkspaceError('workspace_protocol_error')
          if (ackWorkspace(job.counts, frame.ackSeq)) { job.arm(); job.waiter?.resolve(); job.waiter = null }
        } catch { cancel(job, 'workspace_protocol_error') }
      }
    }
    return true
  }
  return { handle }
}
