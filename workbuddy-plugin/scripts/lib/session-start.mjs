// SessionStart: standing instructions plus a status line.
//
// WorkBuddy puts this into the session's first message (and again after a
// compaction), so it does the job of the system-prompt section a plugin
// cannot otherwise add: what MemoryLake is, how it differs from WorkBuddy's
// own memory files, and the rule that every turn starts with a search. The
// per-turn reminder (prompt-submit) and the gate (recall-gate) enforce it.
//
// It also says when memory is NOT usable. Without that, an unreachable
// backend looks exactly like "you never told me that".
import path from "node:path";
import {
  ageSeconds, attachmentsAllowed, cliJson, dataDir, findCli, flagEnabled, loadConfig, mkdirp, readText,
  syncDenied, writeAtomic,
} from "./common.mjs";
import { NO_CLI, REPAIR, notSetUp } from "./host.mjs";

const context = (text) => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });

export function sessionStart(input) {
  const cwd = input.cwd || process.cwd();

  // Not configured: one line pointing at setup. Not silent: connecting is an
  // explicit act, and a memory that says nothing looks like a working one.
  const config = loadConfig(cwd);
  if (!config) {
    return context(`MemoryLake (the user's cross-device long-term memory) is installed but not set up on this machine, so recall and conversation sync are off. ${notSetUp()}`);
  }
  if (!findCli()) {
    return context(`MemoryLake: the 'memorylake' CLI is not installed, so memory recall is UNAVAILABLE this session and conversations are not being synced. Do not treat missing recall results as 'no such memory'. ${NO_CLI}`);
  }

  // The cache holds DATA (the project count), never a rendered line: the
  // tree is shared with the other harnesses, whose lines name other commands.
  const cacheFile = path.join(dataDir(), "status", `${config.workspace}.txt`);
  let projects = "";
  if (ageSeconds(cacheFile) < 600) {
    projects = readText(cacheFile);
    if (!/^\d+$/.test(projects)) projects = "";
  }
  if (!projects) {
    const listed = cliJson(["project", "list", "--workspace", config.workspace]);
    if (!listed || typeof listed !== "object") {
      return context(`MemoryLake: workspace ${config.workspace} is unreachable (not logged in, or the network is down). Memory recall is UNAVAILABLE this session -- if a search returns nothing, say the memory backend could not be reached rather than concluding the memory does not exist. If it stays that way, ${REPAIR}.`);
    }
    projects = String(Array.isArray(listed.items) ? listed.items.length : 0);
    if (mkdirp(path.dirname(cacheFile))) writeAtomic(cacheFile, projects);
  }

  let syncLine;
  if (config.syncConversations && flagEnabled(config.syncConversations) && !syncDenied(config, cwd)) {
    syncLine = "Writing: this conversation (the user's messages and your final replies -- never tool calls or tool output) is appended to MemoryLake automatically after every turn, and memories are distilled from it on the server. Do not copy things into MemoryLake by hand.";
    if (attachmentsAllowed(config, cwd)) {
      syncLine += " Documents and images the user attaches to a message are uploaded too, as searchable documents; do not upload them yourself.";
    }
  } else {
    syncLine = "Writing: conversation sync is OFF for this session, so nothing said here reaches MemoryLake.";
  }

  return context(`MemoryLake: connected (workspace ${config.workspace}, ${projects} project(s)).

MemoryLake is the user's long-term memory across devices and apps -- other WorkBuddy machines, Claude Code, Codex, and more. It is separate from WorkBuddy's own memory files, which only cover this machine; keep maintaining those exactly as your instructions say.

Recall: search it with \`ml-recall "<query>"\` (Bash) at the start of every turn, before other tools and before replying -- each user message carries a reminder, and the first tool call of a turn that skipped the search is held back once. The memorylake-cli-recall skill covers query phrasing and reading results.

${syncLine}`);
}
