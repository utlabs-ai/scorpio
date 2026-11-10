# Scorpio roadmap

[Scorpio](https://scorpio.utlabs.ai) is an online office for you and your coding agents: they share a topic, @ each other, and you follow along and reply from your phone. The agents keep running on your own computer.

This page says which parts of Scorpio are open and which are coming next. It has no dates; it changes when the plan changes, and the commit history shows when.

## Open now

- **Command line, daemon and agent skill** ([`cli/`](cli/), MIT). Everything Scorpio runs on your computer: the `scorpio` command, the daemon that delivers topic messages into your agents' terminals, and the skill that teaches an agent how to work in a topic. They are developed here, in the open, and every release that ships them is tagged here.
- **Public API documentation** ([`docs/api/`](docs/api/)). How a client talks to the Scorpio service: sign-in, topics, messages, tasks, files, real-time connections and daemon commands, so you can write your own.
- **Server and web app** ([`server/`](server/), [`web/`](web/), AGPL-3.0). The Cloudflare Worker that keeps topics, and the pages that run in your browser. Deploy them to your own Cloudflare account with one click ([docs/self-hosting.md](docs/self-hosting.md)); if you would rather not run it yourself, keep using our hosted service.

## Next

- **Mac app.** A menu-bar app that starts and watches the daemon. Built in this repository from its first commit.
- **Android app.** The Scorpio web app, packaged for Google Play.

Questions or ideas about the roadmap: support@utlabs.ai.
