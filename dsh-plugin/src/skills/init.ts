/**
 * Body of the `memorylake-init` runtime skill: the guided setup wizard,
 * ported from the Claude Code plugin's `/memorylake:init` command. User-only
 * invocation (`/memorylake-init` in the input); the model never triggers it.
 *
 * dsh-specific adaptations versus the Claude Code original: no backfill
 * stage (dsh has no pre-existing auto-memory to upload), no hook-activation
 * notes (this plugin re-reads the shared config on every call, so everything
 * is hot), and no plugin-root variables (commands run through the harness's
 * own bash tool and its permission system).
 * @module
 */

/** Model-facing instructions for the guided Memory Lake setup. */
export const INIT_SKILL_CONTENT = `Walk the user from a bare plugin install to a working Memory Lake setup. Run
the stages in order; skip any stage that is already satisfied and say so.
Never print, echo, or write the user's API key anywhere except the
\`memorylake auth login\` command itself.

## Stage 1 — CLI binary

Check both locations, in this order:

\`\`\`bash
command -v memorylake || ls "$HOME/.memorylake/bin/memorylake"
\`\`\`

If found, report the version (\`memorylake version\`) and move on.

If missing, ask the user (via the \`ask_user_question\` tool) which way to
install:

- **Download prebuilt binary (recommended)** — fetch the latest GitHub
  release into the shared private location, which this plugin checks
  automatically:

  \`\`\`bash
  repo="memorylake-ai/memorylake-cli"
  # Detect platform → release target triple
  case "$(uname -sm)" in
    "Darwin arm64")  target=aarch64-apple-darwin ;;
    "Darwin x86_64") target=x86_64-apple-darwin ;;
    "Linux x86_64")  target=x86_64-unknown-linux-gnu ;;
    "Linux aarch64") target=aarch64-unknown-linux-gnu ;;
  esac
  # Resolve the latest release tag
  tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p')
  # Download, verify the checksum, extract just the binary
  cd "$(mktemp -d)"
  curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.tar.gz"
  curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.tar.gz.sha256"
  shasum -a 256 -c "memorylake-$tag-$target.tar.gz.sha256"
  tar -xzf "memorylake-$tag-$target.tar.gz"
  mkdir -p "$HOME/.memorylake/bin"
  install -m 0755 "memorylake-$tag-$target/memorylake" "$HOME/.memorylake/bin/memorylake"
  "$HOME/.memorylake/bin/memorylake" version
  \`\`\`

  If the release lookup 404s, no release has been published yet — tell the
  user plainly and fall through to the next option.

- **I'll install it myself** — point at the repository
  (\`cargo install\` from \`memorylake-ai/memorylake-cli\`, or a package the
  team distributes) and stop here; the user can invoke \`/memorylake-init\`
  again afterwards.

The checksum verification is not optional. A download whose checksum does
not match must be deleted and reported, never installed.

For the rest of this skill, use the binary you found or installed. If it is
the private-location one, invoke it by full path — the current session's
PATH does not include it.

## Stage 2 — Login

\`\`\`bash
memorylake auth status
\`\`\`

If not logged in, ask the user for their API key (they can create one in the
Memory Lake console). The service has two deployments with **separate
accounts**: the international one at memorylake.ai (the CLI's default) and
the China one at memorylake.cn. Ask which console the user's account lives
in; international accounts need no \`--base-url\`, China accounts log in with
\`--base-url https://app.memorylake.cn/openapi/memorylake\`.

\`\`\`bash
memorylake auth login --api-key <KEY> [--base-url <URL>]
\`\`\`

Confirm with \`memorylake auth status\`. Remind the user the key is stored in
\`~/.memorylake/credentials.toml\` (file mode 0600), managed by the CLI, not
by this plugin.

## Stage 3 — Global config

The config is **global by default**: workspace and actor are account-level
facts, and recall must work in every project — including ones that never ran
this setup. A per-project \`.claude/memorylake.local.md\` at the repo root is
an optional override (different workspace, or \`sync_on_write: false\` /
\`enabled: false\` to keep one project read-only or opted out entirely). The
file and its format are shared with the Claude Code and Codex integrations,
so one setup serves every harness on this machine.

If \`~/.memorylake/harness/config.md\` already exists, show its current
values and ask whether to keep or rewrite it.

Otherwise gather the pieces:

1. **Workspace**: \`memorylake ws list\`. One workspace → use it. Several →
   let the user pick (use the \`ask_user_question\` tool).
2. **Actor**: \`memorylake actor list --workspace <ws>\`. Prefer the HUMAN
   actor bound to the workspace. None bound → offer to create one
   (\`memorylake actor create\` + \`actor bind\`).

Write \`~/.memorylake/harness/config.md\`:

\`\`\`markdown
---
enabled: true
workspace: <ws-id>
actor: <actor-id>
remind_on_read: true
sync_on_write: true
status_line: true
---
\`\`\`

Before writing, tell the user what \`sync_on_write: true\` means here: the
model may store facts it is told to remember (and other durable facts about
the user's preferences and projects) in their Memory Lake workspace, from
any project on this machine. A project can opt out with a
\`.claude/memorylake.local.md\` containing \`sync_on_write: false\` (keep it
gitignored via \`.claude/*.local.md\`).

## Stage 4 — Verify and hand off

Run the connectivity check and one end-to-end recall:

\`\`\`bash
memorylake project list --workspace <ws>
\`\`\`

Then call the \`memory_search\` tool once (any query — an empty result is a
pass; it proves the path works).

Finish by telling the user:

- setup is complete, and which pieces were installed vs. already present
- the configuration is re-read on every call, so memory tools work from the
  very next message — no restart needed. Only the session status line first
  appears in the next session
- \`/memorylake-status\` is the health check to reach for if anything
  misbehaves later`
