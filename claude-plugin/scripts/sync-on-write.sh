#!/usr/bin/env bash
# PostToolUse(Write|Edit) — sync the just-written memory file up to Memory Lake.
#
# The model is the author; this hook is only a courier. It reads the final
# file from disk (never tool_input: Edit carries only old/new fragments),
# uploads it into a per-project Library folder, and imports it into the
# matching ML project so it becomes searchable from every other device.
#
# Update semantics are the measured ones, not the assumed ones (2026-08-07):
#   - `lib upload --on-conflict overwrite` keeps the item_id but does NOT
#     trigger re-indexing — the document keeps answering with the old content;
#   - re-importing the same item is reported as a duplicate, and also does
#     not re-index;
#   - the only path that re-indexes is `doc delete` + `doc import`, which
#     assigns a NEW doc id.
# So an update is: overwrite the drive file, delete the old document, import
# it again, and remember the new doc id in local state.
#
# Failure is never silent and never blocking: the local write already
# succeeded and must stand, so every failure path reports itself through
# additionalContext instead of a block decision.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# ---------- silent-exit gate (must stay cheap: runs on every Write/Edit) ----

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

[ -n "$file_path" ] || exit 0
ml_is_memory_file "$file_path" || exit 0
ml_is_memory_index "$file_path" && exit 0
[ -f "$file_path" ] || exit 0

ml_load_config "${cwd:-$PWD}" || exit 0
ml_flag_enabled "${ML_SYNC_ON_WRITE:-}" || exit 0

CLI=$(ml_cli)
[ -n "$CLI" ] || exit 0

# ---------- reporting --------------------------------------------------------

emit() {
  jq -n --arg ctx "$1" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: $ctx
    }
  }'
  exit 0
}

slug=$(basename -- "$file_path")

# A failed sync must be said out loud: the model just wrote a memory it may
# reasonably believe is now available everywhere. Silence here would let an
# outage masquerade as success.
fail() {
  emit "[Memory Lake] \"$slug\" was saved locally but NOT synced to Memory Lake ($1). It will not be recallable from other projects or devices until a later write retries the sync."
}

# ---------- change detection -------------------------------------------------

hash=$(shasum -a 256 "$file_path" 2>/dev/null | cut -d' ' -f1)
[ -n "$hash" ] || exit 0

custom_id="${ML_PROJECT_CUSTOM_ID:-}"
if [ -z "$custom_id" ]; then
  custom_id=$(basename -- "$(cd -- "${cwd:-$PWD}" && git rev-parse --show-toplevel 2>/dev/null || pwd)")
fi

sync_dir="$(ml_data_dir)/sync/${ML_WORKSPACE}/${custom_id}"
mkdir -p "$sync_dir" 2>/dev/null || exit 0
path_key=$(printf '%s' "$file_path" | shasum -a 256 | cut -d' ' -f1)
state_file="$sync_dir/file-${path_key}.json"

prev_hash=""
prev_doc_id=""
if [ -f "$state_file" ]; then
  prev_hash=$(jq -r '.hash // empty' "$state_file" 2>/dev/null)
  prev_doc_id=$(jq -r '.doc_id // empty' "$state_file" 2>/dev/null)
fi
# Claude Code rewrites memory files without changing them (index maintenance,
# frontmatter touch-ups); syncing those would re-index a document for nothing.
[ "$hash" = "$prev_hash" ] && exit 0

# ---------- ensure the ML project exists -------------------------------------

project_id=""
[ -f "$sync_dir/project_id" ] && project_id=$(cat "$sync_dir/project_id" 2>/dev/null)

if [ -z "$project_id" ]; then
  project_id=$("$CLI" project get --workspace "$ML_WORKSPACE" "$custom_id" --by-custom-id 2>/dev/null \
    | jq -r '.id // empty' 2>/dev/null)
fi
if [ -z "$project_id" ]; then
  project_id=$("$CLI" project create --workspace "$ML_WORKSPACE" \
      --name "$custom_id" --custom-id "$custom_id" 2>/dev/null \
    | jq -r '.id // empty' 2>/dev/null)
  # The visible-project cache predates this project; left alone it would make
  # every recall filter the new project OUT until the TTL expires (measured:
  # the fresh document was simply unfindable). The write path knows the world
  # changed, so it invalidates rather than waits.
  rm -f "$(ml_data_dir)/projects/${ML_WORKSPACE}.txt" 2>/dev/null
  # A concurrent hook may have created it first; custom ids are unique per
  # workspace, so losing that race shows up here as a failed create.
  if [ -z "$project_id" ]; then
    project_id=$("$CLI" project get --workspace "$ML_WORKSPACE" "$custom_id" --by-custom-id 2>/dev/null \
      | jq -r '.id // empty' 2>/dev/null)
  fi
fi
[ -n "$project_id" ] || fail "could not resolve or create ML project \"$custom_id\""
printf '%s' "$project_id" >"$sync_dir/project_id" 2>/dev/null

# ---------- ensure the Library folder exists ----------------------------------

folder_name="claude-memory--${custom_id}"
folder_id=""
[ -f "$sync_dir/folder_id" ] && folder_id=$(cat "$sync_dir/folder_id" 2>/dev/null)

if [ -z "$folder_id" ]; then
  folder_id=$("$CLI" lib list MY_SPACE 2>/dev/null \
    | jq -r --arg n "$folder_name" \
        '(.items // [])[] | select(.name == $n and .type == "directory") | .item_id' 2>/dev/null \
    | head -n 1)
fi
if [ -z "$folder_id" ]; then
  folder_id=$("$CLI" lib mkdir "$folder_name" --on-conflict deny 2>/dev/null \
    | jq -r '.item_id // empty' 2>/dev/null)
  # Same race as the project: deny means someone else made it; re-list.
  if [ -z "$folder_id" ]; then
    folder_id=$("$CLI" lib list MY_SPACE 2>/dev/null \
      | jq -r --arg n "$folder_name" \
          '(.items // [])[] | select(.name == $n and .type == "directory") | .item_id' 2>/dev/null \
      | head -n 1)
  fi
fi
[ -n "$folder_id" ] || fail "could not resolve or create the Library folder \"$folder_name\""
printf '%s' "$folder_id" >"$sync_dir/folder_id" 2>/dev/null

# ---------- upload ------------------------------------------------------------

item_id=$("$CLI" lib upload "$file_path" --parent "$folder_id" --name "$slug" \
    --on-conflict overwrite 2>/dev/null \
  | jq -r '.item_id // empty' 2>/dev/null)
[ -n "$item_id" ] || fail "upload failed"

# ---------- (re)index ----------------------------------------------------------

# Overwriting the drive file does not re-index the document, so an update must
# drop the old document first. Deletion failure is tolerated: the id may be
# stale (state from a deleted project), and import below will then report a
# duplicate we can resolve.
if [ -n "$prev_doc_id" ]; then
  "$CLI" project document delete --workspace "$ML_WORKSPACE" --project "$project_id" \
    "$prev_doc_id" >/dev/null 2>&1
fi

import_out=$("$CLI" project document import --workspace "$ML_WORKSPACE" --project "$project_id" \
  "$item_id" 2>/dev/null)
result=$(printf '%s' "$import_out" \
  | jq -r '(.details // [])[0].result // empty' 2>/dev/null)
doc_id=$(printf '%s' "$import_out" \
  | jq -r '(.details // [])[0].document_id // empty' 2>/dev/null)

if [ "$result" = "duplicate" ] && [ -n "$doc_id" ]; then
  # Already imported (state was lost, so the delete above had no id to work
  # with) — and the duplicate answer conveniently names the existing document.
  # Stopping here would be a false success: a duplicate import does NOT
  # re-index, so the document would keep answering with the previous content.
  # Drop it and import again so the fresh content actually gets indexed.
  "$CLI" project document delete --workspace "$ML_WORKSPACE" --project "$project_id" \
    "$doc_id" >/dev/null 2>&1
  doc_id=$("$CLI" project document import --workspace "$ML_WORKSPACE" --project "$project_id" \
      "$item_id" 2>/dev/null \
    | jq -r '(.details // [])[0].document_id // empty' 2>/dev/null)
fi
[ -n "$doc_id" ] || fail "import into project \"$custom_id\" failed"

# ---------- record and report --------------------------------------------------

jq -n --arg hash "$hash" --arg item "$item_id" --arg doc "$doc_id" \
  '{hash: $hash, item_id: $item, doc_id: $doc}' >"$state_file" 2>/dev/null

emit "[Memory Lake] \"$slug\" synced — it is now recallable from the user's other projects, devices, and clients (indexing may take a moment)."
