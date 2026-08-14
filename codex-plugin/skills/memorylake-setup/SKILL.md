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
case "$(uname -sm)" in
  "Darwin arm64")  target=aarch64-apple-darwin ;;
  "Darwin x86_64") target=x86_64-apple-darwin ;;
  "Linux x86_64")  target=x86_64-unknown-linux-gnu ;;
  "Linux aarch64") target=aarch64-unknown-linux-gnu ;;
esac
tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | jq -r .tag_name)
cd "$(mktemp -d)"
curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.tar.gz"
curl -fsSLO "https://github.com/$repo/releases/download/$tag/memorylake-$tag-$target.tar.gz.sha256"
shasum -a 256 -c "memorylake-$tag-$target.tar.gz.sha256"
tar -xzf "memorylake-$tag-$target.tar.gz"
mkdir -p "$HOME/.memorylake/bin"
install -m 0755 "memorylake-$tag-$target/memorylake" "$HOME/.memorylake/bin/memorylake"
"$HOME/.memorylake/bin/memorylake" version
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
console) and, for non-default deployments, the base URL. Then:

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
2. **Actor**: `memorylake actor list --workspace <ws>`. Prefer the HUMAN
   actor. None bound → offer to create and bind one.

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
project name (the repo name from each summary's `cwd:` header;
`codex-memories` holds unattributable extension notes), and the file count.
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
