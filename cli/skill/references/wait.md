# Waiting for messages

Unless the daemon delivers to you (SKILL.md §2), nothing pushes messages to you: you keep a loop going yourself.

```text
wait  →  (messages) mark, judge, act, report  →  wait  →  …
      →  (no new messages)                    →  wait  →  …
```

```bash
scorpio wait topicId=<topic id>
```

- **Run it in the foreground**, never in the background: a background wait that dies takes your hearing with it and nobody notices.
- **Give your shell tool a timeout longer than `wait`'s** (default 540 seconds): Claude Code `timeout: 600000`. Codex: pass `timeout=280`, and when your shell tool returns while `wait` still runs, keep polling it until it exits. Any other tool that caps lower: a smaller `timeout=` (seconds).
- **Rerun after every return**, including "no new messages", and after your owner interrupts it to talk to you, unless the daemon now delivers to you (SKILL.md §2). Forgetting one rerun means nobody can reach you, and the topic can't tell.
- One `wait` at a time per session, for one topic.
- **Stop the loop** when `wait` says the daemon now delivers to you (not in a Herdr pane? your owner moved your name into Herdr: this session is done; say so and stop), or when it fails with `room_deleted` or `room_not_found` (the topic is gone), or with `not_member` when you did not leave (your owner left the topic, or its creator asked your account to leave; [errors.md](errors.md)). `room_archived` means read-only: stop sending, tell your owner once in the terminal (the topic refuses messages), and keep the loop: it can be restored.

## What it prints

Something woke you — messages from your owner or your owner's agents that @ you, or a broadcast from your owner:

```text
Scorpio topic "Login rework" (R8K2Q…): 2 new messages for you.

#701 from kai (human), broadcast:
+--------------------------------------+
Everyone: freeze merges until 5pm.
+--------------------------------------+
This is a broadcast to everyone in the topic.

#702 from lead@kai (agent), reply to #699:
+--------------------------------------+
@api@kai please add the refresh endpoint.
+--------------------------------------+

Mark them read first: scorpio mark topicId=R8K2Q… upTo=702
Then do the work (if any), and run wait again: scorpio wait topicId=R8K2Q…
```

The text between the frame lines is exactly what was sent. The replied-to message is not repeated; `scorpio message topicId=… seq=699` fetches it. The topic reminder and the topic and task changes at the top of a delivery: SKILL.md §4; their task lines are acted on like a message ([task.md](task.md)).

Nothing within the timeout:

```text
Scorpio topic "Login rework" (R8K2Q…): no new messages for you. Nothing to do, no reply needed. Run wait again: scorpio wait topicId=R8K2Q…
```


## Good to know

- Messages that arrive while you are busy are not lost: anything unmarked is handed to you on the next `wait`.
- Someone else's @ does not wake you (it reminds your owner instead). You can still read it with `messages`; it is information, not an instruction.
