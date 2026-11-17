# MemoryLake for WorkBuddy

Cross-device long-term memory for [WorkBuddy](https://www.workbuddy.cn),
backed by MemoryLake via the `memorylake` CLI.

WorkBuddy keeps its own memory -- `MEMORY.md` files and daily notes on this
machine, plus its cloud profile. This plugin adds the memory that lives
**everywhere else**: other WorkBuddy machines, Claude Code, Codex, and the
other MemoryLake clients. It is deliberately assertive about it:

- **Search first, every turn.** Each user message carries an instruction to
  search MemoryLake before replying, and the first tool call of a turn that
  skipped the search is held back once with an instruction to search.
- **Every turn is remembered.** After each turn, the user's message and the
  assistant's final reply are appended to a MemoryLake conversation (one per
  WorkBuddy session); the server distills memories from it.
- **Attached files can follow (opt-in).** With `sync_attachments: true`, the
  documents and images the user attaches to a message are uploaded to the
  MemoryLake Library and imported into the session's project.

All MemoryLake harnesses share one identity and data tree
(`~/.memorylake/harness/`): a machine already set up for Claude Code, Codex,
dsh, opencode, or QwenPaw needs no further setup.

## Install

In WorkBuddy: **Skills -> Plugins -> +** (add marketplace) ->
`memorylake-ai/memorylake-harness`, then install **memorylake**. WorkBuddy reads this repository's
`.workbuddy-plugin/marketplace.json`, which points at this directory; Claude
Code keeps reading `.claude-plugin/`.

Then, in a WorkBuddy session:

```
/memorylake:init
```

It installs the CLI if needed, logs in, and writes the shared config. Skip it
on a machine that is already set up. `/memorylake:status` is the health check.

## How it works

WorkBuddy runs Claude-Code-style plugin hooks (command hooks only, on the
desktop). The plugin uses four events:

| Hook | Script | What it does |
| --- | --- | --- |
| `SessionStart` | `scripts/session-start.sh` | Standing instructions (what MemoryLake is, search-first, what is synced) and a status line; re-sent after a compaction |
| `UserPromptSubmit` | `scripts/prompt-submit.sh` | Starts the turn: resets the gate, queues the user's words for sync, injects the search-first reminder |
| `PreToolUse` | `scripts/recall-gate.sh` | Marks the turn searched when the model runs `ml-recall`; otherwise holds back the turn's first other tool call, once |
| `Stop` (async) | `scripts/sync-turn.sh` | Appends the queued user message and the final reply to the session's MemoryLake conversation |
| `Stop` (async) | `scripts/sync-attachments.sh` | Reads the turn's attached files from the transcript and uploads them, when `sync_attachments` is on |

Why hooks and not the system prompt: WorkBuddy assembles its desktop system
prompt from a fixed set of sources with no plugin slot, and switches off the
CLI's own instruction files (`CODEBUDDY.md`, `rules/`) in desktop sessions.
Hook output is injected as a `<system-reminder>` -- into the first message
for `SessionStart`, into the current message for `UserPromptSubmit` -- which
is the closest a plugin can get.

### What is synced

Text only: what the user typed (WorkBuddy's own injected context stripped)
and the assistant's final reply, each clipped to 8000 characters. Tool calls,
tool output, and thinking never leave the machine, and neither do attachments
unless `sync_attachments` is turned on (next section). Each message
carries a custom id derived from its turn, so retries never duplicate.

### Which project things land in

- **A chat started without choosing a folder** goes to one shared project
  named **WorkBuddy** (custom id `workbuddy`), the same on every machine.
  WorkBuddy runs such a chat in a scratch directory it names after the clock
  (`~/WorkBuddy/2026-11-13-18-10-18`); treating each of those as a project
  would leave a pile of projects named after timestamps and upload the same
  attachment once per chat.
- **A chat in a folder or repository the user opened** goes to that folder's
  project, by the same identity rule as the other harnesses (normalized git
  remote, else the physical path) -- so WorkBuddy, Claude Code, and Codex
  meet in one project per repository.
- `project_custom_id` in the config overrides both.

Each chat stays a separate conversation inside its project. Recall is not
affected by any of this: `ml-recall` searches every project in the
workspace. Projects that versions before 0.2.1 created per chat are left as
they are and stay searchable.

A failed sync keeps its messages queued under
`~/.memorylake/harness/state/workbuddy/<session>/` and retries after the next
turn; `/memorylake:status` shows the last outcome.

### Attached files (opt-in)

With `sync_attachments: true`, files the user attaches to a message are
uploaded after the turn into a Library folder named `attachments--<project>`
and imported into the same project as the conversation, so they are
searchable as documents.

WorkBuddy has no upload directory and tells `UserPromptSubmit` hooks nothing
about attachments, so after each turn the plugin reads the new part of the
session transcript and picks the files up where WorkBuddy leaves them:

| Attached as | Where WorkBuddy keeps it | Synced |
| --- | --- | --- |
| A document (dropped, picked, or @-mentioned) | The original path, listed in the message's `<user_references>` / `<attached_files>` context | Yes |
| An image (dropped, pasted, a screenshot) | Compressed, under `~/.workbuddy/blobs/`, referenced from the transcript | Yes, the compressed copy |
| A cloud item (Tencent drive, Lexiang, ima) | Nowhere local | No |

Two filters apply before anything is sent, because an @-mentioned workspace
file looks exactly like a dropped one: only document and image types are
uploaded (`pdf doc docx ppt pptx xls xlsx csv tsv txt md markdown rtf png jpg
jpeg webp gif bmp`), and only up to `sync_attachments_max_mb` (default 20).
Source files, archives, and anything else are skipped and named in
`/memorylake:status`.

A file is identified by its content hash: attaching the same file again
sends nothing, and attaching the same path with new content replaces the
earlier upload. Attachment sync is never wider than conversation sync -- a
folder that uploads no conversation (`sync_deny`, or `sync_conversations:
false`) uploads no attachment.

## Configuration

Keys in `~/.memorylake/harness/config.md` (or a folder's
`.claude/memorylake.local.md`, which overrides key by key):

| Key | Default | Meaning |
| --- | --- | --- |
| `workspace`, `actor` | -- | Required; written by init |
| `sync_conversations` | follows `sync_on_write` | Upload each turn. Outbound, so explicit opt-in |
| `sync_deny` | -- | Comma-separated path prefixes that never upload |
| `sync_attachments` | off | Upload the documents and images attached to a message. Must be an explicit `true` |
| `sync_attachments_max_mb` | 20 | Largest attached file to upload |
| `recall_reminder` | on | The per-turn search-first reminder |
| `recall_gate` | on | Hold back the first unsearched tool call of a turn |
