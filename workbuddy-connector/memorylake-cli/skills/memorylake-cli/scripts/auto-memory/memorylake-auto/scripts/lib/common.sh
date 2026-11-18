#!/usr/bin/env bash
# Shared helpers for the memorylake WorkBuddy plugin.
#
# Trimmed sibling of claude-plugin/scripts/lib/common.sh (the canonical copy of
# the shared parts lives there). All harnesses deliberately share ONE identity
# and data tree -- ~/.memorylake/harness/ -- so a single init (from any client)
# configures them all. The WorkBuddy-specific pieces (per-session turn state,
# prompt cleanup, conversation identities) are at the bottom.
#
# Every hook sources this and then calls ml_load_config. The load bails out as
# early as possible: the PreToolUse gate runs on every tool call, so the cost
# of a session with no MemoryLake configured must be one stat() and an exit.

set -uo pipefail

# ---------- path normalization -------------------------------------------------
#
# Under Git for Windows / Cygwin bash the same directory arrives in three
# shapes: `C:\Users\me\repo` (what the harness hands a hook),
# `C:/Users/me/repo` (what `git rev-parse --show-toplevel` prints), and
# `/c/Users/me/repo` (what the shell itself understands). Only the last one
# walks up to `/`, so every path entering these helpers is folded to it.
#
# Confined to Windows shells on purpose: a backslash is a legal character in a
# POSIX filename, so folding it on Linux or macOS would corrupt real paths.
# $OSTYPE is a bash builtin (`msys`/`cygwin` under Git for Windows), so the
# guard costs no process.
ml_posix_path() {
  case "${OSTYPE:-}" in
    msys*|cygwin*|win32*) : ;;
    *) printf '%s' "$1"; return 0 ;;
  esac
  local p="${1//\\//}"
  case "$p" in
    [A-Za-z]:|[A-Za-z]:/*)
      command -v cygpath >/dev/null 2>&1 && p=$(cygpath -u "$p" 2>/dev/null || printf '%s' "$p")
      ;;
  esac
  printf '%s' "$p"
}

# The parent of a directory, or empty when there is no further up to go.
#
# The walk-up loops below used to end only at `/`, which a Windows path never
# reaches: `dirname C:/Users/me` bottoms out at `C:` and then returns `C:` for
# ever (measured), so the loop spun at 100% CPU until the hook's timeout killed
# it — 5s for PreToolUse, 300s for the async PostToolUse, on every memory
# write. Ending on "dirname made no progress" terminates on any platform and
# leaves POSIX behaviour untouched, since `dirname /` is already `/`.
ml_parent_dir() {
  local p
  p=$(dirname -- "$1")
  [ "$p" != "$1" ] && [ "$p" != "." ] && printf '%s' "$p"
}

# Read one scalar key out of a YAML frontmatter block.
#
# Deliberately not a YAML parser: the config is written by us and documented in
# the README, so a line-oriented read is enough and keeps the dependency list at
# zero. Values may be quoted; surrounding quotes are stripped.
ml_frontmatter_get() {
  local file="$1" key="$2" value
  value=$(
    awk -v k="$key" '
      NR == 1 && $0 != "---" { exit }
      NR > 1 && $0 == "---" { exit }
      NR > 1 {
        pos = index($0, ":")
        if (pos == 0) next
        name = substr($0, 1, pos - 1)
        gsub(/^[ \t]+|[ \t]+$/, "", name)
        if (name != k) next
        val = substr($0, pos + 1)
        gsub(/^[ \t]+|[ \t]+$/, "", val)
        print val
        exit
      }
    ' "$file" 2>/dev/null
  )
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

# True when a config flag is anything other than an explicit false.
#
# Absent means on: every flag in this config turns a feature OFF, and the file
# only exists because the user opted in.
ml_flag_enabled() {
  case "$1" in
    false|no|off|0) return 1 ;;
    *) return 0 ;;
  esac
}

# Read one key with project-over-global precedence.
#
# Callers set ML_PROJECT_CONFIG / ML_GLOBAL_CONFIG (either may be empty).
ml_cfg_get() {
  local key="$1" v=""
  [ -n "${ML_PROJECT_CONFIG:-}" ] && v=$(ml_frontmatter_get "$ML_PROJECT_CONFIG" "$key")
  if [ -z "$v" ] && [ -n "${ML_GLOBAL_CONFIG:-}" ]; then
    v=$(ml_frontmatter_get "$ML_GLOBAL_CONFIG" "$key")
  fi
  printf '%s' "$v"
}

# Populate ML_* by MERGING the two config layers, or return non-zero to mean
# "not configured" — which every caller treats as "exit 0, do nothing".
#
# Merging, not shadowing: a project file exists to override a field or two
# (sync_on_write: false is the canonical case) and must not have to repeat
# workspace and actor to stay functional. Before this, a one-line project
# file silently knocked out the whole config — recall included — because the
# project file replaced the global one wholesale and then failed the
# workspace check (found while testing the sync_deny override path).
ml_load_config() {
  local cwd="${1:-$PWD}" dir
  ML_PROJECT_CONFIG=""
  ML_GLOBAL_CONFIG=""
  dir=$(ml_posix_path "$cwd")
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.claude/memorylake.local.md" ]; then
      ML_PROJECT_CONFIG="$dir/.claude/memorylake.local.md"
      break
    fi
    dir=$(ml_parent_dir "$dir")
  done
  [ -f "$(ml_data_dir)/config.md" ] && ML_GLOBAL_CONFIG="$(ml_data_dir)/config.md"
  { [ -n "$ML_PROJECT_CONFIG" ] || [ -n "$ML_GLOBAL_CONFIG" ]; } || return 1

  ML_ENABLED=$(ml_cfg_get enabled)
  ml_flag_enabled "$ML_ENABLED" || return 1

  ML_WORKSPACE=$(ml_cfg_get workspace)
  [ -n "$ML_WORKSPACE" ] || return 1
  ML_PROJECTS=$(ml_cfg_get projects)
  ML_SYNC_DENY=$(ml_cfg_get sync_deny)
  ML_PROJECT_CUSTOM_ID=$(ml_cfg_get project_custom_id)
  ML_ACTOR=$(ml_cfg_get actor)
  ML_SYNC_ON_WRITE=$(ml_cfg_get sync_on_write)
  ML_STATUS_LINE=$(ml_cfg_get status_line)
  # WorkBuddy-only keys. recall_reminder and recall_gate are lenient (absent
  # means on); sync_conversations is outbound and therefore explicit opt-in,
  # falling back to sync_on_write so a config written by another harness's
  # init keeps meaning what the user agreed to there.
  ML_RECALL_REMINDER=$(ml_cfg_get recall_reminder)
  ML_RECALL_GATE=$(ml_cfg_get recall_gate)
  ML_SYNC_CONVERSATIONS=$(ml_cfg_get sync_conversations)
  [ -n "$ML_SYNC_CONVERSATIONS" ] || ML_SYNC_CONVERSATIONS="$ML_SYNC_ON_WRITE"
  # sync_attachments sends whole files, not text, so it never inherits from
  # another key: absent means off (see ml_wb_attachments_allowed).
  ML_SYNC_ATTACHMENTS=$(ml_cfg_get sync_attachments)
  ML_SYNC_ATTACHMENTS_MAX_MB=$(ml_cfg_get sync_attachments_max_mb)

  # Kept for callers that display "which config file"; the most specific one.
  ML_CONFIG="${ML_PROJECT_CONFIG:-$ML_GLOBAL_CONFIG}"

  export ML_CONFIG ML_PROJECT_CONFIG ML_GLOBAL_CONFIG
  export ML_WORKSPACE ML_PROJECTS ML_SYNC_DENY ML_PROJECT_CUSTOM_ID ML_ACTOR
  export ML_STATUS_LINE ML_RECALL_REMINDER ML_RECALL_GATE ML_SYNC_CONVERSATIONS
  export ML_SYNC_ATTACHMENTS ML_SYNC_ATTACHMENTS_MAX_MB
  return 0
}

# Comma-separated project ids to scope a search to, or empty when the workspace
# has none.
#
# MEASURED (2026-08-07, twice independently): the search endpoint
# treats a missing project_ids as "match no documents" rather than "match every
# project". Facts still come back — they hang off the actor — but document hits
# are silently always empty. Passing the full visible set is what the MCP
# boundary did, and it is the only way document search works at all.
#
# Resolved from `project list` and cached, since it changes rarely and every
# recall would otherwise pay for the lookup.
ml_project_ids() {
  if [ -n "${ML_PROJECTS:-}" ]; then
    printf '%s' "$ML_PROJECTS"
    return 0
  fi

  local cli cache_dir cache_file ids
  cli=$(ml_cli)
  [ -n "$cli" ] || return 0

  cache_dir="$(ml_data_dir)/projects"
  cache_file="$cache_dir/${ML_WORKSPACE}.txt"

  # Ten minutes, not an hour: a stale entry here does not degrade results, it
  # ZEROES them — a project created after the cache was written is invisible
  # to document search until the cache expires. The write path also invalidates
  # this file outright when it creates a project.
  if [ -f "$cache_file" ]; then
    local now mtime
    now=$(date +%s)
    # GNU first: `stat -f` is file-SYSTEM mode there, so it SUCCEEDS on a real
    # file and prints filesystem stats rather than failing over to the BSD
    # form. The subtraction below then aborts this $() under set -u with
    # `File: unbound variable`, PROJECTS comes back empty, and every recall
    # inside the cache window silently loses its whole FILES section.
    mtime=$(stat -c %Y "$cache_file" 2>/dev/null || stat -f %m "$cache_file" 2>/dev/null || printf '0')
    if [ $((now - mtime)) -lt 600 ]; then
      cat "$cache_file"
      return 0
    fi
  fi

  ids=$("$cli" project list --workspace "$ML_WORKSPACE" 2>/dev/null \
    | jq -r '[(.items // [])[].id] | join(",")' 2>/dev/null)
  [ -n "$ids" ] || return 0

  mkdir -p "$cache_dir" 2>/dev/null && printf '%s' "$ids" >"$cache_file" 2>/dev/null
  printf '%s' "$ids"
}

# True when writing memories for `dir` is denied by the global sync_deny list.
#
# The list is comma-separated path PREFIXES (~ expands to $HOME): `~/work`
# covers every project underneath it. Prefixes, not globs, on purpose — the
# match is predictable at a glance and its bash implementation is a substring
# check, with no surprises about what `*` crosses. Precedence note for
# callers: an explicit per-project config file wins over this list (most
# specific wins), so check the project file's own sync_on_write FIRST and
# consult this only when the setting came from the global config.
ml_sync_denied() {
  local dir list="${ML_SYNC_DENY:-}" entry
  dir=$(ml_posix_path "$1")
  [ -n "$list" ] || return 1
  # Resolve to the PHYSICAL repo root: git rev-parse returns physical paths,
  # and on macOS /tmp-style symlinks a logical prefix would silently miss it
  # (found in e2e: /tmp/... vs /private/tmp/...). Both sides of the match are
  # physicalized so the comparison is apples to apples.
  dir=$(ml_posix_path "$(cd -- "$dir" 2>/dev/null && { git rev-parse --show-toplevel 2>/dev/null || pwd -P; } || printf '%s' "$dir")")
  local IFS=','
  for entry in $list; do
    # Trim surrounding whitespace, expand a leading ~.
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    case "$entry" in "~"*) entry="$HOME${entry#\~}" ;; esac
    # A user on Windows writes the prefix the way their shell shows it
    # (`C:\work`); both sides of the comparison have to speak one dialect.
    entry=$(ml_posix_path "$entry")
    [ -n "$entry" ] || continue
    # Physicalize existing prefixes too; a not-yet-existing path stays as-is.
    if [ -d "$entry" ]; then
      entry=$(cd -- "$entry" 2>/dev/null && pwd -P || printf '%s' "$entry")
    fi
    case "$dir" in
      "$entry"|"$entry"/*) return 0 ;;
    esac
  done
  return 1
}

# ---------- project identity ---------------------------------------------------
#
# What is "the project" a memory belongs to? The rule, most intentional first:
#
#   1. explicit `project_custom_id` in the project's own config file — the
#      user's word beats any inference
#   2. the normalized git remote URL — every clone of a repo, on any machine
#      and under any path, points back to the same origin, which matches how
#      developers themselves decide "same project or not"
#   3. the physical repo-root path — a repo with no remote has no way to
#      exist on another device, so its location IS its identity
#
# The identity is the ML project custom_id; humans see only the display name
# (repo basename). Both harnesses share these helpers, so a repo gets ONE
# cloud project no matter which assistant wrote the memory.

# Normalize a git remote URL to `host/path`: protocol, credentials, and a
# trailing .git stripped, host lowercased, scp-style `host:path` folded to
# `host/path`. Prints nothing when no path remains. Deliberately textual —
# the goal is that the SAME configured URL yields the same identity
# everywhere, not full URL semantics (a nonstandard port folds into the
# path, which stays deterministic).
ml_normalize_remote() {
  local url="$1" host rest
  url="${url%%\?*}"
  url="${url%/}"
  url="${url%.git}"
  case "$url" in *://*) url="${url#*://}" ;; esac
  url="${url##*@}"
  host="${url%%[:/]*}"
  rest="${url#"$host"}"
  rest="${rest#:}"
  rest="${rest#/}"
  rest="${rest%/}"
  [ -n "$host" ] && [ -n "$rest" ] || return 1
  printf '%s/%s' "$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')" "$rest"
}

# The physical root of the project containing a directory (the directory
# itself, physicalized, when it is not in a git repo; the normalized input
# when gone), always in the POSIX form the walk-up loops can consume.
ml_repo_root() {
  local dir root
  dir=$(ml_posix_path "$1")
  root=$( (cd -- "$dir" 2>/dev/null && { git rev-parse --show-toplevel 2>/dev/null || pwd -P; }) )
  # git prints `C:/Users/me/repo` under Git for Windows, which is no more
  # walkable than the backslash form — fold the answer too, not just the input.
  ml_posix_path "${root:-$dir}"
}

# The stable identity (= ML project custom_id) of the project at a directory,
# by the three-level rule above — always in slug form: the API stores a
# custom_id containing slashes fine, but `project get --by-custom-id` routes
# it through the URL path and 404s (measured 2026-08-14), so slashes and
# colons are folded to dashes at the source. The fold is deterministic, which
# is all identity needs; the human-readable original is recoverable enough
# (github.com-acme-alpha). Applies to the explicit override too, as a
# guardrail — a verbatim slash would break every lookup after the create.
ml_project_identity() {
  local root d explicit="" url="" norm first_remote
  root=$(ml_repo_root "$1")
  d="$root"
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -f "$d/.claude/memorylake.local.md" ]; then
      explicit=$(ml_frontmatter_get "$d/.claude/memorylake.local.md" project_custom_id)
      break
    fi
    d=$(ml_parent_dir "$d")
  done
  if [ -n "$explicit" ]; then
    ml_cid_slug "$explicit"
    return 0
  fi
  url=$(git -C "$root" remote get-url origin 2>/dev/null)
  if [ -z "$url" ]; then
    first_remote=$(git -C "$root" remote 2>/dev/null | head -n 1)
    [ -n "$first_remote" ] && url=$(git -C "$root" remote get-url "$first_remote" 2>/dev/null)
  fi
  if [ -n "$url" ]; then
    norm=$(ml_normalize_remote "$url") && [ -n "$norm" ] && { ml_cid_slug "$norm"; return 0; }
  fi
  ml_cid_slug "$root"
}

# The name humans see for that project: the repo folder's basename.
ml_project_display() {
  basename -- "$(ml_repo_root "$1")"
}

# Filesystem- and Drive-safe form of an identity (slashes and colons folded
# to dashes) — identities are used as state directory and folder names.
ml_cid_slug() {
  local s
  s=$(printf '%s' "$1" | tr '/:' '--')
  # Strip leading dashes. A non-repo identity is the physical path, which slugs
  # to a string that BEGINS with one (/home/me/notes -> -home-me-notes,
  # C:\WINDOWS\system32 -> -c-WINDOWS-system32); the CLI then reads
  # `--custom-id -home-me-notes` as an option rather than its value, the
  # project is never created, and every sync for that directory fails with
  # `could not resolve or create ML project`. An identity only has to be
  # deterministic, so the leading dashes cost nothing to drop.
  while [ "${s#-}" != "$s" ]; do s="${s#-}"; done
  printf '%s' "${s:-root}"
}

# Path to the memorylake binary, or empty when it is not installed.
#
# A user-installed binary on PATH always wins; the plugin's private install
# location (populated by /memorylake:init when the user opts in to a managed
# download) is only a fallback, so the plugin can never shadow a CLI the user
# manages themselves.
ml_cli() {
  local found
  found=$(command -v memorylake 2>/dev/null)
  if [ -n "$found" ]; then
    printf '%s' "$found"
    return 0
  fi
  local private="$(ml_bin_dir)/memorylake"
  if [ -x "$private" ]; then
    printf '%s' "$private"
    return 0
  fi
  return 1
}

# Root of this plugin's own cache/state tree.
#
# Lives under ~/.memorylake — the product's home on this machine (the CLI's
# credentials already live there), shared by the Claude Code and Codex
# harnesses so one setup serves both; parking Codex state under ~/.claude was
# a historical accident. Deliberately NOT ${CLAUDE_PLUGIN_DATA}: that variable
# is only injected with THIS plugin's path inside hook processes. When the
# model runs ml-recall via the Bash tool, the variable may be absent or —
# observed live 2026-08-07 — carry ANOTHER plugin's data directory, silently
# splitting the state between hooks and bin commands. A fixed home-relative
# path is the only location both sides always agree on.
# MEMORYLAKE_PLUGIN_DATA overrides it for tests.
ml_data_dir() {
  printf '%s' "${MEMORYLAKE_PLUGIN_DATA:-$HOME/.memorylake/harness}"
}

# Directory for the privately installed CLI and ml-recall.
#
# The sibling of the data tree (~/.memorylake/bin by default), so a test that
# overrides MEMORYLAKE_PLUGIN_DATA with .../harness gets an isolated bin too.
ml_bin_dir() {
  printf '%s' "$(dirname -- "$(ml_data_dir)")/bin"
}

# Per-session scratch directory (e.g. the reminded-once marker).
ml_state_dir() {
  printf '%s/state' "$(ml_data_dir)"
}

# Say out loud that jq is missing, then exit — never exit in silence.
#
# Every hook parses its stdin with jq, so without it they can do nothing. The
# old gate was a bare `exit 0`: on a host with no jq (nixos, alpine, a slim
# container, a locked-down laptop) the plugin looked installed and healthy
# while memories quietly stopped syncing. "Installed but inert, and nobody is
# told" is the worst shape a memory plugin can take — a user who believes
# their memories are being saved is worse off than one who knows they are not.
#
# The notice is a FIXED string precisely because a JSON encoder is the thing
# we are missing; nothing here interpolates untrusted input, so printf is safe.
# $1 is the hook event. SessionStart additionally tells the model recall is
# unavailable, so an empty search is never mistaken for an empty memory.
ml_exit_without_jq() {
  local event="${1:-}" marker now mtime

  # Only speak up for someone who actually configured MemoryLake. "A project
  # that does not use MemoryLake sees no trace of this plugin" outranks the
  # warning: telling an unconfigured user to install jq would be noise about a
  # feature they never turned on. ml_load_config reads frontmatter with awk, so
  # it still works without the jq we are missing.
  ml_load_config "$PWD" || exit 0

  if [ "$event" = "SessionStart" ]; then
    # Fires once per session by nature — no throttle needed.
    printf '%s\n' '{"systemMessage":"[MemoryLake] jq is not installed, so the plugin is inert: memories are NOT syncing and recall is unavailable. Install jq (brew install jq / apt-get install jq), then start a new session.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"MemoryLake is installed but inoperative this session: its jq dependency is missing. Memory recall is UNAVAILABLE — if a search returns nothing, say the memory backend could not be reached rather than concluding the memory does not exist."}}'
    exit 0
  fi

  # Write-path hooks fire on every tool call, so throttle to once every 4h.
  # stat's flags differ between BSD and GNU; try both, GNU FIRST. The order is
  # load-bearing: `-f` on GNU is file-SYSTEM mode, so it succeeds on a real file
  # and prints a block of filesystem stats instead of failing over to `-c %Y`,
  # and the arithmetic below then dies with `File: unbound variable`.
  marker="$(ml_state_dir)/no-jq-notice"
  now=$(date +%s)
  if [ -f "$marker" ]; then
    mtime=$(stat -c %Y "$marker" 2>/dev/null || stat -f %m "$marker" 2>/dev/null || printf '0')
    [ $((now - mtime)) -lt 14400 ] && exit 0
  fi
  mkdir -p "$(ml_state_dir)" 2>/dev/null && : >"$marker" 2>/dev/null
  printf '%s\n' '{"systemMessage":"[MemoryLake] jq is not installed, so memories are NOT being synced to MemoryLake. Local memory files are intact. Install jq (brew install jq / apt-get install jq) to enable syncing."}'
  exit 0
}

# ---------- WorkBuddy session state ---------------------------------------------
#
# One directory per WorkBuddy session under state/workbuddy/<session>/:
#
#   turn.json      the current turn: id, whether the model has searched
#                  MemoryLake yet, whether the recall gate already fired
#   outbox.jsonl   messages captured for conversation sync but not yet
#                  appended (one JSON object per line)
#   sync.json      the session's MemoryLake conversation id and last outcome
#   attachments.jsonl    files the user attached, queued for upload (one JSON
#                        object per line: path, name, blob, cwd)
#   attachments.offset   how many transcript lines have been scanned for them
#   attachments.json     the last attachment sync outcome
#
# WorkBuddy hands every hook the same session_id for the life of a chat, and
# a subagent gets its own id -- which has no turn.json, so the gate leaves
# subagents alone by construction.

# A session id reduced to a safe path component.
ml_wb_safe_id() {
  local s
  s=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s' "${s:0:120}"
}

ml_wb_session_dir() {
  printf '%s/workbuddy/%s' "$(ml_state_dir)" "$(ml_wb_safe_id "$1")"
}

# The user's words with WorkBuddy's own injections removed.
#
# WorkBuddy's UserPromptSubmit payload is the concatenated TEXT of the user
# message: the host's <system-reminder ...> blocks (workspace info, current
# time, its own memory/skills reminder -- 18k characters on a session's first
# message, measured) followed by what the user typed, wrapped in
# <user_query>...</user_query>. Only the wrapped part is conversation; the
# rest is host scaffolding and must never reach the server as if the user had
# said it. Without the wrapper (another host version), strip the reminders.
ml_wb_clean_prompt() {
  perl -0777 -ne '
    my @q = m{<user_query>(.*?)</user_query>}gs;
    my $t = @q ? join("\n\n", @q) : $_;
    $t =~ s{<system-reminder\b[^>]*>.*?</system-reminder>}{}gs;
    $t =~ s{^\s+|\s+$}{}g;
    print $t;
  '
}

# Clip text to N characters (not bytes), marking the cut.
ml_wb_clip() {
  local max="$1"
  perl -CSD -0777 -pe "if (length(\$_) > $max) { \$_ = substr(\$_, 0, $max - 1) . \"\\x{2026}\" }"
}

# True when a shell command line is a MemoryLake search.
ml_wb_is_search_command() {
  case "$1" in
    *ml-recall*) return 0 ;;
    *memorylake*" search"*) return 0 ;;
  esac
  return 1
}

# ---------- WorkBuddy project identity -------------------------------------------
#
# ml_project_identity answers "which project" for a folder someone chose to
# work in. WorkBuddy adds a case it was never meant for: a chat started
# without picking a folder runs in a scratch directory WorkBuddy makes up on
# the spot, named after the clock --
#
#   ~/WorkBuddy/2026-11-13-18-10-18             a new chat
#   ~/WorkBuddy/automation-2026-11-13-18-10-18  an automation run
#
# (WorkBuddy 5.3.14; the parent folder is configurable, the name pattern is
# not). By the path rule every such chat became its own project: a user
# three months in had hundreds of projects named after timestamps, the same
# PDF attached in two chats was uploaded and indexed twice, and nothing
# set per project could ever apply to "my WorkBuddy chats". Nobody thinks of
# a chat as a project -- the conversation already is the per-chat record.
#
# So scratch directories all map to ONE project, the same on every machine:
# custom id `workbuddy`, shown as "WorkBuddy". A folder the user opened on
# purpose keeps the shared rule (git remote, else path) and so still meets
# Claude Code and Codex in the same project.

ML_WB_SCRATCH_PROJECT_ID="workbuddy"
ML_WB_SCRATCH_PROJECT_NAME="WorkBuddy"

# True when `dir` is, or lies inside, one of WorkBuddy's made-up per-chat
# directories.
#
# By name, not by parent: the parent is `~/WorkBuddy` by default but an
# enterprise build renames it. Ancestors count, because the model may have
# moved into a subfolder it created there. A directory that has since gained
# a git remote is a real repository someone is building in, not scratch.
ml_wb_scratch_dir() {
  local root d base
  root=$(ml_repo_root "$1")
  [ -z "$(git -C "$root" remote 2>/dev/null | head -n 1)" ] || return 1
  d="$root"
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    base="${d##*/}"
    base="${base#automation-}"
    case "$base" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9]) return 0 ;;
    esac
    d=$(ml_parent_dir "$d")
  done
  return 1
}

# The project (custom id) a WorkBuddy session in `dir` belongs to. An
# explicit project_custom_id still wins over everything.
ml_wb_project_identity() {
  if [ -n "${ML_PROJECT_CUSTOM_ID:-}" ]; then
    ml_cid_slug "$ML_PROJECT_CUSTOM_ID"
  elif ml_wb_scratch_dir "$1"; then
    printf '%s' "$ML_WB_SCRATCH_PROJECT_ID"
  else
    ml_project_identity "$1"
  fi
}

# The name people see for that project: "WorkBuddy" for scratch chats, the
# folder's own name otherwise.
ml_wb_project_display() {
  if ml_wb_scratch_dir "$1"; then
    printf '%s' "$ML_WB_SCRATCH_PROJECT_NAME"
  else
    ml_project_display "$1"
  fi
}

# ---------- WorkBuddy sync policy ------------------------------------------------

# True when this folder's conversation may be uploaded.
#
# Outbound is explicit opt-in (see ml_load_config), and a folder on the
# sync_deny list uploads nothing unless its own config file says otherwise.
# Call after ml_load_config. $1 = the session's working directory.
ml_wb_sync_allowed() {
  [ -n "${ML_SYNC_CONVERSATIONS:-}" ] || return 1
  ml_flag_enabled "$ML_SYNC_CONVERSATIONS" || return 1
  if ml_sync_denied "$1"; then
    local project_says=""
    [ -n "${ML_PROJECT_CONFIG:-}" ] && project_says=$(ml_frontmatter_get "$ML_PROJECT_CONFIG" sync_conversations)
    [ -n "$project_says" ] || return 1
  fi
  return 0
}

# True when files the user attaches in this folder may be uploaded.
#
# Stricter than every other flag: a file is more than the words typed about
# it, so the key must be an explicit yes (absent is off, unlike
# ml_flag_enabled), and it only ever narrows conversation sync -- a folder
# that uploads no conversation uploads no attachment either.
ml_wb_attachments_allowed() {
  case "${ML_SYNC_ATTACHMENTS:-}" in
    true|yes|on|1) : ;;
    *) return 1 ;;
  esac
  ml_wb_sync_allowed "$1"
}

# The local files attached to a user message, one absolute path per line.
#
# stdin is the full text of one user message AS STORED IN THE TRANSCRIPT. The
# UserPromptSubmit payload is no use here: WorkBuddy strips its own
# <system-reminder> context from that prompt before a hook sees it (measured
# 2026-11-13: a dropped PDF reached the hook only as the @"path" the user's
# text shows). WorkBuddy does not copy a dragged or picked file anywhere: it
# lists the original path in its per-turn context, in one or both of two
# blocks (WorkBuddy 5.3.14, WorkbuddyUserPromptService):
#
#   <user_references>                 every local file or folder chip, one
#   Note: ...                         JSON string per line. A dropped file
#   "/Users/me/report.pdf"            lands here: its chip carries a bare
#   </user_references>                path, not a file:// URI.
#
#   <attached_files>                  only chips whose URI is file://
#   <file path="/Users/me/a.pdf" />
#   </attached_files>
#
# Both are read and the result de-duplicated. Folders (trailing slash) are
# dropped. The user's own text is cut out first, so a message that merely
# QUOTES such a block attaches nothing. Images are not listed here; see
# sync-attachments.sh.
ml_wb_attached_files() {
  perl -0777 -MJSON::PP -ne '
    # Bytes in, bytes out: no utf8 layer, so a non-ASCII path survives as is.
    my $json = JSON::PP->new->allow_nonref;
    my (%seen, @paths);
    s{<user_query>.*?</user_query>}{}gs;
    while (m{<user_references>(.*?)</user_references>}gs) {
      for my $line (split /\n/, $1) {
        next unless $line =~ /^\s*(".*")\s*$/;
        my $p = eval { $json->decode($1) };
        push @paths, $p if defined $p && !ref $p;
      }
    }
    while (m{<attached_files>(.*?)</attached_files>}gs) {
      my $block = $1;
      while ($block =~ m{<file\s+path="([^"]*)"}g) {
        my $p = $1;
        $p =~ s/&lt;/</g; $p =~ s/&gt;/>/g; $p =~ s/&quot;/"/g;
        $p =~ s/&apos;/\x27/g; $p =~ s/&#39;/\x27/g; $p =~ s/&amp;/&/g;
        push @paths, $p;
      }
    }
    for my $p (@paths) {
      next unless $p =~ m{^(?:/|[A-Za-z]:[\\/])} && $p !~ /\n/;
      next if $p =~ m{[\\/]$};
      print "$p\n" unless $seen{$p}++;
    }
  '
}

# True when a file name has an extension worth sending as a document.
#
# An allowlist, on purpose. WorkBuddy lists an @-mentioned workspace file the
# same way as a dropped one, so without this a mention of a source file, a
# key, or an .env would upload it. Documents and pictures only.
ml_wb_attachment_ext_ok() {
  local name ext
  name=$(printf '%s' "${1##*/}" | tr '[:upper:]' '[:lower:]')
  case "$name" in
    *.*) ext="${name##*.}" ;;
    *) return 1 ;;
  esac
  case "$ext" in
    pdf|doc|docx|ppt|pptx|xls|xlsx|csv|tsv|txt|md|markdown|rtf) return 0 ;;
    png|jpg|jpeg|webp|gif|bmp) return 0 ;;
  esac
  return 1
}

# SHA-256 of a file (or of stdin when no argument), hex.
ml_wb_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 ${1:+"$1"} 2>/dev/null | cut -d' ' -f1
  else
    sha256sum ${1:+"$1"} 2>/dev/null | cut -d' ' -f1
  fi
}
