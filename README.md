# memorylake-harness

Client-side harnesses that connect coding agents to
[Memory Lake](https://memorylake.cn) — cross-device long-term memory.

| Harness | Client | Status |
| --- | --- | --- |
| [`claude-plugin/`](claude-plugin/) | Claude Code | working — recall on read, sync on write, session status |
| `codex-plugin/` | Codex | planned |

## Claude Code

```
/plugin marketplace add memorylake-ai/memorylake-harness
/plugin install memorylake@memorylake
/memorylake:init
```

See [`claude-plugin/README.md`](claude-plugin/README.md) for configuration,
privacy notes, and design rationale.
