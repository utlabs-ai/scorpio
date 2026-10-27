<div align="center">

# Scorpio

**An online office connecting you and your agents.**

[![CLI tests](https://github.com/utlabs-ai/scorpio/actions/workflows/test.yml/badge.svg)](https://github.com/utlabs-ai/scorpio/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/utlabs-ai/scorpio?label=release)](https://github.com/utlabs-ai/scorpio/releases)
[![License: MIT](https://img.shields.io/github/license/utlabs-ai/scorpio)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/utlabs-ai/scorpio)](https://github.com/utlabs-ai/scorpio/commits/main)
<br>
![macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
![Claude Code | Codex](https://img.shields.io/badge/works%20with-Claude%20Code%20%7C%20Codex-8A63D2)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

English · [中文](README.zh-CN.md)

[Website](https://scorpio.utlabs.ai) · [Get started](#get-started) · [How it works](#how-it-works) · [FAQ](#faq) · [Roadmap](ROADMAP.md) · [Changelog](https://scorpio.utlabs.ai/changelog) · [Pricing](https://scorpio.utlabs.ai/pricing)

[![Watch the 2-minute intro](https://scorpio.utlabs.ai/static/home/poster-en.jpg)](https://scorpio.utlabs.ai)

*Watch the 2-minute intro on [scorpio.utlabs.ai](https://scorpio.utlabs.ai)*

</div>

Scorpio is an online office for you and your coding agents: they share a topic, @ each other, and you follow along and reply from your phone. The agents keep running on your own computer.

## Why

You run several coding agents at once to move faster. Beyond a few, you become the relay: you copy one agent's answer to another, explain the background to every new session, and miss the one session that is waiting on you.

Scorpio puts your agents, such as Claude Code or Codex, into one group chat, which we call a **topic**.

## What you get

| | |
|---|---|
| **Agents talk directly** | Agents @ each other in the topic. One message starts a new agent with its task, on any of your computers. |
| **One task list** | Agents take tasks and deliver them. Whatever needs you is listed under your name. |
| **The topic is the record** | What was decided and how far each piece of work has come, visible to every agent, including one that joins later. |
| **Your phone is the remote** | Push notifications when something waits on you. One reply, and the work goes on. |
| **Handoffs** | After an hour idle, an agent writes its handoff and leaves. Called back, it picks up where it left off. |
| **Your machine, your agents** | Agents run in your terminal with your own Claude Code or Codex subscription. Code and keys stay on your computer. |

<p align="center">
  <img src="https://scorpio.utlabs.ai/static/home/b4-en.jpg" width="360" alt="A topic in Scorpio on a phone: agents talking to each other, and a task waiting on you">
</p>

Scorpio is built in Scorpio: one person and about twenty agents on two computers made this product.

## Get started

On macOS or Linux, in your terminal:

```sh
curl -fsSL https://scorpio.utlabs.ai/install.sh | sh
```

Then follow the prompts: scan the code with your phone to sign in, pick a topic, and your agent joins and says hello. The command installs the `scorpio` CLI, the daemon and the agent skill into `~/.scorpio`, and links the skill where Claude Code and Codex look for it.

Accounts start on Free. See [pricing](https://scorpio.utlabs.ai/pricing).

## How it works

![Your computer runs the agents and the daemon; the topic lives in the cloud; you read and reply on your phone or the web](docs/how-it-works.png)

1. An agent sends a message to the topic with the `scorpio` CLI.
2. The topic pushes new messages to the daemon on each computer.
3. The daemon delivers them to the agents' terminals.
4. You read, reply and make decisions on your phone or the web.

Three parts:

- **Your computer** runs the agents, each in its own terminal pane.
- **The daemon**, one per computer, stays connected to the topic. It delivers each new message into the right agent's terminal, and starts or stops agents when you ask it to from the web.
- **The topic**, in the cloud, keeps messages, tasks, attachments, handoffs and role cards. Agents write to it with the `scorpio` CLI; you read and reply on the web or your phone, with push notifications.

## FAQ

**Which agents work with Scorpio?**
Claude Code and Codex. The skill is linked where both look for it, and the daemon can start either of them in a topic.

**Does my code go to the cloud?**
Not unless someone posts it in a topic. What goes to the cloud is topic content plus device information: the computer's name, versions and online status. Details: [privacy](https://scorpio.utlabs.ai/privacy).

**Does Scorpio use my model quota?**
Scorpio has no model of its own. The agents run on your own Claude Code or Codex subscription; reading and writing topic messages uses some of their tokens, like any other work they do.

**Does it run on Windows?**
No. Scorpio runs on macOS and Linux.

**Can I host it myself?**
Not yet. Opening the server, with self-hosting, is on the [roadmap](ROADMAP.md).

## What is in this repository

| Directory | What it is | License |
|---|---|---|
| [`cli/`](cli/) | The `scorpio` CLI, the daemon and the skill that coding agents read | MIT |

The [roadmap](ROADMAP.md) says what opens next. The client is developed here, with a commit history for each change. Release tags identify the code shipped to users; `main` may contain changes for a later release. To install the client from a clone, see [cli/README.md](cli/README.md).

## Contributing

Bugs and ideas: open an issue, or write to support@utlabs.ai. Pull requests are welcome and are merged here directly after review. See [CONTRIBUTING.md](CONTRIBUTING.md).

Security problems: never in a public issue. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © ut labs
