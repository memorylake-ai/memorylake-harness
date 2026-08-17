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
`~/.memorylake/harness/`. Run the Claude Code plugin's
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

Then set up Memory Lake itself — just ask Codex:

```
set up memorylake
```

The bundled `memorylake-setup` skill walks through everything: CLI download,
login, workspace/actor selection, the global config, and the hook-trust step.
(If you already ran `/memorylake:init` in Claude Code, it will find everything
in place — the two plugins share one setup.) To configure by hand instead,
install the [`memorylake` CLI](https://github.com/memorylake-ai/memorylake-cli),
log in (`memorylake auth login --api-key sk-...`), and write
`~/.memorylake/harness/config.md`:

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
(`~/.memorylake/bin/ml-recall`) by the session-start hook. The
query-writing contract, result-reading guidance, and the
"failure is not emptiness" rule are shared with the Claude Code plugin.

**Sync.** A `Stop` hook runs after each turn, cheaply detects which session
summaries under `~/.codex/memories/` changed (hash comparison, ~0.5s), and
detaches a background worker to upload them — Codex has no async hooks yet,
so the hook backgrounds itself rather than holding up your next prompt. Each
summary is routed by the `cwd:` in its metadata header to the **same
per-repo Memory Lake project the Claude Code harness uses**, so both
assistants' memories for a repo live together; summaries from projects under
`sync_deny` upload nothing. Files without a cwd header (ad-hoc extension
notes) go to a shared `codex-memories` project. A failed background sync
leaves a marker that the next turn's hook reports out loud. Aggregate files
(`MEMORY.md`, `raw_memories.md`) are deliberately not synced — they duplicate
the summaries and would re-index hundreds of KB on every change.

The **first** sync uploads the summaries that already exist on disk, not just
future ones — which is why the setup skill keeps `sync_on_write` off until it
has shown the user that backlog (`sync-memories.sh --preview`, grouped by
destination project) and gotten an explicit yes.

**Status.** One line at session start reporting whether Memory Lake is
reachable — chiefly so an *unreachable* backend is stated out loud instead of
masquerading as "no such memory".

## Design differences from the Claude Code plugin

| | Claude Code | Codex |
| --- | --- | --- |
| Memory written by | the model, through Write/Edit tool calls | an engine pipeline, no tool calls involved |
| Write-side hook | `PostToolUse(Write\|Edit)` — intercept the write | `Stop` — scan for changed summary files |
| Failure reporting | async hook, `exit 2` + stderr wakes the model | deferred: the background worker leaves a marker, the next turn's hook reports it via `systemMessage` — **in a Codex `Stop` hook, exit 2 means "continue the turn"**, never use it as an error channel |
| Async hooks | supported (`asyncRewake`) | not supported; the hook detaches its own background worker (`nohup` + lock) and returns in ~0.5s |
| Read-side nudge | `PreToolUse(Read)` on memory files | none — Codex injects its memory summary itself; the skill covers discovery |
| Per-project routing | repo identity of the session cwd (remote URL, else path) | the same identity, derived from the `cwd:` baked into each summary's metadata header (extension notes: shared fallback project) |

## Requirements

`jq` — the hooks parse Codex's JSON payloads with it. Without it the plugin
cannot run, and says so rather than failing quietly: session start reports
that recall is unavailable, and the sync hook reports that memories are not
being uploaded. Install with `brew install jq` / `apt-get install jq`.

## Sandbox requirement

`ml-recall` makes a network call, and Codex runs model-generated shell
commands inside its sandbox. Under `read-only` or `workspace-write` sandboxes
the call fails at DNS resolution — the plugin reports it correctly
(`UPSTREAM_UNAVAILABLE`, "do not read this as no relevant memories") rather
than fabricating an empty result, but recall is effectively unavailable.
Interactive sessions honor your `config.toml` sandbox setting; `codex exec`
overrides it with its own default, so pass `--sandbox danger-full-access`
(or a network-enabled policy) when recall matters in non-interactive runs.
The sync hooks are unaffected: hooks run outside the command sandbox.

## Privacy

- With `sync_on_write: true`, Codex session summaries — which describe what
  you worked on — are uploaded to your Memory Lake workspace after each turn.
  Set it to `false` to keep them local
- `ml-recall` sends your query text to your workspace
- Nothing is sent when no config exists

## Uninstall

`codex plugin remove memorylake` and
`codex plugin marketplace remove memorylake`. The shared data tree
(`~/.memorylake/harness/`) and CLI credentials (`~/.memorylake/`) are
shared with the Claude Code plugin — remove them only if you are done with
both.
