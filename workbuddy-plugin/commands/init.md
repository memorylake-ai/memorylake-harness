---
description: Set up MemoryLake for WorkBuddy — CLI install, login, and config, end to end
disable-model-invocation: true
allowed-tools: Bash, Read, Write, AskUserQuestion
---

Walk the user from a bare plugin install to a working MemoryLake setup. Run
the stages in order; skip any stage that is already satisfied and say so.
Never print, echo, or write the user's API key anywhere except the
`memorylake auth login` command itself.

## Stage 1 — CLI binary

Check both locations, in this order:

```bash
command -v memorylake || ls "$HOME/.memorylake/bin/memorylake"
```

If found, report the version (`memorylake version`) and move on.

If missing, ask the user (AskUserQuestion) which way to install:

- **Download prebuilt binary (recommended)** — fetch the latest GitHub
  release into the plugin's private location, which the plugin checks
  automatically:

  ```bash
  repo="memorylake-ai/memorylake-cli"
  # Detect platform → release target triple
  # Windows publishes a .zip holding memorylake.exe; the rest publish .tar.gz.
  ext=tar.gz; exe=
  case "$(uname -sm)" in
    "Darwin arm64")  target=aarch64-apple-darwin ;;
    "Darwin x86_64") target=x86_64-apple-darwin ;;
    "Linux x86_64")  target=x86_64-unknown-linux-gnu ;;
    "Linux aarch64") target=aarch64-unknown-linux-gnu ;;
    MINGW*\ x86_64|MSYS*\ x86_64|CYGWIN*\ x86_64)
      target=x86_64-pc-windows-msvc;  ext=zip; exe=.exe ;;
    MINGW*\ aarch64|MSYS*\ aarch64|CYGWIN*\ aarch64)
      target=aarch64-pc-windows-msvc; ext=zip; exe=.exe ;;
  esac
  # Resolve the latest release tag
  tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | jq -r .tag_name)
  # Download, verify the checksum, extract just the binary
  cd "$(mktemp -d)"
  curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.$ext"
  curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.$ext.sha256"
  shasum -a 256 -c "memorylake-$tag-$target.$ext.sha256"
  case "$ext" in
    # Git for Windows does not ship unzip; fall back to the libarchive tar.exe
    # Windows 10+ puts in System32 (it reads zip), then to PowerShell.
    zip) unzip -q "memorylake-$tag-$target.zip" 2>/dev/null \
           || tar -xf "memorylake-$tag-$target.zip" 2>/dev/null \
           || powershell.exe -NoProfile -Command "Expand-Archive -Path 'memorylake-$tag-$target.zip' -DestinationPath ." ;;
    *)   tar -xzf "memorylake-$tag-$target.tar.gz" ;;
  esac
  # Locate the binary instead of assuming the archive's internal layout.
  src=$(find . -type f -name "memorylake$exe" | head -n 1)
  mkdir -p "$HOME/.memorylake/bin"
  install -m 0755 "$src" "$HOME/.memorylake/bin/memorylake$exe"
  "$HOME/.memorylake/bin/memorylake$exe" version
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
MemoryLake console). The service has two deployments with **separate accounts**: the
international one at [memorylake.ai](https://memorylake.ai) (the CLI's
default) and the China one at [memorylake.cn](https://memorylake.cn). Ask
which console the user's account lives in; international accounts need no
`--base-url`, China accounts log in with
`--base-url https://app.memorylake.cn/openapi/memorylake`.

```bash
memorylake auth login --api-key <KEY> [--base-url <URL>]
```

Confirm with `memorylake auth status`. Remind the user the key is stored in
`~/.memorylake/credentials.toml` (file mode 0600), managed by the CLI, not by
this plugin.

## Stage 3 — Global config

The config is **global by default**: workspace and actor are account-level
facts, and recall must work in every project — including ones that never ran
init. A per-project `.claude/memorylake.local.md` is an optional override
(different workspace, custom project id, or `sync_conversations: false` /
`enabled: false` to keep one folder local-only or opted out entirely).

If `~/.memorylake/harness/config.md` already exists, show its current
values and ask whether to keep them; keeping is the default, since the other
MemoryLake harnesses on this machine read the same file.

Otherwise gather the pieces:

1. **Workspace**: `memorylake ws list`. One workspace → use it. Several →
   let the user pick.
2. **Actor**: start from the actor the API key itself represents.

   ```bash
   memorylake actor me                        # the caller's own actor -> .id
   memorylake actor list --workspace <ws>     # bound actors -> .items[].actor_id
   ```

   The field names differ between the two: `.id` versus `.actor_id`.

   - **Bound to this workspace** → offer it first, labelled `(default)`, and
     preselect it so Enter accepts. If it is the only actor bound, do not ask
     at all — say which actor you used and move on.
   - **Not bound** → ignore it and let the user pick from the workspace's
     actors as usual. This is common rather than exceptional: the actor is
     created with the account, while workspace membership is a separate,
     explicit act.
   - **`actor me` failed** (older CLI or deployment, network) → fall back
     silently to picking from the workspace's actors. Do not report it.

   A deleted actor keeps its binding with a non-`ACTIVE` `status`; skip those.
   None bound at all → offer to create one (`memorylake actor create` +
   `actor bind`).

If `~/.memorylake/harness/config.md` already existed (another harness set
this machine up), keep its `workspace` and `actor`, add only the WorkBuddy
keys below that are missing, and say which keys you added. Otherwise write:

```markdown
---
enabled: true
workspace: <ws-id>
actor: <actor-id>
sync_on_write: true
sync_conversations: true
recall_reminder: true
recall_gate: true
status_line: true
---
```

What the WorkBuddy keys do (all of them are read on every hook run, so a
change takes effect on the next message):

- `sync_conversations` — after every turn, the user's message and your final
  reply (text only; never tool calls or tool output) are appended to a
  MemoryLake conversation, one per WorkBuddy session, filed under the
  project of the folder the session works in (chats started without a folder
  share one project named WorkBuddy). When absent it follows
  `sync_on_write`.
- `sync_attachments` — NOT written by default. Only when the user asks for
  it: documents and images attached to a message (not source files, and
  nothing over `sync_attachments_max_mb`, default 20) are uploaded to the
  MemoryLake Library and imported into the session's project. It must be an
  explicit `true`, and it never applies where conversation sync is off.
- `recall_reminder` — every user message carries an instruction to search
  MemoryLake before replying.
- `recall_gate` — if a turn reaches for a tool without having searched, that
  first tool call is held back once with an instruction to search.

Before writing, tell the user plainly what `sync_conversations: true` means:
what they type in WorkBuddy on this machine, and your replies, are uploaded
to their MemoryLake workspace. Ask whether any directories should be
excluded; write them as comma-separated path prefixes in `sync_deny`, e.g.
`sync_deny: ~/work, ~/clients`. A folder can also opt out on its own with a
`.claude/memorylake.local.md` containing `sync_conversations: false`.

## Stage 4 — Verify and hand off

```bash
memorylake project list --workspace <ws>
ml-recall "test" --top-k 1 || true
```

Finish by telling the user:

- setup is complete, and which pieces were installed vs. already present
- recall reminders, the recall gate, and conversation sync are active from
  the next message; the standing instructions arrive with the next session
- `/memorylake:status` is the health check to reach for if anything
  misbehaves later
