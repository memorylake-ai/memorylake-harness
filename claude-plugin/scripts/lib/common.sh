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
# MEASURED (2026-08-07, and previously by memorylake-mcp): the search endpoint
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
  # Resolve to the repo root when there is one: memories are per-repo, so the
  # deny decision should not depend on which subdirectory the session runs in.
  dir=$(cd -- "$dir" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$dir")
  local IFS=','
  for entry in $list; do
    # Trim surrounding whitespace, expand a leading ~.
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    case "$entry" in "~"*) entry="$HOME${entry#\~}" ;; esac
    [ -n "$entry" ] || continue
    case "$dir" in
      "$entry"|"$entry"/*) return 0 ;;
    esac
  done
  return 1
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
  local private="$(ml_data_dir)/bin/memorylake"
  if [ -x "$private" ]; then
    printf '%s' "$private"
    return 0
  fi
  return 1
}

# Root of this plugin's own cache/state tree.
#
# Deliberately NOT ${CLAUDE_PLUGIN_DATA}: that variable is only injected with
# THIS plugin's path inside hook processes. When the model runs ml-recall via
# the Bash tool, the variable may be absent or — observed live 2026-08-07 —
# carry ANOTHER plugin's data directory, silently splitting the state between
# hooks and bin commands. A fixed home-relative path is the only location both
# sides always agree on. MEMORYLAKE_PLUGIN_DATA overrides it for tests.
ml_data_dir() {
  printf '%s' "${MEMORYLAKE_PLUGIN_DATA:-$HOME/.claude/memorylake-plugin}"
}

# Per-session scratch directory (e.g. the reminded-once marker).
ml_state_dir() {
  printf '%s/state' "$(ml_data_dir)"
}
