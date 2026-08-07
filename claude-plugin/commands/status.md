---
description: Diagnose the Memory Lake plugin setup — CLI, login, config, connectivity
disable-model-invocation: true
allowed-tools: Bash, Read
---

Run the checks below in order and report each one as pass or fail with the
detail shown. Do not stop at the first failure — the user needs the whole
picture. End with the single most useful next action.

## 1. CLI installed

```bash
command -v memorylake || ls "$HOME/.claude/memorylake-plugin/bin/memorylake"
```

Report which location was found (a PATH install takes precedence over the
plugin's private download) and its `memorylake version`. Missing from both →
the plugin cannot do anything; point at `/memorylake:init`, which can download
a prebuilt binary.

## 2. jq installed

```bash
command -v jq
```

Missing → hooks exit silently and `ml-recall` refuses to run. On macOS:
`brew install jq`.

## 3. Logged in

```bash
memorylake auth status
```

Report the profile, base URL, and where each came from. Not logged in →
`memorylake auth login --api-key sk-...`.

## 4. Project config

Two levels, project overrides global:

1. `.claude/memorylake.local.md` from the project root (walk up from the
   working directory) — optional per-project override
2. `~/.claude/memorylake-plugin/config.md` — the global default written by
   `/memorylake:init`

Report which one is in effect and the values of `enabled`, `workspace`,
`project_custom_id` (project-level only), `remind_on_read`, `sync_on_write`,
and `status_line`. Neither exists → point at `/memorylake:init`.

`workspace` is the only strictly required field; without it every hook exits
silently.

## 5. Connectivity

Only if steps 1, 3, and 4 passed:

```bash
memorylake project list --workspace <workspace from config>
```

Report the project count. A failure here means recall is unavailable — say so
explicitly, because a silently unavailable memory backend is
indistinguishable from an empty memory unless someone says it out loud.

## 6. End-to-end recall

Only if step 5 passed:

```bash
ml-recall "test" --top-k 1
```

An empty result is a pass — it proves the path works. A non-zero exit is a
failure; show stderr verbatim.
