# Memory Lake for Claude Code

Cross-device long-term memory for Claude Code, backed by
[Memory Lake](https://github.com/memorylake-ai) via the `memorylake` CLI.

Claude Code already has good local auto-memory — but it is scoped to **one git
repository on one machine**. This plugin does not replace it. It connects it to
Memory Lake, so memories written from another project, another machine, or
another client are reachable, and memories written here become reachable
everywhere else.

| | Local auto-memory | Memory Lake |
| --- | --- | --- |
| Scope | one repo, one machine | all projects, all devices, all clients |
| Latency | zero, loaded at session start | a search away |
| Role here | first stop, unchanged | second stop, for what local memory cannot hold |

## Requirements

- `jq` — the hooks and `ml-recall` parse JSON with it. Without it the plugin
  degrades to doing nothing rather than misbehaving
- The [`memorylake` CLI](https://github.com/memorylake-ai/memorylake-cli) —
  either already on `PATH`, or let `/memorylake:init` download a prebuilt
  binary into the plugin's private location (`~/.claude/memorylake-plugin/bin/`).
  A CLI you installed yourself always takes precedence

## Install

```
/plugin marketplace add memorylake-ai/memorylake-harness
/plugin install memorylake@memorylake
/memorylake:init
```

`/memorylake:init` walks through everything: CLI install (if needed), login,
workspace/actor selection, and writing the **global** config at
`~/.claude/memorylake-plugin/config.md` — after which every project on the
machine can recall and sync, no per-project setup. A project that needs
different settings (or wants out) adds its own `.claude/memorylake.local.md`,
which takes precedence:

```markdown
---
enabled: true
workspace: ws-1234
project_custom_id: my-repo      # optional; defaults to the git repo name
actor: act-human-…              # optional, reserved for a later version
remind_on_read: true
sync_on_write: true
status_line: true
---
```

`workspace` is the only required field. Useful per-project overrides:
`enabled: false` (opt this project out entirely), `sync_on_write: false`
(recall works, but this project's memory stays local), `project_custom_id`
(name the ML project something other than the git repo name).

**With neither a global config nor a project one, the plugin does nothing at
all** — no hooks fire, no network calls happen.

Add `.claude/*.local.md` to your `.gitignore`.

Config changes take effect immediately: the hooks re-read
`.claude/memorylake.local.md` every time they fire, so there is nothing to
restart after editing it. (Only the session-start status line waits for the
next session, by definition.)

Run `/memorylake:status` to check the whole setup at once.

## What it does

**Reading.** When Claude opens one of its own memory files, a hook reminds it
once per session that Memory Lake may hold related memories, and how to phrase
a search. Claude writes the query itself:

```bash
ml-recall "user's preferred editor"
ml-recall "Q4 revenue figures" --top-k 10
```

The hook makes no network call — it only injects the reminder, so it adds no
latency to reading local files.

**Writing.** When Claude saves to its own auto-memory, a background hook
uploads the memory file into a per-project Memory Lake folder and indexes it,
so it becomes searchable from your other projects, devices, and clients — with
zero added latency in the conversation. Rewrites with unchanged content are
skipped (hash check); content changes re-index the document. A failed sync
wakes Claude with an explicit report — it never masquerades as success — and
the next memory write retries the whole chain automatically.

**Session start.** One line reporting whether Memory Lake is reachable. Not a
digest: a workspace summary would cost tokens in every session, including the
majority that never touch memory at all. The line exists mainly so an
*unreachable* backend is stated out loud — otherwise an outage is
indistinguishable from "you never told me that".

## Known limitation: recall coverage

`MEMORY.md` is loaded automatically at session start without a tool call, so
the read hook does not fire for it. The reminder only appears when Claude opens
an individual memory file — high precision, but it will not catch every session
where Memory Lake would have helped. Ask for a recall directly, or run
`ml-recall` yourself, when you know something is stored.

## Privacy

- `ml-recall` sends your query text to your Memory Lake workspace
- With `sync_on_write: true` in the global config, memory files Claude writes
  in ANY project on this machine are uploaded to your Memory Lake workspace —
  including anything Claude chose to note about a project. Setting that flag
  is the consent; opt individual projects out with a
  `.claude/memorylake.local.md` containing `sync_on_write: false`, or set the
  global flag to `false` to make syncing opt-in per project
- Nothing is sent when neither a global nor a project config exists
- Reading local memory files does **not** send anything — that hook is offline

## Uninstall

Removing the plugin does not remove two things it created outside its own
directory, by design:

- `~/.claude/memorylake-plugin/` — caches, sync state, and the privately
  downloaded CLI binary (if you used `/memorylake:init` to install it).
  Delete the directory to remove them
- `~/.memorylake/` — the CLI's own credentials and profiles, shared with any
  other use of the `memorylake` CLI. Delete only if nothing else uses the CLI

## Development

```bash
claude --plugin-dir ./claude-plugin          # load without installing (from repo root)
/reload-plugins                              # pick up edits
claude plugin validate ./ --strict
```

Design rationale, the CLI command contract, and the roadmap live in
[`PLAN.md`](PLAN.md).

## License

MIT
