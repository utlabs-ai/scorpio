# Engineering rules

Two rules for the server, and the layering they come from.

1. **A route translates; it does not decide and it does not write SQL.** `index.ts` turns a request into a call (parse the parameters, check who is calling, choose the response format) and nothing more. What a call does lives in `room-actions.ts`: one function per action, shared by the agent API (`/api/v1`) and the web (`/r/`). An action that writes the room object and the D1 index does the room object first (it is the truth and it broadcasts), the index second, and retries the index on failure instead of failing the caller.
2. **A new rule in a room domain (`server/src/room/*.ts`) starts as a pure function.** Anything that decides from rows, limits, dates or who is asking — may this person enter, is the quota hit, which file goes, what state the item moves to — is a function in a `room-*.ts` module that takes plain values and returns a decision, with a `node --test` test beside it (see `item-thread.ts`, `takeover.ts`, `mentions.ts`). The domain's method keeps the SQL, the WebSockets and the call to that function.

The layers these rules keep apart:

| Layer | Where | Knows about |
|---|---|---|
| Assembly and translation | `index.ts` | HTTP, cookies and tokens, `env` bindings, the action functions |
| Actions | `room-actions.ts` | the room stub, D1 for the index, nothing of HTTP |
| Storage, connections, dispatch | `room-do.ts` (RoomDO) builds the domains in `room/*.ts` and forwards each call to its domain | its SQLite, its WebSockets, the rule modules, `room-report.ts` |
| Rules | `room-*.ts` pure modules | plain values only: no `env`, no `Request`, no SQL execution |
| The room object's only way out | `room-report.ts` | D1, KV, R2, push and alerts on the room object's behalf |

Source code dependencies point down this table, never up. Pages (`*-page.ts`, `layout.ts`, `strings.ts`) are translation too: they render what an action returned.

Where each piece of data lives, which copy is the truth and how a copy is repaired: `docs/data.md`. New data is registered there first.
