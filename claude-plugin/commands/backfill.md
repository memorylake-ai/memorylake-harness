---
description: Upload pre-existing local memories from all projects to Memory Lake (one-time, opt-in)
disable-model-invocation: true
allowed-tools: Bash, Read
---

The write hook only syncs memories written from now on; this command uploads
the auto-memory that already exists on this machine, across all projects.
It is safe to run repeatedly — files already synced (by an earlier backfill
or by the hook) are skipped via the same hash state the hook uses.

## 1. Preview first, always

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/backfill.sh" --dry-run
```

Show the user the summary and notable entries: which projects would upload,
which are excluded by `sync_deny`, and any project directories that could not
be resolved back to a real path (deleted or renamed projects — their memories
stay local; that is expected, not an error).

## 2. Confirm, then run

This uploads the accumulated contents of local memory — potentially months of
notes about what the user worked on — to their Memory Lake workspace. Get an
explicit yes on the dry-run preview before running for real:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/backfill.sh"
```

## 3. Report

Relay the summary (synced / skipped by deny / failed / unresolvable). On
failures, show them verbatim — they name the file and the reason — and note
that re-running backfill retries only what failed (everything else is in
state). If the user wants a project excluded, add it to `sync_deny` in
`~/.memorylake/harness/config.md` (or `/memorylake:sync off` inside that
project) and re-run.

Facts (user/feedback memories) are searchable immediately; file-routed
memories (project/reference) finish indexing within a minute or two.
