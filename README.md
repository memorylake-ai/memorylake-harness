# memorylake-harness

Client-side harnesses that connect coding agents to
[Memory Lake](https://memorylake.ai) — cross-device long-term memory.
(Two deployments, separate accounts: [memorylake.ai](https://memorylake.ai)
international, [memorylake.cn](https://memorylake.cn) China; the CLI defaults
to the international endpoint.)

| Harness | Client | Status |
| --- | --- | --- |
| [`claude-plugin/`](claude-plugin/) | Claude Code | working — recall on read, sync on write, session status |
| [`codex-plugin/`](codex-plugin/) | Codex | working — recall skill, per-turn memory sync, session status |
| [`dsh-plugin/`](dsh-plugin/) | DeepSeek Harness (dsh) | working — memory tools, prompt guidance, session status; published as `@memorylake/dsh-plugin` |
| [`opencode-plugin/`](opencode-plugin/) | opencode | working — memory tools, prompt guidance, compaction guidance; published as `@memorylake/opencode-plugin` |

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
