#!/usr/bin/env node
// Sign-in page for the memorylake CLI, for hosts that run `auth` without a
// terminal (WorkBuddy's CLI connector).
//
// WorkBuddy runs this command with no terminal and no standard input, reads
// standard output for a URL, opens that URL in the browser, and waits for the
// process to exit (`authWaitForExit`).
//
// So this serves a one-off page on the loopback interface. The user signs in
// to the China deployment (WorkBuddy's users are in China), picks or creates a
// default workspace, may copy the memory files WorkBuddy keeps on this computer into
// MemoryLake, and may turn on automatic memory (a small WorkBuddy plugin with
// the hooks a connector cannot carry). Signing in is the
// CLI's browser login (`auth login --no-browser`): the page opens the
// MemoryLake authorization page the CLI hands it, and the CLI receives the
// result on a loopback port of its own and stores the API key MemoryLake
// creates for it. A CLI too old for that, or a user who prefers it, can paste
// an API key instead. Every step is carried out by the CLI, which stays the
// only thing that reads or writes its credentials.
// Exit status: 0 once logged in, 1 otherwise.
//
// A MemoryLake login already on the computer (the CLI keeps one, shared by
// every MemoryLake tool there) is offered first, to keep or to replace.
//
// `login.mjs --status` and `login.mjs --disconnect` serve no page: they are
// the connector's status and disconnect commands (see the end of the file).
// `login.mjs --refresh` is started by the status command, on its own.
//
// No dependencies, Node 18+.

import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = process.env.MEMORYLAKE_BIN || "memorylake";
// WorkBuddy gives up after five minutes; leave before it does so the page can
// say why.
const TIMEOUT_MS = Number(process.env.MEMORYLAKE_LOGIN_TIMEOUT_MS) || 280_000;
const STARTED_AT = Date.now();
// A browser login is worth starting only with this much time left.
const MIN_BROWSER_SECONDS = 30;

// The deployment to sign in to: China, unless the environment names another
// the way the CLI names it (a test stand-in, a deployment of one's own).
const TARGET = process.env.MEMORYLAKE_BASE_URL
  ? { console: "", baseUrl: process.env.MEMORYLAKE_BASE_URL }
  : { console: "https://app.memorylake.cn", baseUrl: "https://app.memorylake.cn/openapi/memorylake" };

const token = randomBytes(24).toString("hex");
let done = false;
// Once the CLI holds a valid login the connection has succeeded, even if the
// page is closed before a workspace is picked.
let loggedIn = false;
// The browser login in progress, if any (see `startBrowserLogin`).
let attempt = null;
// The default workspace chosen on this page, once there is one.
let workspaceId = null;

/** Run a command and resolve with its exit code and output. Never rejects. */
function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, windowsHide: true, ...options }, (error, stdout, stderr) => {
      // `error.code` is the exit status, or a string such as ENOENT when the
      // binary could not be started at all.
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
    });
  });
}

/** Run the memorylake CLI. */
const cli = (args) => run(CLI, args);

/** The line of a CLI failure a person can act on, with the key scrubbed out. */
function failureText(result, secret) {
  let text = (result.stderr || result.stdout).trim();
  if (secret) text = text.split(secret).join("***");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // The CLI prints "Error: <what it was doing>", then "Caused by:" and the
  // root cause, then the raw response. The root cause is the useful line.
  const cause = lines.indexOf("Caused by:");
  const line = cause >= 0 && lines[cause + 1] ? lines[cause + 1] : lines.find((l) => /^Error:/.test(l)) || lines.at(-1);
  return (line || "the memorylake command failed").replace(/^Error:\s*/, "").slice(0, 300);
}

/** Whether a failed login was the server refusing the key, not a network fault. */
const keyRefused = (result) => /UNAUTHORIZE|\b401\b/.test(result.stderr + result.stdout);

// `--disconnect`, `--status` and `--refresh` serve no page; see further down.
const DISCONNECT = process.argv.includes("--disconnect");
const STATUS = process.argv.includes("--status");
const REFRESH = process.argv.includes("--refresh");
const PAGE = !DISCONNECT && !STATUS && !REFRESH;

// Browser login arrived in the CLI after v20261102; older ones only take a key.
const browserLoginSupported = PAGE && await cli(["auth", "login", "--help"]).then(
  (result) => result.code === 0 && result.stdout.includes("--no-browser"),
);

/**
 * A MemoryLake login already on this computer that still works, made by the
 * CLI for anything (another MemoryLake tool, the terminal, an earlier
 * connect), so the page can offer to keep it. Asked once, at start.
 */
const existingLogin = PAGE ? cli(["auth", "status"]).then(async (result) => {
  const text = result.stdout;
  if (result.code !== 0 || !/^Logged in: yes/m.test(text) || !/^Credentials: valid/m.test(text)) return null;
  const field = (name) => text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))?.[1].trim() || "";
  let host = field("Base URL");
  try { host = new URL(host).host; } catch {}
  const me = await cli(["actor", "me"]).then((r) => { try { return JSON.parse(r.stdout); } catch { return {}; } });
  return { account: me.display_name || me.name || me.email || field("API key"), host };
}) : null;

/** What the key is called in the MemoryLake console, so the user can tell it apart. */
function keyName() {
  const device = hostname().replace(/\.local$/i, "").trim().slice(0, 64);
  return device ? `WorkBuddy · ${device}` : "WorkBuddy";
}

async function listWorkspaces() {
  const items = [];
  let continuation = null;
  for (let page = 0; page < 5; page++) {
    const args = ["workspace", "list", "--page-size", "100"];
    if (continuation) args.push("--continuation-token", continuation);
    const result = await cli(args);
    if (result.code !== 0) throw new Error(failureText(result));
    const body = JSON.parse(result.stdout);
    for (const item of body.items ?? []) items.push({ id: item.id, name: item.name || item.id });
    continuation = body.continuation_token;
    if (!continuation) break;
  }
  return items;
}

/**
 * The workspace this computer already uses, if the signed-in account has it:
 * the CLI's default, or else the one automatic memory was writing to (a
 * logout forgets the CLI's default).
 */
async function currentWorkspace(workspaces) {
  const cliDefault = (await cli(["workspace", "current"])).stdout.match(/^(\S+) \(from /m)?.[1];
  const config = await readFile(join(HARNESS_HOME, "config.md"), "utf8").catch(() => "");
  const configured = config.match(/^---\r?\n[\s\S]*?^workspace:[ \t]*(\S+)/m)?.[1];
  return [cliDefault, configured].find((id) => id && workspaces.some((w) => w.id === id)) || null;
}

/**
 * After a login: hand the page the workspaces to pick from or add to. The
 * only one is made the default straight away, so a login that never returns
 * to the page (no new tab allowed) still leaves the CLI ready to use.
 */
async function afterLogin() {
  try {
    const workspaces = await listWorkspaces();
    const current = await currentWorkspace(workspaces);
    if (workspaces.length === 1) {
      const picked = await cli(["workspace", "use", workspaces[0].id]);
      if (picked.code === 0) {
        workspaceId = workspaces[0].id;
        return { workspaces, workspace: workspaces[0] };
      }
    }
    return { workspaces, current };
  } catch (error) {
    // Logged in is what matters; the workspace can be chosen later.
    return { workspaces: [], warning: String(error.message || error) };
  }
}

/**
 * The authorization URL the CLI printed, if it is one the page may send the
 * browser to: on the deployment being logged in to, and nothing else.
 */
function authorizationUrl(line, target) {
  try {
    const url = new URL(line.trim());
    const expected = new URL(target.baseUrl);
    const secure = url.protocol === "https:" || (url.protocol === "http:" && expected.protocol === "http:");
    return secure && url.origin === expected.origin ? url.href : null;
  } catch {
    return null;
  }
}

function stopBrowserLogin() {
  if (attempt?.state === "starting" || attempt?.state === "waiting") {
    attempt.state = "cancelled";
    attempt.child.kill();
  }
}

/**
 * Start `memorylake auth login --no-browser`. Resolves with the authorization
 * URL once the CLI prints it (its first line of standard output); the CLI then
 * waits on its own loopback port for the browser to come back, and exits.
 */
function startBrowserLogin(target) {
  stopBrowserLogin();
  const seconds = Math.floor((STARTED_AT + TIMEOUT_MS - Date.now()) / 1000) - 5;
  if (seconds < MIN_BROWSER_SECONDS) {
    return Promise.resolve({ ok: false, error: "too little time is left; reconnect MemoryLake from WorkBuddy" });
  }
  const child = spawn(
    CLI,
    ["auth", "login", "--no-browser", "--base-url", target.baseUrl, "--key-name", keyName(), "--timeout", String(seconds)],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const current = { child, state: "starting", stdout: "", stderr: "", error: "", result: null, polled: false };
  attempt = current;

  return new Promise((resolve) => {
    const settle = (value) => {
      resolve(value);
      resolve = () => {};
    };
    child.stdout.on("data", (chunk) => {
      current.stdout += chunk;
      if (current.state !== "starting" || !current.stdout.includes("\n")) return;
      const url = authorizationUrl(current.stdout.split(/\r?\n/)[0], target);
      if (url) {
        current.state = "waiting";
        settle({ ok: true, url });
      } else {
        current.state = "failed";
        current.error = "the memorylake command printed an unexpected sign-in address";
        child.kill();
        settle({ ok: false, error: current.error });
      }
    });
    child.stderr.on("data", (chunk) => (current.stderr += chunk));
    child.on("error", (error) => {
      current.state = "failed";
      current.error = `could not run ${CLI}: ${error.message}`;
      settle({ ok: false, error: current.error });
    });
    child.on("close", (code) => {
      if (current.state === "cancelled") return settle({ ok: false, error: "cancelled" });
      if (current.state === "failed") return;
      if (code === 0) {
        loggedIn = true;
        current.state = "done";
        current.result = markConnected(true).catch(() => {}).then(afterLogin);
        // A page that went off to MemoryLake in its own tab is not coming
        // back to ask; do not keep WorkBuddy waiting on it.
        setTimeout(() => {
          if (!current.polled) shutdown(0);
        }, 15_000).unref();
      } else {
        current.state = "failed";
        current.error = failureText({ stdout: current.stdout, stderr: current.stderr });
      }
      settle({ ok: false, error: current.error || "the login ended before the browser was opened" });
    });
  });
}

// ---------------------------------------------------------------------------
// Importing WorkBuddy's own memory files.
//
// WorkBuddy keeps what it remembers in Markdown files. The page offers to copy
// them into MemoryLake as documents of one project; MemoryLake builds memory
// from documents by itself, and drops that memory when a document is deleted,
// so a repeat import replaces a file without leaving duplicates behind. The
// files are only read. The layout is WorkBuddy's own (seen in 5.11.3), so
// whatever is missing is skipped.

const IMPORT_HOME = process.env.MEMORYLAKE_IMPORT_HOME || homedir();
const IMPORT_NAME = "WorkBuddy memory";
const IMPORT_CUSTOM_ID = "workbuddy-memory";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACES = 30;
const MAX_DAILY_NOTES = 60;
// What the last scan found, by group id. The page sends back ids only, so it
// cannot name a path of its own.
let importPlan = new Map();

// Documents are stored as they are, so lines that look like a credential are
// left out of the copy that is uploaded. Losing a harmless line that mentions
// a "token" costs less than storing a real one.
const SECRET_LINE = /pass(word|wd|phrase)|secret|token|api[_-]?key|access[_-]?key|bearer\s|cookie|sk-[A-Za-z0-9_-]{8}|密码|密钥|口令/i;

function scrub(text) {
  const kept = [];
  let removed = 0;
  let inPrivateKey = false;
  for (const line of text.split(/\r?\n/)) {
    if (/BEGIN [A-Z ]*PRIVATE KEY/.test(line)) inPrivateKey = true;
    if (inPrivateKey || SECRET_LINE.test(line)) removed++;
    else kept.push(line);
    if (/END [A-Z ]*PRIVATE KEY/.test(line)) inPrivateKey = false;
  }
  return { text: kept.join("\n"), removed };
}

const entries = (dir) => readdir(dir).catch(() => []);

/** One memory file, or null when it is missing, empty, too large or unreadable. */
async function memoryFile(path, name) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null;
    const { removed } = scrub(await readFile(path, "utf8"));
    return { path, name, size: info.size, modified: info.mtimeMs, removed };
  } catch {
    return null;
  }
}

async function cliJson(args) {
  const result = await cli(args);
  if (result.code !== 0) throw new Error(failureText(result));
  return JSON.parse(result.stdout);
}

async function findImportProject() {
  const result = await cli(["project", "get", IMPORT_CUSTOM_ID, "--by-custom-id"]);
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout).id || null;
  } catch {
    return null;
  }
}

/** Names of the documents already in the project, each with its document ids. */
async function storedDocuments(projectId) {
  const stored = new Map();
  let continuation = null;
  for (let page = 0; page < 50; page++) {
    const args = ["project", "document", "list", "--project", projectId, "--compact"];
    if (continuation) args.push("--continuation-token", continuation);
    const body = await cliJson(args);
    for (const item of body.items ?? []) {
      if (item.name && item.id) stored.set(item.name, [...(stored.get(item.name) ?? []), item.id]);
    }
    continuation = body.continuation_token;
    if (!continuation) break;
  }
  return stored;
}

async function libraryFolder() {
  let continuation = null;
  for (let page = 0; page < 20; page++) {
    const args = ["library", "list", "--page-size", "50"];
    if (continuation) args.push("--continuation-token", continuation);
    const body = await cliJson(args);
    const folder = (body.items ?? []).find((item) => item.type === "directory" && item.name === IMPORT_NAME);
    if (folder) return folder.item_id;
    continuation = body.continuation_token;
    if (!continuation) break;
  }
  return (await cliJson(["library", "mkdir", IMPORT_NAME, "--on-conflict", "deny"])).item_id;
}

/** Find the memory files and describe them to the page as groups to tick. */
async function scanMemory() {
  const workbuddy = join(IMPORT_HOME, ".workbuddy");
  const groups = [];
  const add = async (id, kind, label, suggested, candidates) => {
    const files = (await Promise.all(candidates.map(([path, name]) => memoryFile(path, name)))).filter(Boolean);
    if (files.length) groups.push({ id, kind, label, suggested, files });
  };

  await add("profile", "profile", "", true, [[join(workbuddy, "USER.md"), "workbuddy-USER.md"]]);
  const accounts = (await entries(join(workbuddy, "memory"))).filter((name) => /_memory\.md$/.test(name)).sort();
  await add("account", "account", "", true, accounts.map((name) => [
    join(workbuddy, "memory", name),
    accounts.length === 1 ? "workbuddy-account-memory.md" : `workbuddy-account-memory-${name.slice(0, 8)}.md`,
  ]));
  await add("global", "global", "", true, [[join(workbuddy, "MEMORY.md"), "workbuddy-MEMORY.md"]]);

  // Workspaces WorkBuddy created itself. Others can be anywhere on disk; the
  // memorylake-cli-import skill covers those.
  const folders = (await entries(join(IMPORT_HOME, "WorkBuddy"))).sort().slice(-MAX_WORKSPACES);
  for (const folder of folders) {
    const dir = join(IMPORT_HOME, "WorkBuddy", folder, ".workbuddy", "memory");
    const slug = folder.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60);
    await add(`workspace:${folder}`, "workspace", folder, true, [[join(dir, "MEMORY.md"), `workbuddy-${slug}-MEMORY.md`]]);
    const notes = (await entries(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().slice(-MAX_DAILY_NOTES);
    // Daily notes are mostly a log of single days: offered, not suggested.
    await add(`notes:${folder}`, "notes", folder, false, notes.map((name) => [join(dir, name), `workbuddy-${slug}-${name}`]));
  }
  importPlan = new Map(groups.map((group) => [group.id, group]));
  if (!groups.length) return [];

  // Which of them a previous import already stored, and would now replace.
  let stored = new Map();
  try {
    const projectId = await findImportProject();
    if (projectId) stored = await storedDocuments(projectId);
  } catch {
    // Not knowing is fine here; the import itself looks again.
  }
  return groups.map(({ id, kind, label, suggested, files }) => ({
    id, kind, label, suggested,
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    modified: Math.max(...files.map((file) => file.modified)),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    stored: files.some((file) => stored.has(file.name)),
  }));
}

async function importItem(projectId, itemId) {
  const body = await cliJson(["project", "document", "import", "--project", projectId, itemId]);
  return (body.details ?? [])[0] ?? {};
}

async function deleteDocument(projectId, documentId) {
  const result = await cli(["project", "document", "delete", "--project", projectId, documentId]);
  if (result.code !== 0) throw new Error(failureText(result));
}

// MemoryLake's answer when the team's plan has nothing left to process a file with.
const OUT_OF_QUOTA = /QUOTA_EXCEEDED/;

/** Upload the chosen groups' files and import them into the project. */
async function runImport(ids) {
  const files = ids.flatMap((id) => importPlan.get(id)?.files ?? []);
  if (!files.length) return { ok: false, error: "nothing was selected" };

  let projectId, folderId, stored;
  try {
    projectId = (await findImportProject())
      ?? (await cliJson(["project", "create", "--name", IMPORT_NAME, "--custom-id", IMPORT_CUSTOM_ID,
        "--description", "Memory files imported from WorkBuddy"])).id;
    folderId = await libraryFolder();
    stored = await storedDocuments(projectId);
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }

  const dir = await mkdtemp(join(tmpdir(), "memorylake-import-"));
  let imported = 0;
  const failed = [];
  try {
    for (const file of files) {
      // Leave before the page's own deadline; what is left can be imported
      // later through the skill.
      if (Date.now() > STARTED_AT + TIMEOUT_MS - 20_000) {
        failed.push({ name: file.name, error: "ran out of time" });
        continue;
      }
      try {
        const copy = join(dir, file.name);
        await writeFile(copy, scrub(await readFile(file.path, "utf8")).text, { mode: 0o600 });
        // Uploading over a Library file does not index it again: the old
        // document has to go first, and its derived memory goes with it.
        for (const documentId of stored.get(file.name) ?? []) await deleteDocument(projectId, documentId);
        const item = await cliJson(["library", "upload", copy, "--parent", folderId, "--name", file.name, "--on-conflict", "overwrite"]);
        let detail = await importItem(projectId, item.item_id);
        if (detail.result === "duplicate" && detail.document_id) {
          // The old content is still what is indexed.
          await deleteDocument(projectId, detail.document_id);
          detail = await importItem(projectId, item.item_id);
        }
        imported++;
      } catch (error) {
        failed.push({ name: file.name, error: String(error.message || error).slice(0, 200) });
        // An account out of quota refuses every file alike; do not go on asking.
        if (OUT_OF_QUOTA.test(failed.at(-1).error)) break;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  const quota = failed.some((file) => OUT_OF_QUOTA.test(file.error));
  if (!imported) return { ok: false, quota, error: failed[0]?.error || "nothing was imported", failed };
  return { ok: true, quota, imported, failed };
}


// ---------------------------------------------------------------------------
// Automatic memory.
//
// A connector adds a CLI and skills, so by itself MemoryLake is searched and
// written only when the model decides to. WorkBuddy runs hooks from plugins
// only, so the page offers to install one: `auto-memory/`, the MemoryLake
// plugin's hooks for WorkBuddy without its commands and skill, written in
// Node so that they need nothing WorkBuddy does not bring (the plugin's own
// need bash and jq). It is installed with the `codebuddy` CLI
// that ships inside WorkBuddy, the same way WorkBuddy installs any plugin.
// Where and how that CLI is started is not a documented interface (seen in
// 5.11.3), so every failure here leaves the connection itself untouched.
//
// The MemoryLake plugin proper does the same job and more. When it is
// enabled the page installs nothing, and the hooks installed here stand down
// (scripts/hook.mjs), so the two never both act on a turn.

const AUTO_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "auto-memory");
const AUTO_MARKETPLACE = "memorylake-connector";
const AUTO_PLUGIN = `memorylake-auto@${AUTO_MARKETPLACE}`;
const FULL_PLUGIN = "memorylake@memorylake";
const WORKBUDDY_HOME = process.env.CODEBUDDY_CONFIG_DIR || join(homedir(), ".workbuddy");
// The directory every MemoryLake harness on this computer shares.
const HARNESS_HOME = process.env.MEMORYLAKE_PLUGIN_DATA || join(homedir(), ".memorylake", "harness");
// The marketplace is added from a copy here: the connector's own directory
// is replaced whenever WorkBuddy updates the connector.
const AUTO_COPY = join(HARNESS_HOME, "workbuddy-auto-memory");

const readJsonFile = (path) => readFile(path, "utf8").then(JSON.parse).catch(() => null);

/** The `codebuddy` CLI inside the WorkBuddy that is running this command. */
async function workbuddyCli() {
  const inside = join("app.asar.unpacked", "cli", "bin", "codebuddy");
  // WorkBuddy names its own resources directory to the processes it starts,
  // and a connector's commands inherit that environment (5.11.3).
  const resources = process.env.WORKBUDDY_RESOURCES_PATH;
  const candidates = [process.env.MEMORYLAKE_WORKBUDDY_CLI, resources && join(resources, inside)];
  if (process.platform !== "win32") {
    // Walk up to the app that started us; it may not live in /Applications.
    let pid = process.ppid;
    for (let depth = 0; depth < 6 && pid > 1; depth++) {
      const parent = (await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)])).stdout.trim().match(/^(\d+)\s+(.*)$/);
      if (!parent) break;
      const app = parent[2].match(/^(.*\.app)\/Contents\//);
      if (app) candidates.push(join(app[1], "Contents", "Resources", inside));
      pid = Number(parent[1]);
    }
  }
  if (process.platform === "darwin") {
    candidates.push(join("/Applications/WorkBuddy.app/Contents/Resources", inside));
    candidates.push(join(homedir(), "Applications/WorkBuddy.app/Contents/Resources", inside));
  } else if (process.platform === "win32") {
    for (const base of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"), process.env.ProgramFiles]) {
      if (base) candidates.push(join(base, "WorkBuddy", "resources", inside));
    }
  } else {
    candidates.push(join("/opt/WorkBuddy/resources", inside));
  }
  return candidates.find((path) => path && existsSync(path)) || null;
}

/** Run `codebuddy plugin ...` against WorkBuddy's own configuration. */
function workbuddyPlugin(codebuddy, args) {
  return run(process.execPath, [codebuddy, "plugin", ...args], {
    cwd: tmpdir(),
    env: { ...process.env, CODEBUDDY_CONFIG_DIR: WORKBUDDY_HOME, CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1" },
  });
}

async function autoMemoryInstalled() {
  const installed = (await readJsonFile(join(WORKBUDDY_HOME, "plugins", "installed_plugins.json")))?.plugins ?? {};
  return Boolean(installed[AUTO_PLUGIN]);
}

/**
 * Where automatic memory stands: "plugin" (the MemoryLake plugin provides
 * it), "on" (installed by an earlier connect), "available", or "unavailable".
 */
async function autoMemoryState() {
  const enabled = (await readJsonFile(join(WORKBUDDY_HOME, "settings.json")))?.enabledPlugins ?? {};
  if (enabled[FULL_PLUGIN] === true) return { state: "plugin" };
  if (!existsSync(join(AUTO_PACKAGE, ".workbuddy-plugin", "marketplace.json"))) return { state: "unavailable", reason: "package" };
  if (!(await workbuddyCli())) return { state: "unavailable", reason: "workbuddy" };
  const settings = await memorySettings();
  if ((await autoMemoryInstalled()) && enabled[AUTO_PLUGIN] !== false) return { state: "on", settings };
  return { state: "available", settings };
}

// The switches the page shows, and the config keys behind each.
const SWITCHES = {
  recall: ["recall_reminder", "recall_gate"],
  conversations: ["sync_conversations"],
  attachments: ["sync_attachments"],
};

/** The switches as config.md has them. Everything starts on; a key set to false stays off. */
async function memorySettings() {
  const text = await readFile(join(HARNESS_HOME, "config.md"), "utf8").catch(() => "");
  const body = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const off = (key) => /^(false|no|off|0)$/i.test(body.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1].trim() ?? "");
  return Object.fromEntries(Object.entries(SWITCHES).map(([name, keys]) => [name, !keys.some(off)]));
}

/** What the page asked for, every switch on unless it says otherwise. Files go only with the conversation. */
function chosenSettings(given) {
  const settings = Object.fromEntries(Object.keys(SWITCHES).map((name) => [name, given?.[name] !== false]));
  settings.attachments &&= settings.conversations;
  return settings;
}

/** The actor conversations are filed under: the account's own, bound to the workspace. */
async function resolveActor(workspace) {
  const me = await cli(["actor", "me"]).then((result) => {
    try { return result.code === 0 ? JSON.parse(result.stdout).id || null : null; } catch { return null; }
  });
  const bound = ((await cliJson(["actor", "list", "--workspace", workspace, "--page-size", "100"])).items ?? [])
    .filter((item) => !item.status || item.status === "ACTIVE")
    .map((item) => item.actor_id || item.id)
    .filter(Boolean);
  if (me && bound.includes(me)) return me;
  if (!me && bound.length === 1) return bound[0];
  if (me) {
    // The account's actor exists from the start; reaching a workspace is a
    // separate binding, which a new workspace may not have yet.
    const result = await cli(["actor", "bind", "--workspace", workspace, "--actor", me]);
    if (result.code === 0) return me;
    throw new Error(failureText(result));
  }
  throw new Error("could not tell which MemoryLake actor is yours in this workspace");
}

/**
 * Write the configuration the hooks read, with the switches chosen on the
 * page. One that another MemoryLake harness already wrote keeps its other
 * settings.
 */
async function writeHarnessConfig(workspace, settings) {
  const path = join(HARNESS_HOME, "config.md");
  const text = await readFile(path, "utf8").catch(() => "");
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let next;
  if (front) {
    // Other settings stay as they are. The workspace is the one just chosen
    // on this page; the actor is kept only for the same
    // workspace, since a new workspace or another account needs its own.
    let body = front[1];
    const value = (key) => body.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1].trim() || "";
    const set = (key, to) => {
      const line = new RegExp(`^${key}:.*$`, "m");
      body = line.test(body) ? body.replace(line, () => `${key}: ${to}`) : `${body}\n${key}: ${to}`;
    };
    const actor = value("workspace") === workspace && value("actor") ? value("actor") : await resolveActor(workspace);
    set("workspace", workspace);
    set("actor", actor);
    // The switches are the ones the user just left on or turned off.
    for (const [name, keys] of Object.entries(SWITCHES)) {
      for (const key of keys) set(key, String(settings[name]));
    }
    next = text.replace(front[0], () => `---\n${body}\n---`);
    if (next === text) return workspace;
  } else {
    const actor = await resolveActor(workspace);
    const switches = Object.entries(SWITCHES).flatMap(([name, keys]) => keys.map((key) => `${key}: ${settings[name]}`));
    next = ["---", "enabled: true", `workspace: ${workspace}`, `actor: ${actor}`, `sync_on_write: ${settings.conversations}`,
      ...switches, "status_line: true", "---", ""].join("\n");
  }
  await mkdir(HARNESS_HOME, { recursive: true });
  await writeFile(`${path}.tmp`, next);
  await rename(`${path}.tmp`, path);
  return workspace;
}

// Where the MemoryLake installer puts the CLI. The other MemoryLake tools on
// the computer look there, and so do the hooks when it is not on their PATH.
const CLI_HOME = join(dirname(HARNESS_HOME), "bin", process.platform === "win32" ? "memorylake.exe" : "memorylake");

/** A CLI's release as a number to compare (v20261117 -> 20261117), or 0 when it cannot tell. */
async function cliRelease(path) {
  return Number((await run(path, ["version"])).stdout.match(/v(\d{8})/)?.[1] || 0);
}

/**
 * The binary behind the `memorylake` found on PATH. WorkBuddy installs the CLI
 * from npm (@memorylake/cli), where that name is a small Node launcher and the
 * binary sits in the package npm picked for this machine. The launcher on its
 * own is no CLI, so it is the binary that gets copied. Any other install is
 * the binary already.
 */
async function cliBinary(found) {
  if (!found) return "";
  const exe = process.platform === "win32" ? "memorylake.exe" : "memorylake";
  // Unix: a link to the launcher. Windows: shims next to node_modules.
  const launchers = [
    await realpath(found).catch(() => found),
    join(dirname(found), "node_modules", "@memorylake", "cli", "bin", "memorylake.js"),
  ];
  for (const launcher of launchers) {
    if (!launcher.endsWith("memorylake.js") || !existsSync(launcher)) continue;
    try {
      return createRequire(launcher).resolve(`@memorylake/cli-${process.platform}-${process.arch}/bin/${exe}`);
    } catch {
      return "";
    }
  }
  return found;
}

/**
 * Leave the CLI this connector uses (WorkBuddy keeps it in a directory of its
 * own) at CLI_HOME too, so everything on the computer runs one release:
 * copied there when nothing is, and replacing an older release. A newer
 * release, or a CLI whose release cannot be read (a build of one's own), is
 * left alone. A copy, not a link, so it outlives the connector.
 */
async function updateCli() {
  const found = await run(process.platform === "win32" ? "where" : "which", [CLI]);
  const source = await cliBinary(found.code === 0 ? found.stdout.split(/\r?\n/)[0].trim() : "");
  if (!source || source === CLI_HOME) return;
  const release = await cliRelease(source);
  if (!release) return;
  if (await lstat(CLI_HOME).catch(() => null)) {
    const present = await cliRelease(CLI_HOME);
    if (!present || present >= release) return;
  }
  await mkdir(dirname(CLI_HOME), { recursive: true });
  const temp = `${CLI_HOME}.${process.pid}.new`;
  await cp(source, temp);
  await chmod(temp, 0o755);
  await rename(temp, CLI_HOME);
}

// This connector's own record that it was connected in WorkBuddy, and
// whether the login it uses is one it made.
const CONNECTED = join(HARNESS_HOME, "workbuddy-connector.json");

async function markConnected(ownLogin) {
  loggedIn = true;
  await mkdir(HARNESS_HOME, { recursive: true });
  await writeFile(CONNECTED, JSON.stringify({ connectedAt: new Date().toISOString(), ownLogin }, null, 2) + "\n");
  await updateCli().catch(() => {});
}

async function installAutoMemory() {
  const codebuddy = await workbuddyCli();
  if (!codebuddy) throw new Error("could not find WorkBuddy's plugin installer");
  // Start clean, so a reconnect brings the hooks that came with this connector.
  await workbuddyPlugin(codebuddy, ["uninstall", AUTO_PLUGIN]);
  await workbuddyPlugin(codebuddy, ["marketplace", "remove", AUTO_MARKETPLACE]);
  // Uninstalling leaves the plugin's files in WorkBuddy's cache, and an
  // install of the same version takes them from there (5.11.3).
  await rm(join(WORKBUDDY_HOME, "plugins", "cache", AUTO_MARKETPLACE, AUTO_PLUGIN.split("@")[0]), { recursive: true, force: true });
  await rm(AUTO_COPY, { recursive: true, force: true });
  await mkdir(HARNESS_HOME, { recursive: true });
  await cp(AUTO_PACKAGE, AUTO_COPY, { recursive: true });
  // The model runs bin/ml-recall as a program. A package that travelled
  // through a zip may have lost its executable bits, so set them again.
  const plugin = join(AUTO_COPY, "memorylake-auto");
  for (const dir of [join(plugin, "scripts"), join(plugin, "bin")]) {
    for (const name of await entries(dir)) {
      if (name !== "lib") await chmod(join(dir, name), 0o755).catch(() => {});
    }
  }
  for (const args of [["marketplace", "add", AUTO_COPY], ["install", AUTO_PLUGIN]]) {
    const result = await workbuddyPlugin(codebuddy, args);
    if (result.code !== 0) throw new Error(failureText(result));
  }
  if (!(await autoMemoryInstalled())) throw new Error("WorkBuddy did not record the plugin as installed");
}

/** Take the hooks out again. The shared configuration stays: other harnesses read it. */
async function removeAutoMemory() {
  const codebuddy = await workbuddyCli();
  if (codebuddy && (await autoMemoryInstalled())) await workbuddyPlugin(codebuddy, ["uninstall", AUTO_PLUGIN]);
  if (codebuddy && existsSync(AUTO_COPY)) await workbuddyPlugin(codebuddy, ["marketplace", "remove", AUTO_MARKETPLACE]);
  await rm(AUTO_COPY, { recursive: true, force: true });
  // Earlier versions linked the CLI there; a link into the connector would
  // dangle once it is gone. A copy is a CLI like any other, and stays.
  if ((await lstat(CLI_HOME).catch(() => null))?.isSymbolicLink()) await unlink(CLI_HOME).catch(() => {});
}

/** The files under a directory and their contents, by relative path. */
async function tree(dir, prefix = "") {
  const files = new Map();
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of await tree(path, `${prefix}${entry.name}/`)) files.set(name, content);
    } else {
      files.set(prefix + entry.name, await readFile(path).catch(() => null));
    }
  }
  return files;
}

/** True when the hooks WorkBuddy runs are not the ones that came with this connector. */
async function autoMemoryOutdated() {
  const record = (await readJsonFile(join(WORKBUDDY_HOME, "plugins", "installed_plugins.json")))?.plugins?.[AUTO_PLUGIN]?.[0];
  if (!record?.installPath) return false;
  // WorkBuddy adds files of its own there (.in_use/<pid>); only ours are compared.
  const [running, bundled] = await Promise.all([tree(record.installPath), tree(join(AUTO_PACKAGE, "memorylake-auto"))]);
  for (const [name, content] of bundled) {
    if (!content || !running.get(name)?.equals(content)) return true;
  }
  return false;
}

/**
 * Bring what an earlier connect installed up to this connector's release:
 * the hooks, and the CLI copy the hooks fall back on. WorkBuddy updates a
 * connector without opening its sign-in page again (the status command says
 * it is connected), and the sign-in page is where both are installed.
 */
async function refresh() {
  const lockDir = join(HARNESS_HOME, "workbuddy-refresh.lock");
  await mkdir(HARNESS_HOME, { recursive: true });
  try {
    await mkdir(lockDir);
  } catch {
    const age = Date.now() - ((await stat(lockDir).catch(() => null))?.mtimeMs ?? 0);
    if (age < 300_000) return;
  }
  try {
    if ((await autoMemoryState()).state === "on" && (await autoMemoryOutdated())) await installAutoMemory();
    await updateCli();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function enableAutoMemory(given) {
  if (!workspaceId) return { ok: false, error: "no workspace was chosen" };
  const { state, reason } = await autoMemoryState();
  if (state === "plugin") return { ok: true, state };
  if (state === "unavailable") return { ok: false, error: `automatic memory is not available here (${reason})` };
  const settings = chosenSettings(given);
  try {
    const workspace = await writeHarnessConfig(workspaceId, settings);
    // Recall and conversation sync both off: the hooks would have nothing to do.
    if (!settings.recall && !settings.conversations) {
      await removeAutoMemory();
      return { ok: true, state: "off", workspace, settings };
    }
    await installAutoMemory();
    return { ok: true, state: "on", workspace, settings };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 300) };
  }
}

// WorkBuddy calls the connector connected when its status command prints
// "Logged in: yes", and then skips the sign-in page. A MemoryLake login made
// by something else on this computer must not count until the user has
// connected here once, or they would never get to choose a workspace, import
// their memory or turn on automatic memory.
if (STATUS) {
  if (!(await readJsonFile(CONNECTED))) {
    console.log("Logged in: no (MemoryLake has not been connected in WorkBuddy yet)");
    process.exit(0);
  }
  const result = await cli(["auth", "status"]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  // Connected: bring the hooks and the CLI copy up to date, on the side.
  // WorkBuddy gives this command ten seconds, and an install takes a few.
  if (result.code === 0 && /Logged in: yes/.test(result.stdout)) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--refresh"], {
      detached: true, stdio: "ignore", windowsHide: true, cwd: tmpdir(), env: process.env,
    });
    child.on("error", () => {});
    child.unref();
  }
  process.exit(result.code < 0 ? 127 : result.code);
}

if (REFRESH) {
  await refresh().catch(async (error) => {
    // Nobody sees this command's output; the hooks' log is where to look.
    const logs = join(HARNESS_HOME, "logs");
    await mkdir(logs, { recursive: true }).catch(() => {});
    await writeFile(join(logs, "workbuddy-hooks.log"), `${new Date().toISOString()} refresh: ${error?.stack || error}\n`, { flag: "a" }).catch(() => {});
  });
  process.exit(0);
}

// Disconnecting removes what the connector added. The login goes too only if
// the connector made it: one that was here before belongs to the other
// MemoryLake tools on this computer.
if (DISCONNECT) {
  await removeAutoMemory().catch(() => {});
  const record = await readJsonFile(CONNECTED);
  await rm(CONNECTED, { force: true }).catch(() => {});
  if (record?.ownLogin) await cli(["auth", "logout"]);
  process.exit(0);
}

const handlers = {
  async login({ apiKey }) {
    const target = TARGET;
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!key) return { ok: false, error: "missing API key" };
    stopBrowserLogin();
    // The key travels as an argument because that is the only way the CLI
    // takes one without a terminal. It is visible to this user's own
    // processes for the moment the command runs.
    const result = await cli(["auth", "login", "--api-key", key, "--base-url", target.baseUrl]);
    if (result.code !== 0) return { ok: false, refused: keyRefused(result), error: failureText(result, key) };
    await markConnected(true);
    return { ok: true, ...(await afterLogin()) };
  },

  async existing() {
    return { ok: true, existing: await existingLogin };
  },

  /** Keep the login already on this computer. */
  async useExisting() {
    if (!(await existingLogin)) return { ok: false, error: "there is no MemoryLake login on this computer to keep" };
    stopBrowserLogin();
    await markConnected(false);
    return { ok: true, ...(await afterLogin()) };
  },

  async browser() {
    const target = TARGET;
    if (!browserLoginSupported) return { ok: false, error: "this memorylake CLI cannot log in through the browser" };
    return startBrowserLogin(target);
  },

  async browserStatus() {
    const current = attempt;
    if (!current) return { ok: false, error: "no login in progress" };
    current.polled = true;
    if (current.state === "done") return { ok: true, state: "done", ...(await current.result) };
    if (current.state === "failed") return { ok: true, state: "failed", error: current.error };
    return { ok: true, state: current.state };
  },

  async cancel() {
    stopBrowserLogin();
    return { ok: true };
  },

  async workspace({ id }) {
    if (typeof id !== "string" || !/^[\w.:-]{1,200}$/.test(id)) return { ok: false, error: "bad workspace id" };
    const result = await cli(["workspace", "use", id]);
    if (result.code !== 0) return { ok: false, error: failureText(result) };
    workspaceId = id;
    return { ok: true };
  },

  async workspaceCreate({ name }) {
    const title = typeof name === "string" ? name.trim() : "";
    if (!title || title.length > 100) return { ok: false, error: "bad workspace name" };
    // The API wants an id of the caller's own; nothing else refers to it.
    const customId = `workbuddy-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const created = await cli(["workspace", "create", "--name", title, "--custom-id", customId]);
    if (created.code !== 0) return { ok: false, error: failureText(created) };
    let id;
    try {
      id = JSON.parse(created.stdout).id;
    } catch {
      return { ok: false, error: "unexpected output from memorylake workspace create" };
    }
    const used = await cli(["workspace", "use", id]);
    if (used.code !== 0) return { ok: false, error: failureText(used) };
    workspaceId = id;
    return { ok: true, workspace: { id, name: title } };
  },

  async importScan() {
    return { ok: true, groups: await scanMemory() };
  },

  async importRun({ ids }) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return { ok: false, error: "bad selection" };
    return runImport(ids);
  },

  async autoScan() {
    return { ok: true, ...(await autoMemoryState()) };
  },

  async autoEnable({ settings } = {}) {
    return enableAutoMemory(settings);
  },

  async finish() {
    done = true;
    return { ok: true };
  },
};

function sameToken(candidate) {
  const given = Buffer.from(String(candidate ?? ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(new Error("request too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  const send = (status, type, body) => {
    response.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
    });
    response.end(body);
  };

  // Only this machine can connect, but any web page open in the browser can
  // make it send a request here. The Host check stops a rebound DNS name, and
  // the token (known only to whoever was handed the URL) stops everything else.
  const { port } = server.address();
  if (request.headers.host !== `127.0.0.1:${port}`) return send(403, "text/plain", "forbidden");
  const url = new URL(request.url, `http://127.0.0.1:${port}`);

  if (request.method === "GET" && url.pathname === "/connect") {
    if (!sameToken(url.searchParams.get("t"))) return send(403, "text/plain", "This link has expired. Reconnect from WorkBuddy.");
    return send(200, "text/html; charset=utf-8", page());
  }

  const action = request.method === "POST" && url.pathname.startsWith("/api/") ? url.pathname.slice(5) : "";
  if (Object.hasOwn(handlers, action)) {
    if (!sameToken(request.headers["x-login-token"])) return send(403, "application/json", '{"ok":false,"error":"forbidden"}');
    try {
      const result = await handlers[action](await readJson(request));
      send(200, "application/json", JSON.stringify(result));
    } catch (error) {
      send(400, "application/json", JSON.stringify({ ok: false, error: String(error.message || error) }));
    }
    if (done) setTimeout(() => shutdown(0), 200);
    return;
  }

  send(404, "text/plain", "not found");
});

function shutdown(code) {
  stopBrowserLogin();
  server.close();
  server.closeAllConnections?.();
  process.exitCode = code;
  // Nothing else is pending, but do not let a stuck socket keep WorkBuddy
  // waiting on us.
  setTimeout(() => process.exit(code), 500).unref();
}

// WorkBuddy stops this command when it gives up; take the CLI's login with it.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => shutdown(loggedIn ? 0 : 1));
}

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  // WorkBuddy takes the first URL on standard output that contains
  // `authUrlDomain`, up to the next whitespace. Keep it on a line of its own.
  console.log("Open this page to connect MemoryLake:");
  console.log(`http://127.0.0.1:${port}/connect?t=${token}`);
  setTimeout(() => {
    if (!loggedIn) console.error("timed out waiting for the login page to be completed");
    shutdown(loggedIn ? 0 : 1);
  }, Math.max(0, STARTED_AT + TIMEOUT_MS - Date.now())).unref();
});

server.on("error", (error) => {
  console.error(`could not start the login page: ${error.message}`);
  process.exit(1);
});

// The MemoryLake logo, drawn in the text colour so it follows dark mode.
const LOGO = '<svg class="logo" xmlns="http://www.w3.org/2000/svg" fill="currentColor" role="img" aria-label="MemoryLake" viewBox="0 0 325.6362 53.5781"><polygon points="115.3472 11.0809 115.3472 42.101 111.1824 42.101 111.2064 18.3847 100.3472 30.6534 89.4879 18.4247 89.4639 42.101 85.3472 42.101 85.3472 11.0809 89.2523 11.0809 100.3135 23.9555 111.4325 11.0809 115.3472 11.0809"/><path d="M139.9541,30.5322c0-1.4395-.2363-2.792-.7021-4.0186-.4668-1.2285-1.1328-2.3184-1.9814-3.2393-.8516-.9209-1.8779-1.6455-3.0518-2.1553-1.1729-.5088-2.4854-.7676-3.8994-.7676-1.5234,0-2.9697.2939-4.2988.873-1.3242.5771-2.498,1.3789-3.4883,2.3818-.9893,1.0039-1.7764,2.1914-2.3398,3.5303-.5645,1.3398-.8516,2.793-.8516,4.3184,0,1.5244.294,2.9775.8731,4.3193.5781,1.3398,1.3867,2.5273,2.4033,3.5303,1.0186,1.0039,2.2197,1.8047,3.5723,2.3818,1.3555.5791,2.8154.873,4.3398.873.7559,0,1.4971-.0576,2.2051-.1699.7109-.1143,1.4277-.3154,2.1309-.5967.7041-.2812,1.4395-.667,2.1865-1.1465.7441-.4775,1.5488-1.1035,2.3906-1.8613l.1104-.0996-2.8467-3.208-.1123.1094c-.9033.877-1.8984,1.5508-2.9561,2.0049-1.8584.7969-3.832.9082-5.5518.249-.75-.2852-1.4268-.6855-2.0127-1.1904-.584-.501-1.0742-1.1084-1.4561-1.8047-.3555-.6484-.5957-1.3701-.7139-2.1484h16.0508v-2.165ZM130.3194,24.6387c1.2725,0,2.3477.3691,3.1963,1.0977.8076.6904,1.3486,1.5889,1.6104,2.6729h-10.4238c.4199-1.0527,1.124-1.9414,2.0957-2.6455,1.0312-.7471,2.2158-1.125,3.5215-1.125Z"/><path d="M197.6885,27.0928c-.5928-1.3408-1.4082-2.5283-2.4238-3.5293s-2.21-1.8086-3.5488-2.4023c-1.3428-.5928-2.7686-.8936-4.2363-.8936-1.4688,0-2.8945.3008-4.2363.8945-1.3408.5928-2.5352,1.4082-3.5508,2.4229-1.0156,1.0166-1.8311,2.2041-2.4219,3.5283-.5938,1.3291-.8955,2.7617-.8955,4.2578,0,1.4697.3018,2.8955.8945,4.2363.5918,1.3398,1.4004,2.5342,2.4023,3.5498,1.001,1.0156,2.1885,1.8311,3.5293,2.4229,1.3408.5938,2.7803.8955,4.2783.8955,1.4971,0,2.9365-.3018,4.2783-.8955,1.3379-.5908,2.5254-1.4062,3.5293-2.4229,1.002-1.0176,1.8105-2.2119,2.4014-3.5498.5938-1.3418.8945-2.7676.8945-4.2363,0-1.4961-.3008-2.9355-.8945-4.2783ZM194.2539,31.3711c0,.8965-.1865,1.7656-.5537,2.583-.3682.8203-.8672,1.5537-1.4814,2.1807-.6113.626-1.3369,1.1309-2.1572,1.5-1.6299.7354-3.5293.7334-5.1865,0-.833-.3691-1.5654-.874-2.1777-1.501-.6133-.624-1.1113-1.3584-1.4814-2.1797-.3672-.8154-.5527-1.6846-.5527-2.583,0-.9268.1855-1.8096.5527-2.624.3682-.8184.8672-1.5527,1.4814-2.1816.6143-.627,1.3467-1.1318,2.1777-1.499.8301-.3672,1.7061-.5537,2.6045-.5537.8975,0,1.7656.1865,2.582.5537.8184.3672,1.5439.8721,2.1572,1.499.6162.6309,1.1143,1.3652,1.4814,2.1816s.5537,1.6992.5537,2.624Z"/><path d="M277.1679,20.7705v3.5947c-.1484-.3594-.3379-.7051-.5664-1.0332-.4268-.6113-.9531-1.1455-1.5664-1.5889-.6123-.4395-1.3105-.7861-2.0781-1.0283-.7676-.2402-1.5879-.3633-2.4375-.3633-1.4717,0-2.876.3018-4.1758.8945-1.2969.5928-2.4482,1.4014-3.4229,2.4033-.9756,1.0039-1.7559,2.1846-2.3174,3.5088-.5654,1.3262-.8525,2.7578-.8525,4.2549s.2939,2.9355.873,4.2773c.5771,1.3389,1.3643,2.5332,2.3379,3.5488.9746,1.0176,2.127,1.833,3.4238,2.4248,1.3008.5938,2.7061.8955,4.1758.8955.8525,0,1.666-.1299,2.4189-.3867.7539-.2559,1.4443-.6084,2.0547-1.0479.6123-.4424,1.1396-.9688,1.5654-1.5674.2285-.3193.4189-.6592.5674-1.0156v3.5557h4.2881v-21.3271h-4.2881ZM277.1679,31.4971c0,.8965-.1787,1.7666-.5332,2.585-.3535.8164-.8311,1.543-1.418,2.1592-.5879.6133-1.2861,1.1104-2.0752,1.4785-.7871.3662-1.6406.5518-2.5381.5518s-1.752-.1855-2.5391-.5518c-.791-.3691-1.4883-.873-2.0732-1.499-.5859-.626-1.0635-1.3594-1.4189-2.1807-.3545-.8164-.5332-1.7002-.5332-2.627,0-.8994.1787-1.7686.5332-2.584.3545-.8193.832-1.5459,1.418-2.1592s1.2842-1.1113,2.0742-1.4795c.7891-.3662,1.6436-.5518,2.5391-.5518s1.749.1855,2.5381.5518c.79.3682,1.4883.8652,2.0752,1.4795.5859.6143,1.0635,1.3467,1.418,2.1787.3535.833.5332,1.7246.5332,2.6484Z"/><path d="M325.6362,30.5322c0-1.4395-.2363-2.792-.7021-4.0186-.4668-1.2285-1.1328-2.3184-1.9814-3.2393-.8516-.9209-1.8779-1.6455-3.0518-2.1553-1.1729-.5088-2.4854-.7676-3.8994-.7676-1.5234,0-2.9697.2939-4.2988.873-1.3242.5771-2.498,1.3789-3.4883,2.3818-.9893,1.0039-1.7764,2.1914-2.3398,3.5303-.5645,1.3398-.8516,2.793-.8516,4.3184,0,1.5244.2939,2.9775.873,4.3193.5781,1.3398,1.3867,2.5273,2.4033,3.5303,1.0186,1.0039,2.2197,1.8047,3.5723,2.3818,1.3555.5791,2.8154.873,4.3398.873.7559,0,1.4971-.0576,2.2051-.1699.7109-.1143,1.4277-.3154,2.1309-.5967.7041-.2812,1.4395-.667,2.1865-1.1465.7441-.4775,1.5488-1.1035,2.3906-1.8613l.1104-.0996-2.8467-3.208-.1123.1094c-.9033.877-1.8984,1.5508-2.9561,2.0049-1.8594.7969-3.8311.9082-5.5518.249-.75-.2852-1.4268-.6855-2.0127-1.1904-.584-.501-1.0742-1.1084-1.4561-1.8047-.3555-.6484-.5957-1.3701-.7139-2.1484h16.0508v-2.165ZM316.0015,24.6387c1.2725,0,2.3477.3691,3.1963,1.0977.8076.6904,1.3486,1.5889,1.6104,2.6729h-10.4238c.4199-1.0527,1.124-1.9414,2.0957-2.6455,1.0312-.7471,2.2158-1.125,3.5215-1.125Z"/><path d="M166.4876,20.8306c-1.3228,0-2.583.2666-3.7456.793-1.0366.4688-2.1826,1.21-3.4106,2.2051-.4897-.8643-1.1719-1.5654-2.0337-2.0859-1.0039-.6045-2.2329-.9121-3.6533-.9121-1.23,0-2.4053.2588-3.4917.7686-.8457.3955-1.7031.9209-2.5571,1.5654v-1.7822h-4.1484v20.6982h4.1484v-15.0576c.8398-.6299,1.6895-1.1562,2.5288-1.5674.8604-.4219,1.7271-.6357,2.5757-.6357.894,0,1.5771.1143,2.0298.3398.439.2207.7671.541,1.001.9775.2231.4268.3735,1.0146.4458,1.75.0752.7734.1138,1.6025.1138,2.4639v11.7295h4.1484v-13.1367c0-.3652-.0117-.7334-.0366-1.1045-.0181-.2734-.0391-.5225-.0635-.7461.853-.6436,1.7163-1.1855,2.5688-1.6133.8774-.4385,1.7646-.6602,2.6357-.6602.8931,0,1.5752.1162,2.0264.3467.4409.2266.7695.5508,1.0044.9883.2231.4268.3735,1.0186.4458,1.7598.0752.7783.1138,1.5977.1138,2.4365v11.7295h4.1484v-13.3145c0-2.4561-.5532-4.4053-1.644-5.7959-1.1138-1.4199-2.8467-2.1396-5.1504-2.1396Z"/><polygon points="304.5262 21.3994 299.1658 21.3994 290.0618 29.9618 290.0618 13.5801 285.9134 13.5801 285.9134 42.0977 290.0618 42.0977 290.0618 35.2246 291.8157 33.5566 299.6394 42.0977 305.1492 42.0977 294.867 31.0029 304.5262 21.3994"/><path d="M213.1419,20.5697c-.4984-.1171-1.0012-.1773-1.4963-.1773-1.2421-.0268-2.3805.3155-3.394,1.0224-.6812.4739-1.2432,1.0715-1.6814,1.7851v-2.3425h-4.5792v21.6627h4.5792v-12.4765c0-1.4952.4226-2.7306,1.2555-3.6705.8385-.9433,1.9623-1.4015,3.4363-1.4015.6155,0,1.3826.1371,2.2801.4092l.2765.0836,1.2532-4.3417-.2654-.0836c-.6378-.2029-1.183-.3557-1.6646-.4694Z"/><path d="M236.5667,44.8247v-24.0542h-4.2881v10.9365c0,.8193-.1309,1.6377-.3906,2.4297-.2598.79-.6328,1.502-1.1094,2.1162-.4756.6104-1.0391,1.1055-1.6777,1.4727-.6299.3623-1.3467.5459-2.1279.5459-.7822,0-1.5059-.1836-2.1514-.5469-.6504-.3662-1.2139-.8613-1.6738-1.4707-.4639-.6133-.8301-1.3252-1.0889-2.1172-.2598-.792-.3916-1.6094-.3916-2.4297v-10.9365h-4.2871v10.9365c0,1.4111.2432,2.7842.7227,4.0811.4795,1.2988,1.1455,2.4648,1.9775,3.4639.834,1.0049,1.8427,1.6301,3.0028,2.2238,1.1631.5957,2.4434.8984,3.8037.8984,1.4297,0,2.6753-.341,3.7046-1.2141.7637-.6465,1.3307-1.3867,1.6872-2.374v4.4994c0,.85-.6891,1.5392-1.5391,1.5392h-10.7856v4.2881h12.3248c2.3683,0,4.2881-1.9199,4.2881-4.2881h-.0001Z"/><polygon points="246.2329 37.7709 246.2329 11.0809 241.943 11.0809 241.943 42.101 254.9129 42.101 259.2429 42.101 259.2429 37.7709 246.2329 37.7709"/><path d="M55.0575,18.4539c.2562,0,.516.0247.7769.076,2.1677.4267,3.5791,2.53,3.1525,4.6979-.3754,1.9069-2.0481,3.2287-3.9207,3.2287-.2562,0-.516-.0247-.7769-.076-2.1677-.4267-3.5791-2.53-3.1525-4.6978.3752-1.9069,2.0481-3.2286,3.9207-3.2288M55.0577,13.9539h-.0004c-4.0479.0002-7.5536,2.8853-8.3358,6.8598-.905,4.5989,2.0999,9.0768,6.6986,9.9821.542.1067,1.0958.1608,1.646.1608,4.0477,0,7.5535-2.8848,8.3359-6.8595.905-4.5992-2.1-9.0771-6.6986-9.9824-.542-.1067-1.0957-.1608-1.6458-.1608h0Z"/><path d="M36.3167,11.0097c1.238.8378,2.3176,1.9098,3.1843,3.1805l6.3955-6.3953,2.2026,4.901c1.2195-.8717,2.6025-1.5158,4.0862-1.8839L47.3262,0l-11.0095,11.0097Z"/><path d="M68.5957,47.3271l-6.7365-14.9893c-1.233.85-2.6307,1.463-4.1212,1.8055l3.9026,8.6838h-9.1228c.2798,1.4681.2839,2.9891-.0046,4.5h16.0825Z"/><path d="M10.8633,42.8271l11.9641-11.9638c-1.2341-.8425-2.3118-1.9159-3.1737-3.1903L0,47.3271h28.9408c-.28-1.468-.2843-2.9891.0045-4.5H10.8633Z"/><path d="M29.5874,16.9497c.2562,0,.516.0247.7769.076,2.1677.4267,3.5791,2.53,3.1525,4.6978-.3752,1.907-2.0481,3.2288-3.9207,3.2288-.2562,0-.516-.0247-.7769-.076-2.1677-.4267-3.5791-2.53-3.1525-4.6978.3752-1.907,2.048-3.2286,3.9207-3.2288M29.5875,12.4497h-.0002c-4.0479.0002-7.5536,2.8852-8.3358,6.8598-.9052,4.5989,2.0999,9.0768,6.6986,9.9821.542.1067,1.0958.1608,1.646.1608,4.048,0,7.5537-2.8849,8.3359-6.8598.9052-4.5989-2.1-9.0768-6.6986-9.9821-.542-.1067-1.0957-.1608-1.6459-.1608h0Z"/><polygon points="52.9154 26.5534 50.0736 23.0651 43.4227 28.4828 34.5389 21.8268 31.8406 25.4284 40.9568 32.2585 39.1214 40.1598 43.5042 41.1774 45.4982 32.5955 52.9154 26.5534"/><path d="M40.7249,41.0755c.2562,0,.516.0247.7769.076,2.1677.4267,3.5792,2.53,3.1525,4.6978-.3752,1.907-2.048,3.2288-3.9205,3.2288-.2562,0-.516-.0247-.7769-.076-2.1677-.4267-3.5792-2.53-3.1525-4.6978.3752-1.907,2.0481-3.2286,3.9205-3.2288M40.7252,36.5755h-.0002c-4.048.0002-7.5537,2.8852-8.3359,6.8598-.4386,2.2276.0167,4.4929,1.282,6.3783,1.2651,1.8854,3.1888,3.1652,5.4166,3.6038.542.1067,1.0958.1608,1.646.1608,4.0479,0,7.5536-2.8849,8.3358-6.8598.4386-2.2276-.0167-4.4929-1.282-6.3783-1.2651-1.8854-3.1888-3.1652-5.4166-3.6038-.542-.1067-1.0956-.1608-1.6456-.1608h0Z"/><path d="M187.4793,42.5206c-1.4961,0-2.936-.3018-4.2793-.8955-1.3413-.5928-2.5269-1.4072-3.5293-2.4229-1.0024-1.0166-1.8101-2.2109-2.4004-3.5488-.5947-1.3447-.8955-2.7686-.8955-4.2373,0-1.4951.3013-2.9277.896-4.2578.5908-1.3252,1.4048-2.5107,2.4209-3.5273,1.0146-1.0146,2.2104-1.8311,3.5513-2.4238,1.3423-.5938,2.7666-.8945,4.2363-.8945,1.4678,0,2.8936.3008,4.2373.8936,1.3364.5928,2.5342,1.4033,3.5488,2.4023,1.0146,1.001,1.8306,2.1885,2.4229,3.5293.5938,1.3428.8945,2.7822.8945,4.2783,0,1.4697-.3008,2.8945-.8945,4.2354-.5908,1.3389-1.3984,2.5322-2.4019,3.5518-1.0015,1.0137-2.1909,1.8311-3.5288,2.4219-1.3442.5947-2.7817.8955-4.2783.8955ZM187.4793,24.5577c-.9038,0-1.7856.1885-2.6206.5615-.8154.3613-1.5444.8623-2.1562,1.4854-.6235.6396-1.1187,1.3701-1.4863,2.1855-.3687.8252-.5532,1.7041-.5532,2.626,0,.8857.1807,1.7441.5376,2.5488.3843.8555.8833,1.5898,1.4971,2.2139.6025.6191,1.3408,1.1299,2.1748,1.5.8438.3672,1.7314.5518,2.6079.5518.8628,0,1.6963-.1699,2.4775-.5049.0342-.0146.0679-.0293.1016-.0449.8257-.3721,1.5552-.8799,2.168-1.5098.6064-.6182,1.1099-1.3594,1.4775-2.1836.3564-.7783.5488-1.6602.5488-2.5713,0-.959-.1997-1.8711-.5938-2.7109-.3267-.7275-.8223-1.459-1.4336-2.0869-.6201-.6348-1.3413-1.1367-2.1533-1.501-.8208-.3711-1.6929-.5596-2.5938-.5596Z"/></svg>';

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemoryLake</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --card: #f5f5f7; --surface: #fff; --text: #1d1d1f; --muted: #6e6e73; --line: rgba(0,0,0,.1); --fill: rgba(120,120,128,.2); --accent: #0071e3; --accent-text: #fff; --bad: #d70015; --ok: #34c759; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --card: #1d1d1f; --surface: rgba(255,255,255,.04); --text: #f5f5f7; --muted: #a1a1a6; --line: rgba(255,255,255,.16); --fill: rgba(120,120,128,.36); --accent: #2997ff; --bad: #ff6961; --ok: #30d158; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 16px; background: var(--bg); color: var(--text); font: 15px/1.5 Inter, -apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
  .logo { display: block; height: 24px; width: auto; margin: 0 auto 28px; }
  main { width: 100%; max-width: 420px; background: var(--card); border-radius: 18px; padding: 40px 32px 32px; }
  @media (max-width: 440px) { main { padding: 32px 20px 24px; } }
  h1 { font-size: 28px; line-height: 1.15; font-weight: 600; letter-spacing: -.015em; text-align: center; margin: 0 0 8px; }
  .sub { color: var(--muted); text-align: center; margin: 0 0 28px; text-wrap: balance; }
  .note { color: var(--muted); font-size: 13px; text-align: center; margin: 12px 0 0; text-wrap: balance; }
  .note:empty { display: none; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .btn { display: flex; align-items: center; justify-content: center; width: 100%; height: 48px; padding: 0 22px; font: inherit; font-size: 17px; color: var(--accent-text); background: var(--accent); border: 0; border-radius: 980px; cursor: pointer; text-decoration: none; }
  .btn:hover { text-decoration: none; filter: brightness(1.08); }
  .btn.secondary { color: var(--text); background: var(--surface); border: 1px solid var(--line); }
  .btn[disabled] { opacity: .55; cursor: progress; filter: none; }
  .link { display: block; width: fit-content; margin: 16px auto 0; padding: 4px; font: inherit; color: var(--accent); background: none; border: 0; cursor: pointer; }
  .link:hover { text-decoration: underline; }
  .stack { display: grid; gap: 12px; }
  input[type=password], input[type=text] { width: 100%; height: 44px; padding: 0 14px; font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
  input::placeholder { color: var(--muted); }
  .list { display: grid; gap: 8px; max-height: 300px; overflow: auto; margin: 0 0 20px; padding: 2px; }
  .choice { display: flex; gap: 12px; align-items: center; padding: 13px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; cursor: pointer; }
  .choice:has(input:checked) { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .choice input { margin: 0; accent-color: var(--accent); flex: none; }
  .choice span { min-width: 0; }
  .choice small { display: block; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .new-name { margin: -2px 0 0; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input[type=text]:focus-visible, input[type=password]:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  .choice:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .error { color: var(--bad); font-size: 14px; margin: 0 0 14px; overflow-wrap: anywhere; }
  .spinner { width: 28px; height: 28px; margin: 4px auto 20px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
  .check { display: block; width: 44px; height: 44px; margin: 0 auto 18px; color: var(--ok); }
  .summary { margin: 0 0 24px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
  .summary div { display: flex; justify-content: space-between; gap: 16px; padding: 12px 16px; }
  .summary div + div { border-top: 1px solid var(--line); }
  .summary dt { color: var(--muted); flex: none; }
  .summary dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  /* Memory settings: one grouped card, a switch per feature. */
  .group { margin: 0 0 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .row { position: relative; display: flex; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .row + .row::before, .picks + .row::before { content: ""; position: absolute; top: 0; left: 58px; right: 0; border-top: 1px solid var(--line); }
  .row .text { flex: 1; min-width: 0; }
  .row .title { display: block; }
  .row small { display: block; color: var(--muted); font-size: 13px; line-height: 1.35; margin-top: 1px; }
  .icon { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; color: var(--accent); background: color-mix(in srgb, var(--accent) 13%, transparent); transition: color .2s, background-color .2s; }
  .icon svg { width: 18px; height: 18px; }
  .row:has(.switch:not(:checked)) .icon { color: var(--muted); background: var(--fill); }
  .row:has(.switch:disabled) { cursor: default; }
  .row:has(.switch:disabled) .text { opacity: .45; }
  .switch { flex: none; appearance: none; -webkit-appearance: none; position: relative; width: 44px; height: 26px; margin: 0; border-radius: 13px; background: var(--fill); cursor: pointer; transition: background-color .2s; }
  .switch::before { content: ""; position: absolute; top: 2px; left: 2px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08); transition: transform .22s cubic-bezier(.3,.7,.4,1); }
  .switch:checked { background: var(--accent); }
  .switch:checked::before { transform: translateX(18px); }
  .switch:disabled { opacity: .45; cursor: default; }
  .switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .disclosure { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0 14px 12px 58px; font: inherit; font-size: 13px; color: var(--accent); background: none; border: 0; cursor: pointer; text-align: left; }
  .disclosure .count { color: var(--muted); }
  .disclosure svg { width: 12px; height: 12px; margin-left: auto; color: var(--muted); transition: transform .22s ease; }
  .disclosure[aria-expanded=true] svg { transform: rotate(90deg); }
  .disclosure:disabled { visibility: hidden; height: 0; padding-bottom: 0; }
  .picks { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .25s ease; }
  .picks.open { grid-template-rows: 1fr; }
  .picks > div { overflow: hidden; min-height: 0; }
  .picks.open > div { overflow-y: auto; max-height: 232px; overscroll-behavior: contain; }
  .pick { display: flex; gap: 10px; align-items: flex-start; padding: 8px 14px 8px 58px; cursor: pointer; }
  .pick:last-child { padding-bottom: 14px; }
  .pick span { min-width: 0; font-size: 14px; }
  .pick small { display: block; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .tick { flex: none; appearance: none; -webkit-appearance: none; position: relative; width: 18px; height: 18px; margin: 2px 0 0; border: 1.5px solid var(--fill); border-radius: 5px; background: transparent; cursor: pointer; transition: background-color .15s, border-color .15s; }
  .tick:checked { border-color: var(--accent); background: var(--accent); }
  .tick:checked::after { content: ""; position: absolute; left: 4.75px; top: 1.5px; width: 4px; height: 8px; border: solid #fff; border-width: 0 1.75px 1.75px 0; border-radius: 0 0 1px 0; transform: rotate(45deg); }
  .tick:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .row-error { margin: -4px 0 12px; padding: 0 4px; font-size: 13px; color: var(--bad); }
  .row-error a { margin-left: 4px; }
  #memory-note { margin: 0 0 20px; }
  @media (prefers-reduced-motion: reduce) { .switch, .switch::before, .picks, .disclosure svg, .icon { transition: none; } }
  [hidden] { display: none !important; }
</style>
</head>
<body>
${LOGO}
<main>
  <section id="step-login">
    <h1 data-t="title"></h1>
    <p class="sub" id="intro" data-t="intro"></p>
    <div class="spinner" id="login-check" aria-hidden="true"></div>
    <div id="existing-part" hidden>
      <dl class="summary" id="existing-summary"></dl>
      <p class="error" id="existing-error" role="alert" hidden></p>
      <button type="button" class="btn" id="existing-button" data-t="keepAccount"></button>
      <button type="button" class="link" id="other-account" data-t="otherAccount"></button>
    </div>
    <form id="login-form" autocomplete="off" hidden>
      <div id="browser-part" hidden>
        <p class="error" id="browser-error" role="alert" hidden></p>
        <button type="button" class="btn" id="browser-button" data-t="browser"></button>
        <button type="button" class="link" id="show-key" data-t="useKey"></button>
      </div>
      <div id="key-part">
        <div class="stack">
          <input id="api-key" type="password" name="api-key" spellcheck="false" autocapitalize="off" autocomplete="off">
          <p class="error" id="login-error" role="alert" hidden></p>
          <button type="submit" class="btn" id="login-button" data-t="connect"></button>
        </div>
        <p class="note"><a id="console-link" target="_blank" rel="noopener noreferrer" data-t="openConsole"></a></p>
        <button type="button" class="link" id="show-browser" data-t="useBrowser"></button>
      </div>
      <p class="note" id="switch-note" data-t="switchNote" hidden></p>
    </form>
  </section>

  <section id="step-wait" hidden>
    <div class="spinner" aria-hidden="true"></div>
    <h1 data-t="waitTitle"></h1>
    <p class="sub" data-t="waitIntro"></p>
    <p class="error" id="wait-error" role="alert" hidden></p>
    <button type="button" class="btn secondary" id="cancel-button" data-t="cancel"></button>
    <a class="link" id="reopen" target="_blank" rel="noopener noreferrer" data-t="reopen"></a>
  </section>

  <section id="step-workspace" hidden>
    <h1 data-t="pickTitle"></h1>
    <p class="sub" data-t="pickIntro"></p>
    <form id="workspace-form">
      <div class="list" id="workspaces"></div>
      <p class="error" id="workspace-error" role="alert" hidden></p>
      <button type="submit" class="btn" id="workspace-button" data-t="useWorkspace"></button>
    </form>
  </section>

  <section id="step-memory" hidden>
    <h1 data-t="memoryTitle"></h1>
    <p class="sub" data-t="memoryIntro"></p>
    <form id="memory-form">
      <div class="group" id="memory-options"></div>
      <p class="row-error" id="import-error" role="alert" hidden><span></span><a id="quota-link" target="_blank" rel="noopener noreferrer" data-t="quotaLink" hidden></a></p>
      <p class="note" id="memory-note"></p>
      <p class="error" id="memory-error" role="alert" hidden></p>
      <button type="submit" class="btn" id="memory-button" data-t="memoryGo"></button>
    </form>
  </section>

  <section id="step-done" hidden>
    <svg class="check" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="22" fill="currentColor"/><path d="M13 22.5l6 6 12-13" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <h1 data-t="doneTitle"></h1>
    <p class="sub" data-t="doneIntro"></p>
    <dl class="summary" id="summary" hidden></dl>
  </section>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const CONSOLE = ${JSON.stringify(TARGET.console)};
const BROWSER_LOGIN = ${JSON.stringify(browserLoginSupported)};
const TEXT = {
  en: {
    title: "Connect MemoryLake", intro: "Sign in so WorkBuddy can use your memory.",
    browser: "Sign in with browser", starting: "Opening MemoryLake...", useKey: "Use an API key instead",
    introExisting: "This computer is already signed in to MemoryLake.",
    keepAccount: "Continue with this account", otherAccount: "Sign in with another account",
    switchNote: "Other MemoryLake tools on this computer will switch to the new account too.",
    rowAccount: "Account", rowServer: "Server",
    apiKey: "Paste your API key", useBrowser: "Sign in with browser instead", openConsole: "Get an API key", connect: "Connect", connecting: "Checking...",
    waitTitle: "Continue in your browser", waitIntro: "Approve in the MemoryLake tab. This page continues by itself.",
    reopen: "Open it again", cancel: "Cancel",
    pickTitle: "Choose a workspace", pickIntro: "Your memory is kept here.",
    newWorkspace: "New workspace", newName: "WorkBuddy", nameNeeded: "Enter a name for the new workspace.",
    useWorkspace: "Continue", saving: "Saving...", creating: "Creating...",
    doneTitle: "You're connected", doneIntro: "You can close this page and go back to WorkBuddy.",
    rowWorkspace: "Workspace", rowImport: "Imported", rowAuto: "Automatic memory",
    autoPlugin: "On, via the MemoryLake plugin", autoOff: "Off", featureSep: ", ", sentenceSep: " ",
    featRecall: "Recall", featConversations: "Conversations", featAttachments: "Files",
    files: " files", importFailed: " failed",
    lost: "This page lost contact with WorkBuddy. Reconnect MemoryLake from WorkBuddy.",
    refused: "MemoryLake did not accept this key. Check that it is complete and from app.memorylake.cn.",
    memoryTitle: "Your memory", memoryIntro: "Everything is on. Turn off what you don't need.",
    optRecall: "Recall before answering", optRecallDetail: "Searches MemoryLake first",
    optConversations: "Save conversations", optConversationsDetail: "Your messages and the replies, not tool output",
    optAttachments: "Save files you send", optAttachmentsDetail: "Documents and images, up to 20 MB each",
    optAttachmentsNeeds: "Needs Save conversations",
    optImport: "Import existing memory", optImportDetail: "WorkBuddy's memory files on this computer",
    pickContent: "Choose what to import", pickNone: "Choose at least one item, or turn import off.",
    noteStart: "Starts with your next new conversation.", noteImport: "Lines that look like passwords are never imported.",
    pluginNote: "Automatic memory comes from the MemoryLake plugin.",
    memoryGo: "Done", importing: "Importing...", applying: "Turning on...",
    kindProfile: "Your profile", kindAccount: "Account memory", kindGlobal: "Long-term memory",
    kindWorkspace: "Workspace memory: ", kindNotes: "Daily notes: ",
    updated: "updated ", removed: " lines skipped", stored: "will replace the copy in MemoryLake",
    importQuota: "Out of quota, so import was turned off. You can import later.", quotaLink: "View plans",
  },
  zh: {
    title: "连接 MemoryLake", intro: "登录后，WorkBuddy 即可使用你的记忆。",
    browser: "使用浏览器登录", starting: "正在打开 MemoryLake……", useKey: "改用 API key",
    introExisting: "这台电脑已登录 MemoryLake。",
    keepAccount: "继续使用此账号", otherAccount: "使用其他账号登录",
    switchNote: "这台电脑上其他用到 MemoryLake 的工具也会改用新账号。",
    rowAccount: "账号", rowServer: "服务器",
    apiKey: "粘贴 API key", useBrowser: "改用浏览器登录", openConsole: "获取 API key", connect: "连接", connecting: "正在校验……",
    waitTitle: "在浏览器中继续", waitIntro: "在 MemoryLake 页面确认授权，本页会自动继续。",
    reopen: "重新打开", cancel: "取消",
    pickTitle: "选择工作区", pickIntro: "你的记忆将保存在这里。",
    newWorkspace: "新建工作区", newName: "WorkBuddy", nameNeeded: "请输入新工作区的名称。",
    useWorkspace: "继续", saving: "正在保存……", creating: "正在创建……",
    doneTitle: "已连接", doneIntro: "可以关闭此页面，回到 WorkBuddy。",
    rowWorkspace: "工作区", rowImport: "已导入", rowAuto: "自动记忆",
    autoPlugin: "已开启（MemoryLake 套件）", autoOff: "未开启", featureSep: "、", sentenceSep: "",
    featRecall: "查记忆", featConversations: "对话", featAttachments: "文件",
    files: " 个文件", importFailed: " 个失败",
    lost: "此页面已与 WorkBuddy 断开，请回到 WorkBuddy 重新连接。",
    refused: "MemoryLake 未接受这个 key，请确认它完整且来自 app.memorylake.cn。",
    memoryTitle: "记忆设置", memoryIntro: "已全部开启，不需要的可以关掉。",
    optRecall: "回答前先查记忆", optRecallDetail: "先在 MemoryLake 里搜索",
    optConversations: "自动保存对话", optConversationsDetail: "你的消息和回复，不含工具输出",
    optAttachments: "自动保存发送的文件", optAttachmentsDetail: "文档和图片，单个不超过 20 MB",
    optAttachmentsNeeds: "需要先开启“自动保存对话”",
    optImport: "导入已有记忆", optImportDetail: "WorkBuddy 在本机的记忆文件",
    pickContent: "选择导入内容", pickNone: "请至少选择一项，或关闭导入。",
    noteStart: "从下一个新对话开始生效。", noteImport: "疑似密码的内容不会导入。",
    pluginNote: "自动记忆由 MemoryLake 套件提供。",
    memoryGo: "完成", importing: "正在导入……", applying: "正在开启……",
    kindProfile: "个人档案", kindAccount: "账号记忆", kindGlobal: "长期记忆",
    kindWorkspace: "工作区记忆：", kindNotes: "每日笔记：",
    updated: "更新于 ", removed: " 行已跳过", stored: "将替换 MemoryLake 中的旧版本",
    importQuota: "账号额度不足，已关闭导入，之后可以再导入。", quotaLink: "查看套餐",
  },
};
const t = TEXT[(navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en"];
document.documentElement.lang = t === TEXT.zh ? "zh-CN" : "en";
document.title = t.title;
for (const node of document.querySelectorAll("[data-t]")) node.textContent = t[node.dataset.t];

const $ = (id) => document.getElementById(id);
const show = (id) => { for (const s of document.querySelectorAll("section")) s.hidden = s.id !== id; };
const fail = (id, message) => { const node = $(id); node.textContent = message; node.hidden = !message; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = (button, text) => { button.dataset.idle ??= button.textContent; button.disabled = !!text; button.textContent = text || button.dataset.idle; };

async function call(action, body) {
  try {
    const response = await fetch("/api/" + action, {
      method: "POST",
      headers: { "content-type": "application/json", "x-login-token": TOKEN },
      body: JSON.stringify(body || {}),
    });
    return await response.json();
  } catch {
    return { ok: false, lost: true, error: t.lost };
  }
}

function choice(type, name, value, title, detail, checked) {
  const label = document.createElement("label");
  label.className = "choice";
  const input = document.createElement("input");
  Object.assign(input, { type, name, value, checked });
  const text = document.createElement("span");
  text.textContent = title;
  if (detail) { const small = document.createElement("small"); small.textContent = detail; text.append(small); }
  label.append(input, text);
  return label;
}

$("console-link").href = CONSOLE || "#";
$("quota-link").href = CONSOLE || "#";
$("console-link").parentElement.hidden = !CONSOLE;

// Browser login or a pasted key: one at a time.
$("api-key").placeholder = t.apiKey;
$("api-key").setAttribute("aria-label", t.apiKey);
function showKeyForm(visible) {
  $("key-part").hidden = !visible;
  $("browser-part").hidden = visible;
  $("show-browser").hidden = !BROWSER_LOGIN;
  $("api-key").required = visible;
}
showKeyForm(!BROWSER_LOGIN);
$("show-key").addEventListener("click", () => { showKeyForm(true); $("api-key").focus(); });
$("show-browser").addEventListener("click", () => showKeyForm(false));

// A login already on this computer (another MemoryLake tool's, or an earlier
// connect's): keep it with one click, or sign in with another account.
call("existing").then((result) => {
  $("login-check").hidden = true;
  const existing = result.ok && result.existing;
  if (!existing) { $("login-form").hidden = false; return; }
  $("intro").textContent = t.introExisting;
  row(t.rowAccount, existing.account, $("existing-summary"));
  row(t.rowServer, existing.host, $("existing-summary"));
  $("existing-part").hidden = false;
});
$("other-account").addEventListener("click", () => {
  $("existing-part").hidden = true;
  $("intro").textContent = t.intro;
  $("login-form").hidden = false;
  $("switch-note").hidden = false;
});

let workspaceInUse = null;
let imported = null;
function row(term, value, list = $("summary")) {
  const div = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term; dd.textContent = value;
  div.append(dt, dd);
  list.append(div);
}
function features(settings = {}) {
  const on = [settings.recall && t.featRecall, settings.conversations && t.featConversations, settings.attachments && t.featAttachments];
  return on.filter(Boolean).join(t.featureSep) || t.autoOff;
}
async function finish(auto) {
  if (workspaceInUse) row(t.rowWorkspace, workspaceInUse.name);
  if (imported) row(t.rowImport, imported.imported + t.files + (imported.failed.length ? ", " + imported.failed.length + t.importFailed : ""));
  if (workspaceInUse || auto) {
    row(t.rowAuto, auto?.state === "plugin" ? t.autoPlugin : auto?.state === "on" ? features(auto.settings) : t.autoOff);
  }
  $("summary").hidden = !$("summary").children.length;
  show("step-done");
  await call("finish");
}

const KIND = { profile: "kindProfile", account: "kindAccount", global: "kindGlobal", workspace: "kindWorkspace", notes: "kindNotes" };
function describe(group) {
  const size = group.bytes < 1024 ? group.bytes + " B" : Math.round(group.bytes / 1024) + " KB";
  const parts = [(group.count > 1 ? group.count + t.files + ", " : "") + size, t.updated + new Date(group.modified).toLocaleDateString()];
  if (group.removed) parts.push(group.removed + t.removed);
  if (group.stored) parts.push(t.stored);
  return parts.join(" · ");
}

// Line icons for the memory switches, drawn in the text colour of their tile.
const ICONS = {
  recall: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  conversations: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17h-1A.5.5 0 0 1 4 16.5z"/>',
  attachments: '<path d="M20 11.5l-7.9 7.9a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.65 1.65 0 0 1-2.35-2.35l7.6-7.6"/>',
  import: '<path d="M12 4v10.5"/><path d="M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 15.5v2.5A2 2 0 0 0 6 20h12a2 2 0 0 0 2-2v-2.5"/>',
};
const CHEVRON = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';

function toggleRow(name, icon, title, detail, checked) {
  const label = document.createElement("label");
  label.className = "row";
  const tile = document.createElement("span");
  tile.className = "icon";
  tile.setAttribute("aria-hidden", "true");
  tile.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + icon + "</svg>";
  const text = document.createElement("span");
  text.className = "text";
  const heading = document.createElement("span");
  heading.className = "title";
  heading.textContent = title;
  const small = document.createElement("small");
  small.textContent = detail;
  text.append(heading, small);
  const input = Object.assign(document.createElement("input"), { type: "checkbox", name, checked, className: "switch" });
  input.setAttribute("role", "switch");
  label.append(tile, text, input);
  $("memory-options").append(label);
  return { label, input, small };
}

let memory = null;
function importError(message, quota) {
  const node = $("import-error");
  node.firstChild.textContent = message || "";
  $("quota-link").hidden = !(quota && CONSOLE);
  node.hidden = !message;
}

// WorkBuddy's own memory files: one switch, and the files behind a
// disclosure for whoever wants to choose.
function addImport(groups) {
  const toggle = toggleRow("import", ICONS.import, t.optImport, t.optImportDetail, true);
  const button = document.createElement("button");
  Object.assign(button, { type: "button", className: "disclosure" });
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "picks");
  const label = document.createElement("span");
  label.textContent = t.pickContent;
  const count = document.createElement("span");
  count.className = "count";
  button.append(label, count);
  button.insertAdjacentHTML("beforeend", CHEVRON);
  const picks = document.createElement("div");
  Object.assign(picks, { id: "picks", className: "picks", inert: true });
  const inner = document.createElement("div");
  for (const group of groups) {
    const item = document.createElement("label");
    item.className = "pick";
    const input = Object.assign(document.createElement("input"), { type: "checkbox", name: "group", value: group.id, checked: group.suggested, className: "tick" });
    const text = document.createElement("span");
    text.textContent = t[KIND[group.kind]] + group.label;
    const small = document.createElement("small");
    small.textContent = describe(group);
    text.append(small);
    item.append(input, text);
    inner.append(item);
  }
  picks.append(inner);
  $("memory-options").append(button, picks);

  const tally = () => {
    const boxes = picks.querySelectorAll("input");
    count.textContent = [...boxes].filter((box) => box.checked).length + "/" + boxes.length;
  };
  const expand = (open) => {
    picks.classList.toggle("open", open);
    picks.inert = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", () => expand(!picks.classList.contains("open")));
  picks.addEventListener("change", () => { tally(); importError(""); });
  toggle.input.addEventListener("change", () => {
    button.disabled = !toggle.input.checked;
    if (!toggle.input.checked) expand(false);
    importError("");
  });
  tally();
  memory.importing = { toggle, picks, expand };
}

// With a workspace to keep it in, show every memory feature this computer
// can have, all on except what the user turned off on an earlier connect.
async function openMemory(workspace) {
  workspaceInUse = workspace || null;
  if (!workspace) return finish();
  const [imports, auto] = await Promise.all([call("importScan"), call("autoScan")]);
  const groups = imports.ok ? imports.groups : [];
  const canAuto = auto.ok && (auto.state === "available" || auto.state === "on");
  const plugin = auto.ok && auto.state === "plugin" ? auto : null;
  if (!groups.length && !canAuto) return finish(plugin);
  memory = { canAuto, plugin, switches: null, importing: null };
  if (canAuto) {
    const on = auto.settings || {};
    const sw = {
      recall: toggleRow("recall", ICONS.recall, t.optRecall, t.optRecallDetail, on.recall !== false),
      conversations: toggleRow("conversations", ICONS.conversations, t.optConversations, t.optConversationsDetail, on.conversations !== false),
      attachments: toggleRow("attachments", ICONS.attachments, t.optAttachments, t.optAttachmentsDetail, on.attachments !== false),
    };
    // Files travel with the conversation: without it the switch rests, and
    // comes back as it was when the conversation is turned on again.
    let wanted = sw.attachments.input.checked;
    const follow = () => {
      const allowed = sw.conversations.input.checked;
      if (!allowed && !sw.attachments.input.disabled) wanted = sw.attachments.input.checked;
      sw.attachments.input.disabled = !allowed;
      sw.attachments.input.checked = allowed && wanted;
      sw.attachments.small.textContent = allowed ? t.optAttachmentsDetail : t.optAttachmentsNeeds;
    };
    sw.conversations.input.addEventListener("change", follow);
    follow();
    memory.switches = sw;
  }
  if (groups.length) addImport(groups);
  $("memory-note").textContent = [canAuto && t.noteStart, plugin && t.pluginNote, groups.length && t.noteImport].filter(Boolean).join(t.sentenceSep);
  show("step-memory");
}

$("memory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("memory-button");
  fail("memory-error", "");
  const importing = memory.importing;
  if (importing?.toggle.input.checked && !imported) {
    const ids = [...importing.picks.querySelectorAll("input:checked")].map((box) => box.value);
    if (!ids.length) { importing.expand(true); return importError(t.pickNone); }
    busy(button, t.importing);
    const result = await call("importRun", { ids });
    busy(button);
    if (!result.ok) {
      if (!result.quota) return importError(result.error);
      importing.toggle.input.checked = false;
      importing.toggle.input.dispatchEvent(new Event("change"));
      return importError(t.importQuota, true);
    }
    imported = result;
  }
  let auto = memory.plugin;
  if (memory.canAuto) {
    const sw = memory.switches;
    busy(button, t.applying);
    const result = await call("autoEnable", { settings: {
      recall: sw.recall.input.checked,
      conversations: sw.conversations.input.checked,
      attachments: sw.attachments.input.checked,
    } });
    busy(button);
    if (!result.ok) return fail("memory-error", result.error);
    auto = result;
  }
  finish(auto);
});

// Pick a workspace or make a new one. The new one is the last choice, with
// its name field shown only while it is picked.
const NEW = "+new";
function loggedIn(result) {
  const list = $("workspaces");
  const current = result.workspace?.id || result.current || result.workspaces[0]?.id;
  result.workspaces.forEach((w) => list.append(choice("radio", "workspace", w.id, w.name, "", w.id === current)));
  list.append(choice("radio", "workspace", NEW, t.newWorkspace, "", !result.workspaces.length));
  const name = Object.assign(document.createElement("input"), { type: "text", id: "new-name", className: "new-name", value: t.newName, maxLength: 100 });
  name.setAttribute("aria-label", t.newWorkspace);
  list.append(name);
  const sync = () => { name.hidden = new FormData($("workspace-form")).get("workspace") !== NEW; };
  list.addEventListener("change", (event) => { sync(); if (event.target.value === NEW) name.select(); });
  sync();
  $("workspace-form").workspaces = result.workspaces;
  show("step-workspace");
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("key-part").hidden) return;
  const button = $("login-button");
  busy(button, t.connecting); fail("login-error", "");
  const result = await call("login", { apiKey: $("api-key").value });
  busy(button);
  if (!result.ok) return fail("login-error", result.refused ? t.refused : result.error);
  $("api-key").value = "";
  loggedIn(result);
});

$("existing-button").addEventListener("click", async () => {
  const button = $("existing-button");
  busy(button, t.connecting); fail("existing-error", "");
  const result = await call("useExisting");
  busy(button);
  if (!result.ok) return fail("existing-error", result.error);
  loggedIn(result);
});

let waiting = false;
$("browser-button").addEventListener("click", async () => {
  const button = $("browser-button");
  // Open the tab now, while the click still allows it, and point it at
  // MemoryLake once the CLI has said where.
  const tab = window.open("about:blank", "_blank");
  busy(button, t.starting); fail("browser-error", "");
  const started = await call("browser");
  busy(button);
  if (!started.ok) {
    tab?.close();
    return fail("browser-error", started.error);
  }
  if (!tab) {
    // No new tab allowed: go there in this one. The CLI finishes the login
    // on its own; the default workspace is then picked only if there is one.
    location.href = started.url;
    return;
  }
  tab.opener = null;
  tab.location.href = started.url;
  $("reopen").href = started.url;
  fail("wait-error", "");
  show("step-wait");
  waiting = true;
  while (waiting) {
    await sleep(1500);
    if (!waiting) break;
    const status = await call("browserStatus");
    if (!status.ok) { waiting = false; fail("wait-error", status.error); break; }
    if (status.state === "done") { waiting = false; loggedIn(status); break; }
    if (status.state === "failed") { waiting = false; show("step-login"); fail("browser-error", status.error); break; }
    if (status.state === "cancelled") { waiting = false; show("step-login"); break; }
  }
});

$("cancel-button").addEventListener("click", async () => {
  waiting = false;
  await call("cancel");
  show("step-login");
});

$("workspace-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = new FormData(form).get("workspace");
  const button = $("workspace-button");
  fail("workspace-error", "");
  if (id === NEW) {
    const name = $("new-name").value.trim();
    if (!name) { $("new-name").focus(); return fail("workspace-error", t.nameNeeded); }
    busy(button, t.creating);
    const created = await call("workspaceCreate", { name });
    busy(button);
    if (!created.ok) return fail("workspace-error", created.error);
    return openMemory(created.workspace);
  }
  busy(button, t.saving);
  const result = await call("workspace", { id });
  busy(button);
  if (!result.ok) return fail("workspace-error", result.error);
  openMemory(form.workspaces.find((w) => w.id === id));
});

</script>
</body>
</html>`;
}
