---
name: memorylake
description: Search the user's cross-device long-term memory in Memory Lake. Use when the user refers to something they told an assistant before, asks what you know about them or their preferences, mentions a past decision, project, or document that is not in your session memory, or when your built-in memory has nothing and the answer plausibly exists elsewhere. Covers how to phrase recall queries and read results.
---

# Memory Lake

Memory Lake is the user's long-term memory **across devices, projects, and
clients** — it holds memories written from the user's other machines and other
assistants (Claude Code, mobile and web clients), plus documents they have
stored. Your built-in Codex memory covers only what happened in your own
sessions on this machine; Memory Lake is where everything else lives.

## When to reach for it

- The user refers to something they told an assistant before that your own
  memory does not contain
- A question about the user, their preferences, or past decisions
- A project, document, or fact you have no record of
- Your built-in memory came up empty and the answer plausibly exists somewhere
  else

Built-in memory stays the first stop — it is already in context. Memory Lake
is the second stop, for what your memory structurally cannot hold.

## Searching

```bash
~/.memorylake/bin/ml-recall "user's preferred editor"
~/.memorylake/bin/ml-recall "Q4 revenue figures" --top-k 10
```

(The path is fixed; the plugin installs the command there at session start.)

Write the query well. It matters more than the number of attempts:

- **Statement-style keywords beat questions.** `user's name` finds more than
  `what is my name?`
- **Resolve pronouns to entity names.** `Alice's review deadline`, not
  `her deadline`
- **Convert relative time to absolute dates.** `2026-07 migration`, not
  `last month's migration`
- **One intent per query.** Two ideas in one query match neither well
- For a vague or broad question, run 2–3 **differently-phrased** searches
  rather than one long one

## Reading results

Facts come back most-relevant-first, but **the engine returns matches even for
unrelated queries** — ordering is a hint, not a verdict. Judge every hit
against the actual question by reading its content; discard what does not
answer it, however high it sits in the list.

File hits are pointers, not ranked answers — judge them by name and summary.

## When nothing comes back

Retry **once** with different wording — entity names, synonyms, a different
angle. If it is still empty, **tell the user honestly**. Never invent an answer
from an empty search.

## Failure is not emptiness

If `ml-recall` exits non-zero, the search did **not happen**. Say the memory
backend could not be reached. Do not report it as "no relevant memories" and do
not conclude the user never mentioned the thing — that turns an outage into
contradicting the user about their own history.

## Writing memory

Nothing to do: your session summaries are synced to Memory Lake automatically
in the background after each turn, so they become recallable from the user's
other devices and clients. Each summary is routed (by the `cwd` in its
metadata header) to the same per-repo Memory Lake project the Claude Code
harness writes to, so one repo's memories live together regardless of which
assistant produced them. There is no separate "save to Memory Lake" step.

## If the user asks to exclude a project from syncing

Per-project exclusion works here: session summaries carry the originating
session's `cwd` in their metadata header (written by the engine at generation
time), and the sync routes and filters by it. Adding a path prefix to
`sync_deny` in `~/.memorylake/harness/config.md` keeps that project's
summaries from uploading — same list, same semantics as the Claude Code side.
One honest caveat: ad-hoc extension notes carry no cwd, are not attributable
to a project, and sync to the shared `codex-memories` project regardless;
only `sync_on_write: false` (all Codex sync off) stops those.
