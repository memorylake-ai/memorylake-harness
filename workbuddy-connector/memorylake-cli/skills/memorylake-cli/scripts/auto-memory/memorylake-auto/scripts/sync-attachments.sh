#!/usr/bin/env bash
# Stop (async) -- upload the files the user attached this turn to MemoryLake.
#
# Off unless the config says `sync_attachments: true` (see
# ml_wb_attachments_allowed). Each file goes into a per-project Library
# folder and is imported into the same MemoryLake project the session's
# conversation is filed under, so it is searchable next to what was said
# about it.
#
# Where the files come from -- WorkBuddy keeps no upload directory, and the
# UserPromptSubmit payload does not mention attachments at all (the host
# context is stripped from it). Both kinds are therefore read here, at Stop,
# from the session transcript, whose user messages are stored in full:
#
#   - Documents (dropped, picked, or @-mentioned) stay where they are; the
#     message's hidden context lists their paths (ml_wb_attached_files).
#   - Images (dropped, pasted, screenshots) are compressed by WorkBuddy and
#     stored content-addressed under ~/.workbuddy/blobs/; the message holds
#     an `image_blob_ref` item pointing at the file.
#   - Cloud attachments (Tencent drive, Lexiang, ima) have no local file and
#     are not synced.
#
# Only transcript lines added since the last run are scanned
# (attachments.offset), so a file is picked up on the turn it was attached
# and not re-read on every later one. What is found goes through a queue
# (attachments.jsonl) so that a failed upload is retried after the next turn.
#
# What is uploaded is filtered twice: by extension (documents and pictures
# only, ml_wb_attachment_ext_ok) and by size (sync_attachments_max_mb,
# default 20). Everything skipped is named in attachments.json.
#
# Idempotent by content: a file's SHA-256 is recorded once it is imported,
# so the same file attached again, in any session, is not sent twice. The
# same PATH with new content is an update: the Library file is overwritten
# and the document re-imported (overwriting alone does not re-index --
# measured 2026-08-07, see the Claude Code harness's sync-on-write.sh).
#
# Failures stay queued and go out after the next turn. The hook always exits
# 0 for the same reason sync-turn.sh does.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || printf '{}')

# Detach; see sync-turn.sh for why this line, and not hooks.json, does it.
printf '%s\n' '{"async":true,"asyncTimeout":180000}'

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)

ml_load_config "${cwd:-$PWD}" || exit 0
[ -n "$session_id" ] || exit 0

dir=$(ml_wb_session_dir "$session_id")
queue="$dir/attachments.jsonl"
draining="$dir/attachments.draining"
status_file="$dir/attachments.json"

allowed=""
ml_wb_attachments_allowed "${cwd:-$PWD}" && allowed=1
# The switch governs uploads, not queueing: turned off mid-session, paths
# queued earlier are dropped rather than sent later.
if [ -z "$allowed" ]; then
  rm -f "$queue" "$draining" 2>/dev/null
  exit 0
fi
mkdir -p "$dir" 2>/dev/null || exit 0

has_transcript=""
[ -n "$transcript" ] && [ -f "$transcript" ] && has_transcript=1
[ -s "$queue" ] || [ -s "$draining" ] || [ -n "$has_transcript" ] || exit 0

# ---------- one run at a time per session ----------------------------------------

lock="$dir/attachments.lock"
if ! mkdir "$lock" 2>/dev/null; then
  now=$(date +%s)
  mtime=$(stat -c %Y "$lock" 2>/dev/null || stat -f %m "$lock" 2>/dev/null || printf '0')
  [ $((now - mtime)) -gt 180 ] || exit 0
  rmdir "$lock" 2>/dev/null
  mkdir "$lock" 2>/dev/null || exit 0
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT

uploaded=0
unchanged=0
skipped='[]'
failed=""
record() {
  # $1 = ok|error, $2 = detail
  local pending
  pending=$(cat "$queue" "$draining" 2>/dev/null | grep -c . || true)
  jq -n --arg state "$1" --arg detail "${2:-}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson uploaded "$uploaded" --argjson unchanged "$unchanged" \
      --argjson skipped "$skipped" --argjson pending "${pending:-0}" \
      '{last_state: $state, last_detail: $detail, last_at: $at, uploaded: $uploaded,
        unchanged: $unchanged, skipped: $skipped, pending: $pending}' \
    >"$status_file.tmp" 2>/dev/null && mv -f "$status_file.tmp" "$status_file" 2>/dev/null
}
skip() {
  # $1 = path, $2 = reason
  skipped=$(printf '%s' "$skipped" | jq -c --arg p "$1" --arg r "$2" '. + [{path: $p, reason: $r}]' 2>/dev/null \
    || printf '%s' "$skipped")
}

# ---------- scan the new part of the transcript ----------------------------------

# Under the lock: two runs reading the same offset would queue a file twice.
if [ -n "$has_transcript" ]; then
  total=$(wc -l <"$transcript" 2>/dev/null | tr -d ' ')
  case "$total" in ''|*[!0-9]*) total=0 ;; esac
  offset=$(cat "$dir/attachments.offset" 2>/dev/null)
  case "$offset" in ''|*[!0-9]*) offset=0 ;; esac
  # A transcript shorter than what was scanned has been rewritten (a
  # compaction): start over; the content hash keeps that from re-sending.
  [ "$offset" -le "$total" ] || offset=0
  if [ "$total" -gt "$offset" ]; then
    new_lines=$(tail -n "+$((offset + 1))" "$transcript" 2>/dev/null | head -n "$((total - offset))")
    # Images: items of the user message itself.
    printf '%s\n' "$new_lines" | jq -c --arg cwd "${cwd:-$PWD}" '
        select(type == "object" and .type == "message" and .role == "user")
        | (.content // []) | if type == "array" then .[] else empty end
        | select(type == "object" and .type == "image_blob_ref" and (.blob_path // "") != "")
        | {path: .blob_path, name: (.original_filename // ""), blob: true, cwd: $cwd}
      ' 2>/dev/null >>"$queue"
    # Documents: paths in the hidden context of the message text. Each
    # message is base64'd onto one line so its newlines survive the loop.
    printf '%s\n' "$new_lines" | jq -r '
        select(type == "object" and .type == "message" and .role == "user")
        | (.content // [])
        | if type == "string" then . else ([.[]? | select(type == "object" and .type == "input_text") | .text // ""] | join("\n")) end
        | select(test("<user_references>|<attached_files>"))
        | @base64
      ' 2>/dev/null | while IFS= read -r b64; do
        [ -n "$b64" ] || continue
        printf '%s' "$b64" | jq -Rr '@base64d' 2>/dev/null | ml_wb_attached_files | while IFS= read -r path; do
          [ -n "$path" ] || continue
          jq -cn --arg path "$path" --arg cwd "${cwd:-$PWD}" '{path: $path, name: "", blob: false, cwd: $cwd}'
        done
      done >>"$queue"
    printf '%s' "$total" >"$dir/attachments.offset" 2>/dev/null
  fi
fi
if ! [ -s "$queue" ] && ! [ -s "$draining" ]; then
  rm -f "$queue" 2>/dev/null
  exit 0
fi

CLI=$(ml_cli) || { record error "memorylake CLI not installed"; exit 0; }

max_mb="${ML_SYNC_ATTACHMENTS_MAX_MB:-}"
case "$max_mb" in ''|*[!0-9]*) max_mb=20 ;; esac
max_bytes=$((max_mb * 1024 * 1024))

# ---------- project and Library folder (resolved on first real upload) -----------

ws_dir="$(ml_data_dir)/sync/${ML_WORKSPACE}"
project_id=""
folder_id=""
att_dir=""
resolve_target() {
  # $1 = the directory the turn worked in. Returns non-zero with $failed set.
  [ -n "$project_id" ] && [ -n "$folder_id" ] && return 0
  local where="$1" custom_id display_name proj_dir folder_name
  custom_id=$(ml_wb_project_identity "$where")
  display_name=$(ml_wb_project_display "$where")
  proj_dir="$ws_dir/$(ml_cid_slug "$custom_id")"
  att_dir="$proj_dir/attachments"
  mkdir -p "$att_dir" 2>/dev/null

  # Same project, same cache file, and same create-first order as
  # sync-turn.sh, which may be resolving it at this very moment: custom ids
  # are unique per workspace, so the loser of that race falls to the lookup.
  [ -f "$proj_dir/project_id" ] && project_id=$(cat "$proj_dir/project_id" 2>/dev/null)
  if [ -z "$project_id" ]; then
    project_id=$("$CLI" project create --workspace "$ML_WORKSPACE" \
        --name "$display_name" --custom-id "$custom_id" 2>/dev/null | jq -r '.id // empty' 2>/dev/null)
    if [ -n "$project_id" ]; then
      rm -f "$(ml_data_dir)/projects/${ML_WORKSPACE}.txt" 2>/dev/null
    else
      project_id=$("$CLI" project get --workspace "$ML_WORKSPACE" "$custom_id" --by-custom-id 2>/dev/null \
        | jq -r '.id // empty' 2>/dev/null)
    fi
  fi
  [ -n "$project_id" ] || { failed="could not resolve or create project \"$custom_id\""; return 1; }
  printf '%s' "$project_id" >"$proj_dir/project_id" 2>/dev/null

  # A folder of its own, apart from the memory--<project> folder the Claude
  # Code and Codex harnesses share: those hold files the model wrote, these
  # are the user's originals.
  folder_name="attachments--$(ml_cid_slug "$custom_id")"
  [ -f "$proj_dir/attachments_folder_id" ] && folder_id=$(cat "$proj_dir/attachments_folder_id" 2>/dev/null)
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
  [ -n "$folder_id" ] || { failed="could not resolve or create the Library folder \"$folder_name\""; return 1; }
  printf '%s' "$folder_id" >"$proj_dir/attachments_folder_id" 2>/dev/null
  return 0
}

# ---------- one file ---------------------------------------------------------------

# Returns 0 when the file is dealt with (uploaded, unchanged, or skipped for
# good) and 1 when it should be tried again; $failed then holds the reason.
sync_file() {
  local path="$1" name="$2" where="$3" is_blob="$4"
  local size hash key state prev_hash="" prev_doc="" stored_name="" out item_id doc_id result

  [ -n "$name" ] || name="${path##*/}"
  ml_wb_attachment_ext_ok "$name" || { skip "$path" "file type not synced"; return 0; }
  # Gone, a directory, or unreadable: nothing a retry would fix.
  { [ -f "$path" ] && [ -r "$path" ]; } || { skip "$path" "not a readable file"; return 0; }
  size=$(wc -c <"$path" 2>/dev/null | tr -d ' ')
  [ -n "$size" ] || { skip "$path" "not a readable file"; return 0; }
  [ "$size" -gt 0 ] || { skip "$path" "empty file"; return 0; }
  [ "$size" -le "$max_bytes" ] || { skip "$path" "larger than ${max_mb} MB"; return 0; }

  resolve_target "$where" || return 1

  hash=$(ml_wb_sha256 "$path")
  [ -n "$hash" ] || { failed="could not hash $path"; return 1; }
  # Content already imported into this project, from any path or session.
  if [ -f "$att_dir/sha-$hash" ]; then
    unchanged=$((unchanged + 1))
    return 0
  fi

  # A blob is content-addressed and never changes, so only real paths have
  # an update story.
  key=$(printf '%s' "$path" | ml_wb_sha256)
  state="$att_dir/path-$key.json"
  if [ -z "$is_blob" ] && [ -f "$state" ]; then
    prev_hash=$(jq -r '.hash // empty' "$state" 2>/dev/null)
    prev_doc=$(jq -r '.doc_id // empty' "$state" 2>/dev/null)
    stored_name=$(jq -r '.name // empty' "$state" 2>/dev/null)
  fi

  if [ -n "$stored_name" ]; then
    # Known path, new content: replace the file we stored for it earlier.
    out=$("$CLI" lib upload "$path" --parent "$folder_id" --name "$stored_name" \
        --on-conflict overwrite 2>&1)
  else
    # New path: let the server rename on a clash, so two different
    # report.pdf files never overwrite each other.
    out=$("$CLI" lib upload "$path" --parent "$folder_id" --name "$name" \
        --on-conflict rename 2>&1)
  fi
  item_id=$(printf '%s' "$out" | jq -r '.item_id // empty' 2>/dev/null)
  if [ -z "$item_id" ]; then
    failed="upload of ${name} failed: $(printf '%s' "$out" | tail -n 2 | tr '\n' ' ' | cut -c1-200)"
    return 1
  fi
  [ -n "$stored_name" ] || stored_name=$(printf '%s' "$out" | jq -r '.name // empty' 2>/dev/null)
  [ -n "$stored_name" ] || stored_name="$name"

  # Overwriting does not re-index: the old document has to go first.
  if [ -n "$prev_doc" ]; then
    "$CLI" project document delete --workspace "$ML_WORKSPACE" --project "$project_id" \
      "$prev_doc" >/dev/null 2>&1
  fi
  out=$("$CLI" project document import --workspace "$ML_WORKSPACE" --project "$project_id" \
      "$item_id" 2>/dev/null)
  result=$(printf '%s' "$out" | jq -r '(.details // [])[0].result // empty' 2>/dev/null)
  doc_id=$(printf '%s' "$out" | jq -r '(.details // [])[0].document_id // empty' 2>/dev/null)
  if [ "$result" = "duplicate" ] && [ -n "$doc_id" ] && [ -n "$prev_hash" ]; then
    # The delete above had a stale id; a duplicate import keeps the OLD
    # content indexed, so drop the document it names and import again.
    "$CLI" project document delete --workspace "$ML_WORKSPACE" --project "$project_id" \
      "$doc_id" >/dev/null 2>&1
    doc_id=$("$CLI" project document import --workspace "$ML_WORKSPACE" --project "$project_id" \
        "$item_id" 2>/dev/null \
      | jq -r '(.details // [])[0].document_id // empty' 2>/dev/null)
  fi
  if [ -z "$doc_id" ]; then
    # The file is in the Library; remember where, so the retry overwrites it
    # instead of uploading a second copy.
    [ -n "$is_blob" ] || jq -n --arg item "$item_id" --arg name "$stored_name" \
        '{hash: "", item_id: $item, doc_id: "", name: $name}' >"$state" 2>/dev/null
    failed="import of ${name} into the project failed"
    return 1
  fi

  [ -n "$is_blob" ] || jq -n --arg hash "$hash" --arg item "$item_id" --arg doc "$doc_id" --arg name "$stored_name" \
      '{hash: $hash, item_id: $item, doc_id: $doc, name: $name}' >"$state" 2>/dev/null
  : >"$att_dir/sha-$hash" 2>/dev/null
  uploaded=$((uploaded + 1))
  return 0
}

# ---------- drain ------------------------------------------------------------------

# Queue out of the way first, as in sync-turn.sh: the next turn may append
# while this runs. A draining file from a killed run is finished first --
# whatever it already sent is recognised by its hash.
if [ -s "$queue" ] && mv -f "$queue" "$queue.taken" 2>/dev/null; then
  cat "$queue.taken" >>"$draining" 2>/dev/null && rm -f "$queue.taken" 2>/dev/null
fi
remaining="$dir/attachments.remaining"
: >"$remaining"
first_failure=""
seen=$'\n'
if [ -s "$draining" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    path=$(printf '%s' "$line" | jq -r '.path // empty' 2>/dev/null)
    name=$(printf '%s' "$line" | jq -r '.name // empty' 2>/dev/null)
    where=$(printf '%s' "$line" | jq -r '.cwd // empty' 2>/dev/null)
    is_blob=$(printf '%s' "$line" | jq -r 'if .blob == true then "1" else "" end' 2>/dev/null)
    [ -n "$path" ] || continue
    # The same file mentioned on several turns is one file.
    case "$seen" in *$'\n'"$path"$'\n'*) continue ;; esac
    seen="$seen$path"$'\n'
    # A pasted image has no name of its own; the blob's is its hash.
    if [ -n "$is_blob" ] && [ -z "$name" ]; then
      name="image-$(printf '%s' "${path##*/}" | cut -c1-12).${path##*.}"
    fi
    failed=""
    if ! sync_file "$path" "$name" "${where:-${cwd:-$PWD}}" "$is_blob"; then
      printf '%s\n' "$line" >>"$remaining"
      [ -n "$first_failure" ] || first_failure="$failed"
    fi
  done <"$draining"
fi

# Leftovers ahead of whatever was queued meanwhile.
{ cat "$remaining" 2>/dev/null; [ -f "$queue" ] && cat "$queue" 2>/dev/null; } >"$queue.tmp"
if [ -s "$queue.tmp" ]; then
  mv -f "$queue.tmp" "$queue" 2>/dev/null || exit 0
else
  rm -f "$queue.tmp" "$queue" 2>/dev/null
fi
rm -f "$remaining" "$draining" 2>/dev/null

if [ -n "$first_failure" ]; then
  record error "$first_failure"
else
  record ok "synced"
fi
exit 0
