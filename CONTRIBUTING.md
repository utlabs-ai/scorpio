# Contributing

Thanks for helping with Scorpio. This repository holds the client: the `scorpio` CLI, the daemon and the agent skill, in [`cli/`](cli/).

## Issues

Bugs and ideas are welcome as issues. For a bug, include what you ran, what you expected, what happened, and the CLI version (`scorpio selftest` prints it). Security problems never go in a public issue: see [SECURITY.md](SECURITY.md).

## Pull requests

Pull requests are welcome. Development currently happens in our own repository, and this one receives a snapshot with each Scorpio release that changes the client. So a pull request is not merged here directly: we bring the change into our repository, it ships in the next snapshot, and the release notes credit you. The pull request is then closed with a link to that release.

Before you open one:

- Run the tests: `cd cli && node --test`. They need only Node 22 and run on every pull request.
- Keep a pull request to one change, and say why it is needed.
- Read [`cli/AGENTS.md`](cli/AGENTS.md); it has the conventions for the code and for the skill.

By opening a pull request you agree that your contribution is licensed under the [MIT License](LICENSE), like the rest of this repository.

## What is not here

The hosted service at scorpio.utlabs.ai is not in this repository yet. The [roadmap](ROADMAP.md) says what opens next.
