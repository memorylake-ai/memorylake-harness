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

# Locate .claude/memorylake.local.md by walking up from the session cwd.
#
# Walking up rather than reading $cwd/.claude directly means a session started
# in a subdirectory still finds the repo-root config.
ml_find_config() {
  local dir="${1:-$PWD}"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.claude/memorylake.local.md" ]; then
      printf '%s' "$dir/.claude/memorylake.local.md"
      return 0
    fi
    dir=$(dirname -- "$dir")
  done
  return 1
}

# Populate ML_* from the config file, or return non-zero to mean "not
# configured" — which every caller treats as "exit 0, do nothing".
ml_load_config() {
  local cwd="${1:-$PWD}"
  ML_CONFIG=$(ml_find_config "$cwd") || return 1

  ML_ENABLED=$(ml_frontmatter_get "$ML_CONFIG" enabled)
  ml_flag_enabled "$ML_ENABLED" || return 1

  ML_WORKSPACE=$(ml_frontmatter_get "$ML_CONFIG" workspace)
  [ -n "$ML_WORKSPACE" ] || return 1

  ML_PROJECTS=$(ml_frontmatter_get "$ML_CONFIG" projects)
  ML_PROJECT_CUSTOM_ID=$(ml_frontmatter_get "$ML_CONFIG" project_custom_id)
  ML_ACTOR=$(ml_frontmatter_get "$ML_CONFIG" actor)
  ML_REMIND_ON_READ=$(ml_frontmatter_get "$ML_CONFIG" remind_on_read)
  ML_SYNC_ON_WRITE=$(ml_frontmatter_get "$ML_CONFIG" sync_on_write)
  ML_STATUS_LINE=$(ml_frontmatter_get "$ML_CONFIG" status_line)

  export ML_CONFIG ML_WORKSPACE ML_PROJECTS ML_PROJECT_CUSTOM_ID ML_ACTOR
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
