// What differs between the two packagings of these hooks. Everything else
// under scripts/ and bin/ is the connector's file, copied (dev/sync.mjs);
// this one is each packaging's own.
//
// This is the plugin's: it carries the hooks itself, has the CLI inside it
// (vendor/, put there when the plugin is built), and sets MemoryLake up
// through a sign-in page of its own (scripts/connect.mjs).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = process.env.MEMORYLAKE_PLUGIN_DATA || path.join(os.homedir(), ".memorylake", "harness");

const OPEN = "run `memorylake-connect` (Bash), which opens MemoryLake's sign-in page in the user's browser, and ask them to finish there";

/** What the model is told to do when MemoryLake needs setting up again. */
export const REPAIR = OPEN;

/** The same when there is no CLI to run. */
export const NO_CLI = "This copy of the MemoryLake plugin came without the `memorylake` CLI for this computer. Tell the user to install the plugin from its release zip, which has the CLI inside: https://github.com/memorylake-ai/memorylake-harness/releases";

/** The plugin's hooks are the ones that act; it is the connector's that stand down. */
export const standDown = () => false;

/**
 * Where to look for the CLI before PATH: the one this plugin carries. Windows
 * on ARM runs x64 programs, and the plugin may carry only that one.
 */
export function cliDirs() {
  const dir = (arch) => path.join(ROOT, "vendor", `${process.platform}-${arch}`);
  return process.platform === "win32" && process.arch === "arm64" ? [dir("arm64"), dir("x64")] : [dir(process.arch)];
}

/** Whether there is a CLI at all: the plugin's, one on PATH, or the one in ~/.memorylake/bin. */
function hasCli() {
  if (process.env.MEMORYLAKE_BIN) return true;
  const names = process.platform === "win32" ? ["memorylake.exe", "memorylake.cmd"] : ["memorylake"];
  // Not this plugin's bin/: the launcher there is no CLI by itself.
  const onPath = (process.env.PATH || "").split(path.delimiter).filter((dir) => dir && path.resolve(dir) !== path.join(ROOT, "bin"));
  return [...cliDirs(), ...onPath, path.join(path.dirname(DATA), "bin")]
    .some((dir) => names.some((name) => fs.existsSync(path.join(dir, name))));
}

/**
 * What to say at session start on a computer where MemoryLake was never set
 * up. The first time, the sign-in page is opened for the user as well: they
 * installed the plugin a moment ago, and nothing else would tell them there
 * is one more step. Once only; after that the page opens when asked for.
 */
export function notSetUp() {
  // The page signs in through the CLI; without one it could only fail.
  if (!hasCli()) return NO_CLI;
  const marker = path.join(DATA, "state", "workbuddy-plugin-connect.json");
  if (!fs.existsSync(marker)) {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      // "wx": of two sessions starting together, one opens the page.
      fs.writeFileSync(marker, JSON.stringify({ openedAt: new Date().toISOString() }) + "\n", { flag: "wx" });
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "connect.mjs"), "--serve"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: os.homedir(),
        env: process.env,
      });
      child.on("error", () => {});
      child.unref();
      if (child.pid) {
        return "Its sign-in page has just been opened in the user's browser: tell them to finish signing in there, and that memory works from the next message on. To open the page again, run `memorylake-connect` (Bash).";
      }
    } catch {}
  }
  return `If the user asks about memory or MemoryLake, ${OPEN}.`;
}
