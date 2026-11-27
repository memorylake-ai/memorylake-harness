#!/usr/bin/env node
// End-to-end check of the plugin on its own, with no browser and nothing of
// the real WorkBuddy or MemoryLake configuration touched: a built copy of the
// plugin (a stand-in CLI where the build puts the real one) goes through a
// first session, the sign-in page that session opens, and the session after.
//
//   node dev/test.mjs
//   MEMORYLAKE_REAL_BIN=/path/to/memorylake node dev/test.mjs
//
// The hooks themselves are the connector's, tested there
// (workbuddy-connector/dev/test-hooks.mjs); the first thing checked here is
// that the plugin's copies are still the same files.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const connectorDev = join(here, "../../workbuddy-connector/dev");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const synced = spawnSync(process.execPath, [join(here, "sync.mjs"), "--check"], { encoding: "utf8" });
assert.equal(synced.status, 0, synced.stderr);

const which = spawnSync("which", [process.env.MEMORYLAKE_REAL_BIN || "memorylake"], { encoding: "utf8" }).stdout.trim();
if (!which) {
  console.log("skipped: no memorylake CLI here to stand behind the stub");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "ml-plugin-test-"));
const home = join(root, "home");
const workbuddy = join(root, "workbuddy");
const plugin = join(root, "plugin");
for (const dir of [home, workbuddy, join(root, "nothing-to-import")]) mkdirSync(dir, { recursive: true });

// The plugin as built: its files, and a CLI for this computer under vendor/.
cpSync(join(here, ".."), plugin, { recursive: true, filter: (source) => !/[\\/](dev|dist|vendor)$/.test(source) });
const vendor = join(plugin, "vendor", `${process.platform}-${process.arch}`);
mkdirSync(vendor, { recursive: true });
symlinkSync(join(connectorDev, "cli-stub.mjs"), join(vendor, "memorylake"));

// What stands in for the browser: it writes down the URL it was handed.
const opened = join(root, "opened.txt");
const browser = join(root, "browser.mjs");
writeFileSync(browser, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(opened)}, process.argv[2] + "\\n");\n`);
chmodSync(browser, 0o755);

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  // No other memorylake than the plugin's own.
  PATH: process.env.PATH.split(":").filter((dir) => !existsSync(join(dir, "memorylake"))).join(":"),
  MEMORYLAKE_CONFIG_DIR: join(home, ".memorylake"),
  CODEBUDDY_CONFIG_DIR: workbuddy,
  MEMORYLAKE_WORKBUDDY_CLI: join(root, "no-workbuddy"),
  MEMORYLAKE_REAL_BIN: which,
  MEMORYLAKE_BASE_URL: "http://127.0.0.1:18765",
  MEMORYLAKE_IMPORT_HOME: join(root, "nothing-to-import"),
  MEMORYLAKE_BROWSER: browser,
  STUB_STATE: join(root, "state.json"),
};
delete env.MEMORYLAKE_BIN;
delete env.MEMORYLAKE_PLUGIN_DATA;
const harness = join(home, ".memorylake/harness");
const config = join(harness, "config.md");
const pageFile = join(harness, "state/workbuddy-plugin-page.json");

const hook = (name, input) => {
  const result = spawnSync(process.execPath, [join(plugin, "scripts/hook.mjs"), name], { input: JSON.stringify(input), encoding: "utf8", env });
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : "";
};
const openedUrls = () => (existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n") : []);
async function until(what, test) {
  for (let i = 0; i < 100; i++) {
    if (test()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const pagePid = () => JSON.parse(readFileSync(pageFile, "utf8")).pid;

const children = [];
let serving = 0;
try {
  const mock = spawn(process.execPath, [join(connectorDev, "mock-api.mjs")], { env: { ...process.env, MOCK_WORKSPACES: "ws-1:Personal" }, stdio: "ignore" });
  children.push(mock);
  await sleep(400);
  assert.equal(mock.exitCode, null, "mock API did not start (is port 18765 taken?)");

  // A copy of the plugin without the CLI (this directory as it is) says so,
  // and opens no sign-in page that could only fail.
  const bare = join(root, "bare");
  cpSync(plugin, bare, { recursive: true, filter: (source) => !/[\\/]vendor$/.test(source) });
  const lacking = spawnSync(process.execPath, [join(bare, "scripts/hook.mjs"), "session-start"], { input: JSON.stringify({ cwd: root, session_id: "s0" }), encoding: "utf8", env });
  assert.match(lacking.stdout, /came without the `memorylake` CLI/, lacking.stdout);
  await sleep(300);
  assert.equal(openedUrls().length, 0, "no page without a CLI");

  // The command the model runs is the CLI inside the plugin.
  const cli = spawnSync(join(plugin, "bin/memorylake"), ["version"], { env, encoding: "utf8" });
  assert.match(cli.stdout, /^v\d{8}|dev build/, cli.stderr);

  // The first session on a computer that was never set up: the model is told,
  // and the sign-in page opens by itself.
  const first = hook("session-start", { cwd: root, session_id: "s1" });
  assert.match(first, /not set up on this machine/);
  assert.match(first, /has just been opened in the user's browser/, first);
  await until("the sign-in page to open", () => openedUrls().length === 1);
  serving = pagePid();
  const url = new URL(openedUrls()[0]);
  assert.equal(JSON.parse(readFileSync(pageFile, "utf8")).url, url.href);

  // A second session meanwhile opens nothing more, and says how to.
  const second = hook("session-start", { cwd: root, session_id: "s2" });
  assert.match(second, /run `memorylake-connect` \(Bash\)/);
  assert.doesNotMatch(second, /just been opened/);
  await sleep(300);
  assert.equal(openedUrls().length, 1);

  // Asking for the page while it is open shows the same one again.
  const again = spawnSync(process.execPath, [join(plugin, "bin/memorylake-connect")], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.includes(url.href), again.stdout);
  await until("the page to be shown again", () => openedUrls().length === 2);
  assert.equal(openedUrls()[1], url.href);

  // What a person does on the page.
  const call = async (action, body = {}) => (await fetch(new URL(`/api/${action}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-login-token": url.searchParams.get("t") },
    body: JSON.stringify(body),
  })).json();
  const html = await (await fetch(url)).text();
  new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  assert.equal((await call("login", { apiKey: "sk-test-mock" })).workspace?.id, "ws-1");
  const ALL_ON = { recall: true, conversations: true, attachments: true };
  assert.deepEqual(await call("autoScan"), { ok: true, state: "plugin", settings: ALL_ON }, "the switches are offered");
  const chosen = { recall: true, conversations: true, attachments: false };
  assert.deepEqual(await call("autoEnable", { settings: chosen }), { ok: true, state: "plugin", workspace: "ws-1", settings: chosen });
  assert.equal((await call("finish")).ok, true);

  const written = readFileSync(config, "utf8");
  assert.match(written, /^workspace: ws-1$/m);
  assert.match(written, /^actor: actor-me$/m);
  assert.match(written, /^sync_conversations: true$/m);
  assert.match(written, /^sync_attachments: false$/m);
  assert.ok(!existsSync(join(harness, "workbuddy-connector.json")), "the connector's record is not the plugin's to write");
  assert.ok(!existsSync(join(harness, "workbuddy-auto-memory")), "no second set of hooks is installed");
  assert.ok(!existsSync(join(workbuddy, "plugins")), "WorkBuddy's plugins are left alone");
  await until("the page to close", () => !existsSync(pageFile));
  serving = 0;

  // The next session has memory, with the CLI found inside the plugin.
  const connected = hook("session-start", { cwd: root, session_id: "s3" });
  assert.match(connected, /MemoryLake: connected \(workspace ws-1/, connected);
  assert.match(connected, /conversation sync|appended to MemoryLake/);
  assert.ok(hook("prompt-submit", { cwd: root, session_id: "s3", prompt: "what do you know about me?" }).includes("ml-recall"));

  // The connector's hooks stand down for the plugin; the plugin's never do.
  writeFileSync(join(workbuddy, "settings.json"), JSON.stringify({ enabledPlugins: { "memorylake@memorylake": true } }));
  assert.ok(hook("prompt-submit", { cwd: root, session_id: "s3", prompt: "hi" }).includes("ml-recall"));

  // Asked for later, the page starts again.
  const later = spawnSync(process.execPath, [join(plugin, "bin/memorylake-connect")], { env, encoding: "utf8" });
  assert.equal(later.status, 0, later.stderr);
  await until("a new page", () => openedUrls().length === 3 && existsSync(pageFile));
  serving = pagePid();
  assert.notEqual(openedUrls()[2], url.href);
  assert.ok(later.stdout.includes(openedUrls()[2]));
  assert.equal((await fetch(openedUrls()[2])).status, 200);

  console.log("ok: bundled CLI, first-session sign-in page, switches, next session, page on request");
} finally {
  if (serving) try { process.kill(serving, "SIGTERM"); } catch {}
  for (const child of children) child.kill();
  await sleep(300);
  rmSync(root, { recursive: true, force: true });
}
