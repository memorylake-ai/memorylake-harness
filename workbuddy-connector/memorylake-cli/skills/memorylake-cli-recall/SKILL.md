---
name: memorylake-cli-recall
description: Recall the user's cross-device long-term memory from MemoryLake with the memorylake CLI. Use at the start of a turn that could depend on the user's history, preferences, people, projects or earlier work; whenever the user refers to something they told you before or asks what you know about them; and when they want a file they stored in MemoryLake earlier. Covers when to search, how to phrase and judge a search, getting stored files back, and what to do when the user asks you to remember something.
---

# Recalling from MemoryLake

MemoryLake is the user's long-term memory **across devices and apps**: other
WorkBuddy machines, Claude Code, Codex, and more. WorkBuddy's own memory files
(`MEMORY.md`, the daily notes) only cover this machine; keep maintaining them
exactly as your instructions say. MemoryLake is where everything else lives.

Nothing searches MemoryLake for you: this connector only adds the CLI. Each
search is a command you choose to run, so the judgement below is yours.

**If the MemoryLake plugin is also installed** (the session opens with a
"MemoryLake: connected" line and every message carries a reminder to run
`ml-recall`), follow that plugin's `memorylake` skill for recall and skip this
one. Searching twice gains nothing.

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

## Failure is not emptiness

A non-zero exit means the search did **not happen**. Say MemoryLake could not
be reached, or that the connector needs reconnecting if the error is about the
API key. Do not report it as "no relevant memories", and do not conclude the
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

Nothing is saved automatically. When the user asks you to remember something
in MemoryLake, follow the `memorylake-cli-memory` skill (a fact under their
own actor, written to stand on its own). When they state a lasting
preference or decision without asking, you may offer once to save it; do not
write it unasked. Never store passwords, keys or other secrets.
