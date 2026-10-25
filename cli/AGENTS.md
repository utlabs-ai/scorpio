# Working on the Scorpio client

This directory is the Scorpio client: the `scorpio` CLI, the daemon, and the Scorpio skill that coding agents read. It is published as is: as a public repository, and as the npm package `@utlabs/scorpio` that runs on users' computers. These rules are for everyone who changes it, people and coding agents alike.

Two things follow from publishing it as is. Everything written here becomes public: code, comments, tests, fixtures and skill examples. And the directory must work on its own, because in the public repository nothing sits next to it.

## Do

- **Keep it self-contained.** Code, tests and tools import and read only files inside this directory. The hosted service's source is not public, so anything that reaches outside this directory breaks in the public repository. One existing test, `test/names.test.mjs`, also checks the service's hint texts when that source is present, and skips when it is not. Do not add another test like it.
- **Use the neutral names** in fixtures, examples and skill text: the accounts `kai`, `mei` and `zoe` (`api@kai`, `pm@mei`), the computer `box`, the address `kai@example.com`, and `example.com` for any other domain (`scorpio.example.com` for a server). Made-up data that looks real can belong to a real person.
- **Make each comment say its reason in its own words.** A reader of the public repository cannot open anyone's chats, trackers or design documents, so a pointer there explains nothing. If a comment has no reason to give, leave it out.

## Do not

- **No names of real people:** not in code, comments, tests, examples or the skill, and not as account names either.
- **No private email addresses.** Use `kai@example.com`.
- **No real host names, machine names or personal paths** (a home directory with a user name in it, for example). Use `box`, and put files under a temporary directory.
- **No credentials of any kind:** tokens, keys or passcodes, even expired or revoked ones.
- **No references to private material, in any form:** task or ticket numbers (`T123`), message numbers (`#1234`, `pm #1234`), team roles cited as the source of a decision ("as supervisor asked"), dates of internal events, sections of documents that are not in this directory (`protocol §6`), and paths into other repositories (`../server`, `server/src/…`). They mean nothing to a public reader and can reveal internal context. Write the reason itself instead.
- **No dependency on anything outside this directory,** in code, tests or tools (see the first rule under Do).

## Check before you push

Run both checks from this directory.

1. Run the tests on a copy of this directory with nothing next to it. That is the situation of the public repository, and CI runs the same test:

   ```sh
   dir=$(mktemp -d) && cp -R . "$dir/cli" && (cd "$dir/cli" && node --test)
   ```

   This run includes `test/public-text.test.mjs`, which scans comments and documentation for the references listed under Do not (task and message numbers, paths into other repositories, citations of absent documents, internal host names) and names each hit by file and line.

2. Read the lines you added for names of people and computers. No search finds every name, so this read is the check: every name in your change should be one of the neutral names above.

Before each publication the maintainers scan the published copy against a list of names, and a hit stops the publication. If that happens, the fix goes into this directory like any other change.
