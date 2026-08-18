/**
 * The guided setup wizard, returned by the `memory_setup` tool.
 *
 * It lives behind a tool rather than in the system prompt because it is long
 * and almost never needed: an unconfigured session pays for a two-line hint,
 * and only a user who actually asks pulls in the full text.
 *
 * Adaptations for opencode versus the Claude Code and dsh originals: no
 * backfill stage (opencode has no pre-existing memory of its own to upload),
 * no hook-activation notes, and an explicit restart step at the end — this
 * plugin resolves its configuration once when opencode loads it, so tools
 * cannot appear mid-session no matter how the config changes.
 */

export const SETUP_INSTRUCTIONS = `Walk the user from an installed-but-unconfigured plugin to working memory.
Run the stages in order, skip any that is already satisfied, and say which
ones you skipped.

**Never print, echo, or write the user's API key anywhere except the
\`memorylake auth login\` command itself.**

## Stage 0 — Is it already done elsewhere?

The configuration is shared by every Memory Lake harness on this machine —
Claude Code, Codex, dsh, and opencode all read the same file. Check first:

\`\`\`bash
cat ~/.memorylake/harness/config.md
\`\`\`

If it exists and names a \`workspace\`, setup is already complete and the
plugin simply has not reloaded. Skip to Stage 4.

## Stage 1 — The CLI

\`\`\`bash
command -v memorylake || ls "$HOME/.memorylake/bin/memorylake"
\`\`\`

Found: report \`memorylake version\` and move on.

Missing: ask the user how they want it installed.

- **Download the prebuilt binary (recommended)** — into the shared private
  location this plugin already looks in:

  \`\`\`bash
  repo="memorylake-ai/memorylake-cli"
  case "$(uname -sm)" in
    "Darwin arm64")  target=aarch64-apple-darwin ;;
    "Darwin x86_64") target=x86_64-apple-darwin ;;
    "Linux x86_64")  target=x86_64-unknown-linux-gnu ;;
    "Linux aarch64") target=aarch64-unknown-linux-gnu ;;
  esac
  tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p')
  cd "$(mktemp -d)"
  curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.tar.gz"
  curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.tar.gz.sha256"
  shasum -a 256 -c "memorylake-$tag-$target.tar.gz.sha256"
  tar -xzf "memorylake-$tag-$target.tar.gz"
  mkdir -p "$HOME/.memorylake/bin"
  install -m 0755 "memorylake-$tag-$target/memorylake" "$HOME/.memorylake/bin/memorylake"
  "$HOME/.memorylake/bin/memorylake" version
  \`\`\`

  **The checksum check is not optional.** A download whose checksum does not
  match must be deleted and reported, never installed.

- **I'll install it myself** — point them at
  \`memorylake-ai/memorylake-cli\` and stop; they can ask again afterwards.

## Stage 2 — Login

\`\`\`bash
memorylake auth status
\`\`\`

If not logged in, ask for the API key and run
\`memorylake auth login --api-key <key>\`. Do not echo the key back, do not
put it in a file, and do not repeat it in your reply.

## Stage 3 — The config

\`\`\`bash
memorylake ws list                          # one workspace -> use it
memorylake actor list --workspace <ws-id>   # prefer the HUMAN actor
\`\`\`

With several workspaces, ask which one. With no actor bound, offer to create
one (\`memorylake actor create\` then \`memorylake actor bind\`).

Then write \`~/.memorylake/harness/config.md\`:

\`\`\`markdown
---
enabled: true
workspace: <ws-id>
actor: <actor-id>
---
\`\`\`

Tell the user what this means before writing it: from any project on this
machine, you will be able to search their memory, and to store facts they ask
you to remember. A single project can override this with
\`.opencode/memorylake.local.md\` (or \`.claude/memorylake.local.md\`, which
the Claude Code plugin reads too) containing \`enabled: false\`.

## Stage 4 — Restart, then verify

**opencode must be restarted.** This plugin resolves its configuration once,
when opencode loads it, so the memory tools cannot appear in a session that
started before the config existed. Tell the user to quit and reopen opencode.

After the restart, \`memory_search\` will be available. Run it once with any
query — an empty result is a pass, because it proves the whole path works.

Finish by telling the user which pieces you installed versus found already in
place, and that the same configuration now serves Claude Code, Codex, and dsh
on this machine.`
