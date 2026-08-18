# Memory Lake for opencode

Long-term memory for [opencode](https://opencode.ai), backed by Memory Lake via
the `memorylake` CLI.

opencode has no memory of its own. Its only ambient instructions are static
`AGENTS.md` files, and it reads exactly two things from Claude Code —
`~/.claude/CLAUDE.md` and `.claude/skills/`. It does **not** read Claude Code's
memory directory, so everything your assistant learned about you there is
invisible here.

That is what this plugin fixes. If you already use the
[Claude Code plugin](../claude-plugin/), your memories are available in opencode
the moment you install this — you are connecting memory you already have, not
starting a new collection.

## Install

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@memorylake/opencode-plugin"]
}
```

in `opencode.json` (project) or `~/.config/opencode/opencode.json` (global).
opencode installs it with Bun on next start.

If you already ran `/memorylake:init` in Claude Code, or set up the Codex or dsh
plugin, **you are already configured** — all four harnesses share one identity
at `~/.memorylake/harness/`, and the memory tools appear on next start.

Otherwise, ask opencode:

```
set up memorylake
```

It will call the plugin's `memory_setup` tool and walk you through the CLI,
login, and config. opencode has to be restarted at the end: the plugin resolves
its configuration when opencode loads it, so the memory tools cannot appear in
a session that started before the config existed.

To configure by hand instead, install the
[`memorylake` CLI](https://github.com/memorylake-ai/memorylake-cli), log in
(`memorylake auth login --api-key sk-...`), and write
`~/.memorylake/harness/config.md`:

```markdown
---
enabled: true
workspace: ws-1234
actor: actor-…
---
```

A repository can override the global config with
`.opencode/memorylake.local.md` (or `.claude/memorylake.local.md`, which the
Claude Code plugin already reads — either works).

## What it does

**Recall.** Three tools: `memory_search`, `memory_remember`, `memory_forget`.
They are the same names the dsh plugin registers, so the vocabulary does not
change when you switch harnesses.

**Protocol.** A block appended to the system prompt covers both directions:
when to search and how to read results, and — equally — when to *remember*.
Standing instructions ("from now on…"), corrections, decisions and their
reasoning, and facts about how you want to be worked with all get stored as
they happen, because a session can be compacted or closed at any moment and an
unwritten fact is one you have to repeat.

It goes in the system prompt rather than the conversation for two reasons:
opencode keeps the system prompt in a block separate from its cacheable header,
and — unlike anything in the message history — it is never compacted away. So
the instruction survives a long session, which is exactly when the model is
most likely to forget that a memory backend exists. The block is ~900 tokens,
byte-identical across a session, and omits the write half entirely when no
actor is configured.

**Compaction.** opencode lets a plugin append to the prompt that generates a
compaction summary. We add one line asking that durable facts, decisions, and
corrections survive. Claude Code's equivalent hook cannot reach the model at
all, so this is a capability we only have here.

**Honesty about failure.** If the backend is unreachable, the CLI is missing, or
authentication has lapsed, the system block says so, in those words. This
matters more than it sounds: a memory system that fails silently teaches the
model to tell you that you never mentioned something.

## Design differences from the other plugins

| | Claude Code / Codex | opencode |
| --- | --- | --- |
| Host memory | native auto-memory / engine summaries; we sync them | none — this plugin *is* the memory |
| Value on install | bridges memory the host already keeps | surfaces memory the host cannot see at all |
| Integration | shell hooks, `jq` required | in-process TypeScript, no external tools |
| Protocol location | a skill, in the conversation (compactable) | the system prompt (never compacted) |
| Compaction | `PreCompact` cannot inject into model context | the compaction prompt itself is extensible |
| Writes | intercept the model's own memory writes | the model calls `memory_remember` |

## Requirements

- opencode ≥ 1.16
- the `memorylake` CLI on `PATH`, or installed privately at
  `~/.memorylake/bin/memorylake` by any harness's setup

No `jq` and no shell: the plugin runs in-process and invokes the CLI with
`execFile`, never through a shell. (opencode's `$` is `undefined` outside Bun,
and passing arbitrary query text through a shell is a quoting hazard we have no
reason to accept.)

## Privacy

- `memory_search` sends your query text to your workspace
- `memory_remember` sends exactly the fact text the model passes it
- **conversations are never uploaded.** This plugin does not read transcripts
  and has no "capture the session" mode
- with no config file, nothing is sent anywhere and no network call is made:
  the plugin offers a `memory_setup` tool and tells the model it has no memory
- with `enabled: false`, nothing at all is registered or injected

## Uninstall

Remove the entry from `opencode.json`. The shared data tree
(`~/.memorylake/harness/`) and CLI credentials (`~/.memorylake/`) belong to all
four harnesses — remove them only if you are done with every one.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

`test/setup.ts` redirects `MEMORYLAKE_PLUGIN_DATA` for the whole suite, so tests
cannot touch a real `~/.memorylake` tree.
