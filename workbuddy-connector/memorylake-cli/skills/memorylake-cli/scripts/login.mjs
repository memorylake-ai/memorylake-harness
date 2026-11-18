#!/usr/bin/env node
// Sign-in page for the memorylake CLI, for hosts that run `auth` without a
// terminal (WorkBuddy's CLI connector).
//
// WorkBuddy runs this command with no terminal and no standard input, reads
// standard output for a URL, opens that URL in the browser, and waits for the
// process to exit (`authWaitForExit`).
//
// So this serves a one-off page on the loopback interface. The user signs in
// to the China deployment (WorkBuddy's users are in China), picks a default
// workspace, may copy the memory files WorkBuddy keeps on this computer into
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
// `login.mjs --disconnect` serves no page: it removes the automatic-memory
// plugin, for the connector's disconnect command.
//
// No dependencies, Node 18+.

import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
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

// `--disconnect`: no page, only the clean-up further down.
const DISCONNECT = process.argv.includes("--disconnect");

// Browser login arrived in the CLI after v20261102; older ones only take a key.
const browserLoginSupported = !DISCONNECT && await cli(["auth", "login", "--help"]).then(
  (result) => result.code === 0 && result.stdout.includes("--no-browser"),
);

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

/** After a login: pick the only workspace, or hand the page the list to pick from. */
async function afterLogin() {
  try {
    const workspaces = await listWorkspaces();
    if (workspaces.length === 1) {
      const picked = await cli(["workspace", "use", workspaces[0].id]);
      if (picked.code === 0) {
        workspaceId = workspaces[0].id;
        return { workspaces: [], workspace: workspaces[0] };
      }
    }
    return { workspaces };
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
        current.result = afterLogin();
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
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (!imported) return { ok: false, error: failed[0]?.error || "nothing was imported", failed };
  return { ok: true, imported, failed };
}


// ---------------------------------------------------------------------------
// Automatic memory.
//
// A connector adds a CLI and skills, so by itself MemoryLake is searched and
// written only when the model decides to. WorkBuddy runs hooks from plugins
// only, so the page offers to install one: `auto-memory/`, the hooks of the
// MemoryLake plugin for WorkBuddy without its commands and skill (generated
// by dev/build-auto-memory.mjs). It is installed with the `codebuddy` CLI
// that ships inside WorkBuddy, the same way WorkBuddy installs any plugin.
// Where and how that CLI is started is not a documented interface (seen in
// 5.11.3), so every failure here leaves the connection itself untouched.
//
// The MemoryLake plugin proper does the same job and more. When it is
// enabled the page installs nothing, and the hooks installed here stand down
// (their run.sh), so the two never both act on a turn.

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
  const candidates = [process.env.MEMORYLAKE_WORKBUDDY_CLI];
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
  // The hooks are shell scripts that read their input with jq.
  for (const tool of ["bash", "jq"]) {
    if ((await run(tool, ["--version"])).code !== 0) return { state: "unavailable", reason: tool };
  }
  if ((await autoMemoryInstalled()) && enabled[AUTO_PLUGIN] !== false) return { state: "on" };
  return { state: "available" };
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
 * Write the configuration the hooks read. One that another MemoryLake harness
 * already wrote keeps its workspace and actor, and every switch it sets.
 */
async function writeHarnessConfig(workspace) {
  const path = join(HARNESS_HOME, "config.md");
  const text = await readFile(path, "utf8").catch(() => "");
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const value = (key) => front?.[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1].trim() || "";
  let next;
  let used = workspace;
  if (value("workspace")) {
    used = value("workspace");
    const missing = ["sync_conversations", "recall_reminder", "recall_gate"]
      .filter((key) => !new RegExp(`^${key}:`, "m").test(front[1]))
      .map((key) => `${key}: true`);
    if (!missing.length) return used;
    next = text.replace(front[0], `---\n${front[1]}\n${missing.join("\n")}\n---`);
  } else {
    const actor = await resolveActor(workspace);
    next = ["---", "enabled: true", `workspace: ${workspace}`, `actor: ${actor}`, "sync_on_write: true",
      "sync_conversations: true", "recall_reminder: true", "recall_gate: true", "status_line: true", "---", ""].join("\n");
  }
  await mkdir(HARNESS_HOME, { recursive: true });
  await writeFile(`${path}.tmp`, next);
  await rename(`${path}.tmp`, path);
  return used;
}

// Where the hooks look for the CLI when it is not on their PATH, which in
// WorkBuddy 5.11.3 does not include the directory connectors install into.
const CLI_LINK = join(dirname(HARNESS_HOME), "bin", process.platform === "win32" ? "memorylake.exe" : "memorylake");

/** Point that place at the CLI this page is using, unless something is there already. */
async function linkCli() {
  const found = await run(process.platform === "win32" ? "where" : "which", [CLI]);
  const path = found.code === 0 ? found.stdout.split(/\r?\n/)[0].trim() : "";
  if (!path || (await lstat(CLI_LINK).catch(() => null))) return;
  await mkdir(dirname(CLI_LINK), { recursive: true });
  await symlink(path, CLI_LINK).catch(() => {});
}

async function installAutoMemory() {
  const codebuddy = await workbuddyCli();
  if (!codebuddy) throw new Error("could not find WorkBuddy's plugin installer");
  // Start clean, so a reconnect brings the hooks that came with this connector.
  await workbuddyPlugin(codebuddy, ["uninstall", AUTO_PLUGIN]);
  await workbuddyPlugin(codebuddy, ["marketplace", "remove", AUTO_MARKETPLACE]);
  await rm(AUTO_COPY, { recursive: true, force: true });
  await mkdir(HARNESS_HOME, { recursive: true });
  await cp(AUTO_PACKAGE, AUTO_COPY, { recursive: true });
  for (const args of [["marketplace", "add", AUTO_COPY], ["install", AUTO_PLUGIN]]) {
    const result = await workbuddyPlugin(codebuddy, args);
    if (result.code !== 0) throw new Error(failureText(result));
  }
  if (!(await autoMemoryInstalled())) throw new Error("WorkBuddy did not record the plugin as installed");
  await linkCli();
}

/** Take the hooks out again. The shared configuration stays: other harnesses read it. */
async function removeAutoMemory() {
  const codebuddy = await workbuddyCli();
  if (codebuddy && (await autoMemoryInstalled())) await workbuddyPlugin(codebuddy, ["uninstall", AUTO_PLUGIN]);
  if (codebuddy && existsSync(AUTO_COPY)) await workbuddyPlugin(codebuddy, ["marketplace", "remove", AUTO_MARKETPLACE]);
  await rm(AUTO_COPY, { recursive: true, force: true });
  // Only the link made above; a CLI someone installed there is theirs.
  if ((await lstat(CLI_LINK).catch(() => null))?.isSymbolicLink()) await unlink(CLI_LINK).catch(() => {});
}

async function enableAutoMemory() {
  if (!workspaceId) return { ok: false, error: "no workspace was chosen" };
  const { state, reason } = await autoMemoryState();
  if (state === "plugin") return { ok: true, state };
  if (state === "unavailable") return { ok: false, error: `automatic memory is not available here (${reason})` };
  try {
    const workspace = await writeHarnessConfig(workspaceId);
    await installAutoMemory();
    return { ok: true, state: "on", workspace };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 300) };
  }
}

if (DISCONNECT) {
  // Whatever happens here, the connector's disconnect goes on to log out.
  await removeAutoMemory().catch(() => {});
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
    loggedIn = true;
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

  async autoEnable() {
    return enableAutoMemory();
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

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemoryLake</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #14171c; --muted: #5d6673; --line: #d9dee6; --accent: #1f5eff; --accent-text: #fff; --bad: #b3261e; --ok: #1a7f4b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111418; --card: #1a1e24; --text: #eceff3; --muted: #9aa4b2; --line: #2e3540; --accent: #6b93ff; --accent-text: #0b1020; --bad: #ff8a80; --ok: #6fd6a0; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 16px; color: var(--muted); }
  fieldset { border: 0; padding: 0; margin: 0 0 18px; }
  legend, label.field { display: block; font-weight: 600; margin-bottom: 8px; padding: 0; }
  .choice { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; cursor: pointer; }
  .choice:has(input:checked) { border-color: var(--accent); }
  .choice input { margin-top: 4px; accent-color: var(--accent); flex: none; }
  .choice small { display: block; color: var(--muted); word-break: break-all; }
  input[type=password] { width: 100%; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 10px; }
  input[type=password]:focus-visible, button:focus-visible, a:focus-visible, .choice:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .hint { font-size: 13px; margin: 8px 0 18px; }
  a { color: var(--accent); }
  button { width: 100%; padding: 11px 14px; font: inherit; font-weight: 600; color: var(--accent-text); background: var(--accent); border: 0; border-radius: 10px; cursor: pointer; }
  button.secondary { color: var(--text); background: transparent; border: 1px solid var(--line); }
  button.link { width: auto; padding: 0; margin-top: 14px; font-weight: 400; color: var(--accent); background: none; text-decoration: underline; }
  button[disabled] { opacity: .6; cursor: progress; }
  .error { color: var(--bad); margin: 0 0 14px; overflow-wrap: anywhere; }
  .done { color: var(--ok); font-weight: 600; }
  .list { max-height: 260px; overflow: auto; margin-bottom: 10px; }
  .actions { display: grid; gap: 10px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <section id="step-login">
    <h1 data-t="title"></h1>
    <p data-t="intro"></p>
    <form id="login-form" autocomplete="off">
      <div id="browser-part" hidden>
        <p class="hint" data-t="browserHint"></p>
        <p class="error" id="browser-error" role="alert" hidden></p>
        <button type="button" id="browser-button" data-t="browser"></button>
        <button type="button" class="link" id="show-key" data-t="useKey"></button>
      </div>
      <div id="key-part">
        <label class="field" for="api-key" data-t="apiKey"></label>
        <input id="api-key" type="password" name="api-key" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="sk-...">
        <p class="hint"><span data-t="noKey"></span> <a id="console-link" target="_blank" rel="noopener noreferrer" data-t="openConsole"></a></p>
        <p class="error" id="login-error" role="alert" hidden></p>
        <button type="submit" id="login-button" data-t="connect"></button>
      </div>
    </form>
  </section>

  <section id="step-wait" hidden>
    <h1 data-t="waitTitle"></h1>
    <p data-t="waitIntro"></p>
    <p class="error" id="wait-error" role="alert" hidden></p>
    <div class="actions">
      <a id="reopen" target="_blank" rel="noopener noreferrer" data-t="reopen"></a>
      <button type="button" class="secondary" id="cancel-button" data-t="cancel"></button>
    </div>
  </section>

  <section id="step-workspace" hidden>
    <h1 data-t="pickTitle"></h1>
    <p data-t="pickIntro"></p>
    <form id="workspace-form">
      <div class="list" id="workspaces"></div>
      <p class="error" id="workspace-error" role="alert" hidden></p>
      <button type="submit" id="workspace-button" data-t="useWorkspace"></button>
    </form>
  </section>

  <section id="step-import" hidden>
    <h1 data-t="importTitle"></h1>
    <p data-t="importIntro"></p>
    <form id="import-form">
      <div class="list" id="import-groups"></div>
      <p class="hint" data-t="importNote"></p>
      <p class="error" id="import-error" role="alert" hidden></p>
      <div class="actions">
        <button type="submit" id="import-button" data-t="importGo"></button>
        <button type="button" class="secondary" id="import-skip" data-t="importSkip"></button>
      </div>
    </form>
  </section>

  <section id="step-auto" hidden>
    <h1 data-t="autoTitle"></h1>
    <p data-t="autoIntro"></p>
    <p class="hint" data-t="autoNote"></p>
    <p class="error" id="auto-error" role="alert" hidden></p>
    <div class="actions">
      <button type="button" id="auto-button" data-t="autoGo"></button>
      <button type="button" class="secondary" id="auto-skip" data-t="autoSkip"></button>
    </div>
  </section>

  <section id="step-done" hidden>
    <h1 class="done" data-t="doneTitle"></h1>
    <p id="done-detail"></p>
    <p id="done-import" hidden></p>
    <p id="done-auto" hidden></p>
    <p data-t="doneIntro"></p>
    <p class="hint" id="done-tip" data-t="doneTip"></p>
  </section>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const CONSOLE = ${JSON.stringify(TARGET.console)};
const BROWSER_LOGIN = ${JSON.stringify(browserLoginSupported)};
const TEXT = {
  en: {
    title: "Connect MemoryLake", intro: "Sign the memorylake CLI on this computer in to your MemoryLake account. Its key stays on this computer.",
    browser: "Sign in with browser", starting: "Opening MemoryLake...",
    browserHint: "Sign in on the MemoryLake site and approve. MemoryLake then creates an API key for this computer, which you can see and revoke in its console.",
    useKey: "Use an API key instead",
    apiKey: "API key", noKey: "No key yet?", openConsole: "Create one in the MemoryLake console",
    connect: "Connect", connecting: "Checking the key...",
    waitTitle: "Finish signing in", waitIntro: "MemoryLake has opened in a new tab. Sign in there and approve; this page carries on by itself.",
    reopen: "Open the MemoryLake page again", cancel: "Cancel",
    pickTitle: "Choose a workspace", pickIntro: "Commands use this workspace unless told otherwise. You can change it later.",
    useWorkspace: "Use this workspace", saving: "Saving...",
    doneTitle: "MemoryLake is connected", doneIntro: "You can close this page and go back to WorkBuddy.",
    doneTip: "To bring WorkBuddy's own memory along later, tell it: “Import WorkBuddy's memory into MemoryLake”.",
    workspaceSet: "Default workspace: ", workspaceLater: "No default workspace was set; the assistant will ask which one to use.",
    lost: "This page lost contact with WorkBuddy. Reconnect MemoryLake from WorkBuddy to try again.",
    refused: "MemoryLake did not accept this key. Check that it was copied whole and that it comes from app.memorylake.cn; accounts on app.memorylake.ai are separate.",
    importTitle: "Bring WorkBuddy's memory along?",
    importIntro: "WorkBuddy already keeps memory in files on this computer. Copy them into MemoryLake and your other devices and apps have it too. Nothing on this computer is changed.",
    importNote: "The files are stored as documents in a project named “WorkBuddy memory”, and MemoryLake builds memory from them. Lines that look like passwords or keys are left out. You can delete the documents in MemoryLake at any time.",
    importGo: "Import selected", importing: "Importing...", importSkip: "Not now",
    importNone: "Select at least one item, or choose “Not now”.",
    kindProfile: "Your profile", kindAccount: "Account memory", kindGlobal: "Long-term memory",
    kindWorkspace: "Workspace memory: ", kindNotes: "Daily notes: ",
    files: " files", updated: "updated ", removed: " lines that look like credentials will be left out",
    stored: "already in MemoryLake, will be replaced",
    imported: "Imported from WorkBuddy: ", importedFiles: " files. MemoryLake is building memory from them.",
    importFailed: " could not be imported: ",
    autoTitle: "Turn on automatic memory?",
    autoIntro: "With it on, WorkBuddy checks MemoryLake before every answer and saves each conversation there afterwards, without being asked.",
    autoNote: "What is saved to MemoryLake: the messages you send in WorkBuddy and its final replies, not its tool calls or your files. It applies from the next new conversation, and stops when you disconnect MemoryLake in WorkBuddy. Without it, MemoryLake is used only when you ask WorkBuddy to look something up or remember it.",
    autoGo: "Turn on automatic memory", autoBusy: "Turning on...", autoSkip: "Not now",
    autoOn: "Automatic memory is on, from the next new conversation.",
    autoPlugin: "Automatic memory is provided by the MemoryLake plugin already installed in WorkBuddy.",
    autoWorkspace: " It uses the workspace this computer was already set up with: ",
  },
  zh: {
    title: "连接 MemoryLake", intro: "让这台电脑上的 memorylake 命令行登录到你的 MemoryLake 账号。API key 只保存在本机。",
    browser: "在浏览器中登录", starting: "正在打开 MemoryLake……",
    browserHint: "在 MemoryLake 网站上登录并确认授权后，MemoryLake 会为这台电脑创建一个 API key，可在控制台查看和吊销。",
    useKey: "改用 API key",
    apiKey: "API key", noKey: "还没有 API key？", openConsole: "到 MemoryLake 控制台创建一个",
    connect: "连接", connecting: "正在校验……",
    waitTitle: "完成登录", waitIntro: "已在新标签页打开 MemoryLake。请在那里登录并确认授权，本页会自动继续。",
    reopen: "重新打开 MemoryLake 页面", cancel: "取消",
    pickTitle: "选择工作区", pickIntro: "之后的命令默认使用这个工作区，随时可以更换。",
    useWorkspace: "使用这个工作区", saving: "正在保存……",
    doneTitle: "MemoryLake 已连接", doneIntro: "可以关闭此页面，回到 WorkBuddy 继续。",
    doneTip: "以后想导入 WorkBuddy 自带的记忆，可以对 WorkBuddy 说：“把 WorkBuddy 已有的记忆导入 MemoryLake”。",
    workspaceSet: "默认工作区：", workspaceLater: "尚未设置默认工作区，助手会在需要时询问你用哪一个。",
    lost: "此页面已与 WorkBuddy 失去联系。请回到 WorkBuddy 重新连接 MemoryLake。",
    refused: "MemoryLake 没有接受这个 key。请确认复制完整，并且它来自 app.memorylake.cn：app.memorylake.ai 的账号与它互不相通。",
    importTitle: "把 WorkBuddy 的记忆一起带上？",
    importIntro: "WorkBuddy 已经在这台电脑的文件里保存了一些记忆。把它们复制到 MemoryLake，你的其他设备和应用也能用上。这台电脑上的文件不会被改动。",
    importNote: "文件会作为文档保存在名为“WorkBuddy memory”的项目里，MemoryLake 会从中提炼记忆。看起来像密码或密钥的行不会上传。之后可以随时在 MemoryLake 里删除这些文档。",
    importGo: "导入所选", importing: "正在导入……", importSkip: "暂不导入",
    importNone: "请至少选择一项，或点“暂不导入”。",
    kindProfile: "你的个人档案", kindAccount: "账号记忆", kindGlobal: "长期记忆",
    kindWorkspace: "工作区记忆：", kindNotes: "每日笔记：",
    files: " 个文件", updated: "更新于 ", removed: " 行疑似密码或密钥，不会上传",
    stored: "MemoryLake 里已有，将被替换",
    imported: "已从 WorkBuddy 导入 ", importedFiles: " 个文件，MemoryLake 正在从中提炼记忆。",
    importFailed: " 个文件未能导入：",
    autoTitle: "开启自动记忆？",
    autoIntro: "开启后，WorkBuddy 每次回答前会先查一遍 MemoryLake，每轮对话结束后把内容存进去，不需要你提醒。",
    autoNote: "会保存到 MemoryLake 的内容：你在 WorkBuddy 里发的消息和它的最终回复，不包括工具调用和你的文件。从下一个新对话开始生效，在 WorkBuddy 里断开 MemoryLake 即停止。不开启的话，只有你让 WorkBuddy 去查或去记的时候才会用到 MemoryLake。",
    autoGo: "开启自动记忆", autoBusy: "正在开启……", autoSkip: "暂不开启",
    autoOn: "自动记忆已开启，从下一个新对话开始生效。",
    autoPlugin: "自动记忆由 WorkBuddy 里已安装的 MemoryLake 套件提供。",
    autoWorkspace: " 它使用这台电脑之前设置好的工作区：",
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
$("console-link").parentElement.hidden = !CONSOLE;

function showKeyForm(visible) {
  $("key-part").hidden = !visible;
  $("show-key").hidden = visible;
  $("api-key").required = visible;
}
$("browser-part").hidden = !BROWSER_LOGIN;
showKeyForm(!BROWSER_LOGIN);
$("show-key").addEventListener("click", () => { showKeyForm(true); $("api-key").focus(); });

let workspaceInUse = null;
let imported = null;
async function finish(auto) {
  $("done-detail").textContent = workspaceInUse ? t.workspaceSet + workspaceInUse.name : t.workspaceLater;
  if (auto) {
    let text = auto.state === "plugin" ? t.autoPlugin : t.autoOn;
    if (auto.workspace && auto.workspace !== workspaceInUse?.id) text += t.autoWorkspace + auto.workspace;
    $("done-auto").textContent = text;
    $("done-auto").hidden = false;
  }
  if (imported) {
    let text = t.imported + imported.imported + t.importedFiles;
    if (imported.failed.length) text += " " + imported.failed.length + t.importFailed + imported.failed.map((f) => f.name).join(", ");
    $("done-import").textContent = text;
    $("done-import").hidden = false;
    $("done-tip").hidden = true;
  }
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

// With a workspace to import into, offer WorkBuddy's own memory files, if
// this computer has any.
async function offerImport(workspace) {
  workspaceInUse = workspace || null;
  if (!workspace) return finish();
  const scan = await call("importScan");
  if (!scan.ok || !scan.groups.length) return offerAuto();
  for (const group of scan.groups) {
    $("import-groups").append(choice("checkbox", "group", group.id, t[KIND[group.kind]] + group.label, describe(group), group.suggested));
  }
  show("step-import");
}

// Last, automatic memory: offered when it can be installed, refreshed when an
// earlier connect installed it, and only reported when the MemoryLake plugin
// already provides it.
async function offerAuto(result) {
  imported = result || null;
  const scan = await call("autoScan");
  if (scan.state === "available") return show("step-auto");
  if (scan.state === "plugin") return finish(scan);
  if (scan.state === "on") {
    const again = await call("autoEnable");
    return finish(again.ok ? again : null);
  }
  finish();
}

function loggedIn(result) {
  if (!result.workspaces.length) return offerImport(result.workspace);
  result.workspaces.forEach((w, index) => $("workspaces").append(choice("radio", "workspace", w.id, w.name, w.id, index === 0)));
  $("workspace-form").workspaces = result.workspaces;
  show("step-workspace");
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("key-part").hidden) return;
  const button = $("login-button");
  button.disabled = true; button.textContent = t.connecting; fail("login-error", "");
  const result = await call("login", { apiKey: $("api-key").value });
  button.disabled = false; button.textContent = t.connect;
  if (!result.ok) return fail("login-error", result.refused ? t.refused : result.error);
  $("api-key").value = "";
  loggedIn(result);
});

let waiting = false;
$("browser-button").addEventListener("click", async () => {
  const button = $("browser-button");
  // Open the tab now, while the click still allows it, and point it at
  // MemoryLake once the CLI has said where.
  const tab = window.open("about:blank", "_blank");
  button.disabled = true; button.textContent = t.starting; fail("browser-error", "");
  const started = await call("browser");
  button.disabled = false; button.textContent = t.browser;
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
  button.disabled = true; button.textContent = t.saving; fail("workspace-error", "");
  const result = await call("workspace", { id });
  button.disabled = false; button.textContent = t.useWorkspace;
  if (!result.ok) return fail("workspace-error", result.error);
  offerImport(form.workspaces.find((w) => w.id === id));
});

$("import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ids = new FormData(event.currentTarget).getAll("group");
  if (!ids.length) return fail("import-error", t.importNone);
  const button = $("import-button");
  button.disabled = true; $("import-skip").disabled = true; button.textContent = t.importing; fail("import-error", "");
  const result = await call("importRun", { ids });
  button.disabled = false; $("import-skip").disabled = false; button.textContent = t.importGo;
  if (!result.ok) return fail("import-error", result.error);
  offerAuto(result);
});
$("import-skip").addEventListener("click", () => offerAuto());

$("auto-button").addEventListener("click", async () => {
  const button = $("auto-button");
  button.disabled = true; $("auto-skip").disabled = true; button.textContent = t.autoBusy; fail("auto-error", "");
  const result = await call("autoEnable");
  button.disabled = false; $("auto-skip").disabled = false; button.textContent = t.autoGo;
  if (!result.ok) return fail("auto-error", result.error);
  finish(result);
});
$("auto-skip").addEventListener("click", () => finish());
</script>
</body>
</html>`;
}
