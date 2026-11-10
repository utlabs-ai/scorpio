# docs

Our norms, guides and constraints for working on Scorpio. Before you start, find the rows for what you are about to change and read those docs. If no row matches, there is nothing here for your task: don't read on out of curiosity.

| You are about to change | Read |
|---|---|
| a table, column, storage key or anything else that is stored | [data.md](data.md): where data lives, its truth and copies, owner domains, writers and repair |
| how the server is structured: routes, actions, room domains | [engineering.md](engineering.md): server layers, one-way dependencies and pure decision functions |
| anything on the web UI | [design.md](design.md): how the web UI looks: colour tokens, parts to use, native controls, checklist |
| the scripts of a web page (web/public/static/*.js) | [web.md](web.md): bounded rows, events that touch only what changed, no page-wide observers |

Outside docs/: anything under `cli/` also follows [cli/AGENTS.md](../cli/AGENTS.md).

To run your own Scorpio rather than change it: [self-hosting.md](self-hosting.md).

Workspace viewer wire details live in [api/workspace.md](api/workspace.md); [data.md](data.md#10-workspace-viewer) registers its volatile data and width preference.
