// The current connection owns its queue and bounded incoming buffers; nothing is cached in browser storage.
import { WORKSPACE, wireBytes, isObject, beginWorkspace, chunkWorkspace, ackWorkspace, endWorkspace, validateWorkspaceText, workspaceJsonResult, workspaceDirectoryMeta, WorkspaceError } from './workspace-assets/wire.js';

export function createWorkspaceClient({ topicId, computerId, onState, onReady, onStatus, onRevoked }) {
  let identity = null, stopped = false, active = 0, generation = 0;
  const queue = [], pending = new Map();
  const path = `/r/${encodeURIComponent(topicId)}/workspace`;
  let socket;
  function cancelRequest(job, code = 'workspace_cancelled') {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer); job.abort.abort();
    if (job.transferId && socket) socket.send(JSON.stringify({ type: 'workspace_cancel', v: 1, epoch: job.epoch, requestId: job.requestId, transferId: job.transferId }));
    pending.delete(job.requestId); job.parts = null;
    job.reject(new WorkspaceError(code));
  }
  function cancelAll(code = 'workspace_cancelled') {
    for (const job of queue.splice(0)) { job.done = true; job.reject(new WorkspaceError(code)); }
    for (const job of [...pending.values()]) cancelRequest(job, code);
  }
  function cancelDocuments() {
    for (let i = queue.length - 1; i >= 0; i--) if (['read', 'diff'].includes(queue[i].operation.op)) { const job = queue.splice(i, 1)[0]; job.done = true; job.reject(new WorkspaceError('workspace_cancelled')); }
    for (const job of [...pending.values()]) if (['read', 'diff'].includes(job.operation.op)) cancelRequest(job);
  }
  function failConnection() { identity = null; generation++; cancelAll('workspace_offline'); onState('reconnecting'); }
  const status = { status() { failConnection(); }, clear() {} };
  socket = window.createRoomSocket({ roomId: topicId, path: `${path}/ws?computer=${encodeURIComponent(computerId)}`, readyType: 'workspace_ready', viewing: false,
    status, reconnecting: 'reconnecting', onDisconnect: failConnection,
    removed() { stop(); onRevoked(); }, gone() { stop(); onRevoked(); } });
  function pump() {
    while (!stopped && identity && active < WORKSPACE.viewerPending && queue.length) {
      const job = queue.shift(); active++; pending.set(job.requestId, job);
      const version = generation, ready = identity;
      job.epoch = ready.epoch;
      job.timer = setTimeout(() => cancelRequest(job, 'workspace_expired'), WORKSPACE.totalMs);
      fetch(`${path}/request?computer=${encodeURIComponent(computerId)}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: job.abort.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: ready.connectionId, connectionToken: ready.connectionToken, epoch: ready.epoch, requestId: job.requestId, ...job.operation }) })
        .then(async res => {
          const result = await res.json();
          if (!res.ok) { if (res.status === 401) { stop(); location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); } throw new WorkspaceError(result.error || 'workspace_read_failed', result.details); }
          if (version !== generation || job.done) return;
          accept(result);
        }).catch(error => { if (!job.done) { job.done = true; clearTimeout(job.timer); pending.delete(job.requestId); job.parts = null; job.reject(error); } });
      job.promise.finally(() => { active--; pump(); }).catch(() => {});
    }
  }
  function accept(frame) {
    const job = pending.get(frame.requestId);
    if (!job || frame.epoch !== identity?.epoch || frame.v !== 1) return;
    if (job.transferId && job.transferId !== frame.transferId) return cancelRequest(job, 'workspace_protocol_error');
    job.transferId = frame.transferId;
  }
  socket.on('workspace_ready', frame => {
    if (identity && frame.connectionId === identity.connectionId && frame.epoch === identity.epoch) { identity = frame; onReady(frame.computer); return; }
    identity = frame; generation++; cancelAll('workspace_reset'); onState('ready'); onReady(frame.computer); pump();
  });
  socket.on('workspace_reset', () => { identity = null; generation++; cancelAll('workspace_reset'); onState('reconnecting'); });
  socket.on('workspace_accepted', accept);
  socket.on('workspace_status', frame => { if (frame.epoch === identity?.epoch) onStatus(frame); });
  socket.on('workspace_revoked', () => { stop(); onRevoked(); });
  const check = frame => {
    const job = pending.get(frame.requestId);
    return job && !job.done && frame.v === 1 && frame.epoch === job.epoch && frame.transferId === job.transferId ? job : null;
  };
  socket.on('workspace_begin', frame => {
    const job = check(frame); if (!job) return;
    try {
      if (job.counts) throw new WorkspaceError('workspace_protocol_error');
      job.counts = beginWorkspace(job.operation.op, frame.streams); job.meta = isObject(frame.meta) ? frame.meta : {};
      if (job.operation.directory) job.meta = { ...job.meta, ...workspaceDirectoryMeta(job.meta, !(job.operation.op === 'list' && job.operation.path === '' && job.operation.cursor == null)) };
      job.parts = Object.fromEntries(job.counts.streams.map(s => [s.name, new Uint8Array(s.bytes)]));
    } catch (e) { cancelRequest(job, e.code); }
  });
  socket.on('workspace_chunk', frame => {
    const job = check(frame); if (!job) return;
    try {
      if (!job.counts || wireBytes(JSON.stringify(frame)) > WORKSPACE.frameBytes) throw new WorkspaceError('workspace_protocol_error');
      chunkWorkspace(job.counts, frame);
      const raw = atob(frame.data), part = job.parts[frame.stream];
      for (let i = 0; i < raw.length; i++) part[frame.offset + i] = raw.charCodeAt(i);
      ackWorkspace(job.counts, frame.seq);
      socket.send(JSON.stringify({ type: 'workspace_ack', v: 1, epoch: job.epoch, requestId: job.requestId, transferId: job.transferId, ackSeq: frame.seq }));
    } catch (e) { cancelRequest(job, e.code); }
  });
  socket.on('workspace_end', frame => {
    const job = check(frame); if (!job) return;
    try {
      if (!job.counts) throw new WorkspaceError('workspace_protocol_error');
      endWorkspace(job.counts, frame.streams);
      const result = { meta: job.meta, readAt: frame.readAt };
      for (const s of job.counts.streams) { if (s.name !== 'json') validateWorkspaceText(job.parts[s.name]); result[s.name] = { exists: s.exists, bytes: job.parts[s.name], text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(job.parts[s.name]) }; }
      if (result.json) { result.value = workspaceJsonResult(job.operation.op, JSON.parse(result.json.text), job.operation.path); delete result.json; }
      if (job.operation.directory) {
        const directory = result.meta.directory;
        if (job.operation.directory.id && directory.id !== job.operation.directory.id) throw new WorkspaceError('workspace_directory_changed');
        if (!directory.id && !(job.operation.op === 'list' && job.operation.path === '' && !job.operation.cursor && result.meta.defaultWorkspace === true && result.value.rootMissing === true && result.value.entries.length === 0 && result.value.nextCursor === null && result.value.truncated === false)) throw new WorkspaceError('workspace_protocol_error');
        if (directory.id && result.value?.rootMissing) throw new WorkspaceError('workspace_protocol_error');
      }
      job.done = true; clearTimeout(job.timer); pending.delete(job.requestId); job.parts = null; job.abort.abort(); job.resolve(result);
    } catch (e) { cancelRequest(job, e.code || 'workspace_encoding'); }
  });
  socket.on('workspace_error', frame => {
    const candidate = pending.get(frame.requestId);
    const reset = frame.code === 'workspace_reset' && candidate && frame.v === 1 && frame.epoch === candidate.epoch && (!candidate.transferId || candidate.transferId === frame.transferId);
    const job = reset ? candidate : check(frame);
    if (job) { job.done = true; clearTimeout(job.timer); pending.delete(job.requestId); job.parts = null; job.abort.abort(); job.reject(new WorkspaceError(frame.code, frame.details)); }
  });
  function request(operation) {
    if (stopped || !identity) return Promise.reject(new WorkspaceError('workspace_offline'));
    const job = { operation, requestId: crypto.randomUUID(), abort: new AbortController(), done: false };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    queue.push(job); pump(); return job.promise;
  }
  function stop() { if (stopped) return; stopped = true; cancelAll(); identity = null; socket.stop(); }
  return { start: () => socket.connect(), request, cancelAll, cancelDocuments, stop, get ready() { return !!identity && !stopped; } };
}
