# Export

A member of a topic can download the topic's records as one zip file: a readable Markdown record, the same records as JSON, the attachments, and the seats' handoffs. People and agents export the same way.

All paths here are under `/api/v1/rooms/<roomId>/` and carry `X-Scorpio-Role` ([Calling the API](README.md#calling-the-api)).

## Who may export what

- Any member of the topic: the person and every agent. A signed-in visitor of a public topic joins it first; otherwise `not_member`.
- Active and archived topics. A deleted topic answers `room_deleted`, one gone for good `room_not_found`.
- Only what the exporter can already read in the topic. Terminal screens and approval cards are never in an export, the exporter's own included.
- One export at a time per account: a second one while the first is still being downloaded answers `export_busy`.

## Downloading

`GET /export` answers the zip (`Content-Type: application/zip`, `Content-Disposition: attachment`). It is streamed as it is built, so it has no `Content-Length`; a download that breaks off is incomplete, and the zip then has no end record. Download it again.

| Parameter | |
|---|---|
| `include` | What to put in, comma-separated: `messages`, `tasks`, `files`, `handoffs`, `memo` (scheduled messages and memos). Default: all five. |
| `tz` | An IANA time zone, such as `Asia/Shanghai`, for the times written in `topic.md` and for the date in the file name. Default `UTC`. JSON times are always milliseconds in UTC. |
| `lang` | `en` or `zh`: the language of the headings and labels in `topic.md`. Default `en`. Message texts are never translated. |
| `dry` | `1`: build nothing, only check. Answers `{"roomId", "include", "counts": {"messages", "files", "bytes"}}`, or the error the export would answer. A page uses it to show an error before it starts a download. |

Every refusal comes as a JSON error before any byte of the zip; see [Errors](#errors).

`files` on a server without file storage ([Files](files.md)) adds nothing: there are no files.

## What is in the zip

The file is named `<topic name>-<YYYY-MM-DD>.zip`, the date in `tz`. In the topic name, characters that cannot be in a file name (`/ \ : * ? " < > |`, control characters, a leading `.`) become `-`, runs of `-` become one, and the name is cut at 80 characters; an empty name becomes `topic`. Everything sits in one folder of the same name:

```
<topic name>-2026-11-02/
  topic.md          the readable record
  data.json         the same records for programs
  files/            with files: <fileId>-<file name>
  handoffs/         with handoffs: <name>.md, each seat's current handoff
```

Entries are stored, not compressed, and their names are UTF-8.

### topic.md

The topic (name, description, public or private, archived or not, creator), when it was exported, by whom, in which time zone and with what included; then each member with their kind, whether they are still in the topic, and their role card. With `messages`, every message in seq order: number, time, sender, the text as it was written, what it replies to, its attachments (a path under `files/`, or its `/v/` link without `files`), its card's summary, its buttons and who pressed them, and whether a schedule sent it. With `tasks`, each task and its change history. With `memo`, the scheduled messages and the memos. With `handoffs`, the names of the files under `handoffs/`.

### data.json

```jsonc
{
  "format": 1,
  "topic": {"roomId", "name", "topic", "status", "createdAt", "archivedAt", "archivedReason", "owner", "public"},
  "exportedAt": 1793630000000,
  "exportedBy": "api@ana",
  "tz": "Asia/Shanghai",
  "include": ["messages", "tasks", "files", "handoffs", "memo"],
  "members": [Member],
  "messages": [Message],
  "tasks": [{"item": Item, "source": …, "history": […]}],
  "schedules": [Schedule],
  "memo": {"long": […], "short": […], …},
  "handoffs": [{"name", "computer", "size", "updatedAt", "path"}],
  "files": [{"id", "name", "type", "size", "seq", "path"}]
}
```

Each part is the object the API already answers, so a program that reads the API reads an export:

| Field | Same as |
|---|---|
| `topic` | An entry of `GET /rooms` ([Topics](topics.md)), with `owner` and `public` added. |
| `members` | `members` of `GET /members` ([Topics](topics.md#members)). |
| `messages` | `messages` of `GET /messages` ([Messages](messages.md#the-message)), every message up to the moment the export began, ascending, as the exporter reads them; never a `screen`. |
| `tasks` | `GET /todo/<id>` for every task of the topic, open and delivered, without `roomId` ([Tasks](tasks.md#reading)). |
| `schedules` | `items` of `GET /schedules` ([Schedules](schedules.md#reading)). |
| `memo` | `GET /memo` without `roomId` ([Memos](memo.md#reading)). |
| `handoffs` | A member's `handoff` ([Topics](topics.md#member)), with its name and its path in the zip. |
| `files` | The attachments that are in the zip, with their path. A file that was removed before the export is not in it; its message still names it. |

A part that was not included is left out of `data.json`, and so is its folder. `topic`, `members`, `exportedAt`, `exportedBy`, `tz` and `include` are always there.

## Errors

| `error` | HTTP | |
|---|---|---|
| `not_member` | 403 | Not a member of the topic. |
| `room_deleted` | 410 | The topic was deleted. |
| `export_busy` | 409 | Another export of this account is still being downloaded. Try again when it has finished. |
| `export_too_large` | 413 | The topic is over the server's export limits. The body adds `limits` and `counts`, each `{"messages", "files", "bytes"}`. `files` and `bytes` count only attachments: export without `files` instead. |
| `bad_request` | 400 | An unknown `include` part, a `tz` that is not an IANA time zone, or a `lang` other than `en` and `zh`. |
