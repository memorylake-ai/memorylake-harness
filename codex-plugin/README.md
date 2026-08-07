# Memory Lake for Codex

Cross-device long-term memory for [Codex](https://developers.openai.com/codex),
backed by Memory Lake via the `memorylake` CLI.

Codex already keeps its own memory — an engine pipeline that summarizes each
session into `~/.codex/memories/`. But that memory lives on **one machine, for
one client**. This plugin connects it to Memory Lake: session summaries flow up
automatically, and memories written anywhere else — another machine, Claude
Code, mobile or web clients — become searchable from inside Codex.

The Claude Code sibling lives at [`../claude-plugin/`](../claude-plugin/).
**Both harnesses share one identity**: the same global config, the same
privately installed CLI, the same caches, all under
`~/.claude/memorylake-plugin/`. Run the Claude Code plugin's
`/memorylake:init` once and Codex is configured too (and vice versa — a
hand-written config works the same).

## Install

```bash
codex plugin marketplace add memorylake-ai/memorylake-harness
codex plugin add memorylake@memorylake
```

Then — **required** — trust the plugin's hooks: run `/hooks` inside a Codex
session, review the two hooks, and mark them trusted. Non-managed hooks do not
run until you do; the plugin silently does nothing without it.

If you have not set up Memory Lake before, the fastest path is the Claude Code
plugin's `/memorylake:init` wizard. By hand instead: install the
[`memorylake` CLI](https://github.com/memorylake-ai/memorylake-cli), log in
(`memorylake auth login --api-key sk-...`), and write
`~/.claude/memorylake-plugin/config.md`:

```markdown
---
enabled: true
workspace: ws-1234
actor: actor-…
sync_on_write: true
status_line: true
---
```

## What it does

**Recall.** A `memorylake` skill teaches Codex when and how to search Memory
Lake, with the search command installed at a fixed path
(`~/.claude/memorylake-plugin/bin/ml-recall`) by the session-start hook. The
query-writing contract, result-reading guidance, and the
"failure is not emptiness" rule are shared with the Claude Code plugin.

**Sync.** A `Stop` hook runs after each turn, cheaply detects which session
summaries under `~/.codex/memories/` changed (hash comparison, at most five
uploads per turn, freshest first), and uploads them into a `codex-memories`
project in your workspace. Aggregate files (`MEMORY.md`, `raw_memories.md`)
are deliberately not synced — they duplicate the summaries and would re-index
hundreds of KB on every change.

**Status.** One line at session start reporting whether Memory Lake is
reachable — chiefly so an *unreachable* backend is stated out loud instead of
masquerading as "no such memory".

## Design differences from the Claude Code plugin

| | Claude Code | Codex |
| --- | --- | --- |
| Memory written by | the model, through Write/Edit tool calls | an engine pipeline, no tool calls involved |
| Write-side hook | `PostToolUse(Write\|Edit)` — intercept the write | `Stop` — scan for changed summary files |
| Failure reporting | async hook, `exit 2` + stderr wakes the model | `systemMessage` + `exit 0` — **in a Codex `Stop` hook, exit 2 means "continue the turn"**, never use it as an error channel |
| Async hooks | supported (`asyncRewake`) | not yet supported; `Stop` runs synchronously after the reply, so the user rarely notices |
| Read-side nudge | `PreToolUse(Read)` on memory files | none — Codex injects its memory summary itself; the skill covers discovery |

## Privacy

- With `sync_on_write: true`, Codex session summaries — which describe what
  you worked on — are uploaded to your Memory Lake workspace after each turn.
  Set it to `false` to keep them local
- `ml-recall` sends your query text to your workspace
- Nothing is sent when no config exists

## Uninstall

`codex plugin remove memorylake` and
`codex plugin marketplace remove memorylake`. The shared data tree
(`~/.claude/memorylake-plugin/`) and CLI credentials (`~/.memorylake/`) are
shared with the Claude Code plugin — remove them only if you are done with
both.
