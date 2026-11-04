# Workspace files (v1)

A person may read only their own computer's default workspace for a topic they currently belong to. This is not a command for an agent or a way to choose another working directory. Contents are relayed live and are not stored as topic messages or attachments.

The human web endpoints are relative to the site origin, **not** `/api/v1`: `GET /r/{topicId}/workspace`, `GET .../workspace/hosts`, `GET .../workspace/ws?computer={computerId}` and `POST .../workspace/request?computer={computerId}`. Session authentication and same-origin checks apply. Agent tokens cannot start reads. The daemon uses its existing authenticated topic host connection.

### Identity and acceptance

The workspace socket sends:

```json
{"type":"workspace_ready","v":1,"connectionId":"uuid","connectionToken":"opaque-memory-only-token","epoch":"uuid","computer":{"computerId":"device-id","name":"box","online":true,"workspaceProtocol":1}}
```

The daemon advertises on its host connection (new daemons enable this by default; there is no opt-in flag):

```json
{"type":"workspace_capabilities","v":1,"ops":["list","read","changes","diff"]}
{"type":"workspace_host_ready","v":1,"epoch":"uuid","computerId":"device-id"}
```

The second frame is the server reply to that host. An epoch identifies a live connection group, not a server object construction. Normal hibernation retains the epoch, connection IDs and the capabilities reported on each physical host socket. Old-format or inconsistent connections undergo a controlled handshake; ordinary hibernation does not globally reset them. Missing/broken reader assets in a new install are visible errors, not a silent disabled feature.

A human sends a JSON POST with `connectionId`, its memory-only `connectionToken` delivered over that socket, `epoch`, a fresh UUID `requestId`, and one operation:

```json
{"connectionId":"uuid","connectionToken":"opaque-memory-only-token","epoch":"uuid","requestId":"uuid","op":"list","path":"","cursor":null}
```

- `list`: `path` (relative directory, root empty), optional opaque `cursor` from this same directory.
- `read`: `path` (relative file).
- `changes`: no path; bounded repository discovery in the default workspace.
- `diff`: `repo` (relative repository root, empty for workspace itself), `path` relative to that repo. Neither is an absolute path or gitDir.

The authenticated URL determines the topic and computer. No owner/root/cwd is accepted from the body. The selected socket must belong to that same human account/topic/computer; the current connection token is required. An ID by itself is insufficient. The raw token is invalidated at close or a controlled connection reset and never appears in URLs, logs or persistent attachments. A socket attachment holds its domain-separated SHA-256 verifier bound to connectionId, allowing the current session, membership, computer owner and exact socket binding to be checked after hibernation. A verifier cannot be used as the raw token. Permissions, host selection and budgets are rechecked after the asynchronous digest. Acceptance is sent on that socket **before** dispatch and repeated as the HTTP response:

```json
{"type":"workspace_accepted","v":1,"requestId":"uuid","transferId":"uuid","epoch":"uuid","deadlineAt":1700000030000}
```

The server sends only the chosen host:

```json
{"type":"workspace_request","v":1,"topicId":"topic-id","computerId":"device-id","owner":"kai","viewerId":"uuid","requestId":"uuid","transferId":"uuid","epoch":"uuid","timeoutMs":30000,"op":"read","path":"src/main.ts"}
```

The `owner` is derived by the server. The daemon validates its current authenticated link/topic/device/account. `timeoutMs` is a remaining duration for a local monotonic timer; clocks need not be synchronized.

### Response stream

Host response frames contain `v`, `topicId`, `epoch`, `transferId`; server→viewer frames also contain the original `requestId`. The server derives the viewer from its pending association, never from a host-supplied destination. Every frame must match the original host socket and active association.

```json
{"type":"workspace_begin","v":1,"topicId":"topic-id","epoch":"uuid","transferId":"uuid","streams":[{"name":"file","exists":true,"bytes":3,"encoding":"utf-8"}],"meta":{"path":"src/main.ts"}}
{"type":"workspace_chunk","v":1,"topicId":"topic-id","epoch":"uuid","transferId":"uuid","seq":0,"stream":"file","offset":0,"data":"SGkK"}
{"type":"workspace_end","v":1,"topicId":"topic-id","epoch":"uuid","transferId":"uuid","streams":[{"name":"file","bytes":3,"chunks":1}],"readAt":1700000000000}
```

`begin.streams` names are file (read), before/after (diff), or json (list/changes). Existence, declared byte lengths and ordered stream names are fixed before chunks. Nonexistent sides declare `exists:false,bytes:0` and have no chunks. Empty existing files declare `exists:true,bytes:0`. Optional metadata includes file size/mtime, BOM/EOL, repository/headOid and change kind; all paths remain relative. Timestamps are epoch milliseconds. The relay assigns readAt when it accepts a complete valid end; device mtime is separate source metadata and device clocks need not match server time.

Chunks have **at most 32,768 decoded bytes**. A request has one global seq starting at 0 and increasing by 1; each stream offset starts at 0 and increases by the decoded byte count. Streams are sent in declared order. JSON frames must be no larger than 65,536 UTF-8 bytes including envelope. Validate base64, totals, offsets, lengths, stream order and final chunk counts before publishing the result. The host waits for the final cumulative ACK before sending end. A premature end fails the transfer. Content is not successful until a valid end; errors discard partial buffers.

Viewer ACK/cancel on the workspace socket:

```json
{"type":"workspace_ack","v":1,"epoch":"uuid","transferId":"uuid","requestId":"uuid","ackSeq":0}
{"type":"workspace_cancel","v":1,"epoch":"uuid","transferId":"uuid","requestId":"uuid"}
```

ACK is cumulative and never acknowledges an unsent seq. Repeated ACKs do not extend deadlines. The server validates the actual viewer socket and forwards ACK/cancel only to the original host. No more than **4 chunks** may remain unacknowledged. A completed/cancelled/expired transfer cannot be resumed or reused. Only active duplicate request IDs are rejected; completed request-ID history is not persisted.

### JSON operation results

`list` uses a json stream with:

```json
{"path":"","entries":[{"name":"src","kind":"directory"},{"name":"main.ts","kind":"file","bytes":123},{"name":"linked","kind":"link"}],"nextCursor":null,"truncated":false,"order":"filesystem","readAt":1700000000000}
```

Page size is at most 200 and may end early at the JSON byte budget. A cursor is at most 512 bytes and scoped to this topic/computer/path and directory version, not an authorization credential. Directory changes invalidate it. The server does not persist listings.

Entry kinds are file, directory, link, or special (a non-regular filesystem entry that cannot be read). Links never include their targets. The client validates operation-result schemas before building the tree or change list and ignores unknown response fields.

`changes` uses a json stream with:

```json
{"repositories":[{"repo":"app","headOid":"hex-or-null","changes":[{"path":"src/main.ts","status":" M","kind":"modified","beforeExists":true,"afterExists":true}]}],"discoveryTruncated":false,"changesTruncated":false,"unavailable":[],"readAt":1700000000000}
```

Kinds are modified/added/deleted/conflict. Both staged and unstaged changes are represented against HEAD→disk. Rename detection is disabled in v1 and appears as deleted+added. A no-repository state is valid only after complete discovery; unsupported Git layouts or truncation are explicit. New files have only after; deleted files have only before.

`diff` uses raw before/after streams, not escaped content embedded in the json stream. Per-side metadata states existence and size and pins the HEAD OID used for before. No shell command, arbitrary revision, external Git directory or external content URL is accepted.

### Limits and status

Each viewer connection has at most **2** pending operations, each account **8 within one topic across its viewer connections**, and a topic **32** total. These are not global account limits across topics. Per-request total deadline is **30 s**, no-progress deadline **5 s**. Each file/side is at most **1,048,576 bytes**, **20,000 lines** and **20,000 Unicode scalar values per line**. Diff totals at most **2,097,152 raw bytes**; list/changes json at most **262,144 bytes**. Relative paths are at most 4,096 UTF-8 bytes. Discovery is capped at depth 4, 10,000 entries and 5 s; changes at 500; list scan at 20,000 entries or 5 s.

Workspace start/cancel controls are limited to 60/min per viewer, ACKs to 2,048/min separately, and host workspace controls to 240/min. Account/topic data has a 32 MiB/min decoded-byte QoS bucket with 8 MiB burst. These counters are in-memory QoS and reset with a new server instance; they are not billing quotas. Workspace frames do not consume carry/work/approval frame allowances. Absolute frame-size checks still apply.

Server status/reset/revocation frames:

```json
{"type":"workspace_status","v":1,"epoch":"uuid","computerId":"device-id","online":false}
{"type":"workspace_reset","v":1,"epoch":"new-uuid","reason":"server_restarted"}
{"type":"workspace_revoked","v":1,"computerId":"device-id"}
```

Normal hibernation recovers connection identity and token verifiers only, with the same logical epoch; it sends no extra ready/reset and performs no automatic content read. Attachments may additionally hold at most two in-flight markers per viewer: requestId, transferId and deadlineAt. They never hold operations, paths, stream descriptions, chunks or content. After object reconstruction, each marked old transfer receives a directed workspace_error with code workspace_reset and its original requestId/transferId; a revalidated host for the same computer receives best-effort cancel. Markers are cleared, pending bytes are not recovered, and a new explicit request can start once. Such a transfer-scoped error does not reset other requests or connection credentials, even when its accepted frame had not reached the client. A true connection reset invalidates the old token and partial buffers, then sends workspace_ready with fresh credentials; affected hosts re-advertise before work resumes. Offline status keeps only previously completed viewer memory with its readAt; new or unfinished views have no old result. Reconnect updates status but does not automatically read file contents again. Revocation destroys displayed data and stops reconnects. Changing computer/closing a view cancels work and destroys its old models.

### Errors

HTTP authentication failures retain existing 401 semantics. Before authorization, missing/other-person/inaccessible computer is the same 404 `workspace_not_found`, without other device details. Error frames are terminal for a transfer:

```json
{"type":"workspace_error","v":1,"epoch":"uuid","requestId":"uuid","transferId":"uuid","code":"workspace_too_large","details":{"bytes":2097152,"limit":1048576}}
```

| Code | Meaning / client action |
|---|---|
| workspace_not_found / workspace_revoked | Selection inaccessible; clear and stop. No other computer/account existence details |
| workspace_offline / workspace_unsupported | Computer offline or host lacks v1; no queued read and no claimed current content |
| workspace_busy / workspace_rate_limited | Bound exceeded; no new work started; manual retry, optional numeric retryAfterMs |
| workspace_expired / workspace_reset / workspace_cancelled | Old transfer ended; discard partial data; manual fresh request only |
| workspace_duplicate_request / workspace_protocol_error | Duplicate active ID or invalid sequence/schema/ACK/length; fail that transfer |
| workspace_path_denied / workspace_link | Outside/noncanonical/disallowed path or link; no target/body |
| workspace_file_missing / workspace_read_failed | Missing/permission/I/O failure; safe classification, no raw OS stderr/path |
| workspace_binary / workspace_encoding | Unsupported text input; show kind/size, no content |
| workspace_too_large / workspace_line_limit | Size/line/line-length bound exceeded; show numeric bound only |
| workspace_file_changed / workspace_directory_changed | Input changed while read/paged; refresh from the start |
| workspace_result_too_large / workspace_git_unavailable | Listing/Git result or layout unsupported; show explicit partial/unavailable state |

No response contains stack traces, raw Git errors or absolute paths. No file body, directory listing or path is persisted or logged by the server. No workspace content enters topic exports/search/messages/attachments.

