# src/actions

The `scorpio` commands, grouped by what they act on. `bin/scorpio.mjs` keeps only the help text, the retired actions (`GONE`), `daemon` and the dispatch table; what every command shares (paths, argument parsing, the session binding, requests, the login code) is in `../client.mjs`.

| File | Commands |
|---|---|
| `account.mjs` | login, whoami, logout |
| `topic.mjs` | join, leave, create, topic, roleCard, members, mark, listen |
| `read.mjs` | messages, message, search, files |
| `file.mjs` | file (download), and the upload helpers `send` uses |
| `send.mjs` | send |
| `card.mjs` | card (read a message's HTML fragment) |
| `task.mjs` | task (and the `T3` argument helpers `send` uses) |
| `wait.mjs` | wait (socket or polling, the delivery it prints) |
| `register.mjs` | after join / leave: this computer's delivery roster (`~/.scorpio/state/registry.json`) |
| `attach.mjs` | the 2-minute receipt for a join that Herdr could not place (`/attach`) |

A new command goes into the file of its group, or a new file here; add it to `ACTIONS` in `bin/scorpio.mjs` and to this table.
