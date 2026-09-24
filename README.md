# memorylake-harness

Client-side harnesses that connect coding agents to
[MemoryLake](https://memorylake.ai) — cross-device long-term memory.
(Two deployments, separate accounts: [memorylake.ai](https://memorylake.ai)
international, [memorylake.cn](https://memorylake.cn) China; the CLI defaults
to the international endpoint.)

| Harness | Client | Status |
| --- | --- | --- |
| [`claude-plugin/`](claude-plugin/) | Claude Code | working — recall on read, sync on write, session status |
| [`codex-plugin/`](codex-plugin/) | Codex | working — recall skill, per-turn memory sync, session status |
| [`dsh-plugin/`](dsh-plugin/) | DeepSeek Harness (dsh) | working — memory tools, prompt guidance, session status; published as `@memorylake/dsh-plugin` |
| [`opencode-plugin/`](opencode-plugin/) | opencode | working — memory tools, prompt guidance, compaction guidance; published as `@memorylake/opencode-plugin` |
| [`qwenpaw-plugin/`](qwenpaw-plugin/) | QwenPaw | working — memory backend plugin: automatic recall, memory tools, Console form, `/memorylake-status`; installs from a zip |
| [`qwenwork-plugin/`](qwenwork-plugin/) | QwenWork | working — search-first reminder every turn, per-turn conversation sync, session status; the QwenWork agent installs it from this repo |
| [`workbuddy-plugin/`](workbuddy-plugin/) | WorkBuddy | working — search-first recall every turn (reminder + gate), per-turn conversation sync, session status; installs from this repo as a plugin marketplace |

All harnesses share one identity and data tree (`~/.memorylake/harness/`):
configure once, use from every client.

## Claude Code

```
/plugin marketplace add memorylake-ai/memorylake-harness
/plugin install memorylake@memorylake
/memorylake:init
```

See [`claude-plugin/README.md`](claude-plugin/README.md) for configuration,
privacy notes, and design rationale.

## Codex

```
codex plugin marketplace add memorylake-ai/memorylake-harness
codex plugin add memorylake@memorylake
set up memorylake
```

The last line is asked inside a Codex session, after trusting the hooks via
`/hooks`. See [`codex-plugin/README.md`](codex-plugin/README.md).

## DeepSeek Harness (dsh)

```
dsh plugin --profile web add @memorylake/dsh-plugin
dsh web
/memorylake-init
```

The last line is typed in a session; machines already set up for Claude Code
or Codex can skip it. See [`dsh-plugin/README.md`](dsh-plugin/README.md).

## opencode

```
opencode plugin @memorylake/opencode-plugin -g
set up memorylake
```

The last line is typed in a session; machines already set up for another
harness can skip it. See [`opencode-plugin/README.md`](opencode-plugin/README.md).

## QwenPaw

```
qwenpaw plugin install https://github.com/memorylake-ai/memorylake-harness/releases/download/qwenpaw-plugin-v0.2.1/memory-memorylake-0.2.1.zip
```

Then, per Agent, in the Console: Agent settings → Memory backend → Memory
Lake. On a machine already set up for another harness the form can stay
empty. See [`qwenpaw-plugin/README.md`](qwenpaw-plugin/README.md).

## QwenWork

In a QwenWork conversation, send:

```
Install the MemoryLake plugin by following qwenwork-plugin/INSTALL.md in https://github.com/memorylake-ai/memorylake-harness
```

The agent installs the plugin and runs the setup; machines already set up
for another harness skip the setup. **Agents installing into QwenWork: follow
[`qwenwork-plugin/INSTALL.md`](qwenwork-plugin/INSTALL.md)** -- the plugin is
that directory, not the repository root. See
[`qwenwork-plugin/README.md`](qwenwork-plugin/README.md).

## WorkBuddy

In WorkBuddy: Skills → Plugins → **+** (add marketplace) →
`memorylake-ai/memorylake-harness`, install **memorylake**, then in a session:

```
/memorylake:init
```

Machines already set up for another harness can skip the last step. See
[`workbuddy-plugin/README.md`](workbuddy-plugin/README.md).
