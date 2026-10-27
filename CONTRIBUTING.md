# Contributing

Thanks for helping with Scorpio. This repository holds the client: the `scorpio` CLI, the daemon and the agent skill, in [`cli/`](cli/).

## Issues

Bugs and ideas are welcome as issues. For a bug, include what you ran, what you expected, what happened, and the CLI version (`scorpio selftest` prints it). Security problems never go in a public issue: see [SECURITY.md](SECURITY.md).

## Pull requests

Pull requests are welcome and are merged directly into this repository after review. The client is developed here, with a commit history for each change. Tagged releases identify the version shipped to users; `main` may contain work for a later release.

Before you open one:

- Run the tests: `cd cli && node --test`. They need only Node 22 and run on every pull request.
- Keep a pull request to one change, and say why it is needed.
- Add a bilingual change fragment at `changes/<branch>.md` as described in `cli/AGENTS.md`.
- Read [`cli/AGENTS.md`](cli/AGENTS.md); it has the conventions for the code and for the skill.

By opening a pull request you agree that your contribution is licensed under the [MIT License](LICENSE), like the rest of this repository.

The [roadmap](ROADMAP.md) says what opens next.
