#!/usr/bin/env bash
# Shared helpers for the memorylake Codex plugin.
#
# Trimmed sibling of claude-plugin/scripts/lib/common.sh (the canonical copy of
# the shared parts lives there). Both harnesses deliberately share ONE identity
# and data tree — ~/.claude/memorylake-plugin/ — so a single /init (from either
# client) configures both, the privately downloaded CLI is installed once, and
# caches are not duplicated. The Codex-specific pieces are the memories
# directory helpers at the bottom.

set -uo pipefail

# Root of the plugin family's shared cache/state tree.
#
# Deliberately a fixed home-relative path, not PLUGIN_DATA: that variable is
# only injected into hook processes, and the model invoking ml-recall through
# the shell does not reliably see it (measured on the Claude Code side, where
# the equivalent variable carried another plugin's directory). A fixed path is
# the only location hooks and shell commands always agree on — and here it
# additionally lets the Claude Code and Codex harnesses share one identity.
# MEMORYLAKE_PLUGIN_DATA overrides it for tests.
ml_data_dir() {
  printf '%s' "${MEMORYLAKE_PLUGIN_DATA:-$HOME/.claude/memorylake-plugin}"
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
ml_flag_enabled() {
  case "$1" in
    false|no|off|0) return 1 ;;
    *) return 0 ;;
  esac
}

# Locate the config: project-level first, then the shared global default.
ml_find_config() {
  local dir="${1:-$PWD}"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.claude/memorylake.local.md" ]; then
      printf '%s' "$dir/.claude/memorylake.local.md"
      return 0
    fi
    dir=$(dirname -- "$dir")
  done
  if [ -f "$(ml_data_dir)/config.md" ]; then
    printf '%s' "$(ml_data_dir)/config.md"
    return 0
  fi
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
  ML_ACTOR=$(ml_frontmatter_get "$ML_CONFIG" actor)
  ML_SYNC_ON_WRITE=$(ml_frontmatter_get "$ML_CONFIG" sync_on_write)
  ML_STATUS_LINE=$(ml_frontmatter_get "$ML_CONFIG" status_line)

  export ML_CONFIG ML_WORKSPACE ML_PROJECTS ML_ACTOR
  return 0
}

# Path to the memorylake binary, or empty when it is not installed.
#
# A user-installed binary on PATH always wins; the shared private install
# location is only a fallback.
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

# Comma-separated project ids to scope a search to, or empty when the workspace
# has none.
#
# MEASURED (2026-08-07): the search endpoint treats a missing project_ids as
# "match no documents", not "match every project". Facts still come back, but
# document hits are silently always empty. Cached for ten minutes; the write
# path invalidates the cache outright when it creates a project.
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

# ---------- Codex-specific -----------------------------------------------------

# Codex's global memory tree. Unlike Claude Code's per-repo auto-memory, this
# is engine-managed: session rollouts are summarized into
# rollout_summaries/*.md and aggregated into MEMORY.md by a background
# pipeline, not written by the model through tool calls — which is why the
# write side hooks Stop and scans for changes instead of intercepting writes.
ml_codex_memories_dir() {
  printf '%s' "${CODEX_HOME:-$HOME/.codex}/memories"
}
