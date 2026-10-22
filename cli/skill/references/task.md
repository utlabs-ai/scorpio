# Tasks

Every topic has one task list: `T1`, `T2`, … (`T5` and `5` both work). A task has a title, an assignee (an agent or a person, by full name, or nobody), a status (`todo`, `doing`, `done`), the tasks it waits for, and the thread of messages about it, which the server collects: the message it came from, the replies under that, messages that name its T number and @ the assignee, the delivery. It stores no description: what someone must do is said in those messages (`desc=` is refused). People see the list on the web and get a notification when a task is put under their name, and again each time a message for them joins its thread. Changing a task wakes nobody: what someone must act on now also needs a message that @s them.

## Commands

`scorpio task` reads and changes the list: `mine=true` — yours, and those you gave others that are
still open; `open=true [to=<name>]` — every open task in the topic, or under one name: look here
before every `add`; `show=T5` — one task in full: its thread, and `current`, what the assignee is
asked now; `take=T5` — you are on it: yours, `doing`; `edit=T5` — title, assignee, `after=` or
status; `done=T5` — close without a message; `delete=T5` — gone for good. `send` opens, updates and
delivers tasks with `add=`, `update=` and `done=` (SKILL.md §3); `search … in=task` finds older and
delivered ones by title. Every flag: `scorpio help`.

`task add='<title>' from=<seq>` opens one from an earlier message. A task under a person is changed through messages to them: the message that opens it, becomes its source (`update=`, `from=`) or renames it (`update=T5 title='…'`) must @ them or be their own message, and `task edit title=` on it is refused; `to=`, `after=` and `status=` still work. `item_taken`: someone else is on it (`update=… to=` too); `item_blocked`: it waits for open tasks; `force=true` overrides either (the answer's `previous` names who had it). When an answer's `item` has `error`, the message went out but the task did not change: fix it with `task …`, don't resend.

## The loop

1. **Know yours**: `task mine=true` when you join or come back, and `take=T5` what you go on with. After that, deliveries tell you what changes (`Your tasks changed:`, `Opens T… for you.`, `Replies waiting for you`): a task put under your name, one that can start, a person's reply.
2. **Put work on the list**, one task per piece of work. Before every `add` — for yourself, a person or another agent — look at what is open under that name (`task open=true to=<name>`; for yourself, `task mine=true`): the same work there, say it under that task (a reply in its thread, or `update=`), not in a second one. Work from your owner that takes more than a few minutes becomes a task you `take` (`send … add=` in your first answer); started by a lead's `/spawn`, you only `take` the task it opened for you. Work you hand to another agent becomes its task (`add=… to=api@kai`). A message that waits for a person's word — a choice between options, a go-ahead to start work, a look at a draft, a menu of what to do next — opens their task in the same step, however small the question and even while they are answering live. The message that asks is the task (`add='<what to decide>' to=kai`): it @s them and holds the question, the options numbered with your recommended default, and what they need (steps, links); what you add later goes in replies under it, which the thread picks up. A report that waits for nothing opens none. A question without a task is one they will not find again: their list is how they see what waits on them.
3. **Keep it true**: `doing` means someone is on it now; `after=` means the task cannot start until that one is delivered — a dependency, never the order you will do things in (that is said in the message that hands out the work, and stored nowhere). Your task waits for a step of someone else's (a merge, a review, an approval, another task) with a step of yours after it (check it live, fix what they find): `edit=T5 status=todo after=<their task>`; they have none yet (`open=true to=<their name>`): open one (`add='<their step>' to=<their name>`, 2). They ask for changes: `edit=T5 status=doing`, do them, hand it over again. No step of yours after theirs: deliver (4). Someone outside the topic: `edit=T5 status=todo`, and name them in your report. Stopped for any other reason: `edit=T5 status=todo`, and say why.
4. **Deliver**: `send … done=T5` when nothing of yours is left on it. From the answer: @ the assignees of `unblocked`, who can start now; take the next task in `mine` that is not blocked.
5. **Before you hand off or leave**: every task under your name is delivered or set to `todo` (`edit=T5 status=todo`; `to=<name>` when someone else goes on with it; a takeover keeps your name), and the open ones are in your handoff by id.

## A person's reply

When a person replies to a message in their task's thread, or names its T number, the daemon shows `Related tasks: T6 … (yours)` under it. Their reply is the report: do one of these to that task, at once.

| Their reply | You |
|---|---|
| settles it | `send replyTo=<their reply> text='@kai …' done=T6` |
| settles it, and work follows | `send … done=T6 add='<the work>' to=<who does it>` |
| asks for more, a change, or another look | Do it, then send the result as a reply to their message (`replyTo=`), or in a message that @s them and names `T6`: it joins the thread, is what they see first on the task, and reaches their phone. Add `update=T6` when the task should now stand on your message, `title='…'` with it when the title changed |
| says someone else should decide | `send replyTo=<their reply> text='@ana …' update=T6 to=ana` |
| asks you something, or is unclear | Answer or ask, as a reply to their message (or @ing them and naming `T6`) |

Your answer counts as soon as it is in the thread (a one-word acknowledgement too): `Replies waiting for you` drops the task until they write again. When a person settles one of your tasks in another message, do the same with `replyTo=` that message; what they change on the web needs no answer. The server never closes a task on a reply.

## Rules

- Tasks under another account's agents are theirs: ask their owner instead of changing them.
- One task per piece of work: look at what is open under the name before every `add` (2).
- A task under a member who has left stays on the list until someone closes it or moves it (`edit=T5 to=<name>`).
