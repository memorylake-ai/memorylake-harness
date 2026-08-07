---
name: memorylake
description: Search the user's cross-device long-term memory in Memory Lake. Use when the user refers to something they told you before, asks what you know about them or their preferences, mentions a past decision, project, or document you have no local record of, or when local auto-memory turns up nothing and the answer plausibly exists elsewhere. Also covers how to phrase recall queries and how to read relevance scores.
---

# Memory Lake

Memory Lake is the user's long-term memory **across projects, machines, and
clients**. Claude Code's own auto-memory covers only the current repository on
this machine — Memory Lake is where everything else lives, including memories
written from other apps and other devices.

## When to reach for it

- The user refers to something they told you before that is not in local memory
- A question about the user, their preferences, or past decisions
- A project, document, or fact you have no local record of
- Local memory came up empty and the answer plausibly exists somewhere else

Local auto-memory stays the first stop — it is already in context and costs
nothing. Memory Lake is the second stop, for what local memory structurally
cannot hold.

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

Write to local auto-memory exactly as you normally would. Anything you save in
this project's memory directory is synced up to Memory Lake automatically, so
it becomes available from the user's other projects and devices. There is no
separate "save to Memory Lake" step.

Write facts the way both systems expect: one atomic statement per memory,
entities resolved, absolute dates.
