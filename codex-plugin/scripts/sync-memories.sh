#!/usr/bin/env bash
# Stop — sync changed Codex memory summaries up to Memory Lake, in the
# background.
#
# Codex memories are not written by the model through tool calls: an engine
# pipeline summarizes each session into ~/.codex/memories/rollout_summaries/
# and aggregates them into MEMORY.md. There is therefore no tool-call moment
# to intercept (the claude-plugin approach); instead this hook runs at every
# turn end and uploads whatever per-session summaries changed.
#
# Codex does not support async hooks yet ("async" parses but does nothing), and
# a synchronous Stop hook visibly stalls the next prompt — the first-ever sync
# has dozens of never-synced summaries to upload and held the UI for over ten
# seconds (observed live). So this script backgrounds itself: the hook
# invocation only detects change (fast hash scan), then detaches a worker with
# nohup and returns immediately. The worker takes a lock so consecutive turns
# cannot run two of them, and reports failure by leaving a marker file that the
# NEXT hook invocation surfaces via systemMessage — deferred, but never silent.
#
# What syncs: rollout_summaries/*.md and extensions/**/*.md — one document per
# file, natural granularity, stable names. What deliberately does NOT sync:
# MEMORY.md / raw_memories.md / memory_summary.md, the engine's aggregate
# files. They duplicate the summaries' content, weigh hundreds of KB, and
# would be re-cooked in full on every change.
#
# ATTRIBUTION: rollout summaries carry a stable metadata header written by the
# engine at generation time, including the session's `cwd:`. That line is what
# routes each summary to the SAME per-repo ML project the Claude Code harness
# uses (ml_project_identity: explicit config > remote URL > physical path),
# merging both harnesses' memories for a
# repo — and it is what makes sync_deny reliable here: the cwd is baked into
# the content, so there is no sync-time/session-cwd mismatch. Files without a
# cwd header (extension notes, unknown formats) fall back to the shared
# codex-memories project.
#
# CONTRACT WARNING (differs from claude-plugin's sync!): in a Codex Stop hook,
# exit code 2 means "block the stop and CONTINUE the turn" — it is a turn-
# continuation request, not an error channel. Nothing here may exit non-zero
# on failure.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

command -v jq >/dev/null 2>&1 || exit 0

MEM_DIR=$(ml_codex_memories_dir)

FALLBACK_ID="codex-memories"

# Per-identity state directory under the sync root (slugged: identities are
# remote URLs with slashes in them).
state_dir_for() {
  printf '%s/sync/%s/%s' "$(ml_data_dir)" "$ML_WORKSPACE" "$(ml_cid_slug "$1")"
}

# The state file that tracks one memory file's sync status.
state_file_for() { # $1=custom_id $2=file path
  printf '%s/file-%s.json' "$(state_dir_for "$1")" "$(printf '%s' "$2" | shasum -a 256 | cut -d' ' -f1)"
}

# The `cwd:` line from a summary's metadata header, or nothing. Only the
# first ten lines are consulted — the header is at the top by construction,
# and a "cwd:" appearing later in prose must not reroute the file.
ml_summary_cwd() {
  head -n 10 -- "$1" 2>/dev/null | grep -m1 '^cwd: ' | cut -c6- | sed 's/^[[:space:]]*//'
}

# Resolve a summary file to the project identity it belongs to. Same rule as
# the Claude Code harness (ml_project_identity: explicit config > remote URL >
# physical path), so every clone of a repo — any machine, either assistant —
# lands in one ML project. Empty when unattributable (no cwd header).
ml_summary_custom_id() {
  local scwd
  scwd=$(ml_summary_cwd "$1")
  [ -n "$scwd" ] || return 0
  ml_project_identity "$scwd"
}

# The display name for a summary's project: the repo folder's basename.
ml_summary_display() {
  local scwd
  scwd=$(ml_summary_cwd "$1")
  [ -n "$scwd" ] || return 0
  ml_project_display "$scwd"
}

# Should a summary from this cwd upload? Mirrors the claude-side three-layer
# policy for the summary's OWN project (not the hook's cwd): that project's
# config file explicitly setting sync_on_write is the final word; otherwise
# the global sync_deny prefix list; otherwise yes — the global default was
# already checked before the worker detached.
ml_summary_allowed() { # $1 = the summary's cwd (the directory may be gone)
  local dir says="" d
  dir=$(cd -- "$1" 2>/dev/null && { git rev-parse --show-toplevel 2>/dev/null || pwd -P; } || printf '%s' "$1")
  d="$dir"
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -f "$d/.claude/memorylake.local.md" ]; then
      says=$(ml_frontmatter_get "$d/.claude/memorylake.local.md" sync_on_write)
      break
    fi
    d=$(dirname -- "$d")
  done
  if [ -n "$says" ]; then
    ml_flag_enabled "$says"
    return $?
  fi
  ml_sync_denied "$dir" && return 1
  return 0
}

# List the syncable memory files, one path per line.
list_memory_files() {
  find "$MEM_DIR/rollout_summaries" "$MEM_DIR/extensions" -type f -name '*.md' 2>/dev/null
}

# Print the paths whose content hash differs from the synced state.
changed_memory_files() {
  local f hash cid state_file prev_hash
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    hash=$(shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1)
    [ -n "$hash" ] || continue
    cid=$(ml_summary_custom_id "$f")
    state_file=$(state_file_for "${cid:-$FALLBACK_ID}" "$f")
    prev_hash=""
    [ -f "$state_file" ] && prev_hash=$(jq -r '.hash // empty' "$state_file" 2>/dev/null)
    [ "$hash" = "$prev_hash" ] && continue
    printf '%s\n' "$f"
  done < <(list_memory_files)
}

# ---------- worker mode (runs detached, owns the lock) -------------------------

run_worker() {
  ml_load_config "$1" || exit 0
  CLI=$(ml_cli)
  [ -n "$CLI" ] || exit 0
  sync_root="$(ml_data_dir)/sync/${ML_WORKSPACE}"
  mkdir -p "$sync_root" 2>/dev/null || exit 0

  lock_dir="$sync_root/worker.lock"
  # mkdir is the atomic lock primitive; a stale lock (dead pid) is reclaimed.
  if ! mkdir "$lock_dir" 2>/dev/null; then
    old_pid=$(cat "$lock_dir/pid" 2>/dev/null)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      exit 0 # a live worker is already draining the queue
    fi
    rm -rf "$lock_dir" 2>/dev/null
    mkdir "$lock_dir" 2>/dev/null || exit 0
  fi
  printf '%s' $$ >"$lock_dir/pid" 2>/dev/null
  trap 'rm -rf "$lock_dir"' EXIT

  fail_marker="$sync_root/last-failure.txt"

  # Resolve (create-first, file-cached per identity) the ML project id.
  ensure_project() { # $1=custom_id $2=display name → stdout id, empty on failure
    local cid="$1" name_="${2:-$1}" cache pid_
    cache="$(state_dir_for "$cid")/project_id"
    pid_=$(cat "$cache" 2>/dev/null)
    if [ -z "$pid_" ]; then
      pid_=$("$CLI" project create --workspace "$ML_WORKSPACE" \
          --name "$name_" --custom-id "$cid" 2>/dev/null \
        | jq -r '.id // empty' 2>/dev/null)
      if [ -n "$pid_" ]; then
        rm -f "$(ml_data_dir)/projects/${ML_WORKSPACE}.txt" 2>/dev/null
      else
        pid_=$("$CLI" project get --workspace "$ML_WORKSPACE" "$cid" --by-custom-id 2>/dev/null \
          | jq -r '.id // empty' 2>/dev/null)
      fi
      [ -n "$pid_" ] && { mkdir -p "$(state_dir_for "$cid")" 2>/dev/null; printf '%s' "$pid_" >"$cache" 2>/dev/null; }
    fi
    printf '%s' "$pid_"
  }

  # Resolve (mkdir-first, file-cached per custom_id) the Library folder id.
  # The name is NEUTRAL and shared with the Claude Code harness (same
  # folder_id cache file): one repo, one folder, both assistants' memories.
  ensure_folder() { # $1=custom_id → stdout id, empty on failure
    local cid="$1" fname cache fid
    fname="memory--$(ml_cid_slug "$cid")"
    [ "$cid" = "$FALLBACK_ID" ] && fname="codex-memories"
    cache="$(state_dir_for "$cid")/folder_id"
    fid=$(cat "$cache" 2>/dev/null)
    if [ -z "$fid" ]; then
      fid=$("$CLI" lib mkdir "$fname" --on-conflict deny 2>/dev/null \
        | jq -r '.item_id // empty' 2>/dev/null)
      if [ -z "$fid" ]; then
        fid=$("$CLI" lib list MY_SPACE 2>/dev/null \
          | jq -r --arg n "$fname" \
              '(.items // [])[] | select(.name == $n and .type == "directory") | .item_id' 2>/dev/null \
          | head -n 1)
      fi
      [ -n "$fid" ] && { mkdir -p "$(state_dir_for "$cid")" 2>/dev/null; printf '%s' "$fid" >"$cache" 2>/dev/null; }
    fi
    printf '%s' "$fid"
  }

  # Drain the whole changed set, freshest first — the worker is off the
  # conversation path, so no per-turn cap is needed. Re-scan here rather than
  # trusting the parent: files may have changed since detach.
  failed=""
  ordered=$(changed_memory_files | while IFS= read -r f; do
    mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || printf '0')
    printf '%s\t%s\n' "$mtime" "$f"
  done | sort -rn | cut -f2-)

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    slug=$(basename -- "$f")

    # Attribute the file; a summary whose own project opted out uploads
    # nothing (unattributable files carry no project to opt out).
    scwd=$(ml_summary_cwd "$f")
    cid=$(ml_summary_custom_id "$f")
    cid="${cid:-$FALLBACK_ID}"
    display=$(ml_summary_display "$f")
    if [ -n "$scwd" ] && ! ml_summary_allowed "$scwd"; then
      continue
    fi

    project_id=$(ensure_project "$cid" "${display:-$cid}")
    if [ -z "$project_id" ]; then
      failed="$slug (project \"$cid\")"
      continue
    fi
    folder_id=$(ensure_folder "$cid")
    if [ -z "$folder_id" ]; then
      failed="$slug (folder for \"$cid\")"
      continue
    fi

    hash=$(shasum -a 256 "$f" | cut -d' ' -f1)
    state_file=$(state_file_for "$cid" "$f")
    mkdir -p "$(dirname -- "$state_file")" 2>/dev/null
    prev_doc_id=""
    [ -f "$state_file" ] && prev_doc_id=$(jq -r '.doc_id // empty' "$state_file" 2>/dev/null)

    item_id=$("$CLI" lib upload "$f" --parent "$folder_id" --name "$slug" \
        --on-conflict overwrite 2>/dev/null \
      | jq -r '.item_id // empty' 2>/dev/null)
    if [ -z "$item_id" ]; then
      failed="$slug"
      continue
    fi

    # Measured update semantics: overwrite does not re-index and a duplicate
    # import does not either — delete + import is the only re-indexing path.
    if [ -n "$prev_doc_id" ]; then
      "$CLI" project document delete --workspace "$ML_WORKSPACE" --project "$project_id" \
        "$prev_doc_id" >/dev/null 2>&1
    fi
    import_out=$("$CLI" project document import --workspace "$ML_WORKSPACE" --project "$project_id" \
      "$item_id" 2>/dev/null)
    result=$(printf '%s' "$import_out" | jq -r '(.details // [])[0].result // empty' 2>/dev/null)
    doc_id=$(printf '%s' "$import_out" | jq -r '(.details // [])[0].document_id // empty' 2>/dev/null)
    if [ "$result" = "duplicate" ] && [ -n "$doc_id" ]; then
      "$CLI" project document delete --workspace "$ML_WORKSPACE" --project "$project_id" \
        "$doc_id" >/dev/null 2>&1
      doc_id=$("$CLI" project document import --workspace "$ML_WORKSPACE" --project "$project_id" \
          "$item_id" 2>/dev/null \
        | jq -r '(.details // [])[0].document_id // empty' 2>/dev/null)
    fi
    if [ -z "$doc_id" ]; then
      failed="$slug"
      continue
    fi

    jq -n --arg hash "$hash" --arg item "$item_id" --arg doc "$doc_id" --arg cid "$cid" \
      '{hash: $hash, item_id: $item, doc_id: $doc, custom_id: $cid}' >"$state_file" 2>/dev/null

    # One-time migration from the pre-0.4.0 layout, where every summary's
    # state and document lived under the fallback project: now that this file
    # has an attributed copy, retire the old one so it does not exist twice.
    if [ "$cid" != "$FALLBACK_ID" ]; then
      old_state=$(state_file_for "$FALLBACK_ID" "$f")
      if [ -f "$old_state" ]; then
        old_doc=$(jq -r '.doc_id // empty' "$old_state" 2>/dev/null)
        old_proj=$(cat "$(state_dir_for "$FALLBACK_ID")/project_id" 2>/dev/null)
        [ -n "$old_doc" ] && [ -n "$old_proj" ] && \
          "$CLI" project document delete --workspace "$ML_WORKSPACE" \
            --project "$old_proj" "$old_doc" >/dev/null 2>&1
        rm -f "$old_state" 2>/dev/null
      fi
    fi
  done <<<"$ordered"

  [ -n "$failed" ] && printf '"%s" did not upload\n' "$failed" >"$fail_marker"
  exit 0
}

# ---------- preview mode (setup-time disclosure, no network) -------------------
#
# Lists what the next sync would upload, grouped by destination project. The
# setup skill runs this BEFORE sync_on_write is enabled: the first sync
# drains every summary already on disk — potentially months of history — and
# that backlog must be consented to, not discovered after the fact.
if [ "${1:-}" = "--preview" ]; then
  ml_load_config "${2:-$PWD}" || { printf 'NOT_CONFIGURED\n' >&2; exit 1; }
  changed_memory_files | while IFS= read -r f; do
    scwd=$(ml_summary_cwd "$f")
    cid=$(ml_summary_custom_id "$f")
    cid="${cid:-$FALLBACK_ID}"
    if [ -n "$scwd" ] && ! ml_summary_allowed "$scwd"; then
      printf 'DENY\t%s\n' "$cid"
    else
      printf 'UPLOAD\t%s\n' "$cid"
    fi
  done | sort | uniq -c | sort -rn \
    | awk '{printf "%-6s  %-40s  %d file(s)\n", $2, $3, $1}'
  exit 0
fi

if [ "${1:-}" = "--worker" ]; then
  run_worker "${2:-$PWD}"
  exit 0
fi

# ---------- hook mode (must return fast) ---------------------------------------

[ -d "$MEM_DIR" ] || exit 0

input=$(cat 2>/dev/null || printf '{}')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

ml_load_config "${cwd:-$PWD}" || exit 0
ml_flag_enabled "${ML_SYNC_ON_WRITE:-}" || exit 0
[ -n "$(ml_cli)" ] || exit 0

sync_root="$(ml_data_dir)/sync/${ML_WORKSPACE}"
mkdir -p "$sync_root" 2>/dev/null || exit 0

# Surface the previous worker's failure, exactly once. Deferred by one turn,
# but a failed sync is still said out loud — never silently swallowed.
fail_marker="$sync_root/last-failure.txt"
if [ -f "$fail_marker" ]; then
  reason=$(head -c 300 "$fail_marker" 2>/dev/null)
  rm -f "$fail_marker" 2>/dev/null
  jq -n --arg msg "[Memory Lake] the previous background memory sync failed ($reason). Local memories are intact; this turn's sync retries automatically." \
    '{systemMessage: $msg}'
fi

# Anything to do at all? (fast: hash scan, no network)
[ -z "$(changed_memory_files | head -n 1)" ] && exit 0

# A live worker is already draining; don't stack another.
lock_pid=$(cat "$sync_root/worker.lock/pid" 2>/dev/null)
if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
  exit 0
fi

nohup "${BASH_SOURCE[0]}" --worker "${cwd:-$PWD}" >/dev/null 2>&1 &
exit 0
