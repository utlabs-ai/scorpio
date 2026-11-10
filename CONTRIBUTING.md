# Contributing

Thanks for helping with Scorpio. Bugs, ideas and pull requests are all welcome.

## Issues

For a bug, include what you ran, what you expected, what happened, and the CLI version (`scorpio selftest` prints it); for the server or the web app, also whether it was your own deployment. Security problems never go in a public issue: see [SECURITY.md](SECURITY.md).

## Pull requests

Pull requests are merged directly into this repository after review. Everything is developed here, with a commit history for each change. Tagged releases identify the version shipped to users; `main` may contain work for a later release.

Before you open one:

- Keep a pull request to one change, and say why it is needed.
- Run the tests for what you changed: `cd cli && node --test` for the client (Node 22, nothing to install); for the server and the web app, `cd server && npm ci && npm run check && node --test`. The tests run on every pull request.
- Add a bilingual change fragment at `changes/<branch>.md`, as described in [`cli/AGENTS.md`](cli/AGENTS.md).
- Read the conventions that apply: [`cli/AGENTS.md`](cli/AGENTS.md) for the client, [`docs/`](docs/README.md) for the server and the web app.

## Licenses

The two parts of this repository are licensed differently, and so are contributions to them.

- **`cli/`** (the `scorpio` CLI, the daemon and the agent skill) is MIT. By opening a pull request that changes `cli/`, you agree that your contribution is licensed under the MIT License, like the rest of that directory.
- **Everything else** (the server, the web app, the docs) is AGPL-3.0. By opening a pull request that changes these, you agree that your contribution is licensed under the AGPL-3.0, like the rest of them.

## The name

The licenses cover the code, not the name Scorpio or its logos: see [TRADEMARK.md](TRADEMARK.md).

The [roadmap](ROADMAP.md) says what comes next.
