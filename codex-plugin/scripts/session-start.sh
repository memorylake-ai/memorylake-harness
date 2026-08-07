#!/usr/bin/env bash
# SessionStart — one line of status, plus self-installing ml-recall.
#
# Codex has no equivalent of Claude Code's plugin bin/-on-PATH mechanism, so
# the model cannot rely on `ml-recall` resolving by name unless we put it
# somewhere stable. This hook copies the bundled script into the shared data
# tree (idempotent, ~5ms) and the skill refers to it by that absolute path.
#
# The status line itself follows the claude-plugin rationale: no workspace
# digest (Codex already injects its own memory summary at session start), just
# "the system is online" — and, more importantly, "the system is NOT online",
# because an unreachable backend must never read as "no such memory".

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

# Self-install ml-recall into the shared bin so `<data>/bin/ml-recall` always
# works, whichever harness installed it first. common.sh rides along because
# ml-recall sources it relative to its own location.
shared_bin="$(ml_data_dir)/bin"
if [ ! -x "$shared_bin/ml-recall" ] || ! cmp -s "$SCRIPT_DIR/../bin/ml-recall" "$shared_bin/ml-recall" 2>/dev/null; then
  mkdir -p "$shared_bin" "$(ml_data_dir)/scripts/lib" 2>/dev/null
  install -m 0755 "$SCRIPT_DIR/../bin/ml-recall" "$shared_bin/ml-recall" 2>/dev/null
  install -m 0644 "$SCRIPT_DIR/lib/common.sh" "$(ml_data_dir)/scripts/lib/common.sh" 2>/dev/null
fi

input=$(cat 2>/dev/null || printf '{}')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

# Not configured: stay silent. A machine that does not use Memory Lake should
# see no trace of this plugin.
ml_load_config "${cwd:-$PWD}" || exit 0
ml_flag_enabled "${ML_STATUS_LINE:-}" || exit 0

RECALL="$shared_bin/ml-recall"

CLI=$(ml_cli)
[ -n "$CLI" ] || emit "Memory Lake: the 'memorylake' CLI is not installed, so cross-device memory recall is unavailable this session. Do not treat missing recall results as 'no such memory'."

CACHE_DIR="$(ml_data_dir)/status"
CACHE_FILE="$CACHE_DIR/${ML_WORKSPACE}.txt"
CACHE_TTL=600

if [ -f "$CACHE_FILE" ]; then
  now=$(date +%s)
  mtime=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || printf '0')
  if [ $((now - mtime)) -lt $CACHE_TTL ]; then
    emit "$(cat "$CACHE_FILE")"
  fi
fi

projects=$("$CLI" project list --workspace "$ML_WORKSPACE" 2>/dev/null | jq -r '(.items // []) | length' 2>/dev/null)

if [ -z "$projects" ]; then
  emit "Memory Lake: workspace ${ML_WORKSPACE} is unreachable. Cross-device memory recall is UNAVAILABLE this session — if a recall returns nothing, say the backend could not be reached rather than concluding the memory does not exist."
fi

line="Memory Lake: connected · workspace ${ML_WORKSPACE} · ${projects} project(s). Memories from the user's other devices, projects, and clients (including Claude Code) are searchable with \`${RECALL} \"<query>\"\`."

mkdir -p "$CACHE_DIR" 2>/dev/null && printf '%s' "$line" >"$CACHE_FILE" 2>/dev/null
emit "$line"
