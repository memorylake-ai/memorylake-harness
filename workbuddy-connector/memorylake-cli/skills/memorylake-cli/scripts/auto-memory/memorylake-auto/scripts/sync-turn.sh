#!/usr/bin/env bash
# Stop (async) -- append the finished turn to a MemoryLake conversation.
#
# One MemoryLake conversation per WorkBuddy session (custom id
# workbuddy:<session_id>); the server distills memories from it, so nothing
# is extracted locally. What goes over the wire, and what does not:
#
#   - TEXT only: what the user typed (host scaffolding stripped, see
#     ml_wb_clean_prompt) and the assistant's final reply. Tool calls, tool
#     output, and thinking stay on this machine. (Attached files are a
#     separate, opt-in upload: sync-attachments.sh.)
#   - Two actors: the user's messages as the configured actor; the
#     assistant's as an ASSISTANT actor created once per workspace (custom id
#     workbuddy-agent).
#   - Idempotent: every message carries a custom id derived from its turn, so
#     a retry never duplicates it.
#
# Failures are kept, not dropped: messages that did not land stay in the
# session's outbox and go out with the next turn, and the outcome is recorded
# in sync.json for /memorylake:status. The hook always exits 0 -- on Stop, a
# non-zero exit would push the error into the conversation and make the model
# keep talking.
#
# Project: the conversation is filed under the project of the folder the
# session works in, by the same identity rule as the Claude Code and Codex
# harnesses (git remote, else physical path), so every client meets in one
# project per repository or folder. A chat started without a folder runs in
# a scratch directory WorkBuddy names after the clock; all of those share
# the single "WorkBuddy" project instead of each becoming its own (see
# ml_wb_project_identity). Recall is unaffected by this choice: ml-recall
# searches every project in the workspace.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || printf '{}')

# Detach. WorkBuddy's hook executor does not act on "async": true in
# hooks.json; it backgrounds a hook only when the hook's first stdout line is
# {"async": true} (measured: without this, every turn's end waited for the
# sync -- 2.7 s, 4.5 s, and 16.6 s in the first live runs). After this line
# the executor stops waiting and kills us at asyncTimeout.
printf '%s\n' '{"async":true,"asyncTimeout":180000}'

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)

ml_load_config "${cwd:-$PWD}" || exit 0
[ -n "$session_id" ] || exit 0

dir=$(ml_wb_session_dir "$session_id")
outbox="$dir/outbox.jsonl"
draining="$dir/outbox.draining"
# Nothing queued means sync is off for this session (prompt-submit.sh only
# queues when it is allowed), or the prompt was empty.
[ -s "$outbox" ] || [ -s "$draining" ] || exit 0

status_file="$dir/sync.json"
record() {
  # $1 = ok|error, $2 = detail
  local conv=""
  [ -f "$status_file" ] && conv=$(jq -r '.conversation_id // empty' "$status_file" 2>/dev/null)
  jq -n --arg state "$1" --arg detail "${2:-}" --arg conv "${conversation_id:-$conv}" \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson pending "$(cat "$outbox" "$draining" 2>/dev/null | grep -c . || true)" \
      '{conversation_id: $conv, last_state: $state, last_detail: $detail, last_at: $at, pending: $pending}' \
    >"$status_file.tmp" 2>/dev/null && mv -f "$status_file.tmp" "$status_file" 2>/dev/null
}

# ---------- queue the assistant's reply ------------------------------------------

turn_id=""
[ -f "$dir/turn.json" ] && turn_id=$(jq -r '.id // empty' "$dir/turn.json" 2>/dev/null)
reply=$(printf '%s' "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)
if [ -n "$turn_id" ] && [ -n "$reply" ] \
    && ! cat "$outbox" "$draining" 2>/dev/null | grep -qF "\"wb:${turn_id}:assistant\""; then
  jq -cn \
    --arg id "wb:${turn_id}:assistant" \
    --arg text "$(printf '%s' "$reply" | ml_wb_clip 8000)" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{id: $id, side: "assistant", text: $text, timestamp: $ts}' \
    >>"$outbox" 2>/dev/null
fi

# ---------- one sync at a time per session -------------------------------------

lock="$dir/sync.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # A crashed run leaves its lock behind; anything older than the hook's own
  # timeout cannot still be running.
  now=$(date +%s)
  mtime=$(stat -c %Y "$lock" 2>/dev/null || stat -f %m "$lock" 2>/dev/null || printf '0')
  [ $((now - mtime)) -gt 180 ] || exit 0
  rmdir "$lock" 2>/dev/null
  mkdir "$lock" 2>/dev/null || exit 0
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT

CLI=$(ml_cli) || { record error "memorylake CLI not installed"; exit 0; }
[ -n "${ML_ACTOR:-}" ] || { record error "no actor in the MemoryLake config"; exit 0; }

# ---------- identities (cached per workspace) ------------------------------------

ws_dir="$(ml_data_dir)/sync/${ML_WORKSPACE}"
mkdir -p "$ws_dir" 2>/dev/null

assistant_actor=""
[ -f "$ws_dir/workbuddy-assistant-actor" ] && assistant_actor=$(cat "$ws_dir/workbuddy-assistant-actor" 2>/dev/null)
if [ -z "$assistant_actor" ]; then
  assistant_actor=$("$CLI" actor get --by-custom-id workbuddy-agent 2>/dev/null | jq -r '.id // empty' 2>/dev/null)
  if [ -z "$assistant_actor" ]; then
    assistant_actor=$("$CLI" actor create --custom-id workbuddy-agent --display-name WorkBuddy \
        2>/dev/null | jq -r '.id // empty' 2>/dev/null)
  fi
  [ -n "$assistant_actor" ] || { record error "could not resolve or create the WorkBuddy assistant actor"; exit 0; }
  # Binding an already-bound actor is refused by the server; not our failure.
  "$CLI" actor bind --actor "$assistant_actor" --workspace "$ML_WORKSPACE" >/dev/null 2>&1
  printf '%s' "$assistant_actor" >"$ws_dir/workbuddy-assistant-actor" 2>/dev/null
fi

# ---------- conversation ----------------------------------------------------------

conversation_id=""
[ -f "$status_file" ] && conversation_id=$(jq -r '.conversation_id // empty' "$status_file" 2>/dev/null)

if [ -z "$conversation_id" ]; then
  conv_cid="workbuddy:$(ml_wb_safe_id "$session_id")"
  conversation_id=$("$CLI" conversation get --workspace "$ML_WORKSPACE" --by-custom-id "$conv_cid" 2>/dev/null \
    | jq -r '.id // empty' 2>/dev/null)
fi

if [ -z "$conversation_id" ]; then
  # The project the conversation lives in (see header).
  first_cwd=$(cat "$draining" "$outbox" 2>/dev/null | head -n 1 | jq -r '.cwd // empty' 2>/dev/null)
  where="${first_cwd:-${cwd:-$PWD}}"
  custom_id=$(ml_wb_project_identity "$where")
  display_name=$(ml_wb_project_display "$where")
  proj_dir="$ws_dir/$(ml_cid_slug "$custom_id")"
  mkdir -p "$proj_dir" 2>/dev/null
  project_id=""
  [ -f "$proj_dir/project_id" ] && project_id=$(cat "$proj_dir/project_id" 2>/dev/null)
  if [ -z "$project_id" ]; then
    # Create-first, as in the Claude Code harness: reaching here usually means
    # the project does not exist yet; when it does, create fails and the
    # lookup recovers.
    project_id=$("$CLI" project create --workspace "$ML_WORKSPACE" \
        --name "$display_name" --custom-id "$custom_id" 2>/dev/null | jq -r '.id // empty' 2>/dev/null)
    if [ -n "$project_id" ]; then
      rm -f "$(ml_data_dir)/projects/${ML_WORKSPACE}.txt" 2>/dev/null
    else
      project_id=$("$CLI" project get --workspace "$ML_WORKSPACE" "$custom_id" --by-custom-id 2>/dev/null \
        | jq -r '.id // empty' 2>/dev/null)
    fi
  fi
  [ -n "$project_id" ] || { record error "could not resolve or create project \"$custom_id\""; exit 0; }
  printf '%s' "$project_id" >"$proj_dir/project_id" 2>/dev/null

  title=$(cat "$draining" "$outbox" 2>/dev/null | head -n 1 | jq -r '.text // empty' 2>/dev/null | tr '\n' ' ' | ml_wb_clip 60)
  conversation_id=$("$CLI" conversation create --workspace "$ML_WORKSPACE" \
      --custom-id "$conv_cid" --project "$project_id" --actors "${ML_ACTOR},${assistant_actor}" \
      --name "WorkBuddy: ${title:-session ${session_id:0:8}}" \
      --metadata harness=workbuddy --metadata "session=${session_id}" 2>/dev/null \
    | jq -r '.id // empty' 2>/dev/null)
  [ -n "$conversation_id" ] || { record error "could not create the conversation"; exit 0; }
fi
record ok "conversation ready"

# ---------- drain the outbox --------------------------------------------------------

# Take the queue out of the way first: the next turn's prompt-submit.sh may
# append to outbox.jsonl while this loop runs, and those lines must survive.
# A draining file left by a crashed run is finished before anything new.
[ -s "$draining" ] || mv -f "$outbox" "$draining" 2>/dev/null
remaining="$dir/outbox.remaining"
: >"$remaining"
failed=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  if [ -n "$failed" ]; then
    printf '%s\n' "$line" >>"$remaining"
    continue
  fi
  id=$(printf '%s' "$line" | jq -r '.id // empty' 2>/dev/null)
  side=$(printf '%s' "$line" | jq -r '.side // empty' 2>/dev/null)
  text=$(printf '%s' "$line" | jq -r '.text // empty' 2>/dev/null)
  ts=$(printf '%s' "$line" | jq -r '.timestamp // empty' 2>/dev/null)
  [ -n "$id" ] && [ -n "$text" ] || continue
  actor="$ML_ACTOR"
  [ "$side" = "assistant" ] && actor="$assistant_actor"
  # --workspace is load-bearing although the CLI's help says it is only for
  # --wait: without --parent, append looks up the conversation's latest
  # message, and that lookup needs a workspace. A fresh login remembers none,
  # so every append failed until something ran `memorylake workspace use`
  # (measured live in QwenWork, 2026-09-24).
  if err=$("$CLI" conversation message append --workspace "$ML_WORKSPACE" \
      --actor "$actor" --custom-id "$id" \
      --text "$text" ${ts:+--timestamp "$ts"} \
      --metadata "role=${side}" --metadata harness=workbuddy \
      -- "$conversation_id" 2>&1 >/dev/null); then
    continue
  fi
  # An id the server already has is a replay of a message that landed before
  # a crash; it is done, not failed.
  case "$err" in
    *already*exist*|*duplicate*|*conflict*|*409*) continue ;;
  esac
  failed=$(printf '%s' "$err" | tail -n 3 | tr '\n' ' ' | cut -c1-300)
  printf '%s\n' "$line" >>"$remaining"
done <"$draining"

# Leftovers go back AHEAD of whatever was queued meanwhile, keeping order.
# outbox.jsonl usually does not exist here (it was moved to draining), so the
# merge must not depend on cat's exit status -- chaining on it once dropped
# every unsent message on the failure path.
{ cat "$remaining" 2>/dev/null; [ -f "$outbox" ] && cat "$outbox" 2>/dev/null; } >"$outbox.tmp"
if [ -s "$outbox.tmp" ]; then
  # Could not put the queue back: keep draining for the next run to finish.
  mv -f "$outbox.tmp" "$outbox" 2>/dev/null || exit 0
else
  rm -f "$outbox.tmp" "$outbox" 2>/dev/null
fi
rm -f "$remaining" "$draining" 2>/dev/null
if [ -n "$failed" ]; then
  record error "append failed: $failed"
else
  record ok "synced"
fi
exit 0
