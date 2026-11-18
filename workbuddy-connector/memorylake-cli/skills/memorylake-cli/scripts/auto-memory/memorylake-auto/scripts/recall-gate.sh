#!/usr/bin/env bash
# PreToolUse -- the recall gate.
#
# The per-turn reminder asks the model to search MemoryLake first; models
# routinely skip advice like that. This hook turns it into a checkpoint: when
# the model reaches for any tool this turn without having searched yet, the
# FIRST such call is denied with an instruction to run ml-recall, and the
# model sees that reason as the tool's result (WorkBuddy raises it as a
# PermissionDeniedError carrying our message).
#
# Deliberately once per turn. A second denial could trap a model that cannot
# search (CLI missing, backend down, a task where memory is plainly
# irrelevant) in a loop; one denial is enough to make it consider memory,
# after which everything goes through. A reply that uses no tools at all is
# never gated -- the reminder is all there is for those.
#
# Cost on the hot path: this runs before EVERY tool call, so the not-armed
# cases (no config, no turn state, already searched/gated) exit after a
# config stat, one small jq read, and a marker stat.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || printf '{}')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

ml_load_config "${cwd:-$PWD}" || exit 0
ml_flag_enabled "${ML_RECALL_GATE:-}" || exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$session_id" ] || exit 0

dir=$(ml_wb_session_dir "$session_id")
# No turn state: a subagent (own session id), or a session whose prompt we
# never saw. Neither is ours to gate.
[ -f "$dir/turn.json" ] || exit 0
turn_id=$(jq -r '.id // empty' "$dir/turn.json" 2>/dev/null)
[ -n "$turn_id" ] || exit 0

# Per-turn markers, not fields in turn.json: models issue tool calls in
# parallel, and WorkBuddy runs their PreToolUse hooks concurrently. Three
# hooks rewriting one JSON file through one temp name once corrupted it
# (measured: the turn id vanished and that turn's reply never synced).
# touch and mkdir are atomic, so the markers cannot be lost or doubled.
searched="$dir/searched.$turn_id"
gated="$dir/gated.$turn_id"
[ -e "$searched" ] && exit 0
[ -e "$gated" ] && exit 0

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)

case "$tool_name" in
  Bash)
    command_line=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
    if ml_wb_is_search_command "$command_line"; then
      : >"$searched" 2>/dev/null
      exit 0
    fi
    ;;
  # Loading a skill or a deferred tool's schema is preparation, not work --
  # the memorylake skill itself arrives through Skill.
  Skill|ToolSearch)
    exit 0
    ;;
esac

# A search issued in the same parallel batch as this call has its own hook
# running right now; give it a moment to mark the turn before holding this
# call back for nothing (measured: ml-recall, Read, and ls in one batch had
# both siblings denied). Only the about-to-deny path pays this, once a turn.
sleep 0.4
[ -e "$searched" ] && exit 0

# Exactly one denial per turn, however many calls race to this line.
mkdir "$gated" 2>/dev/null || exit 0

reason='MemoryLake first: this call was held back once because the user'"'"'s long-term memory has not been searched this turn. Run `ml-recall "<query built from the user'"'"'s message>"` now (2-3 differently-phrased searches for questions about the user or their past work), then retry this call -- it will go through. If the search reports UNAVAILABLE, continue without it and tell the user memory could not be reached.'

jq -n --arg reason "$reason" '{
  reason: $reason,
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
