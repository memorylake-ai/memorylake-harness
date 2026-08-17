#!/usr/bin/env bash
# PostToolUse(Write|Edit) — sync the just-written memory file up to Memory Lake.
#
# The model is the author; this hook is only a courier. It reads the final
# file from disk (never tool_input: Edit carries only old/new fragments) and
# routes it by mutability and recall latency (the memory type encodes both):
#
#   - type user/feedback → a FACT, from the frontmatter `description`. Facts
#     are searchable the moment they are stored — no cook step — which is what
#     a preference needs: "remember I use vim" must be recallable in the very
#     next question. The description IS the atomic statement (both memory
#     systems share that writing convention), and semantic conflicts between
#     facts are the backend's job, so an update is simply storing the new
#     statement.
#   - type project/reference (or no type) → a FILE, uploaded into a
#     per-project Library folder and imported into the matching ML project.
#     Long evolving bodies belong in documents; the indexing delay is the
#     price of full-text.
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
# This hook runs in the BACKGROUND (asyncRewake): a sync taking seconds on a
# slow network must not stall the conversation — the first-ever sync once blew
# a 15s synchronous timeout and was killed silently, the exact failure mode
# the synchronous design was supposed to prevent. The failure contract is now:
#   - success: exit 0, silently — background work that worked owes no report;
#   - failure: exit 2 with the reason on stderr, which asyncRewake surfaces to
#     Claude as a system reminder, so a failed sync is still said out loud.
# The local write always stands either way; recovery is automatic — the next
# write of ANY memory file re-runs the full chain (hash mismatch against the
# unwritten state), and a lost import resolves through the duplicate branch.

set -uo pipefail

# Cheap pre-filter BEFORE sourcing anything: this script runs on every single
# tool call its matcher covers, and the overwhelming majority are not memory
# files. A bash substring check answers that for the cost of process startup
# alone (~5ms), where source + jq cost ~25ms (measured). The precise path
# check below still applies; this only rejects obvious non-matches early.
_raw_input=$(cat)
case "$_raw_input" in
  *"/.claude/projects/"*) : ;;
  *) exit 0 ;;
esac

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# ---------- silent-exit gate (must stay cheap: runs on every Write/Edit) ----

# jq is what parses everything below, so without it this hook can do nothing —
# but silence is the wrong way to say so. A bare `exit 0` here meant that on a
# host with no jq the plugin looked installed and healthy while every memory
# quietly failed to upload; a user who believes their memories are saved is
# worse off than one who knows they are not. This is the same failure the
# script's own contract already forbids, so report it the same way the rest of
# the file does: exit 2 with the reason on stderr, which asyncRewake surfaces.
if ! command -v jq >/dev/null 2>&1; then
  # Only for someone who configured Memory Lake: an unconfigured project must
  # see no trace of this plugin, and nothing was going to be synced anyway.
  # ml_load_config parses frontmatter with awk, so it works without jq.
  ml_load_config "$PWD" || exit 0
  printf '[Memory Lake] this memory was saved locally but NOT synced: the jq dependency is missing, so the sync hook cannot run. Install jq (brew install jq / apt-get install jq); a later memory write retries the sync automatically.\n' >&2
  exit 2
fi

input="$_raw_input"
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

[ -n "$file_path" ] || exit 0
ml_is_memory_file "$file_path" || exit 0
ml_is_memory_index "$file_path" && exit 0
[ -f "$file_path" ] || exit 0

ml_load_config "${cwd:-$PWD}" || exit 0
# The OUTBOUND flag is explicit-opt-in: an absent/empty sync_on_write means
# OFF, unlike the lenient ml_flag_enabled default used for enabled and
# status_line — uploading user memories must never be the fail-open path.
# (init/setup always write the key explicitly, so this only bites
# hand-written configs — in the safe direction.)
[ -n "${ML_SYNC_ON_WRITE:-}" ] || exit 0
ml_flag_enabled "$ML_SYNC_ON_WRITE" || exit 0

# Global sync_deny gate, placed BEFORE the fact/file routing so a denied
# project uploads nothing on either path. Precedence is most-specific-wins:
# the deny list only yields to a project config file that EXPLICITLY sets
# sync_on_write (a project file that merely exists, or sets other keys, has
# not spoken on the matter).
if ml_sync_denied "${cwd:-$PWD}"; then
  project_says=""
  [ -n "${ML_PROJECT_CONFIG:-}" ] && project_says=$(ml_frontmatter_get "$ML_PROJECT_CONFIG" sync_on_write)
  [ -n "$project_says" ] || exit 0
  # A non-empty value that was false already exited at the flag check above,
  # so reaching here means the project file explicitly said true — exempt.
fi

CLI=$(ml_cli)
[ -n "$CLI" ] || exit 0

# ---------- reporting --------------------------------------------------------

slug=$(basename -- "$file_path")

# A failed sync must be said out loud: the model just wrote a memory it may
# reasonably believe is now available everywhere. exit 2 + stderr is the
# asyncRewake wake-up contract.
fail() {
  printf '[Memory Lake] "%s" was saved locally but NOT synced to Memory Lake (%s). It stays local-only until a later memory write retries the sync automatically; /memorylake:status can check connectivity.\n' "$slug" "$1" >&2
  exit 2
}

# ---------- change detection -------------------------------------------------

hash=$(shasum -a 256 "$file_path" 2>/dev/null | cut -d' ' -f1)
[ -n "$hash" ] || exit 0

# Identity (custom_id) and display name are separate on purpose: the identity
# is remote-URL-based so every clone of a repo maps to one cloud project (see
# ml_project_identity); the name is the basename humans recognize.
# ML_PROJECT_CUSTOM_ID (merged config) still wins for compatibility, though
# ml_project_identity reads the same project-file key itself.
custom_id="${ML_PROJECT_CUSTOM_ID:-}"
[ -n "$custom_id" ] || custom_id=$(ml_project_identity "${cwd:-$PWD}")
display_name=$(ml_project_display "${cwd:-$PWD}")

sync_dir="$(ml_data_dir)/sync/${ML_WORKSPACE}/$(ml_cid_slug "$custom_id")"
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

# ---------- route by memory type -----------------------------------------------

mem_type=$(ml_frontmatter_get "$file_path" type)
if [ -z "$mem_type" ]; then
  # Flow-style metadata ({type: user, ...}) hides the key from the line-based
  # reader. The model's output format is not ours to control, and silently
  # downgrading a preference to the slow file path defeats the fast path's
  # point — so fish the type out of the flow map. The (^|[{,]) guard keeps
  # node_type from matching.
  mem_type=$(ml_frontmatter_get "$file_path" metadata \
    | grep -oE '(^|[{,])[[:space:]]*type:[[:space:]]*[a-z]+' 2>/dev/null \
    | grep -oE '[a-z]+$' | head -n 1)
fi
description=$(ml_frontmatter_get "$file_path" description)

case "$mem_type" in
  user|feedback)
    # Fact fast path — but only when it is actually available: it needs an
    # actor to own the fact and a description to store. Missing either falls
    # through to the file path below rather than dropping the memory.
    if [ -n "${ML_ACTOR:-}" ] && [ -n "$description" ]; then
      desc_hash=$(printf '%s' "$description" | shasum -a 256 | cut -d' ' -f1)
      prev_desc_hash=""
      [ -f "$state_file" ] && prev_desc_hash=$(jq -r '.desc_hash // empty' "$state_file" 2>/dev/null)
      if [ "$desc_hash" = "$prev_desc_hash" ]; then
        # The body changed but the statement did not (a Why/How touch-up).
        # Nothing new to say to the fact store; just remember the new file
        # hash so the next unchanged rewrite short-circuits earlier.
        jq -n --arg hash "$hash" --arg dh "$desc_hash"             --arg fid "$(jq -r '.fact_id // empty' "$state_file" 2>/dev/null)"           '{hash: $hash, kind: "fact", fact_id: $fid, desc_hash: $dh}' >"$state_file" 2>/dev/null
        exit 0
      fi
      fact_id=$("$CLI" fact add --workspace "$ML_WORKSPACE" --actor "$ML_ACTOR"           "$description" 2>/dev/null         | jq -r '(.facts // [])[0].id // empty' 2>/dev/null)
      [ -n "$fact_id" ] || fail "storing the fact failed"
      jq -n --arg hash "$hash" --arg fid "$fact_id" --arg dh "$desc_hash"         '{hash: $hash, kind: "fact", fact_id: $fid, desc_hash: $dh}' >"$state_file" 2>/dev/null
      exit 0
    fi
    ;;
esac

# ---------- ensure the ML project exists -------------------------------------

project_id=""
[ -f "$sync_dir/project_id" ] && project_id=$(cat "$sync_dir/project_id" 2>/dev/null)

# Create-first, not get-first: with the state cache above, reaching this point
# usually means the project does not exist yet, so a lookup would be a wasted
# round trip on the path that is already the slowest (the first sync ever ran
# into the hook timeout on a slow network — every round trip here counts).
# When the project does exist — cache lost, or a concurrent hook won the
# creation race (custom ids are unique per workspace) — create fails and the
# lookup below recovers.
if [ -z "$project_id" ]; then
  project_id=$("$CLI" project create --workspace "$ML_WORKSPACE" \
      --name "$display_name" --custom-id "$custom_id" 2>/dev/null \
    | jq -r '.id // empty' 2>/dev/null)
  if [ -n "$project_id" ]; then
    # The visible-project cache predates this project; left alone it would
    # make every recall filter the new project OUT until the TTL expires
    # (measured: the fresh document was simply unfindable).
    rm -f "$(ml_data_dir)/projects/${ML_WORKSPACE}.txt" 2>/dev/null
  else
    project_id=$("$CLI" project get --workspace "$ML_WORKSPACE" "$custom_id" --by-custom-id 2>/dev/null \
      | jq -r '.id // empty' 2>/dev/null)
  fi
fi
[ -n "$project_id" ] || fail "could not resolve or create ML project \"$custom_id\""
printf '%s' "$project_id" >"$sync_dir/project_id" 2>/dev/null

# ---------- ensure the Library folder exists ----------------------------------

# One NEUTRAL folder name per repo, shared with the Codex harness: both sync
# paths key their folder_id cache on the same sync/<ws>/<custom_id>/ file, so
# whichever harness creates the folder first names it for both — a
# harness-specific name here would end up holding the other harness's files.
folder_name="memory--$(ml_cid_slug "$custom_id")"
folder_id=""
[ -f "$sync_dir/folder_id" ] && folder_id=$(cat "$sync_dir/folder_id" 2>/dev/null)

# mkdir-first for the same reason as create-first above: on the cold path the
# folder usually does not exist, and deny turns "already there" into a cheap
# failure the listing below recovers from.
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

# Background success owes no report.
exit 0
