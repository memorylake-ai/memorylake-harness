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
- **Attached files follow.** The documents and images the user attaches to a
  message are uploaded to the MemoryLake Library and imported into the
  session's project, unless that switch is turned off.
- **The whole of MemoryLake is at hand.** The `memorylake` CLI comes inside
  the plugin, with skills for managing memory, files, projects and access.

Installing the plugin is all there is to it. Nothing else has to be on the
computer: the CLI for macOS and Windows is inside the plugin, the
hooks need only the Node that WorkBuddy runs hooks with, and signing in
happens on a page the plugin opens in the browser.

All MemoryLake harnesses share one identity and data tree
(`~/.memorylake/harness/`): a machine already set up for Claude Code, Codex,
dsh, opencode, or QwenPaw needs no further setup.

## Install

In WorkBuddy: **Skills -> Plugins -> +** (add marketplace) ->
`memorylake-ai/memorylake-harness`, then install **memorylake**. WorkBuddy
reads this repository's `.workbuddy-plugin/marketplace.json`, which names the
released plugin: a zip among this repository's releases, with the CLI inside,
that WorkBuddy downloads and checks against the SHA-256 written there.

The first session after that opens MemoryLake's sign-in page in the browser,
once. There the user signs in (or keeps the MemoryLake login already on the
computer), picks a workspace, may import the memory WorkBuddy already keeps on
the computer, and chooses what automatic memory does. Memory works from the
next message on. On a machine another MemoryLake harness already set up, no
page opens: the plugin just works.

`/memorylake:init` opens the page again, to change the account, the workspace
or the switches; `/memorylake:status` is the health check.

This directory is a plugin as it is, too, for a marketplace of one's own that
points at it, but then without the CLI:
the plugin falls back on a `memorylake` in `~/.memorylake/bin` or on `PATH`.

## How it works

WorkBuddy runs Claude-Code-style plugin hooks (command hooks only, on the
desktop). All of them are `node scripts/hook.mjs <name>`:

| Hook | Name | What it does |
| --- | --- | --- |
| `SessionStart` | `session-start` | Standing instructions (what MemoryLake is, search-first, what is synced) and a status line; re-sent after a compaction. Not set up yet: opens the sign-in page, the first time |
| `UserPromptSubmit` | `prompt-submit` | Starts the turn: resets the gate, queues the user's words for sync, injects the search-first reminder |
| `PreToolUse` | `recall-gate` | Marks the turn searched when the model runs `ml-recall`; otherwise holds back the turn's first other tool call, once |
| `Stop` | `sync-turn` | Queues the final reply and starts the upload of the turn on its own, so it outlives the turn |
| `Stop` | `sync-attachments` | Reads the turn's attached files from the transcript and starts their upload the same way |

WorkBuddy puts the plugin's `bin/` on the model's `PATH`:

| Command | What it is |
| --- | --- |
| `ml-recall` | The search the model runs at the start of a turn |
| `memorylake` | The CLI inside the plugin, for this computer's platform |
| `memorylake-connect` | Opens the sign-in page (`scripts/connect.mjs`) |

The hooks, `ml-recall`, the sign-in page and the skills are the same files
the [WorkBuddy connector](../workbuddy-connector) carries; see
[Development](#development).

Why hooks and not the system prompt: WorkBuddy assembles its desktop system
prompt from a fixed set of sources with no plugin slot, and switches off the
CLI's own instruction files (`CODEBUDDY.md`, `rules/`) in desktop sessions.
Hook output is injected as a `<system-reminder>` -- into the first message
for `SessionStart`, into the current message for `UserPromptSubmit` -- which
is the closest a plugin can get.

### What is synced

Text only: what the user typed (WorkBuddy's own injected context stripped)
and the assistant's final reply, each clipped to 8000 characters. Tool calls,
tool output, and thinking never leave the machine. Attachments are the next
section. Each message
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

### Attached files

With `sync_attachments: true` (a switch on the sign-in page, on unless the
user turns it off there), files the user attaches to a message are
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
| `workspace`, `actor` | -- | Required; written by the sign-in page |
| `sync_conversations` | follows `sync_on_write` | Upload each turn. A switch on the sign-in page |
| `sync_deny` | -- | Comma-separated path prefixes that never upload |
| `sync_attachments` | off | Upload the documents and images attached to a message. Must be an explicit `true`, which the sign-in page writes |
| `sync_attachments_max_mb` | 20 | Largest attached file to upload |
| `recall_reminder` | on | The per-turn search-first reminder |
| `recall_gate` | on | Hold back the first unsearched tool call of a turn |

## Building

```bash
node dev/build.mjs --zip
```

leaves `dist/memorylake-plugin/`, a marketplace directory holding the plugin
with the `memorylake` CLI under `vendor/` for macOS (arm64, x64) and Windows
(x64), about 22 MB, and the same as a zip. On any other platform the plugin
falls back on a `memorylake` in `~/.memorylake/bin` or on `PATH`. The binaries are not in this repository:
the build takes them from the CLI's npm packages, at the release the
connector pins in `workbuddy-connector/memorylake/cli.json` (`--cli VERSION`
for another, `--registry URL` for a mirror, `--platforms` to choose others: `linux-x64`,
`linux-arm64` and `win32-arm64` exist too).

## Releasing

1. Set the version in `.workbuddy-plugin/plugin.json`, merge, and build from
   that commit: `node dev/build.mjs --zip`.
2. Create the release `workbuddy-plugin-v<version>` on that commit with
   `dist/memorylake-plugin-<version>.zip` and its `.sha256` as assets (not
   marked latest: other tools read this repository's latest release).
3. Put the entry the build printed (`version`, and `source` with the asset's
   URL and SHA-256) into this repository's `.workbuddy-plugin/marketplace.json`
   and merge that. From then on WorkBuddy installs the new release; until
   then it keeps installing the one before.

## Development

The connector's copies of the shared files are the source. After changing
one, bring the plugin's along:

```bash
node dev/sync.mjs           # copy; skills get the plugin's wording
node dev/test.mjs           # the plugin end to end, against a stand-in API
```

What is the plugin's own: `scripts/lib/host.mjs` (where its CLI is, what the
model is told when setup is needed, opening the page at the first session),
`scripts/connect.mjs`, `bin/memorylake*`, the commands and the manifest.
