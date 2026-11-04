const WORKSPACE = Object.freeze({
  version: 1,
  frameBytes: 65536,
  chunkBytes: 32768,
  fileBytes: 1048576,
  jsonBytes: 262144,
  window: 4,
  viewerPending: 2,
  accountPending: 8,
  topicPending: 32,
  totalMs: 3e4,
  progressMs: 5e3,
  pathBytes: 4096,
  lines: 2e4,
  lineScalars: 2e4,
  startsPerMinute: 60,
  acksPerMinute: 2048,
  hostControlsPerMinute: 240,
  bytesPerMinute: 32 * 1048576,
  byteBurst: 8 * 1048576
});
const textFail = (code, details) => { throw new WorkspaceError(code, details); };
function validateWorkspaceText(bytes) {
  if (bytes.byteLength > WORKSPACE.fileBytes) textFail('workspace_too_large', { bytes: bytes.byteLength, limit: WORKSPACE.fileBytes })
  if (bytes.includes(0)) textFail('workspace_binary', { bytes: bytes.byteLength })
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { textFail('workspace_encoding', { bytes: bytes.byteLength }) }
  let lines = 1, scalars = 0, wasCR = false
  for (const c of text) {
    if (c === '\n' && wasCR) { wasCR = false; continue }
    if (c === '\r' || c === '\n') { lines++; scalars = 0; wasCR = c === '\r' }
    else { scalars++; wasCR = false }
    if (lines > WORKSPACE.lines || scalars > WORKSPACE.lineScalars) textFail('workspace_line_limit', { limit: lines > WORKSPACE.lines ? WORKSPACE.lines : WORKSPACE.lineScalars })
  }
  return { bom: bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191, eol: text.includes('\r\n') ? 'crlf' : text.includes('\r') ? 'cr' : 'lf' }
}


const encoder = new TextEncoder();
const wireBytes = (value) => encoder.encode(value).byteLength;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isWorkspaceId = (value) => typeof value === "string" && uuid.test(value);
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
class WorkspaceError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
  code;
  details;
}
const fail = () => {
  throw new WorkspaceError("workspace_protocol_error");
};
function relativeWorkspacePath(value, root = false) {
  return typeof value === "string" && (root || value !== "") && wireBytes(value) <= WORKSPACE.pathBytes && !/[\x00\\]/.test(value) && !/^[a-z]:/i.test(value) && (value === "" || value.split("/").every((p) => p !== "" && p !== "." && p !== ".." && p !== ".git"));
}
const WORKSPACE_OPS = Object.freeze(["list", "read", "changes", "diff"]);
function operationKeys(value) {
  if (!WORKSPACE_OPS.includes(value.op)) return fail();
  if (value.op !== "changes" && !relativeWorkspacePath(value.path, value.op === "list")) throw new WorkspaceError("workspace_path_denied");
  if (value.op === "diff" && !relativeWorkspacePath(value.repo, true)) throw new WorkspaceError("workspace_path_denied");
  if (value.op === "list" && value.cursor != null && (typeof value.cursor !== "string" || wireBytes(value.cursor) > 512)) return fail();
  return ["op", ...(value.op === "changes" ? [] : ["path"]), ...(value.op === "list" ? ["cursor"] : []), ...(value.op === "diff" ? ["repo"] : [])];
}
function workspaceRequest(value) {
  if (!isObject(value)) return fail();
  const { connectionId, connectionToken, epoch, requestId } = value;
  if (!isWorkspaceId(connectionId) || !isWorkspaceId(epoch) || !isWorkspaceId(requestId) || typeof connectionToken !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(connectionToken)) return fail();
  const keys = ["connectionId", "connectionToken", "epoch", "requestId", ...operationKeys(value)];
  if (Object.keys(value).some(k => !keys.includes(k))) return fail();
  return value;
}
function workspaceHostRequest(value) {
  if (!isObject(value) || value.type !== "workspace_request" || value.v !== WORKSPACE.version ||
    !/^[A-Za-z0-9_-]{22}$/.test(value.topicId) || typeof value.computerId !== "string" || !value.computerId || wireBytes(value.computerId) > 256 ||
    typeof value.owner !== "string" || !/^[a-z0-9-]{1,39}$/.test(value.owner) ||
    !isWorkspaceId(value.viewerId) || !isWorkspaceId(value.requestId) || !isWorkspaceId(value.transferId) || !isWorkspaceId(value.epoch) ||
    !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0 || value.timeoutMs > WORKSPACE.totalMs) return fail();
  const keys = ["type", "v", "topicId", "computerId", "owner", "viewerId", "requestId", "transferId", "epoch", "timeoutMs", ...operationKeys(value)];
  if (Object.keys(value).some(k => !keys.includes(k))) return fail();
  return value;
}
const WORKSPACE_ERRORS = /* @__PURE__ */ new Set([
  "workspace_not_found",
  "workspace_revoked",
  "workspace_offline",
  "workspace_unsupported",
  "workspace_busy",
  "workspace_rate_limited",
  "workspace_expired",
  "workspace_reset",
  "workspace_cancelled",
  "workspace_duplicate_request",
  "workspace_protocol_error",
  "workspace_path_denied",
  "workspace_link",
  "workspace_file_missing",
  "workspace_read_failed",
  "workspace_binary",
  "workspace_encoding",
  "workspace_too_large",
  "workspace_line_limit",
  "workspace_file_changed",
  "workspace_directory_changed",
  "workspace_result_too_large",
  "workspace_git_unavailable"
]);
function safeWorkspaceDetails(value) {
  if (!isObject(value)) return void 0;
  const result = {};
  for (const key of ["bytes", "limit", "retryAfterMs"]) {
    const n = value[key];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) result[key] = n;
  }
  return Object.keys(result).length ? result : void 0;
}
function beginWorkspace(op, value) {
  if (!Array.isArray(value)) return fail();
  const names = op === "read" ? ["file"] : op === "diff" ? ["before", "after"] : ["json"];
  if (value.length !== names.length) return fail();
  const streams = value.map((s, i) => {
    if (!isObject(s) || s.name !== names[i] || typeof s.exists !== "boolean" || s.encoding !== "utf-8" || typeof s.bytes !== "number" || !Number.isSafeInteger(s.bytes) || s.bytes < 0 || !s.exists && s.bytes !== 0) return fail();
    if (s.bytes > (s.name === "json" ? WORKSPACE.jsonBytes : WORKSPACE.fileBytes)) throw new WorkspaceError("workspace_too_large");
    if (s.name === "json" && !s.exists) return fail();
    return { name: names[i], exists: s.exists, bytes: s.bytes, received: 0, chunks: 0 };
  });
  return { streams, seq: -1, ack: -1, index: 0 };
}
function base64Bytes(data) {
  if (typeof data !== "string" || data.length === 0 || data.length > 43692 || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return fail();
  let decoded;
  try {
    decoded = atob(data);
  } catch {
    return fail();
  }
  if (btoa(decoded) !== data || decoded.length > WORKSPACE.chunkBytes) return fail();
  return decoded.length;
}
function chunkWorkspace(s, frame) {
  if (frame.seq !== s.seq + 1 || frame.seq - s.ack > WORKSPACE.window) return fail();
  while (s.index < s.streams.length && s.streams[s.index].received === s.streams[s.index].bytes) s.index++;
  const stream = s.streams[s.index];
  if (!stream || frame.stream !== stream.name || frame.offset !== stream.received) return fail();
  const bytes = base64Bytes(frame.data);
  if (stream.received + bytes > stream.bytes) return fail();
  stream.received += bytes;
  stream.chunks++;
  s.seq++;
  return bytes;
}
function ackWorkspace(s, seq) {
  if (!Number.isSafeInteger(seq) || seq < s.ack || seq > s.seq) return fail();
  const changed = seq > s.ack;
  s.ack = seq;
  return changed;
}
function endWorkspace(s, value) {
  if (s.ack !== s.seq || !Array.isArray(value) || value.length !== s.streams.length) return fail();
  s.streams.forEach((stream, i) => {
    const end = value[i];
    if (!isObject(end) || end.name !== stream.name || end.bytes !== stream.bytes || end.chunks !== stream.chunks || stream.received !== stream.bytes) fail();
  });
}
function workspaceCapacity(pending, account, viewer) {
  return pending.length < WORKSPACE.topicPending && pending.filter((p) => p.account === account).length < WORKSPACE.accountPending && pending.filter((p) => p.viewer === viewer).length < WORKSPACE.viewerPending;
}
export {
  validateWorkspaceText,
  WORKSPACE_OPS,
  workspaceHostRequest,
  WORKSPACE,
  WORKSPACE_ERRORS,
  WorkspaceError,
  ackWorkspace,
  base64Bytes,
  beginWorkspace,
  chunkWorkspace,
  endWorkspace,
  isObject,
  isWorkspaceId,
  relativeWorkspacePath,
  safeWorkspaceDetails,
  wireBytes,
  workspaceCapacity,
  workspaceRequest
};
