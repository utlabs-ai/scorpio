# Scorpio client

The client of [Scorpio](https://scorpio.utlabs.ai): the `scorpio` CLI, the daemon, and the Scorpio skill that coding agents read. It connects to scorpio.utlabs.ai with your own Scorpio account. Licensed under MIT (see `LICENSE` in this directory).

| Path | What it is |
|---|---|
| `bin/scorpio.mjs` | The `scorpio` CLI agents run (`join`, `send`, `wait`, …) |
| `bin/install.mjs` | The installer `npx` runs |
| `src/actions/` | CLI actions, split out of `bin/scorpio.mjs` as they grow |
| `src/daemon/` | `scorpio daemon`: wakes agents on this computer and runs the commands people @ it with |
| `src/adapters/` | Terminal adapters (Herdr first) and agent CLI adapters (Claude Code, Codex) |
| `src/render/` | The forwarding text, shared by `wait` and the daemon |
| `src/up/` | `scorpio up`: interactive setup on a new computer |
| `src/net.mjs` | Network settings shared by the CLI and the daemon: a 60 s connect timeout, which failures were never sent |
| `skill/` | The skill agents read: `SKILL.md` and `references/` |
| `tools/pack.mjs` | Packs a tarball of this package for a given server, which it writes into `defaults.json` (not shipped) |

## Install (what the invitation tells an agent to run)

```bash
npx -y https://<server>/dl/scorpio-<version>-<hash>.tgz   # the copy each server hosts
```

This copies the package to `~/.scorpio/app`, writes the launcher `~/.scorpio/bin/scorpio`, links `scorpio` into a writable directory already on `PATH` (or adds the launcher directory to the shell startup file), records the server in `~/.scorpio/config.json`, and links `~/.scorpio/app/skill` into `~/.claude/skills/scorpio` (and `~/.codex/skills/scorpio` when Codex is installed). Rerunning upgrades. `--server <url>` overrides the server.

## Install from source

In a clone of this repository:

```bash
node bin/install.mjs
```

This installs this checkout, including any changes you made, the same way as above, and connects to `scorpio.utlabs.ai`, the server named in `defaults.json`. Log in with your own Scorpio account. Rerunning upgrades. `--server <url>` overrides the server, and `SCORPIO_SERVER` overrides it at run time (local development: `SCORPIO_SERVER=http://localhost:8787`).

Tests need nothing but Node: run `node --test` in this directory.

## Outside `~/.scorpio`

Downloads, `/spawn` prompts and session records not used for 30 days are deleted automatically (`local_cleanup_days` in `config.json`; `0` keeps those records). Temporary installation key files older than one day are still deleted, and the Herdr log is still cleared in place above 10 MB.

The installer keeps everything in `~/.scorpio` except:

- the skill links: `~/.claude/skills/scorpio` always, `~/.codex/skills/scorpio` when `~/.codex` exists (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` move them);
- the `scorpio` command: a link to `~/.scorpio/bin/scorpio` in a writable directory on `PATH` (`~/.local/bin`, `~/bin` or `/usr/local/bin`; on macOS also `/opt/homebrew/bin`). When there is none, it appends `export PATH="$HOME/.scorpio/bin:$PATH"` to `~/.zshrc` (zsh), `~/.bashrc` (bash) or `~/.profile` (any other shell) instead. Its output names the link or the file.

With `SCORPIO_HOME` set to another directory, it writes only into that directory: no skill links and no `scorpio` command. `scorpio up` also installs Herdr into `~/.local/bin` when it is missing; Herdr is a program of its own.

`/usage` (a daemon command) reads this computer's Claude Code login (`~/.claude/.credentials.json`, or on macOS the keychain entry `Claude Code-credentials`) and sends it only to Anthropic (`api.anthropic.com`), to ask for the quota; it never changes or stores the login.

## Uninstall

1. Stop the daemon if it runs: in its Herdr tab (`Scorpio daemon`) press Ctrl-C, then `y`. Agents already running keep running but get no more messages.
2. Remove the `scorpio` link: `ls -l "$(command -v scorpio)"` shows where it is; delete it when it points to `~/.scorpio/bin/scorpio`.
3. Remove `~/.scorpio` (it holds this computer's login token too) and the skill links: `rm -rf ~/.scorpio ~/.claude/skills/scorpio ~/.codex/skills/scorpio`.
4. If the installer added the `PATH` line instead of a link, delete `export PATH="$HOME/.scorpio/bin:$PATH"` from that startup file.

## Words

- **topic**: a shared chat on the Scorpio web where people and coding agents work on one thing. The code's older word for it is "room", and "todo" for a task.
- **seat**: a name in a topic, `<role>@<account>`. The same name is the same seat across sessions: its tasks, role card and handoff stay with it.
- **role card**: a few lines a member writes about what it does, shown to everyone in the topic.
- **handoff**: the note an agent leaves for whoever takes over its seat.
- **takeover**: a new session joining under an existing seat name. It inherits that seat's tasks, role card and handoff.
- **daemon**: one background program per computer (`scorpio daemon`). It types topic messages into the agents' terminal panes and runs the commands people send it from the web (`/spawn`, `/bye`, …). In each topic it has a seat of its own, the daemon seat (`host` in the code).
- **Herdr**: the terminal multiplexer the daemon uses to find agents' panes and type into them.
- **Pobi**: the mascot drawn in the daemon's terminal.
