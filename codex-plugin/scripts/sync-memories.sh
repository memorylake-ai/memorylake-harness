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

custom_id="codex-memories"

# List the syncable memory files, one path per line.
list_memory_files() {
  find "$MEM_DIR/rollout_summaries" "$MEM_DIR/extensions" -type f -name '*.md' 2>/dev/null
}

# Print the paths whose content hash differs from the synced state.
changed_memory_files() {
  local f hash path_key state_file prev_hash
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    hash=$(shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1)
    [ -n "$hash" ] || continue
    path_key=$(printf '%s' "$f" | shasum -a 256 | cut -d' ' -f1)
    state_file="$sync_dir/file-${path_key}.json"
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
  sync_dir="$(ml_data_dir)/sync/${ML_WORKSPACE}/${custom_id}"

  lock_dir="$sync_dir/worker.lock"
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

  fail_marker="$sync_dir/last-failure.txt"

  # Ensure the ML project (create-first, cached).
  project_id=""
  [ -f "$sync_dir/project_id" ] && project_id=$(cat "$sync_dir/project_id" 2>/dev/null)
  if [ -z "$project_id" ]; then
    project_id=$("$CLI" project create --workspace "$ML_WORKSPACE" \
        --name "$custom_id" --custom-id "$custom_id" 2>/dev/null \
      | jq -r '.id // empty' 2>/dev/null)
    if [ -n "$project_id" ]; then
      rm -f "$(ml_data_dir)/projects/${ML_WORKSPACE}.txt" 2>/dev/null
    else
      project_id=$("$CLI" project get --workspace "$ML_WORKSPACE" "$custom_id" --by-custom-id 2>/dev/null \
        | jq -r '.id // empty' 2>/dev/null)
    fi
  fi
  if [ -z "$project_id" ]; then
    printf 'could not resolve or create ML project "%s"\n' "$custom_id" >"$fail_marker"
    exit 0
  fi
  printf '%s' "$project_id" >"$sync_dir/project_id" 2>/dev/null

  # Ensure the Library folder (mkdir-first, cached).
  folder_name="codex-memories"
  folder_id=""
  [ -f "$sync_dir/folder_id" ] && folder_id=$(cat "$sync_dir/folder_id" 2>/dev/null)
  if [ -z "$folder_id" ]; then
    folder_id=$("$CLI" lib mkdir "$folder_name" --on-conflict deny 2>/dev/null \
      | jq -r '.item_id // empty' 2>/dev/null)
    if [ -z "$folder_id" ]; then
      folder_id=$("$CLI" lib list MY_SPACE 2>/dev/null \
        | jq -r --arg n "$folder_name" \
            '(.items // [])[] | select(.name == $n and .type == "directory") | .item_id' 2>/dev/null \
        | head -n 1)
    fi
  fi
  if [ -z "$folder_id" ]; then
    printf 'could not resolve or create the Library folder "%s"\n' "$folder_name" >"$fail_marker"
    exit 0
  fi
  printf '%s' "$folder_id" >"$sync_dir/folder_id" 2>/dev/null

  # Drain the whole changed set, freshest first — the worker is off the
  # conversation path, so no per-turn cap is needed anymore. Re-scan here
  # rather than trusting the parent: files may have changed since detach.
  failed=""
  ordered=$(changed_memory_files | while IFS= read -r f; do
    mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || printf '0')
    printf '%s\t%s\n' "$mtime" "$f"
  done | sort -rn | cut -f2-)

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    slug=$(basename -- "$f")
    hash=$(shasum -a 256 "$f" | cut -d' ' -f1)
    path_key=$(printf '%s' "$f" | shasum -a 256 | cut -d' ' -f1)
    state_file="$sync_dir/file-${path_key}.json"
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

    jq -n --arg hash "$hash" --arg item "$item_id" --arg doc "$doc_id" \
      '{hash: $hash, item_id: $item, doc_id: $doc}' >"$state_file" 2>/dev/null
  done <<<"$ordered"

  [ -n "$failed" ] && printf '"%s" did not upload\n' "$failed" >"$fail_marker"
  exit 0
}

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

sync_dir="$(ml_data_dir)/sync/${ML_WORKSPACE}/${custom_id}"
mkdir -p "$sync_dir" 2>/dev/null || exit 0

# Surface the previous worker's failure, exactly once. Deferred by one turn,
# but a failed sync is still said out loud — never silently swallowed.
fail_marker="$sync_dir/last-failure.txt"
if [ -f "$fail_marker" ]; then
  reason=$(head -c 300 "$fail_marker" 2>/dev/null)
  rm -f "$fail_marker" 2>/dev/null
  jq -n --arg msg "[Memory Lake] the previous background memory sync failed ($reason). Local memories are intact; this turn's sync retries automatically." \
    '{systemMessage: $msg}'
fi

# Anything to do at all? (fast: hash scan, no network)
[ -z "$(changed_memory_files | head -n 1)" ] && exit 0

# A live worker is already draining; don't stack another.
lock_pid=$(cat "$sync_dir/worker.lock/pid" 2>/dev/null)
if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
  exit 0
fi

nohup "${BASH_SOURCE[0]}" --worker "${cwd:-$PWD}" >/dev/null 2>&1 &
exit 0
