# memorylake-harness

Client-side harnesses that connect coding agents to
[Memory Lake](https://memorylake.cn) — cross-device long-term memory.

| Harness | Client | Status |
| --- | --- | --- |
| [`claude-plugin/`](claude-plugin/) | Claude Code | working — recall on read, sync on write, session status |
| [`codex-plugin/`](codex-plugin/) | Codex | working — recall skill, per-turn memory sync, session status |

Both harnesses share one identity and data tree (`~/.claude/memorylake-plugin/`):
configure once, use from both clients.

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
```

Then trust the hooks via `/hooks` inside a Codex session. See
[`codex-plugin/README.md`](codex-plugin/README.md).
