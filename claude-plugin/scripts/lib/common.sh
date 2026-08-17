#!/usr/bin/env bash
# Shared helpers for the memorylake plugin hooks.
#
# Every hook sources this and then calls ml_load_config. The load is written to
# bail out as early as possible: these scripts run on the Read/Write path of
# every tool call, so the cost of a session with no Memory Lake configured must
# be one stat() and an exit.

set -uo pipefail

# Absolute path of a memory file, or empty when the path is not one.
#
# The auto-memory directory is ~/.claude/projects/<escaped-repo-root>/memory/.
# Matching the shape of the path is deliberate: deriving the escaped name from
# the git root would mean running git on every Read, and the shape is stable
# enough that a false positive is impossible in practice.
ml_is_memory_file() {
  local path="$1"
  case "$path" in
    */.claude/projects/*/memory/*.md) return 0 ;;
    *) return 1 ;;
  esac
}

# MEMORY.md is the index, not content. It is loaded wholesale at session start,
# so touching it says nothing about what the model is looking for, and syncing
# it upstream would push pure noise.
ml_is_memory_index() {
  [ "$(basename -- "$1")" = "MEMORY.md" ]
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
  dir="$cwd"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.claude/memorylake.local.md" ]; then
      ML_PROJECT_CONFIG="$dir/.claude/memorylake.local.md"
      break
    fi
    dir=$(dirname -- "$dir")
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
  ML_REMIND_ON_READ=$(ml_cfg_get remind_on_read)
  ML_SYNC_ON_WRITE=$(ml_cfg_get sync_on_write)
  ML_STATUS_LINE=$(ml_cfg_get status_line)

  # Kept for callers that display "which config file"; the most specific one.
  ML_CONFIG="${ML_PROJECT_CONFIG:-$ML_GLOBAL_CONFIG}"

  export ML_CONFIG ML_PROJECT_CONFIG ML_GLOBAL_CONFIG
  export ML_WORKSPACE ML_PROJECTS ML_SYNC_DENY ML_PROJECT_CUSTOM_ID ML_ACTOR
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
    mtime=$(stat -f %m "$cache_file" 2>/dev/null || stat -c %Y "$cache_file" 2>/dev/null || printf '0')
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
  local dir="$1" list="${ML_SYNC_DENY:-}" entry
  [ -n "$list" ] || return 1
  # Resolve to the PHYSICAL repo root: git rev-parse returns physical paths,
  # and on macOS /tmp-style symlinks a logical prefix would silently miss it
  # (found in e2e: /tmp/... vs /private/tmp/...). Both sides of the match are
  # physicalized so the comparison is apples to apples.
  dir=$(cd -- "$dir" 2>/dev/null && { git rev-parse --show-toplevel 2>/dev/null || pwd -P; } || printf '%s' "$dir")
  local IFS=','
  for entry in $list; do
    # Trim surrounding whitespace, expand a leading ~.
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    case "$entry" in "~"*) entry="$HOME${entry#\~}" ;; esac
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
# itself, physicalized, when it is not in a git repo; verbatim when gone).
ml_repo_root() {
  (cd -- "$1" 2>/dev/null && { git rev-parse --show-toplevel 2>/dev/null || pwd -P; }) || printf '%s' "$1"
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
    d=$(dirname -- "$d")
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
  printf '%s' "$1" | tr '/:' '--'
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

  # Only speak up for someone who actually configured Memory Lake. "A project
  # that does not use Memory Lake sees no trace of this plugin" outranks the
  # warning: telling an unconfigured user to install jq would be noise about a
  # feature they never turned on. ml_load_config reads frontmatter with awk, so
  # it still works without the jq we are missing.
  ml_load_config "$PWD" || exit 0

  if [ "$event" = "SessionStart" ]; then
    # Fires once per session by nature — no throttle needed.
    printf '%s\n' '{"systemMessage":"[Memory Lake] jq is not installed, so the plugin is inert: memories are NOT syncing and recall is unavailable. Install jq (brew install jq / apt-get install jq), then start a new session.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Memory Lake is installed but inoperative this session: its jq dependency is missing. Memory recall is UNAVAILABLE — if a search returns nothing, say the memory backend could not be reached rather than concluding the memory does not exist."}}'
    exit 0
  fi

  # Write-path hooks fire on every tool call, so throttle to once every 4h.
  # stat's flags differ between BSD and GNU; try both rather than assume.
  marker="$(ml_state_dir)/no-jq-notice"
  now=$(date +%s)
  if [ -f "$marker" ]; then
    mtime=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker" 2>/dev/null || printf '0')
    [ $((now - mtime)) -lt 14400 ] && exit 0
  fi
  mkdir -p "$(ml_state_dir)" 2>/dev/null && : >"$marker" 2>/dev/null
  printf '%s\n' '{"systemMessage":"[Memory Lake] jq is not installed, so memories are NOT being synced to Memory Lake. Local memory files are intact. Install jq (brew install jq / apt-get install jq) to enable syncing."}'
  exit 0
}
