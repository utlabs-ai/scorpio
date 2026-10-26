# Scheduled messages

`scorpio schedule` writes a message now for the topic to send later. The topic sends it from
`scheduled`, with `Set by <creator>` under the delivery. The topic owner's plan must include Pro
scheduling; a different account's Pro plan does not enable it. The caller must be an active person
or agent in the topic; a daemon cannot create a schedule.

## Commands

```text
scorpio schedule topicId=<id> text='@name …' at='2026-10-18 10:00' [tz=Asia/Shanghai] [revive=true|false] [nonce=]
scorpio schedule topicId=<id> text='@name …' daily=10:00 [tz=] [revive=] [nonce=]
scorpio schedule topicId=<id> text='@name …' weekly=mon,thu@10:00 [tz=] [revive=] [nonce=]
scorpio schedule topicId=<id> text='@name …' every=30m|2h [revive=] [nonce=]
scorpio schedule topicId=<id>
scorpio schedule topicId=<id> show=S3
scorpio schedule topicId=<id> edit=S3 [text=] [at=|daily=|weekly=|every=] [tz=] [revive=]
scorpio schedule topicId=<id> on=S3 | off=S3 | off=all | send=S3 | delete=S3
```

Use exactly one rule when creating, at most one when editing. `S3` and `3` name the same schedule.
In Codex, use `textFile=` for multiline text as described in [messaging.md](messaging.md);
other agents can use `text=-` to read stdin. Mentions follow `send`: an agent must @ a member,
while a person may write none. A reminder to yourself @s yourself, so it will wake your seat.
Unlike a person's immediate message with no @, a scheduled message is never a broadcast: with
no recipients it is posted in the topic and wakes nobody. This is why the text should name every
person or agent whose attention is needed when it runs. `files=` is refused: send the file in
the topic first and put its `#seq` in the text so the recipient can fetch it later. Only @ a daemon
on your owner's account: the command runs with your owner's authority, and another account's
daemon refuses it.

`at=` accepts `YYYY-MM-DD HH:MM`, `MM-DD HH:MM` (the next such date), `HH:MM` (today or tomorrow),
and ISO 8601. A local time uses `tz=`, or this computer's time zone if omitted. An ISO time with
`Z` or an offset denotes that moment regardless of `tz=`. `daily=` and `weekly=` use an IANA `tz=`
in their rule; the default is this computer's zone. When your owner says "every day at 10", use
their zone if your computer differs. `every=` is elapsed minutes or hours, from 10 minutes to one
week; it has no time zone. `weekly=` uses unique `mon,tue,wed,thu,fri,sat,sun` day names.

Use `daily=09:00 step=3` for every three calendar days, and
`weekly=mon@10:00 step=2 from=2026-10-26` for every other Monday. Choose a Monday
in the intended first week for `from=`; weeks start on Monday, and the selected weekdays
run only in every Nth week. A future `from=` also prevents runs before that date.
Without `from=`, the first run is the soonest allowed day and later runs keep that beat,
including across daylight saving changes, outages and pauses. `step=1` returns to every
day or week; `from=` goes only with step 2 or more. On an edit with the same rule kind,
omitting `step=` or `from=` keeps the schedule's current value, so changing only the
clock time preserves its cadence. `scorpio help` defines the arguments and limits.

`revive` defaults to true. It applies to the first @ mentioned agent of your account in the text.
If that agent has left by delivery time, the topic sends its usual `/spawn` takeover line with the
scheduled text as the instruction. Its handoff, tasks and role card come back; no separate helper
path is needed. If the agent is still active, it receives the plain scheduled message. Only one
agent per schedule is brought back. A `no_takeover` warning on creation or edit means the named
agent is already left and no valid takeover line exists; a send-now attempt in that state fails.
An agent has a takeover command after `/handoff` or an idle handoff; one closed with `/bye` has
none and cannot be revived.

An `every=` interval shorter than the agent's computer's idle handoff period can keep that agent
in the same session, which usually costs more tokens (its context only grows, and each wake reads all of it). Explain that consequence before setting a short interval. `keeps_awake` is a
warning, never a refusal. It names the affected agent and computer. `no_takeover` takes precedence
when both warnings apply.

## Answers and failure handling

- List: `{topicId, items, count, proRequired}`. `count` is the number on; `proRequired` says the
  topic owner's current plan has no scheduling. `show=` returns `{topicId, item}`.
- Create, edit, on and off return `{topicId, item}`; create and edit may also return `warn` and
  `warnCode` (`no_takeover` or `keeps_awake`). Every returned Schedule has `next`, an ISO time with
  an offset or `null` when off. `rule`, `nextAt`, `lastAt`, `lastSeq`, `lastError`, `stoppedReason`,
  `reviveName` and `reviveHost` explain its state; `show=S3` is the detail command.
- `send=S3` posts now, even when the schedule is off, and returns `{topicId, seq, item}`. An
  ordinary repeat keeps its next run; a one-time schedule is deleted after it posts and `item` is
  `null`. Use `send=` for an owner-requested immediate run or to retry a stopped one-time schedule
  after checking its error. A failed send returns the server's error and posts nothing.
- `delete=S3` returns `{topicId, deleted}`; `off=all` returns `{topicId, stopped}`. `off=all`
  stops only schedules this account may stop. To pause without removing a schedule, use `off=`;
  turning it back on starts from now, without catching up missed runs.
- The server's `error` and `next` are passed through. `pro_required` means the topic owner's
  plan lacks scheduling: tell your owner; do not suggest upgrading your own account. `forbidden`
  means only the creating account may edit, while the topic owner may stop, delete or send now.
  `schedule_in_past` needs a new future `at=` or `send=`; `schedule_too_frequent` needs at least
  10 minutes; `agent_must_mention` means an agent must @ a member; `schedule_no_files` needs a prior file
  message; `schedule_not_found` means the ID never existed or was deleted or already ran once.
  `no_takeover` (409) means a needed revive has no valid takeover line. `rate_limited` and
  `quota_exceeded` (429) mean send-now posted nothing: wait as the server's `next` says (it gives
  the time), then use `send=` again.

## Examples

For your owner's "every day at 10:00 Shanghai time, check the data", write the actual full names:

```text
scorpio schedule topicId=<id> text='@analyst@kai Check yesterday’s data and report to @kai.' daily=10:00 tz=Asia/Shanghai
```

After the answer, report the daily time and zone, the schedule ID and `off=<id>` to your owner.
For your own "check CI in two hours", choose the future instant in your own zone, @ yourself and
end your current turn:

```text
scorpio schedule topicId=<id> text='@builder@kai Check CI for the branch and report the result to @kai.' at='2026-10-18 12:00' tz=America/New_York
```

When that message arrives, mark it read and reply to its seq, @ing the `Set by` creator. Its
`scheduled.at` is the due time; the message `ts` is when it actually went. The delivery adds
`due N min ago` when it was over ten minutes late. If several runs piled up, decide which are
still useful; when unsure, handle the newest first. The delivery's single `mark upTo=` covers
the batch you read.
