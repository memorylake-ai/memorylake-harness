// What differs between the two packagings of these hooks. Everything else
// under scripts/ and bin/ is the same file in both (workbuddy-plugin/dev/sync.mjs
// keeps it so); this one is each packaging's own.
//
// This is the connector's: the hooks are installed by its sign-in page, the
// CLI is the one WorkBuddy installed for the connector, and setting up means
// connecting the connector again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WORKBUDDY = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".workbuddy");

/** What the model is told to do when MemoryLake needs setting up again. */
export const REPAIR = "ask the user to reconnect the MemoryLake connector in WorkBuddy's connector list";

/** The same when there is no CLI to run. */
export const NO_CLI = `${REPAIR[0].toUpperCase()}${REPAIR.slice(1)} -- that installs the CLI and signs in.`;

/** What to say at session start on a computer where MemoryLake was never set up. */
export const notSetUp = () => "If the user asks about memory or MemoryLake, ask them to reconnect the MemoryLake connector in WorkBuddy's connector list.";

/**
 * The MemoryLake plugin for WorkBuddy does the same job with hooks of its
 * own. When it is enabled these stand down; otherwise every turn would be
 * reminded and synced twice.
 */
export function standDown() {
  try {
    return /"memorylake@memorylake"\s*:\s*true/.test(fs.readFileSync(path.join(WORKBUDDY, "settings.json"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Where to look for the CLI before PATH: WorkBuddy's own tools directory,
 * where the connector installs it (a hook's PATH may not include it, and an
 * older memorylake elsewhere must not win).
 */
export function cliDirs() {
  const tools = path.join(WORKBUDDY, "binaries", "node", "cli-connector-packages");
  return [process.platform === "win32" ? tools : path.join(tools, "bin")];
}
