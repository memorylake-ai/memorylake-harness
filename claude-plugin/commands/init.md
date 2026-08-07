---
description: Set up Memory Lake for this project — CLI install, login, and config, end to end
disable-model-invocation: true
allowed-tools: Bash, Read, Write, AskUserQuestion
---

Walk the user from a bare plugin install to a working Memory Lake setup. Run
the stages in order; skip any stage that is already satisfied and say so.
Never print, echo, or write the user's API key anywhere except the
`memorylake auth login` command itself.

## Stage 1 — CLI binary

Check both locations, in this order:

```bash
command -v memorylake || ls "$HOME/.claude/memorylake-plugin/bin/memorylake"
```

If found, report the version (`memorylake version`) and move on.

If missing, ask the user (AskUserQuestion) which way to install:

- **Download prebuilt binary (recommended)** — fetch the latest GitHub
  release into the plugin's private location, which the plugin checks
  automatically:

  ```bash
  # TODO: point back at memorylake-ai/memorylake-cli once it publishes releases
  repo="memorylake-ai/memorylake-cli"
  # Detect platform → release target triple
  case "$(uname -sm)" in
    "Darwin arm64")  target=aarch64-apple-darwin ;;
    "Darwin x86_64") target=x86_64-apple-darwin ;;
    "Linux x86_64")  target=x86_64-unknown-linux-gnu ;;
    "Linux aarch64") target=aarch64-unknown-linux-gnu ;;
  esac
  # Resolve the latest release tag
  tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | jq -r .tag_name)
  # Download, verify the checksum, extract just the binary
  cd "$(mktemp -d)"
  curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.tar.gz"
  curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.tar.gz.sha256"
  shasum -a 256 -c "memorylake-$tag-$target.tar.gz.sha256"
  tar -xzf "memorylake-$tag-$target.tar.gz"
  mkdir -p "$HOME/.claude/memorylake-plugin/bin"
  install -m 0755 "memorylake-$tag-$target/memorylake" "$HOME/.claude/memorylake-plugin/bin/memorylake"
  "$HOME/.claude/memorylake-plugin/bin/memorylake" version
  ```

  If the release lookup 404s, no release has been published yet — tell the
  user plainly and fall through to the next option.

- **I'll install it myself** — point at the repository
  (`cargo install` from `memorylake-ai/memorylake-cli`, or a package the
  team distributes) and stop here; the user can re-run `/memorylake:init`
  afterwards.

The checksum verification is not optional. A download whose checksum does not
match must be deleted and reported, never installed.

For the rest of this command, use the binary you found or installed. If it is
the private-location one, invoke it by full path — the current session's PATH
does not include it.

## Stage 2 — Login

```bash
memorylake auth status
```

If not logged in, ask the user for their API key (they can create one in the
Memory Lake console) and, if their deployment uses a non-default endpoint,
the base URL. Then:

```bash
memorylake auth login --api-key <KEY> [--base-url <URL>]
```

Confirm with `memorylake auth status`. Remind the user the key is stored in
`~/.memorylake/credentials.toml` (file mode 0600), managed by the CLI, not by
this plugin.

## Stage 3 — Project config

If `.claude/memorylake.local.md` already exists, show its current values and
ask whether to keep or rewrite it.

Otherwise gather the pieces:

1. **Workspace**: `memorylake ws list`. One workspace → use it. Several →
   let the user pick.
2. **Actor**: `memorylake actor list --workspace <ws>`. Prefer the HUMAN
   actor bound to the workspace. None bound → offer to create one
   (`memorylake actor create` + `actor bind`).
3. **Project custom id**: default to the git repo name (or directory name);
   let the user override.

Write `.claude/memorylake.local.md`:

```markdown
---
enabled: true
workspace: <ws-id>
project_custom_id: <custom-id>
actor: <actor-id>
remind_on_read: true
sync_on_write: true
status_line: true
---
```

Before writing, tell the user what `sync_on_write: true` means: every memory
file Claude writes in this project is uploaded to their Memory Lake
workspace. If they prefer local-only memory, set it to `false`.

Ensure `.gitignore` covers `.claude/*.local.md`; append it if missing.

## Stage 4 — Verify and hand off

Run the connectivity check and one end-to-end recall:

```bash
memorylake project list --workspace <ws>
ml-recall "test" --top-k 1 || true
```

(`ml-recall` may not be on PATH until the plugin reloads — a failure here is
fine if stage 1 just installed the CLI; say so instead of treating it as an
error.)

Finish by telling the user:

- setup is complete, and which pieces were installed vs. already present
- memory sync and recall reminders are active from the next memory
  read/write — the hooks re-read the config every time they fire, so no
  restart is needed. Only the session status line first appears in the
  next session
- `/memorylake:status` is the health check to reach for if anything
  misbehaves later
