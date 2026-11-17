---
name: memorylake
description: Search the user's cross-device long-term memory in MemoryLake. Use at the start of every turn that could depend on the user's history, preferences, people, projects, or earlier work -- and whenever the user refers to something they told you before or asks what you know about them. Covers how to phrase recall queries, read results, and control conversation sync.
---

# MemoryLake

MemoryLake is the user's long-term memory **across devices and apps** --
other WorkBuddy machines, Claude Code, Codex, and more. WorkBuddy's own
memory files (`MEMORY.md`, the daily notes) only cover this machine; keep
maintaining them exactly as your instructions say. MemoryLake is where
everything else lives.

## The contract: search first

Every user message arrives with a reminder to search MemoryLake before
replying, and the first tool call of a turn that skipped the search is held
back once. So: make `ml-recall` your first action of the turn. Skip it only
for pure small talk with nothing to look up.

## Searching

```bash
ml-recall "user's preferred editor"
ml-recall "Q4 revenue figures" --top-k 10
```

Write the query well. It matters more than the number of attempts:

- **Statement-style keywords beat questions.** `user's name` finds more than
  `what is my name?`
- **Resolve pronouns to entity names.** `Alice's review deadline`, not
  `her deadline`
- **Convert relative time to absolute dates.** `2026-07 migration`, not
  `last month's migration`
- **Use the user's language.** Memories are stored in the language they were
  said in; a query in the same language matches best
- **One intent per query.** Two ideas in one query match neither well
- For a question about the user, or a vague or broad one, run 2-3
  **differently-phrased** searches rather than one long one

Search covers every project in the workspace, whatever folder this session
works in.

## Reading results

Facts come back most-relevant-first, but **the engine returns matches even for
unrelated queries** -- ordering is a hint, not a verdict. Judge every hit
against the actual question by reading its content; discard what does not
answer it, however high it sits in the list.

File hits are pointers, not ranked answers -- judge them by name and summary.

Use what survives as background: apply it where it helps, say so when you
rely on it, and never recite memories the user did not ask about.

## When nothing comes back

Retry **once** with different wording -- entity names, synonyms, a different
angle. If it is still empty, **tell the user honestly**. Never invent an answer
from an empty search.

## Failure is not emptiness

If `ml-recall` exits non-zero, the search did **not happen**. Say the memory
backend could not be reached. Do not report it as "no relevant memories" and do
not conclude the user never mentioned the thing -- that turns an outage into
contradicting the user about their own history.

## Writing memory

There is no "save to MemoryLake" step. After every turn, the user's message
and your final reply (text only -- never tool calls or tool output) are
appended to a MemoryLake conversation for this session, and memories are
distilled from it on the server. Say what matters in your reply and it will
be remembered.

## Controlling sync

When the user asks to stop (or resume) uploading conversations, act on it
directly -- the config is re-read on every hook run, so a change applies from
the next message:

- **This folder**: set `sync_conversations: false` (or `true`) in
  `.claude/memorylake.local.md` at the folder root, preserving other keys.
- **A whole directory tree** ("nothing under ~/work"): add the path prefix to
  `sync_deny` (comma-separated) in `~/.memorylake/harness/config.md`.
- **Everywhere**: set `sync_conversations: false` in
  `~/.memorylake/harness/config.md`.
- Precedence: folder file `sync_conversations` > global `sync_deny` > global
  `sync_conversations` > global `sync_on_write`. Recall keeps working when
  sync is off; the switch only governs uploads.

Attached files are a separate, stricter switch: `sync_attachments: true` in
either file uploads the documents and images the user attaches to a message
(off unless explicitly `true`; never on where conversation sync is off). The
upload happens by itself after the turn -- do not upload attachments by hand.

The search-first reminder and the gate have their own switches in the same
file: `recall_reminder: false` and `recall_gate: false`.
