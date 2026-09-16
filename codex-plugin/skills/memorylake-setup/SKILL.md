---
name: memorylake-setup
description: Set up or diagnose Memory Lake for this machine — CLI install, login, and global config, end to end. Use when the user asks to initialize, set up, configure, or troubleshoot Memory Lake / memorylake, when ml-recall reports NOT_CONFIGURED or CLI_NOT_FOUND, or when the session status line says Memory Lake is not installed or not configured.
---

# Memory Lake setup

Walk the user from a bare plugin install to a working Memory Lake setup. Run
the stages in order; skip any stage that is already satisfied and say so.
Never print, echo, or write the user's API key anywhere except the
`memorylake auth login` command itself.

The config, CLI, and caches are **shared with the Claude Code plugin** under
`~/.memorylake/harness/` — if the user already ran `/memorylake:init`
in Claude Code, most stages below will already pass.

## Stage 1 — CLI binary

Check both locations, in this order:

```bash
command -v memorylake || ls "$HOME/.memorylake/bin/memorylake"
```

If found, report the version and move on.

If missing, ask the user whether to download the prebuilt binary. On yes:

```bash
repo="memorylake-ai/memorylake-cli"
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
tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | jq -r .tag_name)
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

The checksum verification is not optional: a download whose checksum does not
match must be deleted and reported, never installed. If the release lookup
404s, no release has been published yet — say so plainly and point at manual
installation from the memorylake-cli repository.

For the rest of this setup, if the binary lives in the private location,
invoke it by full path.

## Stage 2 — Login

```bash
memorylake auth status
```

If not logged in, ask the user for their API key (created in the Memory Lake
console). The service has two deployments with **separate accounts**: the
international one at [memorylake.ai](https://memorylake.ai) (the CLI's
default) and the China one at [memorylake.cn](https://memorylake.cn). Ask
which console the user's account lives in; international accounts need no
`--base-url`, China accounts log in with
`--base-url https://app.memorylake.cn/openapi/memorylake`. Then:

```bash
memorylake auth login --api-key <KEY> [--base-url <URL>]
```

Confirm with `memorylake auth status`. The key is stored by the CLI in
`~/.memorylake/credentials.toml` (mode 0600), not by this plugin.

## Stage 3 — Global config

If `~/.memorylake/harness/config.md` already exists, show its values
and ask whether to keep or rewrite.

Otherwise gather:

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

Write `~/.memorylake/harness/config.md` — with sync **off**; enabling it is
a separate, informed step (Stage 3.5):

```markdown
---
enabled: true
workspace: <ws-id>
actor: <actor-id>
sync_on_write: false
status_line: true
---
```

## Stage 3.5 — First-sync disclosure, then enable sync

Turning `sync_on_write` on does not only affect future sessions: the first
sync drains **every session summary already on disk** — potentially months of
history across all the user's projects. Never flip the flag without showing
the user that backlog first:

```bash
bash ~/.memorylake/scripts/sync-memories.sh --preview
```

(Fixed path — the plugin installs the script there at session start, next to
`ml-recall`.)

Each line is one destination Memory Lake project: `UPLOAD` or `DENY`, the
project identity (derived from each summary's `cwd:` header — the repo's
normalized remote URL like `github.com-acme-foo`, or its dash-folded path
when it has no remote; `codex-memories` holds unattributable extension
notes), and the file count.
Show it to the user and let them decide:

- **Exclude some projects** → add path prefixes to `sync_deny` in
  `~/.memorylake/harness/config.md` (comma-separated, `~` allowed), then
  re-run the preview and confirm those rows now read `DENY`
- **Upload** → set `sync_on_write: true`; the backlog uploads in the
  background after the next turn ends (in a session with trusted hooks)
- **Not now** → leave it `false`; recall keeps working either way

Only an explicit yes from the user enables the flag. If they also use the
Claude Code plugin, mention that `sync_on_write: true` uploads Claude's
memory files too as they are written — and that their pre-existing Claude
Code memories are a separate, equally explicit step: `/memorylake:backfill`
in Claude Code.

## Stage 4 — Hook trust

The plugin's hooks (status line, memory sync) do not run until trusted.
Tell the user to run `/hooks` in Codex, review the two memorylake hooks, and
mark them trusted. This cannot be done for them — it is a deliberate security
gate.

## Stage 5 — Verify

```bash
memorylake project list --workspace <ws>
"$HOME/.memorylake/bin/ml-recall" "test" --top-k 1 || true
```

An empty recall result is a pass — it proves the path works. A non-zero exit
is a failure; show stderr verbatim.

Finish by telling the user:

- setup is complete, and which pieces were installed vs. already present
- memory sync starts from the next session (hooks load at session start, and
  only after they are trusted)
- this same setup serves the Claude Code plugin — nothing to repeat there
