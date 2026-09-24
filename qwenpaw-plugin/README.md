# MemoryLake for QwenPaw

MemoryLake as a [QwenPaw](https://github.com/agentscope-ai/QwenPaw) memory
backend: persistent memory shared **across projects, machines, and clients**.
An Agent switched to this backend sees the memories written from Claude Code,
Codex, dsh, and opencode on the first turn, and everything it stores is
visible to them.

QwenPaw has a pluggable long-term memory slot, with ReMe Light as the default.
This plugin fills that slot. For the Agents that select it, the platform's own
machinery does the rest: the memory protocol goes into the system prompt,
`memory_search` / `memory_remember` / `memory_forget` join the toolkit,
relevant memories are **recalled automatically before every reply**, and
`/memorylake-status` shows what is going on.

Selecting MemoryLake replaces ReMe Light for that Agent. Its Markdown memory
files stay on disk; they are simply no longer read or written.

## Install

```sh
qwenpaw plugin install https://github.com/memorylake-ai/memorylake-harness/releases/download/qwenpaw-plugin-v0.2.1/memory-memorylake-0.2.1.zip
```

Works against a running QwenPaw (hot-loaded, no restart) and a stopped one
(loaded on next start). In Docker, run the same command through
`docker exec <container> qwenpaw plugin install <url>`, or use the Console's
plugin page (URL or zip upload). Installing from a local checkout also works:
`qwenpaw plugin install /path/to/qwenpaw-plugin`.

Then, for each Agent that should use it: **Console → Agent settings → Memory
backend → MemoryLake**, fill the form, save. QwenPaw rebuilds the Agent's
memory manager on save.

### Already set up for Claude Code, Codex, dsh, or opencode?

Leave every field in the form empty. The plugin reads the shared
`~/.memorylake/harness/config.md` (workspace, actor, `enabled`) and uses the
`memorylake` CLI's existing login. Nothing else to do.

### Fresh machine, Docker, or a multi-user Hub

Fill in the form:

| Field | Meaning |
| --- | --- |
| Deployment | memorylake.ai (default) or memorylake.cn. The link next to the API key field opens the matching console, where keys are created |
| API key | Logs the CLI in inside a directory owned by this Agent (`<working dir>/plugin-state/memory-memorylake/cli-home/<agent_id>/`), never touching the machine's own `~/.memorylake` login. Different Agents can use different teams. Re-applied on every start, so a rebuilt container heals itself |
| Workspace, Actor | Click **Load from MemoryLake** and pick from what the key can see. One workspace is selected for you; your own actor is selected when it is bound to the workspace. Pasting an id still works. Without an actor, memory is read-only |
| Automatic recall | On by default; searches with the user's message before each reply. Results per recall: 3 |
| Install the CLI automatically | On by default. When no `memorylake` binary is on `PATH` or in `~/.memorylake/bin`, the release archive is downloaded, its SHA-256 verified, and the binary installed under `<working dir>/plugin-state/memory-memorylake/bin/` |

Without the Console, the same lives in the Agent's `agent.json`:

```json
{
  "running": {
    "memory_manager_backend": "memorylake",
    "memory_backend_configs": {
      "memorylake": { "api_key": "sk-...", "workspace": "ws-...", "actor": "actor-..." }
    }
  }
}
```

**Where the key rests.** The API key is masked in the Console and in the
running-config API, but stored in `agent.json` in plain text, exactly like
other memory backends' credentials. Protect the working directory
accordingly.

## What the Agent gets

- **Automatic recall** before every reply, when there are relevant facts. It
  is injected as a synthetic tool exchange for that turn only and never enters
  the persisted history. The whole message is the query (QwenPaw's default
  keeps 50 characters); slash commands and bare acknowledgements are not
  searched. Turn it off per Agent in the form.
- **A search playbook in the system prompt**: what automatic recall misses,
  when to search again, how to phrase a query the way a memory is written,
  when to stop, how to use a hit.
- **`memory_search`** for anything automatic recall missed. Facts first,
  ordered by relevance, scores never shown; an empty result carries a hint
  rather than a bare empty list.
- **`memory_remember`** and **`memory_forget`**, offered only when an actor
  is configured. Facts are written when the model calls the tool.
- **Conversation sync, off by default.** When switched on in the form, the
  text of what the user says and what the Agent replies is appended to one
  MemoryLake conversation per chat session, and MemoryLake distills
  memories from it in the background. It is sent in batches, every N user
  turns (N is configurable, default 1), and also when QwenPaw compacts the
  context or the user runs `/new`. **Only text is sent**: tool calls, tool
  results, reasoning, images, and files never leave the machine. The user's
  messages are attributed to the configured actor; the Agent's to an
  `ASSISTANT` actor the plugin creates once per Agent. Every message is sent
  with its QwenPaw id as the idempotency key, so retries and QwenPaw's own
  replays never duplicate anything. A batch that fails is kept on disk and
  retried with the next one; `/memorylake-status` shows the last outcome.
- **Honest failure.** When the CLI is missing, not logged in, or the backend
  is unreachable, the system prompt says recall is UNAVAILABLE and a failing
  tool call says so too, so the model cannot mistake an outage for "you never
  told me that".

## `/memorylake-status`

Type it in any chat with the Agent. It reports, without calling the model:
config state and where each value came from (Agent config or shared file),
CLI path and version, whose login is in use, connectivity, and which tools
are currently offered. It is the first thing to run when memory seems off.

## Configuration reference

`memory_backend_configs.memorylake`:

| Key | Default | Meaning |
| --- | --- | --- |
| `api_key` | `""` | non-empty → this Agent logs the CLI in itself, in its own directory |
| `base_url` | `""` | passed to that login; empty keeps the CLI default |
| `workspace` | `""` | overrides the shared config |
| `actor` | `""` | overrides the shared config; required for writes |
| `sync_conversations` | `false` | record conversation text to MemoryLake (needs `actor` and `project`) |
| `project` | `""` | the MemoryLake project the conversation is filed under |
| `sync_interval` | `1` | send every N user turns (1–20) |
| `max_message_chars` | `8000` | longer messages are clipped before sending (500–64000) |
| `auto_recall` | `true` | recall before every reply |
| `auto_recall_top_k` | `3` | results per automatic recall (1–10) |
| `top_k` | `5` | default for `memory_search` (1–20) |
| `install_cli` | `true` | `false` never downloads |
| `timeout_seconds` | `20` | per CLI invocation (1–120) |

Per key, the Agent config wins over `~/.memorylake/harness/config.md`. The
shared `enabled: false` switch applies only to an Agent that is relying on the
shared file for its workspace; an Agent with its own workspace has opted in.
`MEMORYLAKE_PLUGIN_DATA` relocates the shared tree, as in every harness.

## Uninstall

Switch every Agent that uses MemoryLake back to another backend first;
QwenPaw refuses to uninstall a memory plugin whose backend is in use. Then
`qwenpaw plugin uninstall memory-memorylake`.

## Development

```sh
uv venv .venv && uv pip install --python .venv/bin/python qwenpaw pytest pytest-asyncio
.venv/bin/python -m pytest
(cd frontend && npm install && npm run build)     # rebuilds frontend/dist/index.js
qwenpaw plugin validate .
```

`frontend/dist/index.js` is committed so the plugin installs from a plain zip
with no build step. The form's pickers call the plugin's own
`POST /api/memorylake/discover`, which runs the CLI server-side with the
credentials the form is about to save; an unsaved key is used from a
throwaway directory and never written to disk by that call. To produce the release zip with QwenPaw's own packer,
lay the plugin out as `plugins/memory/memory-memorylake/` and run
`scripts/pack/generate_plugin_metadata.py` from a QwenPaw checkout; it honours
`pack_exclude` in `plugin.json`.

See [`DESIGN.md`](DESIGN.md) for the decisions and the platform facts they
rest on.
