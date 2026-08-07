#!/usr/bin/env bash
# PreToolUse(Read) — remind the model that Memory Lake exists, once per session.
#
# This hook deliberately does NOT search. An earlier design had it take the
# target file's `description` as a query and inject the results; that is the
# wrong direction. The model can only be reading that file because it already
# saw the description in the MEMORY.md index, so querying with it just returns
# a paraphrase of the memory already in hand. What the model actually wants is
# "memories about the task I am on", and only the model knows that query.
#
# So: no network, no latency, no timeout risk. Just a nudge at the one moment
# we know the model is thinking about memory, plus the query-writing contract
# it needs to phrase the search well.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# Reading the model's own memory must never be blocked or slowed by us. Every
# failure path below is a silent exit 0, which leaves the tool call untouched.
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)

[ -n "$file_path" ] || exit 0
ml_is_memory_file "$file_path" || exit 0
ml_is_memory_index "$file_path" && exit 0

ml_load_config "${cwd:-$PWD}" || exit 0
ml_flag_enabled "${ML_REMIND_ON_READ:-}" || exit 0

# No point advertising a command that is not installed.
[ -n "$(ml_cli)" ] || exit 0

# Once per session. Five memory files read in a row must not mean five nudges.
state_dir=$(ml_state_dir)
marker="$state_dir/reminded-${session_id:-unknown}"
[ -e "$marker" ] && exit 0
mkdir -p "$state_dir" 2>/dev/null && : >"$marker" 2>/dev/null

read -r -d '' reminder <<'EOF'
[Memory Lake] You are reading a local auto-memory file. Local memory covers
only this repository on this machine. Memory Lake may hold related memories
written from other projects, other machines, or other clients.

To search it, run: ml-recall "<query>"

Write the query yourself — it should describe what you need for the task at
hand, not restate the file you are reading. Phrase it well: statement-style
keywords beat questions ("user's preferred editor" over "what editor do I
use?"); resolve pronouns to entity names; convert relative time to absolute
dates; one intent per query.

Reading results: hits come most-relevant-first but may include unrelated
matches — judge each one against your question by its content. On empty or
irrelevant results, retry once with different wording, then tell the user
honestly — never invent an answer.

(Shown once per session.)
EOF

jq -n --arg ctx "$reminder" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    additionalContext: $ctx
  }
}'
