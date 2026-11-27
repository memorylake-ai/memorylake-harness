#!/usr/bin/env node
// Runs one hook of MemoryLake's automatic memory in WorkBuddy:
//
//   node hook.mjs session-start|prompt-submit|recall-gate|sync-turn|sync-attachments
//
// WorkBuddy pipes the hook's JSON payload to stdin and reads our answer from
// stdout. Every hook exits 0 whatever happens: a failing Stop hook pushes its
// error into the conversation and makes the model keep talking, and a failing
// PreToolUse hook would block the tool. What went wrong goes to a log file
// instead (<data dir>/logs/workbuddy-hooks.log).
//
// The two Stop hooks do only what is quick and local (queue the reply, note
// where the session works) and leave the upload to `node hook.mjs run ...`,
// started on its own (see inBackground in lib/common.mjs). Session start does
// the same with `flush`, which sends whatever earlier sessions left queued.
//
// Whether these hooks should act at all is the packaging's to say (standDown
// in lib/host.mjs).
import fs from "node:fs";
import path from "node:path";
import { ageSeconds, dataDir, inBackground, lock, mkdirp, readJson, recalledSession, rememberSession, sessionDir, stateDir } from "./lib/common.mjs";
import { standDown } from "./lib/host.mjs";
import { promptSubmit } from "./lib/prompt-submit.mjs";
import { recallGate } from "./lib/recall-gate.mjs";
import { sessionStart } from "./lib/session-start.mjs";
import { attachmentsDue, attachmentsPending, syncAttachments } from "./lib/sync-attachments.mjs";
import { queueTurn, syncTurn, turnPending } from "./lib/sync-turn.mjs";

const HOOKS = {
  "session-start": sessionStart,
  "prompt-submit": promptSubmit,
  "recall-gate": recallGate,
};

// Stop hooks: the quick part, which says whether there is anything to
// upload, and the upload itself.
const STOP = {
  "sync-turn": { due: queueTurn, upload: syncTurn, pending: turnPending, status: "sync.json" },
  "sync-attachments": { due: attachmentsDue, upload: syncAttachments, pending: attachmentsPending, status: "attachments.json" },
};

// Sessions untouched this long are not retried by flush any more.
const FLUSH_DAYS = 14;

function log(name, error) {
  try {
    const dir = path.join(dataDir(), "logs");
    mkdirp(dir);
    fs.appendFileSync(path.join(dir, "workbuddy-hooks.log"), `${new Date().toISOString()} ${name}: ${error?.stack || error}\n`);
  } catch {}
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The upload of one Stop hook. A turn that ended meanwhile was refused the lock; its messages go too. */
function run(job, sessionId) {
  const stop = STOP[job];
  if (!stop || !sessionId) return;
  for (let round = 0; round < 3; round++) {
    stop.upload(recalledSession(sessionId));
    if (!stop.pending(sessionId)) break;
    // Failed: the next turn or session tries again.
    if (readJson(path.join(sessionDir(sessionId), stop.status))?.last_state !== "ok") break;
  }
}

/** Send what earlier sessions left queued: their uploads were cut short, or failed. */
function flush() {
  const release = lock(path.join(stateDir(), "workbuddy-flush.lock"), 600);
  if (!release) return;
  const root = path.join(stateDir(), "workbuddy");
  let sessions = [];
  try {
    sessions = fs.readdirSync(root);
  } catch {}
  for (const session of sessions) {
    if (ageSeconds(path.join(root, session)) > FLUSH_DAYS * 86400) continue;
    for (const [job, stop] of Object.entries(STOP)) {
      try {
        if (stop.pending(session)) stop.upload(recalledSession(session));
      } catch (error) {
        log(`flush ${job} ${session}`, error);
      }
    }
  }
  release();
}

const name = process.argv[2];
try {
  if (standDown()) {
    // Standing down.
  } else if (HOOKS[name] || STOP[name]) {
    let input = {};
    try {
      const parsed = JSON.parse(await readStdin());
      if (parsed && typeof parsed === "object") input = parsed;
    } catch {}
    if (HOOKS[name]) {
      const output = await HOOKS[name](input);
      if (output) process.stdout.write(JSON.stringify(output) + "\n");
      if (name === "session-start" && fs.existsSync(path.join(stateDir(), "workbuddy"))) inBackground(["flush"]);
    } else if (STOP[name].due(input)) {
      rememberSession(input);
      if (!inBackground(["run", name, input.session_id])) log(name, "could not start the upload");
    }
  } else if (name === "run") {
    run(process.argv[3], process.argv[4]);
  } else if (name === "flush") {
    flush();
  } else {
    log(name, "unknown hook");
  }
} catch (error) {
  log(name, error);
}
process.exitCode = 0;
