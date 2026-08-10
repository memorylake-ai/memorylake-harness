#!/usr/bin/env bash
# SessionStart — one line of status, no digest.
#
# Deliberately NOT an inspect/briefing. A workspace digest (project list, file
# counts, fact samples) was considered and dropped: three of its four parts do
# not change what the model does, and the fourth — knowing who the user is — is
# already covered by the locally loaded MEMORY.md. Injecting it every session
# would be a fixed token cost on the majority of sessions that never touch
# Memory Lake at all.
#
# What this line IS for: telling the model the system is online, and — more
# importantly — telling it when the system is NOT. Without this, an unreachable
# backend looks exactly like "you never told me that".

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

emit() {
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg ctx "$1" '{
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: $ctx
      }
    }'
  fi
  exit 0
}

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || printf '{}')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

# Not configured for this project: say nothing at all. A project that does not
# use Memory Lake should see no trace of this plugin.
ml_load_config "${cwd:-$PWD}" || exit 0
ml_flag_enabled "${ML_STATUS_LINE:-}" || exit 0

CLI=$(ml_cli)
[ -n "$CLI" ] || emit "Memory Lake: the 'memorylake' CLI is not installed, so memory recall is unavailable this session. Do not treat missing recall results as 'no such memory'. To set it up, suggest the user run /memorylake:init — it can download the CLI and walk through login and configuration."

CACHE_DIR="$(ml_data_dir)/status"
CACHE_FILE="$CACHE_DIR/${ML_WORKSPACE}.txt"
CACHE_TTL=600

# The cache stores DATA (the project count), never the rendered line: the data
# tree is shared with the Codex harness, whose status line names a different
# recall invocation — a cached Claude-side sentence served to Codex (or vice
# versa) would teach the model a command that does not resolve there.
projects=""
if [ -f "$CACHE_FILE" ]; then
  now=$(date +%s)
  # stat's flags differ between BSD and GNU; try both rather than assume.
  mtime=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || printf '0')
  if [ $((now - mtime)) -lt $CACHE_TTL ]; then
    projects=$(cat "$CACHE_FILE" 2>/dev/null)
    case "$projects" in *[!0-9]*) projects="" ;; esac
  fi
fi

if [ -z "$projects" ]; then
  projects=$("$CLI" project list --workspace "$ML_WORKSPACE" 2>/dev/null | jq -r '(.items // []) | length' 2>/dev/null)
  if [ -z "$projects" ]; then
    emit "Memory Lake: workspace ${ML_WORKSPACE} is unreachable. Memory recall is UNAVAILABLE this session — if a recall returns nothing, say the backend could not be reached rather than concluding the memory does not exist."
  fi
  mkdir -p "$CACHE_DIR" 2>/dev/null && printf '%s' "$projects" >"$CACHE_FILE" 2>/dev/null
fi

emit "Memory Lake: connected · workspace ${ML_WORKSPACE} · ${projects} project(s). Cross-project and cross-device memories are searchable with \`ml-recall \"<query>\"\`."
