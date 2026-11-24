// PreToolUse: the recall gate.
//
// Models routinely skip a reminder to search first. When the model reaches
// for a tool this turn without having searched, the FIRST such call is denied
// with an instruction to run ml-recall; WorkBuddy shows the model our reason
// as the tool's result.
//
// Once per turn on purpose: a second denial could trap a model that cannot
// search (CLI missing, backend down) in a loop. A reply that uses no tools is
// never gated. This runs before EVERY tool call, so the cases where it is not
// armed must return after a config read, one small JSON read and a stat.
import fs from "node:fs";
import path from "node:path";
import { exists, flagEnabled, isSearchCommand, loadConfig, readJson, sessionDir } from "./common.mjs";

const REASON = "MemoryLake first: this call was held back once because the user's long-term memory has not been searched this turn. Run `ml-recall \"<query built from the user's message>\"` now (2-3 differently-phrased searches for questions about the user or their past work), then retry this call -- it will go through. If the search reports UNAVAILABLE, continue without it and tell the user memory could not be reached.";

export async function recallGate(input) {
  const config = loadConfig(input.cwd || process.cwd());
  if (!config || !flagEnabled(config.recallGate) || !input.session_id) return null;

  // No turn state: a subagent (its own session id), or a session whose
  // prompt we never saw. Neither is ours to gate.
  const dir = sessionDir(input.session_id);
  const turnId = readJson(path.join(dir, "turn.json"))?.id;
  if (!turnId) return null;

  // Marker files, not fields in turn.json: parallel tool calls run their
  // hooks concurrently, and creating a file or a directory is atomic.
  const searched = path.join(dir, `searched.${turnId}`);
  const gated = path.join(dir, `gated.${turnId}`);
  if (exists(searched) || exists(gated)) return null;

  const tool = input.tool_name;
  if (tool === "Bash" && isSearchCommand(String(input.tool_input?.command ?? ""))) {
    try {
      fs.writeFileSync(searched, "");
    } catch {}
    return null;
  }
  // Loading a skill or a deferred tool's schema is preparation, not work.
  if (tool === "Skill" || tool === "ToolSearch") return null;

  // A search in the same parallel batch has its own hook running right now;
  // give it a moment to mark the turn before holding this call back for
  // nothing. Only the about-to-deny path pays this, once a turn.
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (exists(searched)) return null;

  // Exactly one denial per turn, however many calls race to this line.
  try {
    fs.mkdirSync(gated);
  } catch {
    return null;
  }
  return {
    reason: REASON,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON },
  };
}
