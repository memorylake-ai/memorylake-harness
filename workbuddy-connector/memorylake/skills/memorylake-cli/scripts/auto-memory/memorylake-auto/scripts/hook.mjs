#!/usr/bin/env node
// Runs one hook of the MemoryLake connector's automatic memory:
//
//   node hook.mjs session-start|prompt-submit|recall-gate|sync-turn|sync-attachments
//
// WorkBuddy pipes the hook's JSON payload to stdin and reads our answer from
// stdout. Every hook exits 0 whatever happens: a failing Stop hook pushes its
// error into the conversation and makes the model keep talking, and a failing
// PreToolUse hook would block the tool. What went wrong goes to a log file
// instead (<data dir>/logs/workbuddy-hooks.log).
//
// The MemoryLake plugin for WorkBuddy does the same job with hooks of its own. When
// it is enabled these stand down; otherwise every turn would be reminded and
// synced twice.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASYNC_LINE, dataDir, mkdirp } from "./lib/common.mjs";
import { promptSubmit } from "./lib/prompt-submit.mjs";
import { recallGate } from "./lib/recall-gate.mjs";
import { sessionStart } from "./lib/session-start.mjs";
import { syncAttachments } from "./lib/sync-attachments.mjs";
import { syncTurn } from "./lib/sync-turn.mjs";

const HOOKS = {
  "session-start": sessionStart,
  "prompt-submit": promptSubmit,
  "recall-gate": recallGate,
  // WorkBuddy ignores "async": true in hooks.json; it stops waiting for a
  // hook only when the hook's FIRST stdout line is {"async": true}. Without
  // it every turn's end waited for the upload (2.7 s to 16.6 s, measured).
  "sync-turn": syncTurn,
  "sync-attachments": syncAttachments,
};
const ASYNC = new Set(["sync-turn", "sync-attachments"]);

function log(name, error) {
  try {
    const dir = path.join(dataDir(), "logs");
    mkdirp(dir);
    fs.appendFileSync(path.join(dir, "workbuddy-hooks.log"), `${new Date().toISOString()} ${name}: ${error?.stack || error}\n`);
  } catch {}
}

function pluginEnabled() {
  const config = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".workbuddy");
  try {
    return /"memorylake@memorylake"\s*:\s*true/.test(fs.readFileSync(path.join(config, "settings.json"), "utf8"));
  } catch {
    return false;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const name = process.argv[2];
const hook = HOOKS[name];
try {
  if (hook && !pluginEnabled()) {
    let input = {};
    try {
      const parsed = JSON.parse(await readStdin());
      if (parsed && typeof parsed === "object") input = parsed;
    } catch {}
    if (ASYNC.has(name)) process.stdout.write(ASYNC_LINE + "\n");
    const output = await hook(input);
    if (output) process.stdout.write(JSON.stringify(output) + "\n");
  } else if (!hook) {
    log(name, "unknown hook");
  }
} catch (error) {
  log(name, error);
}
process.exitCode = 0;
