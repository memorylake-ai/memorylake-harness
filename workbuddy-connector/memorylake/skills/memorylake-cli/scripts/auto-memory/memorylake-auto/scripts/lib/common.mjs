// Shared helpers for the MemoryLake connector's automatic memory.
//
// A port to Node of the MemoryLake plugin's hooks (workbuddy-plugin/scripts,
// bash and jq). The plugin can ask its users for bash and jq; the connector
// cannot: it is installed with one click, often on Windows, on a computer
// that has neither. WorkBuddy always has Node for a connector that declares
// `runtime: node`, so Node's own modules are all this uses. No git, jq, perl
// or shell either.
//
// Every harness on a computer shares ONE identity and data tree,
// ~/.memorylake/harness/, so what is computed here (the project a folder
// belongs to, above all) must come out the same as in the bash harnesses.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS = process.platform === "win32";

// ---------- small file helpers ---------------------------------------------------

export const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

export const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Write through a temporary name, so a reader never sees half a file. */
export function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
    return true;
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    return false;
  }
}

export const exists = (file) => fs.existsSync(file);
export const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
export const isDir = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};
/** True when a file exists and has something in it. */
export const hasContent = (file) => {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
};
/** Seconds since a file was last changed, or Infinity when it is not there. */
export const ageSeconds = (file) => {
  try {
    return (Date.now() - fs.statSync(file).mtimeMs) / 1000;
  } catch {
    return Infinity;
  }
};
export const mkdirp = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
};
export const remove = (file) => {
  try {
    fs.rmSync(file, { recursive: true, force: true });
  } catch {}
};
/** The non-empty lines of a file. */
export const lines = (file) => readText(file).split("\n").filter((line) => line.trim() !== "");
/** UTC, to the second: 2026-11-23T08:59:46Z. */
export const utcNow = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

// ---------- configuration ----------------------------------------------------------

/** Root of the cache/state tree every MemoryLake harness shares. MEMORYLAKE_PLUGIN_DATA overrides it for tests. */
export const dataDir = () => process.env.MEMORYLAKE_PLUGIN_DATA || path.join(os.homedir(), ".memorylake", "harness");
/** Where the MemoryLake installer, and the sign-in page, leave a CLI for every harness. */
export const binDir = () => path.join(path.dirname(dataDir()), "bin");
export const stateDir = () => path.join(dataDir(), "state");

/**
 * One scalar key out of a YAML frontmatter block.
 *
 * Deliberately not a YAML parser: the config is written by us, so a
 * line-oriented read is enough. Values may be quoted.
 */
export function frontmatterGet(file, key) {
  const all = readText(file).split("\n").map((line) => line.replace(/\r$/, ""));
  if (all[0] !== "---") return "";
  for (const line of all.slice(1)) {
    if (line === "---") break;
    const colon = line.indexOf(":");
    if (colon < 0 || line.slice(0, colon).trim() !== key) continue;
    return line.slice(colon + 1).trim().replace(/"$/, "").replace(/^"/, "").replace(/'$/, "").replace(/^'/, "");
  }
  return "";
}

/** True when a config flag is anything other than an explicit false. Absent means on. */
export const flagEnabled = (value) => !["false", "no", "off", "0"].includes(value ?? "");

/** The directories from `dir` up to, but not including, the root of its drive. */
function ancestors(dir) {
  const out = [];
  let d = dir;
  for (;;) {
    const parent = path.dirname(d);
    if (!d || parent === d) break;
    out.push(d);
    d = parent;
  }
  return out;
}

const PROJECT_CONFIG = path.join(".claude", "memorylake.local.md");

/**
 * The two config layers merged (a project file overrides a field or two and
 * need not repeat the rest), or null for "not configured", which every
 * caller treats as "do nothing".
 */
export function loadConfig(cwd) {
  const projectFile = ancestors(path.resolve(cwd || process.cwd()))
    .map((dir) => path.join(dir, PROJECT_CONFIG))
    .find(isFile) || "";
  const globalFile = isFile(path.join(dataDir(), "config.md")) ? path.join(dataDir(), "config.md") : "";
  if (!projectFile && !globalFile) return null;
  const get = (key) => (projectFile && frontmatterGet(projectFile, key)) || (globalFile && frontmatterGet(globalFile, key)) || "";

  if (!flagEnabled(get("enabled"))) return null;
  const workspace = get("workspace");
  if (!workspace) return null;
  const syncOnWrite = get("sync_on_write");
  return {
    projectFile,
    globalFile,
    workspace,
    projects: get("projects"),
    syncDeny: get("sync_deny"),
    projectCustomId: get("project_custom_id"),
    actor: get("actor"),
    // recall_reminder and recall_gate are lenient (absent means on).
    // sync_conversations falls back to sync_on_write, so a config written by
    // another harness keeps meaning what the user agreed to there.
    recallReminder: get("recall_reminder"),
    recallGate: get("recall_gate"),
    syncConversations: get("sync_conversations") || syncOnWrite,
    // Whole files, not text: never inherited, absent means off.
    syncAttachments: get("sync_attachments"),
    syncAttachmentsMaxMb: get("sync_attachments_max_mb"),
  };
}

// ---------- the memorylake CLI -------------------------------------------------------

const EXE = WINDOWS ? "memorylake.exe" : "memorylake";

/**
 * The binary behind a `memorylake` that npm installed, or "" when there is
 * none. npm's `memorylake` is a small Node launcher (a link to it on Unix, a
 * .cmd shim beside node_modules on Windows). The hooks run the binary itself:
 * a .cmd cannot be given arbitrary text as an argument safely, and the
 * launcher would cost a second Node start on every call.
 */
function npmBinary(found) {
  let real = found;
  try {
    real = fs.realpathSync(found);
  } catch {}
  const launchers = [real, path.join(path.dirname(found), "node_modules", "@memorylake", "cli", "bin", "memorylake.js")];
  for (const launcher of launchers) {
    if (path.basename(launcher) !== "memorylake.js" || !isFile(launcher)) continue;
    try {
      return createRequire(launcher).resolve(`@memorylake/cli-${process.platform}-${process.arch}/bin/${EXE}`);
    } catch {
      return "";
    }
  }
  return null;
}

/** How to start the CLI at `found`: [program, ...leading arguments], or null when it cannot be run. */
function launch(found) {
  if (!isFile(found)) return null;
  const behind = npmBinary(found);
  if (behind) return [behind];
  if (behind === "") return null;
  let real = found;
  try {
    real = fs.realpathSync(found);
  } catch {}
  // A script standing in for the CLI (the tests' stub).
  if (/\.[cm]?js$/.test(real)) return [process.execPath, real];
  if (WINDOWS && !/\.exe$/i.test(found)) return null;
  return [found];
}

let cliCache;
/**
 * The CLI to run, as [program, ...leading arguments], or null when there is
 * none. In order: WorkBuddy's own tools directory, where the connector
 * installs it (a hook's PATH may not include it, and an older memorylake
 * elsewhere must not win); then PATH; then the copy the sign-in page leaves
 * in ~/.memorylake/bin.
 */
export function findCli() {
  if (cliCache !== undefined) return cliCache;
  const names = WINDOWS ? ["memorylake.exe", "memorylake.cmd"] : ["memorylake"];
  const tools = path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".workbuddy"), "binaries", "node", "cli-connector-packages");
  const dirs = [
    WINDOWS ? tools : path.join(tools, "bin"),
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
    binDir(),
  ];
  const candidates = [process.env.MEMORYLAKE_BIN, ...dirs.flatMap((dir) => names.map((name) => path.join(dir, name)))];
  for (const candidate of candidates) {
    const command = candidate && launch(candidate);
    if (command) return (cliCache = command);
  }
  return (cliCache = null);
}

/** Run the CLI and wait. `code` is -1 when it could not be started. */
export function runCli(args, options = {}) {
  const command = findCli();
  if (!command) return { code: -1, stdout: "", stderr: "memorylake CLI not installed" };
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: result.status ?? -1, stdout: result.stdout || "", stderr: result.stderr || String(result.error?.message || "") };
}

/**
 * The JSON a CLI call printed, or null. The exit status is not consulted: a
 * failed call prints nothing on stdout, and what it did print is the answer.
 */
export function cliJson(args, options) {
  const result = runCli(args, options);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Comma-separated project ids to scope a search to, or "" when the workspace
 * has none. The search endpoint reads a missing list as "match no documents",
 * so every search names them all. Cached for ten minutes; a longer cache
 * would hide a new project's documents for as long.
 */
export function projectIds(config) {
  if (config.projects) return config.projects;
  const cacheFile = path.join(dataDir(), "projects", `${config.workspace}.txt`);
  if (ageSeconds(cacheFile) < 600) return readText(cacheFile);
  const listed = cliJson(["project", "list", "--workspace", config.workspace]);
  const ids = (listed?.items ?? []).map((item) => item.id).join(",");
  if (!ids) return "";
  if (mkdirp(path.dirname(cacheFile))) writeAtomic(cacheFile, ids);
  return ids;
}

// ---------- which project a folder is ------------------------------------------------
//
// Most intentional first:
//   1. `project_custom_id` in the project's own config file;
//   2. the normalized git remote URL: every clone of a repository, on any
//      computer and under any path, is the same project;
//   3. the physical path of the folder: a repository with no remote cannot
//      exist anywhere else, so where it is, is what it is.
//
// The git parts read .git directly instead of running git. A new Mac answers
// `git` with a dialog offering to install developer tools, and a new Windows
// computer has no git on PATH at all.

function physical(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return "";
  }
}

/** The repository a directory is in: { root, gitDir }, or null. */
function repository(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const dotGit = path.join(d, ".git");
    if (isDir(dotGit)) return { root: d, gitDir: dotGit };
    if (isFile(dotGit)) {
      // A worktree or submodule: .git is a file naming the real directory.
      const named = readText(dotGit).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (named) return { root: d, gitDir: path.resolve(d, named) };
    }
    if (path.dirname(d) === d) return null;
  }
}

/** The physical root of the project containing a directory: its repository's, else the directory itself. */
export function repoRoot(dir) {
  const real = physical(dir);
  if (!real) return dir;
  return repository(real)?.root ?? real;
}

/** The repository's remotes, as { name: url }. */
function remotes(dir) {
  const real = physical(dir);
  const repo = real && repository(real);
  if (!repo) return {};
  // A worktree keeps its configuration in the main repository.
  const common = readText(path.join(repo.gitDir, "commondir")).trim();
  const config = readText(path.join(common ? path.resolve(repo.gitDir, common) : repo.gitDir, "config"));
  const found = {};
  let remote = "";
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const section = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/);
    if (section) {
      remote = section[1].toLowerCase() === "remote" && section[2] !== undefined ? section[2].replace(/\\(.)/g, "$1") : "";
      continue;
    }
    const url = remote && line.match(/^url\s*=\s*(.*)$/i);
    if (url && !(remote in found)) found[remote] = url[1].trim().replace(/^"(.*)"$/, "$1");
  }
  return found;
}

/** The remote that names the project: origin, else the first by name, as `git remote` lists them. */
function remoteUrl(dir) {
  const all = remotes(dir);
  return all.origin || all[Object.keys(all).sort()[0]] || "";
}

/**
 * A git remote URL as `host/path`: protocol, credentials and a trailing .git
 * removed, host lowercased, `host:path` folded to `host/path`. "" when no
 * path remains. Textual on purpose: the same configured URL must give the
 * same identity everywhere.
 */
export function normalizeRemote(given) {
  let url = given.split("?")[0].replace(/\/$/, "").replace(/\.git$/, "");
  const scheme = url.indexOf("://");
  if (scheme >= 0) url = url.slice(scheme + 3);
  url = url.slice(url.lastIndexOf("@") + 1);
  const host = url.match(/^[^:/]*/)[0];
  const rest = url.slice(host.length).replace(/^:/, "").replace(/^\//, "").replace(/\/$/, "");
  return host && rest ? `${host.toLowerCase()}/${rest}` : "";
}

/**
 * An identity as a custom id: slashes and colons to dashes (a custom id with
 * a slash cannot be looked up again), leading dashes dropped (the CLI would
 * read `-home-me` as an option).
 */
export const cidSlug = (text) => text.replace(/[/:]/g, "-").replace(/^-+/, "") || "root";

/**
 * A path the way the bash harnesses see it. On Windows they run under Git
 * Bash, where C:\Users\me\notes is /c/Users/me/notes; a folder with no
 * remote is identified by this spelling, so it must match theirs.
 */
function posixSpelling(dir) {
  if (!WINDOWS) return dir;
  const forward = dir.replace(/\\/g, "/");
  const drive = forward.match(/^([A-Za-z]):(\/.*)?$/);
  return drive ? `/${drive[1].toLowerCase()}${drive[2] ?? ""}` : forward;
}

/** The stable identity (the MemoryLake project custom id) of the project at a directory. */
export function projectIdentity(dir) {
  const root = repoRoot(dir);
  const own = [root, ...ancestors(path.dirname(root))].map((d) => path.join(d, PROJECT_CONFIG)).find(isFile);
  const explicit = own ? frontmatterGet(own, "project_custom_id") : "";
  if (explicit) return cidSlug(explicit);
  const url = remoteUrl(root);
  const normalized = url && normalizeRemote(url);
  return cidSlug(normalized || posixSpelling(root));
}

// A chat started without picking a folder runs in a directory WorkBuddy makes
// up and names after the clock (~/WorkBuddy/2026-11-13-18-10-18, or
// automation-<the same> for an automation run). Nobody thinks of a chat as a
// project, so all of them are ONE project, the same on every computer.
export const SCRATCH_PROJECT_ID = "workbuddy";
export const SCRATCH_PROJECT_NAME = "WorkBuddy";

/** True when `dir` is, or lies inside, one of those per-chat directories and has not become a repository with a remote. */
export function scratchDir(dir) {
  const root = repoRoot(dir);
  if (Object.keys(remotes(root)).length) return false;
  return ancestors(root).some((d) => /^\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d$/.test(path.basename(d).replace(/^automation-/, "")));
}

/** The project (custom id) a WorkBuddy session in `dir` belongs to. An explicit project_custom_id wins over everything. */
export function wbProjectIdentity(config, dir) {
  if (config.projectCustomId) return cidSlug(config.projectCustomId);
  return scratchDir(dir) ? SCRATCH_PROJECT_ID : projectIdentity(dir);
}

/** The name people see for that project. */
export const wbProjectDisplay = (dir) => (scratchDir(dir) ? SCRATCH_PROJECT_NAME : path.basename(repoRoot(dir)));

// ---------- what may be sent ---------------------------------------------------------

const samePath = (a, b) => (WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * True when `dir` is under one of the comma-separated path prefixes of
 * `sync_deny` (~ is the home directory). Prefixes, not patterns: `~/work`
 * covers everything beneath it and nothing else.
 */
export function syncDenied(config, dir) {
  if (!config.syncDeny) return false;
  const target = repoRoot(dir);
  for (const raw of config.syncDeny.split(",")) {
    let entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("~")) entry = os.homedir() + entry.slice(1);
    entry = physical(entry) || path.resolve(entry);
    if (samePath(target, entry) || samePath(target.slice(0, entry.length + 1), entry.replace(/[\\/]$/, "") + path.sep)) return true;
  }
  return false;
}

/**
 * True when this folder's conversation may be uploaded. A folder on the
 * sync_deny list uploads nothing unless its own config file says otherwise.
 */
export function syncAllowed(config, dir) {
  if (!config.syncConversations || !flagEnabled(config.syncConversations)) return false;
  if (syncDenied(config, dir)) return Boolean(config.projectFile && frontmatterGet(config.projectFile, "sync_conversations"));
  return true;
}

/**
 * True when files the user attaches here may be uploaded. Stricter than every
 * other flag: it must be an explicit yes, and it only ever narrows
 * conversation sync.
 */
export const attachmentsAllowed = (config, dir) =>
  ["true", "yes", "on", "1"].includes(config.syncAttachments) && syncAllowed(config, dir);

// ---------- one WorkBuddy session ----------------------------------------------------
//
// state/workbuddy/<session>/ holds:
//   turn.json            the current turn's id
//   searched.<turn>      the model searched MemoryLake this turn
//   gated.<turn>         the recall gate already held a call back this turn
//   outbox.jsonl         messages waiting to be appended to the conversation
//   sync.json            the session's conversation id and last outcome
//   session.json         its folder and transcript, for the background run
//   attachments.jsonl    files the user attached, waiting to be uploaded
//   attachments.offset   how many transcript lines have been scanned for them
//   attachments.json     the last attachment sync outcome
//
// WorkBuddy gives every hook the same session_id for the life of a chat. A
// subagent has its own, with no turn.json, so the gate leaves it alone.

/** A session id as a safe path component. */
export function safeId(id) {
  return Array.from(Buffer.from(String(id), "utf8"), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9._-]/.test(char) ? char : "_";
  }).join("").slice(0, 120);
}

export const sessionDir = (sessionId) => path.join(stateDir(), "workbuddy", safeId(sessionId));

/**
 * The user's words with WorkBuddy's own additions removed. The prompt a hook
 * gets is the host's <system-reminder> blocks followed by what the user
 * typed, wrapped in <user_query>. Only the wrapped part is conversation.
 */
export function cleanPrompt(text) {
  const typed = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((match) => match[1]);
  return (typed.length ? typed.join("\n\n") : text).replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/** Clip text to `max` characters, marking the cut. */
export function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "\u2026" : text;
}

/** True when a shell command line is a MemoryLake search. */
export const isSearchCommand = (command) => command.includes("ml-recall") || /memorylake[\s\S]* search/.test(command);

/**
 * The local files attached to a user message, as the transcript stores it.
 * WorkBuddy copies a dropped file nowhere; it lists the path in the
 * message's hidden context, in one or both of:
 *
 *   <user_references>            one JSON string per line
 *   "/Users/me/report.pdf"
 *   </user_references>
 *
 *   <attached_files>
 *   <file path="/Users/me/a.pdf" />
 *   </attached_files>
 *
 * The user's own text is cut out first, so a message that only QUOTES such a
 * block attaches nothing. Folders are dropped.
 */
export function attachedFiles(message) {
  const text = message.replace(/<user_query>[\s\S]*?<\/user_query>/g, "");
  const found = [];
  for (const block of text.matchAll(/<user_references>([\s\S]*?)<\/user_references>/g)) {
    for (const line of block[1].split("\n")) {
      const quoted = line.match(/^\s*(".*")\s*$/)?.[1];
      if (!quoted) continue;
      try {
        const value = JSON.parse(quoted);
        if (typeof value === "string") found.push(value);
      } catch {}
    }
  }
  const entities = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&amp;": "&" };
  for (const block of text.matchAll(/<attached_files>([\s\S]*?)<\/attached_files>/g)) {
    for (const file of block[1].matchAll(/<file\s+path="([^"]*)"/g)) {
      found.push(file[1].replace(/&lt;|&gt;|&quot;|&apos;|&#39;/g, (entity) => entities[entity]).replace(/&amp;/g, "&"));
    }
  }
  const absolute = found.filter((file) => /^(?:\/|[A-Za-z]:[\\/])/.test(file) && !file.includes("\n") && !/[\\/]$/.test(file));
  return [...new Set(absolute)];
}

/** The last component of a path, whichever way its slashes lean. */
export const baseName = (file) => file.split(/[\\/]/).pop();

/**
 * True when a file name is worth sending as a document. A list of what is
 * allowed, on purpose: WorkBuddy lists an @-mentioned workspace file the same
 * way as a dropped one, so anything else would upload source files and keys.
 */
export function attachmentExtOk(name) {
  const base = baseName(name).toLowerCase();
  if (!base.includes(".")) return false;
  return ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "tsv", "txt", "md", "markdown", "rtf",
    "png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(base.split(".").pop());
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export function sha256File(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return "";
  }
}

/**
 * Take a lock directory, or return null when another run holds it. A crashed
 * run leaves its lock behind; one older than the hook's own time limit cannot
 * still be running.
 */
export function lock(dir, staleSeconds = 180) {
  const take = () => {
    try {
      fs.mkdirSync(dir);
      return true;
    } catch {
      return false;
    }
  };
  if (!take()) {
    if (ageSeconds(dir) <= staleSeconds) return null;
    try {
      fs.rmdirSync(dir);
    } catch {}
    if (!take()) return null;
  }
  const release = () => {
    try {
      fs.rmdirSync(dir);
    } catch {}
  };
  process.on("exit", release);
  return release;
}

// ---------- the MemoryLake project a folder's conversation is filed under --------

/** The per-workspace cache directory of the sync hooks. */
export const workspaceDir = (config) => path.join(dataDir(), "sync", config.workspace);

/**
 * The MemoryLake project for the folder `where`, created when it does not
 * exist yet: { id, customId, dir } or { error }. Create first, then look up:
 * reaching here usually means the project is new, and when it is not the
 * create fails (custom ids are unique per workspace) and the lookup finds it.
 * Both sync hooks may run this at the same moment; the loser of that race
 * falls through to the lookup.
 */
export function resolveProject(config, where) {
  const customId = wbProjectIdentity(config, where);
  const dir = path.join(workspaceDir(config), cidSlug(customId));
  mkdirp(dir);
  const cache = path.join(dir, "project_id");
  let id = readText(cache);
  if (!id) {
    id = cliJson(["project", "create", "--workspace", config.workspace, "--name", wbProjectDisplay(where), "--custom-id", customId])?.id || "";
    if (id) remove(path.join(dataDir(), "projects", `${config.workspace}.txt`));
    else id = cliJson(["project", "get", "--workspace", config.workspace, customId, "--by-custom-id"])?.id || "";
  }
  if (!id) return { error: `could not resolve or create project "${customId}"` };
  writeAtomic(cache, id);
  return { id, customId, dir };
}

/** The last `count` lines of a command's output on one line, as an error detail. */
export const tailLine = (text, count, max) =>
  text.replace(/\n+$/, "").split("\n").slice(-count).join(" ").slice(0, max);

// ---------- work that outlives the turn ----------------------------------------------

const HOOK_SCRIPT = fileURLToPath(new URL("../hook.mjs", import.meta.url));

/**
 * Run `node hook.mjs <args>` on its own and return at once.
 *
 * WorkBuddy (5.11.3) runs each turn in a process of its own and ends it about
 * a second after the turn is over. On the way out that process kills every
 * hook still running, children included, a hook that answered
 * {"async": true} as well; an upload started by a Stop hook never finished.
 * A process started here is detached, and once the hook that started it has
 * returned it is no hook's child, so nothing reaches it. It runs on the Node
 * that runs the hook, so it needs nothing the hook did not.
 */
export function inBackground(args) {
  try {
    const child = spawn(process.execPath, [HOOK_SCRIPT, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // Not the session's folder: on Windows a working directory cannot be deleted.
      cwd: os.homedir(),
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
    return Boolean(child.pid);
  } catch {
    return false;
  }
}

/** What the background run needs to know about a session: where it works and its transcript. */
export function rememberSession(input) {
  const dir = sessionDir(input.session_id);
  if (!mkdirp(dir)) return;
  const file = path.join(dir, "session.json");
  const known = readJson(file) || {};
  const next = { cwd: input.cwd || known.cwd || "", transcript_path: input.transcript_path || known.transcript_path || "" };
  if (next.cwd !== known.cwd || next.transcript_path !== known.transcript_path) {
    writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
  }
}

/** The input a Stop hook got, as far as the background run needs it. */
export function recalledSession(sessionId) {
  const dir = sessionDir(sessionId);
  const known = readJson(path.join(dir, "session.json")) || {};
  let cwd = known.cwd;
  if (!cwd) {
    // Sessions from before session.json: the user's messages carry the folder.
    for (const line of [...lines(path.join(dir, "outbox.draining")), ...lines(path.join(dir, "outbox.jsonl"))]) {
      try {
        cwd = JSON.parse(line).cwd;
      } catch {}
      if (cwd) break;
    }
  }
  return { session_id: sessionId, cwd: cwd || os.homedir(), transcript_path: known.transcript_path || "" };
}
