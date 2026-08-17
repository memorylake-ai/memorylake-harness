# @memorylake/dsh-plugin

Memory Lake for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness):
persistent, cross-session, cross-project, cross-device memory.

dsh ships no native memory capability, so this plugin is not a bridge to one —
it IS the harness's memory layer. It contributes:

- **Three tools** — `memory_search`, `memory_remember`, `memory_forget` —
  backed by the `memorylake` CLI (never by direct HTTP, never through a shell).
- **A prompt section** owning the policy: when to remember, how to phrase
  recall queries, how to read results, and that a failed search is never an
  empty one.
- **A one-line status context** reporting connectivity — most importantly when
  the backend is UNREACHABLE, because a silently unavailable memory backend is
  indistinguishable from "you never told me that".
- **Two user-invocable skills** — type `/memorylake-init` for the guided setup
  wizard (CLI download with mandatory checksum verification, login, shared
  config) and `/memorylake-status` for the end-to-end health check. The model
  cannot trigger either.

## Install

```sh
dsh plugin --profile web add @memorylake/dsh-plugin
dsh --profile web --dump-config   # shows the "@memorylake/dsh-plugin" layer
dsh web
```

`web` is dsh's built-in Web UI profile (auto-initialized on first use); any
other profile name works the same way — the plugin composes with whatever
surface the profile mounts.

The package publishes with built `lib/`, so no build allowance is needed. A
`github:` install also works — a self-contained `prepare` script builds from
source — but pnpm ≥10 will ask you to allowlist the build; prefer the
registry install.

## Zero-config on a machine that already has Memory Lake

Identity and switches live in the **shared `~/.memorylake/` tree**, not in
this plugin:

- `~/.memorylake/credentials.toml` — the CLI's login state
- `~/.memorylake/harness/config.md` — workspace, actor, and feature flags
- `<repo>/.claude/memorylake.local.md` — optional per-project override,
  **merged key by key** over the global file (a one-line
  `sync_on_write: false` override keeps the global workspace working)

If the Claude Code or Codex integration already wrote these, a dsh session
picks them up with zero additional steps: status line, tools, recall — all
live. Config files are re-read on every call, so `/memorylake-init` finishing
mid-session takes effect on the very next message, no restart.

When nothing is configured, the plugin is **completely silent**: no network
requests, no prompt injection. Only an explicitly invoked memory tool answers,
and only to point at `/memorylake-init`.

### Shared config keys (`config.md` / `memorylake.local.md` frontmatter)

| Key | Default | Meaning |
| --- | --- | --- |
| `workspace` | — | Memory Lake workspace id. The only required key; absent means the plugin stays silent |
| `actor` | — | Actor id facts are attributed to; required for writes |
| `enabled` | `true` | `false` switches the plugin off entirely |
| `sync_on_write` | `true` | `false` makes memory read-only (the canonical per-project override) |
| `status_line` | `true` | `false` suppresses the session status line |

Keys consumed by the other harnesses (`remind_on_read`, `sync_deny`,
`projects`, `project_custom_id`) are parsed and preserved but not consumed by
this plugin's v1.

## Deployment knobs (cordis config)

Only operational tuning lives in the bundle's rows; override by `id` in your
profile's `cordis.patch.yml` (a patch replaces the row's whole `config`).

Row `memorylake` (`@memorylake/dsh-plugin/service`):

| Key | Default | Meaning |
| --- | --- | --- |
| `binaryPath` | — | Absolute path of the `memorylake` binary, overriding resolution (PATH, then `~/.memorylake/bin/memorylake`) |
| `timeoutMs` | `30000` | Hard deadline per CLI invocation |
| `killGraceMs` | `2000` | SIGTERM→SIGKILL grace on timeout/cancel |
| `maxOutputBytes` | `1000000` | In-memory cap per collected CLI stream |

Row `memorylake-tools` (`@memorylake/dsh-plugin/tools`):

| Key | Default | Meaning |
| --- | --- | --- |
| `topKMax` | `10` | Upper bound for the model's `top_k` |
| `statusTtlSeconds` | `600` | Status-line refresh interval and cache TTL |

## Behavior notes

- **Authentication is CLI login state.** The dsh subprocess seam scrubs
  credential-shaped environment names from children, so an ambient
  `MEMORYLAKE_API_KEY` is never forwarded — by design, and matching the CLI's
  own "env vars alone are not a session" rule. Log in once with
  `memorylake auth login` (the init skill walks through it).
- **Payload before exit code.** The CLI prints its full JSON payload and then
  encodes the business outcome in the exit code (`fact delete` exits non-zero
  when ids were not found). The plugin parses first and classifies second.
- **Failure is not emptiness.** Unavailable backends produce an explicit
  `notice` in the tool value and a loud status line, instructing the model to
  attribute empty results to the connection rather than to missing memory.
- **Scores are ordering-only.** Relevance scores sort results and are then
  discarded; they never reach the model (they are weakly calibrated, and a
  model shown a number treats it as authority).
- **No auto-recall, no session memory digest.** Both were evaluated and
  rejected in the Claude Code integration: fixed token cost on sessions that
  never touch memory, no behavioral gain. The status line reports
  connectivity only.

## v2 roadmap (deliberately not in v1)

- **Session→conversation cook**: append dsh session transcripts as Memory Lake
  conversations and let the backend distill them into memories — dsh's
  "model-visible ⟺ logged" invariant makes the transcript complete, which no
  other harness guarantees. Privacy defaults off.
- **Document search**: Library upload + project import, and passing
  `--projects` on search (without it the server returns zero document hits —
  facts are unaffected, which is why v1 is facts-only).
- **Project identity**: the explicit-custom-id → normalized-git-remote →
  physical-path rule shared with the other harnesses.
- **Session-start facts digest**: a small, config-gated summary — dsh has no
  local MEMORY.md, so unlike the other harnesses this may carry real value,
  but it must first justify its token cost.
- **Upstreaming** as an in-tree `packages/memorylake/` capability seam.

## Development

```sh
pnpm install
pnpm test        # vitest: unit + integration + real-Loader composition
pnpm build       # tsc → lib/
```

Tests run against a mock `memorylake` binary and an isolated data tree; no
network, no API key, and no touching your real `~/.memorylake`.
