#!/usr/bin/env bash
# Stop — sync changed Codex memory summaries up to Memory Lake.
#
# Codex memories are not written by the model through tool calls: an engine
# pipeline summarizes each session into ~/.codex/memories/rollout_summaries/
# and aggregates them into MEMORY.md. There is therefore no tool-call moment
# to intercept (the claude-plugin approach); instead this hook runs at every
# turn end, cheaply short-circuits when nothing changed, and uploads whatever
# per-session summaries are new or modified since the last sync.
#
# What syncs: rollout_summaries/*.md and extensions/**/*.md — one document per
# file, natural granularity, stable names. What deliberately does NOT sync:
# MEMORY.md / raw_memories.md / memory_summary.md, the engine's aggregate
# files. They duplicate the summaries' content, weigh hundreds of KB, and
# would be re-cooked in full on every change.
#
# CONTRACT WARNING (differs from claude-plugin's sync!): in a Codex Stop hook,
# exit code 2 means "block the stop and CONTINUE the turn" — it is a turn-
# continuation request, not an error channel. A failed sync must never restart
# the conversation, so failures report through systemMessage and exit 0.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

command -v jq >/dev/null 2>&1 || exit 0

MEM_DIR=$(ml_codex_memories_dir)
[ -d "$MEM_DIR" ] || exit 0

input=$(cat 2>/dev/null || printf '{}')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

ml_load_config "${cwd:-$PWD}" || exit 0
ml_flag_enabled "${ML_SYNC_ON_WRITE:-}" || exit 0

CLI=$(ml_cli)
[ -n "$CLI" ] || exit 0

# Report a failure without exiting non-zero: see the contract warning above.
warn() {
  jq -n --arg msg "[Memory Lake] Codex memory sync failed ($1). Local memories are intact; the next turn retries automatically." \
    '{systemMessage: $msg}'
  exit 0
}

custom_id="codex-memories"
sync_dir="$(ml_data_dir)/sync/${ML_WORKSPACE}/${custom_id}"
mkdir -p "$sync_dir" 2>/dev/null || exit 0

# ---------- collect changed files (cheap path: all hashes match) --------------

changed_files=()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  hash=$(shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1)
  [ -n "$hash" ] || continue
  path_key=$(printf '%s' "$f" | shasum -a 256 | cut -d' ' -f1)
  state_file="$sync_dir/file-${path_key}.json"
  prev_hash=""
  [ -f "$state_file" ] && prev_hash=$(jq -r '.hash // empty' "$state_file" 2>/dev/null)
  [ "$hash" = "$prev_hash" ] && continue
  changed_files+=("$f")
done < <(find "$MEM_DIR/rollout_summaries" "$MEM_DIR/extensions" -type f -name '*.md' 2>/dev/null)

[ ${#changed_files[@]} -eq 0 ] && exit 0

# ---------- ensure the ML project exists (create-first, cached) ---------------

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
[ -n "$project_id" ] || warn "could not resolve or create ML project \"$custom_id\""
printf '%s' "$project_id" >"$sync_dir/project_id" 2>/dev/null

# ---------- ensure the Library folder exists -----------------------------------

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
[ -n "$folder_id" ] || warn "could not resolve or create the Library folder \"$folder_name\""
printf '%s' "$folder_id" >"$sync_dir/folder_id" 2>/dev/null

# ---------- sync each changed file ---------------------------------------------

# Cap per turn: a first run on a machine with months of history has dozens of
# summaries. Sync the freshest first (find order is unspecified, so sort by
# mtime), let later turns drain the rest — each turn's Stop re-enters here.
MAX_PER_TURN=5
synced=0
failed=""

# mtime-descending ordering of the changed set.
ordered=$(for f in "${changed_files[@]}"; do
  mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || printf '0')
  printf '%s\t%s\n' "$mtime" "$f"
done | sort -rn | cut -f2-)

while IFS= read -r f; do
  [ $synced -ge $MAX_PER_TURN ] && break
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

  # Measured update semantics (same backend as claude-plugin): overwrite does
  # not re-index and a duplicate import does not either — delete + import is
  # the only re-indexing path.
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
  synced=$((synced + 1))
done <<<"$ordered"

[ -n "$failed" ] && warn "\"$failed\" did not upload"
exit 0
