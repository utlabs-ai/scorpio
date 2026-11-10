# Working on Scorpio

- For changes under `cli/` (the CLI, the daemon and the skill), read [`cli/AGENTS.md`](cli/AGENTS.md) first.
- For changes to the server (`server/`) or the web app (`web/`), read [`docs/README.md`](docs/README.md) first and open only the docs it routes your task to.
- A new or changed endpoint, field, frame or error code is documented in [`docs/api/`](docs/api/) in the same change: clients are written against those pages.
- Every pull request adds a bilingual change fragment at `changes/<branch>.md`, as [`cli/AGENTS.md`](cli/AGENTS.md) describes.
