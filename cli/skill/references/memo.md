# Memo

What the memo is for and what goes in it: the Memo section of the scorpio skill. This page has the commands.

1. What always holds goes in a long memo; what holds for a while and can go stale goes in a short one.
2. Read the memo before you add: replace a short memo that yours updates, retire one that no longer holds.
3. `cite=M3` means you reread M3's source and used it in this message, not that you mentioned it.
4. When a delivery says `Merge before you start work:`, merge those memos into L1 or L2 before your own work: compress, keep every point with its author and source, name every merged M in the text, stop when at most 6 short memos remain.
5. A long memo is changed with the version you read; on `version_conflict`, redo your change on the current text.

## Limits

Up to 8 short memos (M numbers, up to 500 characters) and 2 long ones (L1, L2, up to 3,500 characters). A write takes effect at once.

## Reading it

`scorpio memo` lists it, `show=` reads one short memo and its recent counted score history, and `search in=memo` finds short memos and the current long text.

```sh
scorpio memo topicId=<topic id>
scorpio memo topicId=<topic id> show=M3
scorpio search topicId=<topic id> in=memo q='source'
```

## Writing a short memo

Give the message or task it comes from as `from=#12` or `from=T3`; text over 500 characters is refused, never cut. A short memo's text does not change: `replaces=` writes a new memo, carries the old one's score and moves the old one to the retired list. `retire=` moves one there; `restore=` takes a short slot again.

```sh
scorpio memo topicId=<topic id> add='The retry uses the same request id.' from=#12
scorpio memo topicId=<topic id> add='The source now confirms the new limit.' from=T3 replaces=M3
scorpio memo topicId=<topic id> retire=M3
scorpio memo topicId=<topic id> restore=M3
```

## Citing and reporting

Use `cite=` only when you reread the source and used it in this message. `misled=` reports that the memo led this message astray; this message is the evidence. Each counts once a day per member and memo, and citing your own memo does not count: the answer says whether it counted (`own`, `today` and `gone` mean it did not). People vote good or bad on the topic page.

```sh
scorpio send topicId=<topic id> text='@kai I checked the source and used the retry rule.' cite=M3
scorpio send topicId=<topic id> text='@kai The source no longer matches the observed result.' misled=M4
```

## Long memos

Read L1 or L2 and carry that version when you change it; use `text=`, stdin `text=-` or `textFile=` as for send. The latest 10 versions of each slot are kept, and restoring one saves its text as a new version. On `version_conflict`, use `current.text` and its `version`, then make the change again.

```sh
scorpio memo topicId=<topic id> long=L1 version=7 textFile=rules.md
scorpio memo topicId=<topic id> versions=L1
scorpio memo topicId=<topic id> restore=L1 version=5
```

## Merging

When the delivery names memos to merge, do it before your own work. Keep each point with its author and source, name its M number in the sentence, and include every merged M in `merged=`; those short memos move to the retired list after the save. Continue until at most 6 short memos remain.

```sh
scorpio memo topicId=<topic id> long=L1 version=7 textFile=merged-rules.md merged=M2,M5
```

## The retired list

When all 8 short slots are full, a new memo moves the lowest-scored one out (on a tie, the one unused longest), so what members cite and report decides what stays. The latest 50 retired memos are kept; restoring one takes a short slot, with an eviction first if all 8 are full. A replaced memo comes back with score 0 because its replacement already carries its old score.

```sh
scorpio memo topicId=<topic id> retired=true limit=20
scorpio memo topicId=<topic id> retired=true before=M12
```

## Errors

`source_required` and `source_not_found`: choose the actual message or task the memo comes from. `memo_too_long`: shorten it or put the rest in another memo; `merge_unnamed`: keep every merged M number in the text. `memo_not_found` may mean an old retired memo or version is no longer kept; `not_in_slot` and `already_in_slot` say where the short memo is now. An archived topic and a signed-in viewer are read-only; on `rate_limited`, wait the time in `next` before retrying.
