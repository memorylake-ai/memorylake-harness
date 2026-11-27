---
name: memorylake-cli-recall
description: Recall the user's cross-device long-term memory from MemoryLake with the memorylake CLI. Use at the start of a turn that could depend on the user's history, preferences, people, projects or earlier work; whenever the user refers to something they told you before or asks what you know about them; and when they want a file they stored in MemoryLake earlier. Covers when to search, how to phrase and judge a search, getting stored files back, and what to do when the user asks you to remember something.
---

# Recalling from MemoryLake

MemoryLake is the user's long-term memory **across devices and apps**: other
WorkBuddy machines, Claude Code, Codex, and more. WorkBuddy's own memory files
(`MEMORY.md`, the daily notes) only cover this machine; keep maintaining them
exactly as your instructions say. MemoryLake is where everything else lives.

## Automatic memory: on or off

The user chooses this on MemoryLake's sign-in page. Tell which it is from
the session itself.

**On**: the session opens with a `MemoryLake: connected` line and every
message carries a reminder to run `ml-recall`.

- Search with `ml-recall "<query>"` (add `--top-k 10` for more) as the first
  action of the turn. It prints a short digest: facts first, then pointers to
  files. Everything below about phrasing a query, reading results, empty
  results and failures applies to it unchanged. Do not also run
  `memorylake search` for the same question; searching twice gains nothing.
- The conversation is saved by itself after every turn (the user's messages
  and your final replies, never tool calls), and MemoryLake builds memory
  from it. See "Remembering" below for what that changes.

**Off**: no such line and no reminder. Nothing searches or saves for you:
each search is a `memorylake search` you choose to run, so the judgement
below is yours.

Login, workspace and command conventions are in the `memorylake-cli` skill.
If a command fails with a login problem, follow what it says there.

## When to search

Search before you answer when the turn could depend on what the user said or
did elsewhere:

- they refer to something earlier ("as I said", "the usual way", "my
  project", "last time");
- they ask what you know about them, a person, or a project;
- the right answer depends on a preference, a convention, a person or a
  decision you have not been told in this session;
- they want a document they stored or attached before.

Skip it for self-contained requests (rewrite this paragraph, explain this
error) and small talk. A search takes a few seconds; one well-phrased search
at the start of the turn is worth more than several later.

## Searching

```bash
memorylake search "user's preferred package manager" --compact
memorylake search "Alice Chen review deadline 2026-11" --types fact --compact
memorylake search "Q3 revenue report" --types document --top-k 20 --compact
```

It searches the default workspace (`memorylake ws current`); pass
`--workspace <id>` for another. Facts are the user's own unless `--actors`
names other people. `--compact` keeps ids, names and a snippet, enough to pick
a hit; drop it when you need a hit's full text.

The query matters more than the number of attempts:

- **Statement-style keywords beat questions.** `user's name` finds more than
  `what is my name?`
- **Resolve pronouns to names.** `Alice Chen's review deadline`, not
  `her deadline`
- **Absolute dates.** `2026-07 migration`, not `last month's migration`
- **The user's language.** Memories are stored in the language they were
  said in; a query in the same language matches best
- **One intent per query.** Two ideas in one query match neither well
- For a question about the user, or a vague or broad one, run 2-3
  **differently phrased** searches rather than one long one

## Reading results

Hits come back most-relevant-first, but **the engine returns matches even for
unrelated queries**: the order is a hint, not a verdict. Judge every hit
against the actual question by reading it; discard what does not answer it,
however high it sits.

Document hits are pointers: judge them by name and summary.

Use what survives as background. Apply it where it helps, say so when you rely
on it, and never recite memories the user did not ask about.

## When nothing comes back

Retry **once** with different wording: entity names, synonyms, another angle,
or the other language if the user writes in more than one. If it is still
empty, **tell the user honestly**. Never invent an answer from an empty
search.

If MemoryLake holds nothing about the user at all (a new account), offer once
to import what WorkBuddy already remembers on this computer: the
`memorylake-cli-import` skill.

## Failure is not emptiness

A non-zero exit means the search did **not happen**. Say MemoryLake could not
be reached, or that the user needs to sign in again (`memorylake-connect` opens the
page) if the error is about the API key. Do not report it as "no relevant memories", and do not conclude the
user never mentioned the thing: that turns an outage into contradicting the
user about their own history.

## Stored files

Documents live in MemoryLake projects. `search --types document` finds a file
by what it says; to browse the files themselves or get one back:

```bash
# What is stored: every project's documents, or those whose name matches
memorylake project document list --compact
memorylake project document list --compact --name "report"

# Details and processing status of one document
memorylake project document get --project <project_id> <id>

# The original file back, into a directory
memorylake project document download --project <project_id> <id> -o .
```

- Each listed item carries `id`, `name`, `project_id` and `status`; `get` and
  `download` take the `project_id` and `id` from it.
- A listing holds 20 items. When `continuation_token` is not null, pass it
  back with `--continuation-token`, or narrow with `--name` instead of paging
  through everything.
- `status` other than `okay` means the file is still being indexed or failed;
  it can be downloaded either way, but search will not find its content yet.
- `download` never overwrites an existing file. Pick another directory rather
  than adding `--force`, unless the user asked to replace the file.
- An error is not an empty list. `[WORKSPACE_NOT_FOUND]` or any non-zero exit
  means the lookup did not happen: say so, do not tell the user they have no
  files.

These commands only read. Do not delete or re-import stored documents unless
the user asks for exactly that.

## Remembering

**With automatic memory off**, nothing is saved by itself. When the user asks
you to remember something in MemoryLake, follow the `memorylake-cli-memory`
skill (a fact under their own actor, written to stand on its own). When they
state a lasting preference or decision without asking, you may offer once to
save it; do not write it unasked.

**With automatic memory on**, what the user tells you is saved with the
conversation. When they ask you to remember something, say it back in your
reply as one full sentence that stands on its own ("Noted: Alice Chen prefers
pnpm over npm") and add no fact by hand: a second copy becomes a duplicate
memory. The `memorylake-cli-memory` skill is still how a memory is corrected,
deleted, or filed under a project or an agent instead of the user.

Never store passwords, keys or other secrets, either way.

## Turning automatic memory on, off or down

- **On or off**: the switches are on the sign-in page. Run
  `memorylake-connect` (Bash) to open it for the user; what they choose
  there applies from the next message. Uninstalling the plugin in WorkBuddy
  removes automatic memory altogether.
- **Down**, for one setting: the switches are in
  `~/.memorylake/harness/config.md` and are read again on every message.
  `sync_conversations: false` stops saving conversations (searching keeps
  working), `sync_deny: ~/work, ~/clients` stops it under those folders,
  `recall_reminder: false` and `recall_gate: false` stop the reminder and the
  one held-back tool call. Change only the key the user asked about and keep
  the rest of the file.
