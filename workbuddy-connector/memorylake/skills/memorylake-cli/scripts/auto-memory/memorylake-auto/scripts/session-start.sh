#!/usr/bin/env bash
# SessionStart -- standing instructions plus a status line.
#
# WorkBuddy injects this into the session's first message (and again after a
# compaction, when SessionStart fires with source=compact), so it plays the
# role of the system-prompt section a plugin cannot otherwise add: what
# MemoryLake is, how it differs from WorkBuddy's own memory files, and the
# contract that every turn starts with a search. The per-turn reminder
# (prompt-submit.sh) and the gate (recall-gate.sh) enforce it.
#
# It also says when the system is NOT usable. Without that, an unreachable
# backend looks exactly like "you never told me that".

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

emit() {
  jq -n --arg ctx "$1" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: $ctx
    }
  }'
  exit 0
}

command -v jq >/dev/null 2>&1 || ml_exit_without_jq SessionStart

input=$(cat 2>/dev/null || printf '{}')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

# Not configured: one line pointing at setup, nothing else. Unlike the Claude
# Code harness this is not silent -- installing this plugin in WorkBuddy is
# an explicit act, and an installed-but-unconfigured memory plugin that says
# nothing looks like a working one.
if ! ml_load_config "${cwd:-$PWD}"; then
  emit "MemoryLake (the user's cross-device long-term memory) is installed but not set up on this machine, so recall and conversation sync are off. If the user asks about memory or MemoryLake, ask them to reconnect the MemoryLake connector in WorkBuddy's connector list."
fi

CLI=$(ml_cli)
[ -n "$CLI" ] || emit "MemoryLake: the 'memorylake' CLI is not installed, so memory recall is UNAVAILABLE this session and conversations are not being synced. Do not treat missing recall results as 'no such memory'. Ask the user to reconnect the MemoryLake connector in WorkBuddy's connector list -- that installs the CLI and signs in."

CACHE_DIR="$(ml_data_dir)/status"
CACHE_FILE="$CACHE_DIR/${ML_WORKSPACE}.txt"
CACHE_TTL=600

# The cache stores DATA (the project count), never a rendered line: the tree
# is shared with the other harnesses, whose lines name other commands.
projects=""
if [ -f "$CACHE_FILE" ]; then
  now=$(date +%s)
  # GNU stat first; `-f` is file-SYSTEM mode there (see common.sh).
  mtime=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || stat -f %m "$CACHE_FILE" 2>/dev/null || printf '0')
  if [ $((now - mtime)) -lt $CACHE_TTL ]; then
    projects=$(cat "$CACHE_FILE" 2>/dev/null)
    case "$projects" in *[!0-9]*) projects="" ;; esac
  fi
fi
if [ -z "$projects" ]; then
  projects=$("$CLI" project list --workspace "$ML_WORKSPACE" 2>/dev/null | jq -r '(.items // []) | length' 2>/dev/null)
  if [ -z "$projects" ]; then
    emit "MemoryLake: workspace ${ML_WORKSPACE} is unreachable (not logged in, or the network is down). Memory recall is UNAVAILABLE this session -- if a search returns nothing, say the memory backend could not be reached rather than concluding the memory does not exist. If it stays that way, ask the user to reconnect the MemoryLake connector in WorkBuddy's connector list."
  fi
  mkdir -p "$CACHE_DIR" 2>/dev/null && printf '%s' "$projects" >"$CACHE_FILE" 2>/dev/null
fi

if [ -n "${ML_SYNC_CONVERSATIONS:-}" ] && ml_flag_enabled "$ML_SYNC_CONVERSATIONS" && ! ml_sync_denied "${cwd:-$PWD}"; then
  sync_line="Writing: this conversation (the user's messages and your final replies -- never tool calls or tool output) is appended to MemoryLake automatically after every turn, and memories are distilled from it on the server. Do not copy things into MemoryLake by hand."
  if ml_wb_attachments_allowed "${cwd:-$PWD}"; then
    sync_line="${sync_line} Documents and images the user attaches to a message are uploaded too, as searchable documents; do not upload them yourself."
  fi
else
  sync_line="Writing: conversation sync is OFF for this session, so nothing said here reaches MemoryLake."
fi

read -r -d '' ctx <<TEXT
MemoryLake: connected (workspace ${ML_WORKSPACE}, ${projects} project(s)).

MemoryLake is the user's long-term memory across devices and apps -- other WorkBuddy machines, Claude Code, Codex, and more. It is separate from WorkBuddy's own memory files, which only cover this machine; keep maintaining those exactly as your instructions say.

Recall: search it with \`ml-recall "<query>"\` (Bash) at the start of every turn, before other tools and before replying -- each user message carries a reminder, and the first tool call of a turn that skipped the search is held back once. The memorylake-cli-recall skill covers query phrasing and reading results.

${sync_line}
TEXT

emit "$ctx"
