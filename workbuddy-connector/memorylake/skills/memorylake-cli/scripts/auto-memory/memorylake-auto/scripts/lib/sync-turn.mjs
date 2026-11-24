// Stop (async): append the finished turn to a MemoryLake conversation.
//
// One MemoryLake conversation per WorkBuddy session (custom id
// workbuddy:<session_id>); the server distills memories from it. What goes
// over the wire:
//
//   - TEXT only: what the user typed (WorkBuddy's additions removed, see
//     cleanPrompt) and the assistant's final reply. Tool calls, tool output
//     and thinking stay on this computer. Attached files are a separate,
//     opt-in upload (sync-attachments).
//   - Two actors: the user's messages as the configured actor; the
//     assistant's as an actor created once per workspace (custom id
//     workbuddy-agent).
//   - Idempotent: every message carries a custom id derived from its turn,
//     so a retry never duplicates it.
//
// Messages that did not land stay in the session's outbox and go out with
// the next turn; the outcome is recorded in sync.json.
//
// The conversation is filed under the project of the folder the session
// works in, by the rule every harness uses (git remote, else path), so all
// clients meet in one project per repository or folder. Chats started without
// a folder all share the single "WorkBuddy" project.
import fs from "node:fs";
import path from "node:path";
import {
  clip, cliJson, findCli, hasContent, isFile, lines, loadConfig, lock, mkdirp, readJson, readText, remove,
  resolveProject, runCli, safeId, sessionDir, tailLine, utcNow, workspaceDir, writeAtomic,
} from "./common.mjs";

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return {};
  }
};

export function syncTurn(input) {
  const cwd = input.cwd || process.cwd();
  const config = loadConfig(cwd);
  const sessionId = input.session_id;
  if (!config || !sessionId) return;

  const dir = sessionDir(sessionId);
  const outbox = path.join(dir, "outbox.jsonl");
  const draining = path.join(dir, "outbox.draining");
  // Nothing queued: sync is off for this session (prompt-submit only queues
  // when it is allowed), or the prompt was empty.
  if (!hasContent(outbox) && !hasContent(draining)) return;

  const statusFile = path.join(dir, "sync.json");
  let conversationId = "";
  const record = (state, detail = "") => {
    const pending = lines(draining).length + lines(outbox).length;
    const conversation = conversationId || readJson(statusFile)?.conversation_id || "";
    writeAtomic(statusFile, JSON.stringify({ conversation_id: conversation, last_state: state, last_detail: detail, last_at: utcNow(), pending }, null, 2) + "\n");
  };
  const queued = () => readText(outbox) + readText(draining);

  // ---------- queue the assistant's reply ----------
  const turnId = readJson(path.join(dir, "turn.json"))?.id || "";
  const reply = String(input.last_assistant_message ?? "").replace(/\n+$/, "");
  if (turnId && reply && !queued().includes(`"wb:${turnId}:assistant"`)) {
    const message = { id: `wb:${turnId}:assistant`, side: "assistant", text: clip(reply, 8000), timestamp: utcNow() };
    try {
      fs.appendFileSync(outbox, JSON.stringify(message) + "\n");
    } catch {}
  }

  // ---------- one sync at a time per session ----------
  const release = lock(path.join(dir, "sync.lock"));
  if (!release) return;

  if (!findCli()) return record("error", "memorylake CLI not installed");
  if (!config.actor) return record("error", "no actor in the MemoryLake config");

  // ---------- identities (cached per workspace) ----------
  const wsDir = workspaceDir(config);
  mkdirp(wsDir);
  const actorFile = path.join(wsDir, "workbuddy-assistant-actor");
  let assistant = readText(actorFile);
  if (!assistant) {
    assistant = cliJson(["actor", "get", "--by-custom-id", "workbuddy-agent"])?.id
      || cliJson(["actor", "create", "--custom-id", "workbuddy-agent", "--display-name", "WorkBuddy"])?.id || "";
    if (!assistant) return record("error", "could not resolve or create the WorkBuddy assistant actor");
    // Binding an actor that is already bound is refused; not our failure.
    runCli(["actor", "bind", "--actor", assistant, "--workspace", config.workspace]);
    writeAtomic(actorFile, assistant);
  }

  // ---------- conversation ----------
  conversationId = readJson(statusFile)?.conversation_id || "";
  if (!conversationId) {
    const conversationCid = `workbuddy:${safeId(sessionId)}`;
    conversationId = cliJson(["conversation", "get", "--workspace", config.workspace, "--by-custom-id", conversationCid])?.id || "";
    if (!conversationId) {
      const first = parse((lines(draining)[0] ?? lines(outbox)[0]) || "{}");
      const project = resolveProject(config, first.cwd || cwd);
      if (project.error) return record("error", project.error);
      const title = clip(String(first.text ?? "").replace(/\n/g, " ").trim(), 60);
      conversationId = cliJson([
        "conversation", "create", "--workspace", config.workspace,
        "--custom-id", conversationCid, "--project", project.id, "--actors", `${config.actor},${assistant}`,
        "--name", `WorkBuddy: ${title || `session ${String(sessionId).slice(0, 8)}`}`,
        "--metadata", "harness=workbuddy", "--metadata", `session=${sessionId}`,
      ])?.id || "";
      if (!conversationId) return record("error", "could not create the conversation");
    }
  }
  record("ok", "conversation ready");

  // ---------- drain the outbox ----------
  // The queue goes out of the way first: the next turn's prompt-submit may
  // append to outbox.jsonl meanwhile, and those lines must survive. A
  // draining file left by a crashed run is finished before anything new.
  if (!hasContent(draining)) {
    try {
      fs.renameSync(outbox, draining);
    } catch {}
  }
  const remaining = [];
  let failed = "";
  for (const line of lines(draining)) {
    if (failed) {
      remaining.push(line);
      continue;
    }
    const message = parse(line);
    if (!message.id || !message.text) continue;
    const actor = message.side === "assistant" ? assistant : config.actor;
    // --workspace is needed although the CLI's help says it is only for
    // --wait: without --parent, append looks up the conversation's latest
    // message, and that lookup needs a workspace.
    const result = runCli([
      "conversation", "message", "append", "--workspace", config.workspace,
      "--actor", actor, "--custom-id", message.id, "--text", message.text,
      ...(message.timestamp ? ["--timestamp", message.timestamp] : []),
      "--metadata", `role=${message.side ?? ""}`, "--metadata", "harness=workbuddy",
      "--", conversationId,
    ]);
    if (result.code === 0) continue;
    // An id the server already has is a replay of a message that landed
    // before a crash: done, not failed.
    if (/already[\s\S]*exist|duplicate|conflict|409/.test(result.stderr)) continue;
    failed = tailLine(result.stderr, 3, 300);
    remaining.push(line);
  }

  // Leftovers go back AHEAD of whatever was queued meanwhile, in order.
  const rest = remaining.map((line) => line + "\n").join("") + readText(outbox);
  if (rest) {
    // Could not put the queue back: keep draining for the next run.
    if (!writeAtomic(outbox, rest)) return;
  } else {
    remove(outbox);
  }
  remove(draining);
  record(failed ? "error" : "ok", failed ? `append failed: ${failed}` : "synced");
  release();
}
