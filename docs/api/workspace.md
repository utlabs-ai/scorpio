# Workspace files (v1)

A person may read directories that their own computer's daemon system account can read, for a topic they currently belong to. This is a read-only human view, not an agent command or a change to any process working directory. Contents are relayed live and are not stored as topic messages or attachments.

The human web endpoints are relative to the site origin, **not** `/api/v1`: `GET /r/{topicId}/workspace`, `GET .../workspace/hosts`, `GET .../workspace/ws?computer={computerId}` and `POST .../workspace/request?computer={computerId}`. Session authentication and same-origin checks apply. Agent tokens cannot start reads. The daemon uses its existing authenticated topic host connection.

### Identity and acceptance

The workspace socket sends:

```json
{"type":"workspace_ready","v":1,"connectionId":"uuid","connectionToken":"opaque-memory-only-token","epoch":"uuid","computer":{"computerId":"device-id","name":"box","online":true,"workspaceProtocol":1}}
```

The daemon advertises on its host connection (new daemons enable this by default; there is no opt-in flag):

```json
{"type":"workspace_capabilities","v":1,"ops":["list","read","changes","diff"],"directoryNavigation":1}
{"type":"workspace_host_ready","v":1,"epoch":"uuid","computerId":"device-id"}
```

The second frame is the server reply to that host. An epoch identifies a live connection group, not a server object construction. Normal hibernation retains the epoch, connection IDs and the capabilities reported on each physical host socket. Old-format or inconsistent connections undergo a controlled handshake; ordinary hibernation does not globally reset them. Missing/broken reader assets in a new install are visible errors, not a silent disabled feature.

A human sends a JSON POST with `connectionId`, its memory-only `connectionToken` delivered over that socket, `epoch`, a fresh UUID `requestId`, and one operation:

```json
{"connectionId":"uuid","connectionToken":"opaque-memory-only-token","epoch":"uuid","requestId":"uuid","op":"list","path":"","cursor":null}
```

- `list`: `path` (relative directory, root empty), optional opaque `cursor` from this same directory.
- `read`: `path` (relative file).
- `changes`: no path; bounded repository discovery below the selected directory.
- `diff`: `repo` (relative repository root, empty for workspace itself), `path` relative to that repo. Neither is an absolute path or gitDir.

The authenticated URL determines the topic and computer. No owner or execution cwd is accepted from the body. The selected socket must belong to that same human account/topic/computer; the current connection token is required. An ID by itself is insufficient. The raw token is invalidated at close or a controlled connection reset and never appears in URLs, logs or persistent attachments. A socket attachment holds its domain-separated SHA-256 verifier bound to connectionId, allowing the current session, membership, computer owner and exact socket binding to be checked after hibernation. A verifier cannot be used as the raw token. Permissions, host selection and budgets are rechecked after the asynchronous digest. Acceptance is sent on that socket **before** dispatch and repeated as the HTTP response:

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

`begin.streams` names are file (read), before/after (diff), or json (list/changes/locations). Existence, declared byte lengths and ordered stream names are fixed before chunks. Nonexistent sides declare `exists:false,bytes:0` and have no chunks. Empty existing files declare `exists:true,bytes:0`. Optional metadata includes file size/mtime, BOM/EOL, repository/headOid and change kind; content paths remain relative; directory metadata carries the canonical absolute selected root. Timestamps are epoch milliseconds. The relay assigns readAt when it accepts a complete valid end; device mtime is separate source metadata and device clocks need not match server time.

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

Git metadata is hidden and cannot be read, including a name such as `.GIT` when the filesystem resolves it to `.git`. A separate `.GIT` directory on a case-sensitive filesystem remains ordinary content.

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

No response contains stack traces or raw Git errors. Absolute paths occur only in validated directory/location metadata. No file body, directory listing or path is persisted or logged by the server. No workspace content enters topic exports/search/messages/attachments.


### Directory navigation extension

Wire v1 keeps its original four advertised `ops`. A host additionally advertises optional `directoryNavigation:1`, enabling `locations` and optional `directory` on the original operations. Computer summaries in ready/status/hosts carry `directoryNavigation:1|null`. This capability belongs to the current physical host socket and survives normal hibernation as bounded capability metadata. A server rejects extension requests with `workspace_unsupported` if that socket has no capability; it never strips a directory to read the default workspace. An old server can ignore the optional capability and continue its original operations. A new UI requires the extension, with no silent fallback.

Each operation independently selects its root; there is no mutable daemon/server current directory. Omission preserves the original default-topic-workspace meaning, never a previous selection. The request-body budget is 16,384 UTF-8 bytes (413 on overflow). Each absolute/relative path separately remains limited to 4,096 bytes.

```json
{"op":"list","path":"","cursor":null,"directory":{"path":"/home/kai/project"}}
{"op":"read","path":"src/main.ts","directory":{"path":"/home/kai/project","id":"1:12345"}}
```

These examples show operation fields; ordinary connection credentials and requestId are still required. `directory` must be an object with only `path` and optional `id`. Absolute POSIX syntax is `/` or nonempty segments: no NUL, backslash, empty/dot/dot-dot segment or trailing slash. No trimming, Unicode rewriting or secondary URL decoding. An id is decimal dev:ino, 1–32 digits on each side. Only an initial `list,path="",cursor=null` may omit id. Every later explicit operation and page carries the returned id. `directory:null` is invalid. Native Windows drives/UNC are outside this extension.

The daemon canonicalizes the initial root with realpath, allowing root/ancestor aliases, confirms a readable directory and records dev/ino. The candidate and physical path cannot traverse Git metadata, including actual case-insensitive `.git` aliases. Content links are still not followed; `.ssh`/`.env` are ordinary content subject to OS permissions and existing bounds. Each request uses one immutable scope for file and Git reads, rechecking root/ancestor identity. A bound id mismatch is `workspace_directory_changed`; normal child additions do not invalidate root identity. The non-atomic same-machine path-race limitation remains. No extra listener, permission elevation or filesystem sandbox is introduced.

Every successful explicit operation except locations includes validated begin metadata:

```json
{"directory":{"path":"/home/kai/project","id":"1:12345"},"defaultWorkspace":false}
```

Publish this identity/tree/preference only after a complete valid end. The sole id-less successful exception is the actual missing default workspace: meta.defaultWorkspace=true, list.rootMissing=true and empty entries. It creates no directory and cannot drive later bound reads. Other missing directories fail. Cursors bind topic, computer, canonical root path/id, relative path, directory version and offset within 512 bytes; cross-root/device reuse and changed versions fail.

`locations` has no directory/path/repo/cursor. Its bounded json stream contains:

```json
{"defaultPath":"/home/kai/.scorpio/topics/aaaaaaaaaaaaaaaaaaaaaa/workspace","homePath":"/home/kai","entries":[{"path":"/home/kai/.scorpio/topics/aaaaaaaaaaaaaaaaaaaaaa/workspace","kinds":["default"]},{"path":"/home/kai","kinds":["home"]},{"path":"/home/kai/project","kinds":["agent"]}],"truncated":false}
```

Sources are workspaceFor(topicId), the daemon system account's os.homedir(), and valid dir fields in that topic's existing spawn JSON records. Only the fixed bookkeeping directory is enumerated, never target content or other topics; bad records count toward the scan bound but produce no entry. Missing bookkeeping directory means no records; other read failures return workspace_read_failed. Deduplicate canonical-syntax literal paths and merge kinds, default/home first and agent paths sorted. At most 200 distinct entries, 10,000 scanned records, 5 seconds and 262,144 JSON bytes; any limit makes truncated=true. No target directory is prevalidated. These are shortcuts, never an allowlist.

Git scans only downward from this same scope: selecting an inner folder does not borrow a parent repository. Root access errors cannot become noRepository. Original bounds and unsupported Git layouts/filter refusal remain. Empty nondefault directories are successful empty entries; partial Git discovery/changes is always explicit.

Navigation first increments a local generation, cancels all old jobs/queues, disposes models and clears tree, changes, selection, filename and read time. Only this generation's complete root list can publish scope, then start changes with its id. Late pages, reads, diffs, changes, accepted frames, render work and errors cannot change the new view or preference. Same-root refresh checks the bound root before restoring bounded expanded directories and selection. Reconnect never automatically requests any of the five content operations; completed memory remains stale until manual refresh.

The sole path-storage exception is browser localStorage `view-files-directory-v1:<account>:<computerId>`, holding one last fully successful canonical root path, across topics on that stable computer ID. Trusted viewerAccount comes from authenticated page bootstrap. No id/history/selection/content is stored. Invalid values are discarded; unavailable storage uses the default on the next open. A saved missing/denied/non-directory path shows its error without silent fallback. Logout/account deletion clears that account's preferences. Server stores/logs no paths, locations or content; attachment recovery still holds only identity/verifier, capability and at most two request/transfer/deadline markers.

| Additional code | Meaning |
|---|---|
| workspace_directory_missing | Nondefault selected directory does not exist |
| workspace_directory_denied | Selected directory cannot be listed by the daemon's system account |
| workspace_not_directory | Selected path is not a directory |

These errors clear old content and retain navigation, with no raw OS error or path in error details. Ordinary file failures retain their existing classification.

Optional `locations.entries[].agents` displays full names derived from that same valid spawn record's `<role>.json` filename and the authenticated daemon account; JSON name/account fields are ignored. Role is `[A-Za-z0-9_.-]{1,62}`, full name `^[A-Za-z0-9_.-]{1,62}@[A-Za-z0-9_.-]+$`, at most 128 UTF-8 bytes. It is a recent spawn association, not proof of current cwd or online state. Merge labels on the literal path, including default/home matches, deduplicate and ASCII-sort; keep the first 32 valid names per entry and mark truncated for extra valid names. Invalid labels never erase a valid dir. Names count within the existing total JSON budget; omit only complete names/entries with truncated=true, never cut strings. Shared schema rejects malformed agents; absent/empty arrays are compatible. Labels use textContent, stay only in live viewer memory, and do not affect authorization/scope/cursors/Git.
