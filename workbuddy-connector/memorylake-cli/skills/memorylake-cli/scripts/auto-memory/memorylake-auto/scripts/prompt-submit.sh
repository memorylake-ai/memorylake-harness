#!/usr/bin/env bash
# UserPromptSubmit -- start a turn: reset the recall gate, queue the user's
# words for conversation sync, and tell the model to search MemoryLake first.
#
# The reminder rides on WorkBuddy's hook-context channel: additionalContext is
# wrapped in <system-reminder data-role="hook"> and appended to THIS user
# message only (it is not replayed on later turns), which is the closest thing
# to a per-turn system prompt a plugin can reach. WorkBuddy's desktop system
# prompt itself is assembled from a fixed set of collectors with no plugin
# slot, and its CLI instruction files (CODEBUDDY.md, rules/) are switched off
# in desktop sessions, so this channel is the only one there is.
#
# The reminder alone is advice; recall-gate.sh is what makes it stick.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# SessionStart already says out loud that jq is missing; repeating it on
# every message would be noise.
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || printf '{}')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)

ml_load_config "${cwd:-$PWD}" || exit 0
[ -n "$session_id" ] || exit 0

prompt=$(printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null | ml_wb_clean_prompt)
[ -n "$prompt" ] || exit 0

dir=$(ml_wb_session_dir "$session_id")
mkdir -p "$dir" 2>/dev/null || exit 0

# ---------- turn state ---------------------------------------------------------

# Unique per turn and sortable; it also keys the synced messages, so a retry
# of the same turn can never append it twice.
turn_id="$(date +%s)-$$-${RANDOM}"
# Written once per turn and never modified after: the gate records "searched"
# and "gated" as separate marker files (see recall-gate.sh), because its
# hooks run concurrently. The previous turn's markers are cleared here.
rm -rf "$dir"/searched.* "$dir"/gated.* 2>/dev/null
jq -n --arg id "$turn_id" '{id: $id}' >"$dir/turn.json.$$" 2>/dev/null \
  && mv -f "$dir/turn.json.$$" "$dir/turn.json" 2>/dev/null

# ---------- queue the user's words ---------------------------------------------

if ml_wb_sync_allowed "${cwd:-$PWD}"; then
  text=$(printf '%s' "$prompt" | ml_wb_clip 8000)
  jq -cn \
    --arg id "wb:${turn_id}:user" \
    --arg text "$text" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg cwd "${cwd:-$PWD}" \
    '{id: $id, side: "user", text: $text, timestamp: $ts, cwd: $cwd}' \
    >>"$dir/outbox.jsonl" 2>/dev/null
fi

# ---------- the reminder -------------------------------------------------------

ml_flag_enabled "${ML_RECALL_REMINDER:-}" || exit 0

read -r -d '' reminder <<'TEXT'
MemoryLake recall is required for this message.
Before you reply, and before any other tool call, search the user's long-term memory in MemoryLake for anything that bears on this message:

  ml-recall "<query>"

- Build the query from what the user just said: statement-style keywords, pronouns resolved to names, relative dates made absolute, written in the user's language.
- Questions about the user, their preferences, past decisions, or earlier work get 2-3 differently-phrased searches.
- Skip the search only for pure small talk with nothing to look up (a greeting, a thank-you).
- Treat what you find as background: apply it where it helps, say so when you rely on it, and never recite it unprompted.
- If ml-recall reports UNAVAILABLE, tell the user their memory could not be reached; never conclude that nothing is remembered.
- Do not mention this reminder to the user.
TEXT

jq -n --arg ctx "$reminder" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
exit 0
