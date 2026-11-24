// Stop (async): upload the files the user attached this turn to MemoryLake.
//
// Off unless the config says `sync_attachments: true` (attachmentsAllowed).
// Each file goes into a per-project Library folder and is imported into the
// project the session's conversation is filed under, so it is searchable
// next to what was said about it.
//
// WorkBuddy keeps no upload directory, and the UserPromptSubmit payload does
// not mention attachments, so both kinds are read here from the session
// transcript, whose user messages are stored in full:
//
//   - Documents (dropped, picked, or @-mentioned) stay where they are; the
//     message's hidden context lists their paths (attachedFiles).
//   - Images (dropped, pasted, screenshots) are compressed by WorkBuddy and
//     stored under ~/.workbuddy/blobs/; the message holds an `image_blob_ref`
//     item pointing at the file.
//   - Cloud attachments have no local file and are not synced.
//
// Only transcript lines added since the last run are scanned
// (attachments.offset). What is found goes through a queue
// (attachments.jsonl), so a failed upload is retried after the next turn.
// Filtered by extension (attachmentExtOk) and size (sync_attachments_max_mb,
// default 20); everything skipped is named in attachments.json.
//
// Idempotent by content: a file's SHA-256 is recorded once it is imported,
// so the same file attached again, in any session, is not sent twice. The
// same PATH with new content is an update: the Library file is overwritten
// and the document imported again (overwriting alone does not re-index).
import fs from "node:fs";
import path from "node:path";
import {
  attachedFiles, attachmentExtOk, attachmentsAllowed, baseName, cidSlug, cliJson, exists, findCli, hasContent,
  isFile, lines, loadConfig, lock, mkdirp, readJson, readText, remove, resolveProject, runCli, sessionDir, sha256,
  sha256File, tailLine, utcNow, writeAtomic,
} from "./common.mjs";

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Queue entries for the attachments in new transcript lines. */
function scan(text, cwd) {
  const found = [];
  for (const line of text) {
    const entry = parse(line);
    if (!isObject(entry) || entry.type !== "message" || entry.role !== "user") continue;
    const content = entry.content ?? [];
    // Images: items of the user message itself.
    if (Array.isArray(content)) {
      for (const item of content) {
        if (isObject(item) && item.type === "image_blob_ref" && item.blob_path) {
          found.push({ path: item.blob_path, name: item.original_filename ?? "", blob: true, cwd });
        }
      }
    }
  }
  for (const line of text) {
    const entry = parse(line);
    if (!isObject(entry) || entry.type !== "message" || entry.role !== "user") continue;
    const content = entry.content ?? [];
    // Documents: paths in the hidden context of the message text.
    const message = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter((item) => isObject(item) && item.type === "input_text").map((item) => item.text ?? "").join("\n")
      : "";
    if (!/<user_references>|<attached_files>/.test(message)) continue;
    for (const file of attachedFiles(message)) found.push({ path: file, name: "", blob: false, cwd });
  }
  return found;
}

export function syncAttachments(input) {
  const cwd = input.cwd || process.cwd();
  const config = loadConfig(cwd);
  const sessionId = input.session_id;
  if (!config || !sessionId) return;

  const dir = sessionDir(sessionId);
  const queue = path.join(dir, "attachments.jsonl");
  const draining = path.join(dir, "attachments.draining");
  const statusFile = path.join(dir, "attachments.json");

  // The switch governs uploads, not queueing: turned off mid-session, paths
  // queued earlier are dropped rather than sent later.
  if (!attachmentsAllowed(config, cwd)) {
    remove(queue);
    remove(draining);
    return;
  }
  if (!mkdirp(dir)) return;
  const transcript = input.transcript_path && isFile(input.transcript_path) ? input.transcript_path : "";
  if (!hasContent(queue) && !hasContent(draining) && !transcript) return;

  // ---------- one run at a time per session ----------
  const release = lock(path.join(dir, "attachments.lock"));
  if (!release) return;

  let uploaded = 0;
  let unchanged = 0;
  const skipped = [];
  const record = (state, detail = "") => {
    const pending = lines(queue).length + lines(draining).length;
    writeAtomic(statusFile, JSON.stringify({ last_state: state, last_detail: detail, last_at: utcNow(), uploaded, unchanged, skipped, pending }, null, 2) + "\n");
  };
  const skip = (file, reason) => skipped.push({ path: file, reason });

  // ---------- scan the new part of the transcript ----------
  // Under the lock: two runs reading the same offset would queue a file twice.
  if (transcript) {
    const all = readText(transcript).split("\n");
    const total = all.length - 1; // complete lines only, as `wc -l` counts them
    let offset = Number(readText(path.join(dir, "attachments.offset")));
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    // A transcript shorter than what was scanned has been rewritten (a
    // compaction): start over; the content hash keeps that from re-sending.
    if (offset > total) offset = 0;
    if (total > offset) {
      const found = scan(all.slice(offset, total), cwd);
      if (found.length) {
        try {
          fs.appendFileSync(queue, found.map((entry) => JSON.stringify(entry) + "\n").join(""));
        } catch {}
      }
      writeAtomic(path.join(dir, "attachments.offset"), String(total));
    }
  }
  if (!hasContent(queue) && !hasContent(draining)) {
    remove(queue);
    return;
  }

  if (!findCli()) return record("error", "memorylake CLI not installed");

  const maxMb = /^\d+$/.test(config.syncAttachmentsMaxMb) ? Number(config.syncAttachmentsMaxMb) : 20;
  const maxBytes = maxMb * 1024 * 1024;

  // ---------- project and Library folder (resolved on the first real upload) ----------
  let target = null;
  let failed = "";
  const resolveTarget = (where) => {
    if (target) return true;
    const project = resolveProject(config, where);
    if (project.error) {
      failed = project.error;
      return false;
    }
    const attachmentsDir = path.join(project.dir, "attachments");
    mkdirp(attachmentsDir);
    // A folder of its own, apart from the memory--<project> folder the
    // Claude Code and Codex harnesses share: those hold files the model
    // wrote, these are the user's originals.
    const folderName = `attachments--${cidSlug(project.customId)}`;
    const folderFile = path.join(project.dir, "attachments_folder_id");
    let folder = readText(folderFile);
    if (!folder) {
      folder = cliJson(["lib", "mkdir", folderName, "--on-conflict", "deny"])?.item_id
        || (cliJson(["lib", "list", "MY_SPACE"])?.items ?? []).find((item) => item?.name === folderName && item?.type === "directory")?.item_id
        || "";
    }
    if (!folder) {
      failed = `could not resolve or create the Library folder "${folderName}"`;
      return false;
    }
    writeAtomic(folderFile, folder);
    target = { project: project.id, folder, dir: attachmentsDir };
    return true;
  };

  // ---------- one file ----------
  // True when the file is dealt with (uploaded, unchanged, or skipped for
  // good); false when it should be tried again, with `failed` saying why.
  const syncFile = (file, given, where, blob) => {
    const name = given || baseName(file);
    if (!attachmentExtOk(name)) return skip(file, "file type not synced"), true;
    // Gone, a directory, or unreadable: nothing a retry would fix.
    let size;
    try {
      fs.accessSync(file, fs.constants.R_OK);
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error("not a file");
      size = stat.size;
    } catch {
      return skip(file, "not a readable file"), true;
    }
    if (size === 0) return skip(file, "empty file"), true;
    if (size > maxBytes) return skip(file, `larger than ${maxMb} MB`), true;

    if (!resolveTarget(where)) return false;

    const hash = sha256File(file);
    if (!hash) {
      failed = `could not hash ${file}`;
      return false;
    }
    // Content already imported into this project, from any path or session.
    if (exists(path.join(target.dir, `sha-${hash}`))) {
      unchanged++;
      return true;
    }

    // A blob is content-addressed and never changes; only real paths can be updated.
    const stateFile = path.join(target.dir, `path-${sha256(file)}.json`);
    const previous = (!blob && readJson(stateFile)) || {};
    let stored = previous.name || "";

    // Known path, new content: replace the file stored for it earlier. New
    // path: let the server rename on a clash, so two different report.pdf
    // files never overwrite each other.
    const upload = runCli(["lib", "upload", file, "--parent", target.folder, "--name", stored || name, "--on-conflict", stored ? "overwrite" : "rename"]);
    const out = upload.stdout + upload.stderr;
    let item;
    try {
      item = JSON.parse(upload.stdout);
    } catch {}
    if (!item?.item_id) {
      failed = `upload of ${name} failed: ${tailLine(out, 2, 200)}`;
      return false;
    }
    stored = stored || item.name || name;

    const del = (doc) => runCli(["project", "document", "delete", "--workspace", config.workspace, "--project", target.project, doc]);
    const importItem = () => cliJson(["project", "document", "import", "--workspace", config.workspace, "--project", target.project, item.item_id])?.details?.[0] ?? {};
    // Overwriting does not re-index: the old document has to go first.
    if (previous.doc_id) del(previous.doc_id);
    let imported = importItem();
    let doc = imported.document_id || "";
    if (imported.result === "duplicate" && doc && previous.hash) {
      // The delete above had a stale id; a duplicate import keeps the OLD
      // content indexed, so drop the document it names and import again.
      del(doc);
      doc = importItem().document_id || "";
    }
    if (!doc) {
      // The file is in the Library; remember where, so the retry overwrites
      // it instead of uploading a second copy.
      if (!blob) writeAtomic(stateFile, JSON.stringify({ hash: "", item_id: item.item_id, doc_id: "", name: stored }, null, 2) + "\n");
      failed = `import of ${name} into the project failed`;
      return false;
    }
    if (!blob) writeAtomic(stateFile, JSON.stringify({ hash, item_id: item.item_id, doc_id: doc, name: stored }, null, 2) + "\n");
    writeAtomic(path.join(target.dir, `sha-${hash}`), "");
    uploaded++;
    return true;
  };

  // ---------- drain ----------
  // The queue goes out of the way first, as in sync-turn: the next turn may
  // append while this runs. A draining file from a killed run is finished
  // first; what it already sent is recognised by its hash.
  if (hasContent(queue)) {
    const taken = `${queue}.taken`;
    try {
      fs.renameSync(queue, taken);
      fs.appendFileSync(draining, readText(taken));
      remove(taken);
    } catch {}
  }
  const remaining = [];
  let firstFailure = "";
  const seen = new Set();
  for (const line of lines(draining)) {
    const entry = parse(line);
    if (!isObject(entry) || !entry.path) continue;
    const file = String(entry.path);
    // The same file mentioned on several turns is one file.
    if (seen.has(file)) continue;
    seen.add(file);
    const blob = entry.blob === true;
    let name = String(entry.name ?? "");
    // A pasted image has no name of its own; the blob's is its hash.
    if (blob && !name) name = `image-${Array.from(baseName(file)).slice(0, 12).join("")}.${file.split(".").pop()}`;
    failed = "";
    if (!syncFile(file, name, entry.cwd || cwd, blob)) {
      remaining.push(line);
      firstFailure ||= failed;
    }
  }

  // Leftovers ahead of whatever was queued meanwhile.
  const rest = remaining.map((line) => line + "\n").join("") + readText(queue);
  if (rest) {
    if (!writeAtomic(queue, rest)) return;
  } else {
    remove(queue);
  }
  remove(draining);
  record(firstFailure ? "error" : "ok", firstFailure || "synced");
  release();
}
