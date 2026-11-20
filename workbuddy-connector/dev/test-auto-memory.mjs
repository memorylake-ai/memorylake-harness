#!/usr/bin/env node
// End-to-end check of the sign-in page's automatic-memory step, without a
// browser and without touching the real WorkBuddy configuration: the plugin
// is installed by the `codebuddy` CLI inside the WorkBuddy on this computer,
// into a temporary configuration directory.
//
//   node dev/test-auto-memory.mjs
//   MEMORYLAKE_WORKBUDDY_CLI=/path/to/cli/bin/codebuddy node dev/test-auto-memory.mjs
//
// Without a WorkBuddy to install with, only the generated plugin is checked.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const login = join(here, "../memorylake/skills/memorylake-cli/scripts/login.mjs");

// The generated plugin must be what the MemoryLake plugin's hooks are today.
const check = spawnSync(process.execPath, [join(here, "build-auto-memory.mjs"), "--check"], { encoding: "utf8" });
assert.equal(check.status, 0, check.stderr);

const codebuddy = process.env.MEMORYLAKE_WORKBUDDY_CLI
  || "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";
if (!existsSync(codebuddy)) {
  console.log("ok: generated plugin is current (no WorkBuddy here, install not tested)");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "ml-auto-test-"));
const home = join(root, "home");
const workbuddy = join(root, "workbuddy");
for (const dir of [home, workbuddy]) mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CODEBUDDY_CONFIG_DIR: workbuddy,
  MEMORYLAKE_WORKBUDDY_CLI: codebuddy,
  MEMORYLAKE_BIN: join(here, "cli-stub.mjs"),
  MEMORYLAKE_REAL_BIN: process.env.MEMORYLAKE_REAL_BIN || "memorylake",
  MEMORYLAKE_BASE_URL: "http://127.0.0.1:18765",
  MEMORYLAKE_IMPORT_HOME: join(root, "nothing-to-import"),
  STUB_STATE: join(root, "state.json"),
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const installed = () => readJson(join(workbuddy, "plugins/installed_plugins.json")).plugins["memorylake-auto@memorylake-connector"];
const settings = join(workbuddy, "settings.json");
const config = join(home, ".memorylake/harness/config.md");

// As if the package had come out of a zip that dropped the executable bits.
const packaged = join(root, "package");
cpSync(join(dirname(login), "auto-memory"), join(packaged, "auto-memory"), { recursive: true });
cpSync(login, join(packaged, "login.mjs"));
for (const file of ["scripts/run.sh", "scripts/session-start.sh", "scripts/prompt-submit.sh", "bin/ml-recall"]) {
  chmodSync(join(packaged, "auto-memory/memorylake-auto", file), 0o644);
}
const loginCopy = join(packaged, "login.mjs");

const children = [];
try {
  const mock = spawn(process.execPath, [join(here, "mock-api.mjs")], { env: { ...process.env, MOCK_WORKSPACES: "ws-1:Personal" }, stdio: "ignore" });
  children.push(mock);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(mock.exitCode, null, "mock API did not start (is port 18765 taken?)");

  const page = spawn(process.execPath, [loginCopy], { env, stdio: ["ignore", "pipe", "inherit"] });
  children.push(page);
  const url = await new Promise((resolve, reject) => {
    let out = "";
    page.stdout.on("data", (chunk) => {
      out += chunk;
      const found = out.match(/http:\/\/127\.0\.0\.1:\d+\/connect\?t=\w+/);
      if (found) resolve(new URL(found[0]));
    });
    page.on("exit", (code) => reject(new Error(`page exited early with ${code}`)));
  });
  const call = async (action, body = action === "login" ? { apiKey: "sk-test-mock" } : {}) => (await fetch(new URL(`/api/${action}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-login-token": url.searchParams.get("t") },
    body: JSON.stringify(body),
  })).json();
  const realCli = (...args) => spawnSync(env.MEMORYLAKE_REAL_BIN, args, { env, encoding: "utf8" });

  const html = await (await fetch(url)).text();
  new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  assert.ok(html.includes('id="step-memory"'));

  // Nothing can be turned on before there is a workspace to write to.
  assert.equal((await call("autoEnable")).ok, false);
  assert.equal((await call("login")).workspace?.id, "ws-1");
  const ALL_ON = { recall: true, conversations: true, attachments: true };
  assert.deepEqual(await call("autoScan"), { ok: true, state: "available", settings: ALL_ON }, "everything starts on");

  const enabled = await call("autoEnable", { settings: ALL_ON });
  assert.deepEqual(enabled, { ok: true, state: "on", workspace: "ws-1", settings: ALL_ON }, JSON.stringify(enabled));
  assert.ok(installed(), "WorkBuddy records the plugin as installed");
  assert.equal(readJson(settings).enabledPlugins["memorylake-auto@memorylake-connector"], true);
  const written = readFileSync(config, "utf8");
  assert.match(written, /^workspace: ws-1$/m);
  assert.match(written, /^actor: actor-me$/m, "the account's own actor, bound to the workspace on the way");
  assert.match(written, /^sync_conversations: true$/m);
  assert.match(written, /^sync_attachments: true$/m, "attached files are uploaded unless turned off");
  assert.match(written, /^recall_reminder: true$/m);
  assert.match(written, /^recall_gate: true$/m);
  assert.deepEqual(readJson(env.STUB_STATE).bound, ["actor-me"]);
  assert.equal((await call("autoScan")).state, "on");
  const link = join(home, ".memorylake/bin/memorylake");
  assert.ok(existsSync(link) && !lstatSync(link).isSymbolicLink(), "the hooks can find the CLI without it being on their PATH");

  // The installed hooks, run the way WorkBuddy runs them.
  const plugin = installed()[0].installPath;
  // PATH holds no `memorylake`; the link is what the hooks find.
  const hook = (script, input) => spawnSync("bash", [join(plugin, "scripts/run.sh"), script], {
    input: JSON.stringify(input), encoding: "utf8",
    env: { ...env, PATH: process.env.PATH.split(":").filter((dir) => !existsSync(join(dir, "memorylake"))).join(":") },
  });
  const session = hook("session-start.sh", { cwd: root, session_id: "s1" });
  const context = JSON.parse(session.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /MemoryLake: connected \(workspace ws-1/, session.stdout + session.stderr);
  assert.ok(context.includes("memorylake-cli-recall skill") && !context.includes("/memorylake:"), "it points at the connector, not the plugin");
  const prompt = hook("prompt-submit.sh", { cwd: root, session_id: "s1", prompt: "what do you know about me?" });
  assert.ok(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext.includes("ml-recall"));

  // With the MemoryLake plugin enabled, these hooks stand down and the page
  // installs nothing.
  const before = readFileSync(settings, "utf8");
  const both = readJson(settings);
  both.enabledPlugins["memorylake@memorylake"] = true;
  writeFileSync(settings, JSON.stringify(both, null, 2));
  assert.equal(hook("prompt-submit.sh", { cwd: root, session_id: "s1", prompt: "hi" }).stdout, "");
  assert.deepEqual(await call("autoScan"), { ok: true, state: "plugin" });
  writeFileSync(settings, before);

  // A reconnect shows the switches as they are, installs again and leaves the
  // configuration as it is.
  const again = await call("autoScan");
  assert.deepEqual(again, { ok: true, state: "on", settings: ALL_ON });
  assert.equal((await call("autoEnable", { settings: again.settings })).ok, true);
  assert.equal(readFileSync(config, "utf8"), written);

  // Another workspace chosen on a later connect: automatic memory follows it,
  // with the actor bound there, and a switch the user turned off shows off.
  writeFileSync(config, written.replace("recall_gate: true", "recall_gate: false"));
  const created = await call("workspaceCreate", { name: "Second" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const shown = (await call("autoScan")).settings;
  assert.deepEqual(shown, { ...ALL_ON, recall: false });
  const moved = await call("autoEnable", { settings: shown });
  assert.equal(moved.workspace, created.workspace.id);
  const rewritten = readFileSync(config, "utf8");
  assert.match(rewritten, new RegExp(`^workspace: ${created.workspace.id}$`, "m"));
  assert.match(rewritten, /^actor: actor-me$/m);
  assert.match(rewritten, /^recall_gate: false$/m);
  assert.match(rewritten, /^recall_reminder: false$/m, "one switch, both keys");
  assert.ok(readJson(env.STUB_STATE).bindings.includes(`${created.workspace.id}/actor-me`));

  // Files go only with the conversation.
  const noChat = await call("autoEnable", { settings: { recall: true, conversations: false, attachments: true } });
  assert.deepEqual(noChat.settings, { recall: true, conversations: false, attachments: false });
  assert.match(readFileSync(config, "utf8"), /^sync_attachments: false$/m);
  assert.ok(installed(), "recall alone still needs the hooks");

  // Everything off: nothing for the hooks to do, so they go.
  const off = await call("autoEnable", { settings: { recall: false, conversations: false, attachments: false } });
  assert.equal(off.state, "off", JSON.stringify(off));
  assert.equal(installed(), undefined, "no hooks with nothing on");
  assert.match(readFileSync(config, "utf8"), /^sync_conversations: false$/m);
  assert.equal((await call("autoScan")).state, "available");

  // And back on.
  assert.equal((await call("autoEnable", { settings: ALL_ON })).state, "on");
  assert.ok(installed());

  // The next sign-in offers the workspace already in use: the CLI's default,
  // or after a logout the one automatic memory writes to.
  assert.equal((await call("login")).current, created.workspace.id);
  realCli("workspace", "use", "ws-1");
  assert.equal((await call("login")).current, "ws-1", "the CLI's default comes first");
  realCli("auth", "logout");
  const relogin = await call("login");
  assert.equal(relogin.current, created.workspace.id, JSON.stringify(relogin));
  await call("workspace", { id: created.workspace.id });

  await call("finish");
  assert.equal(await new Promise((resolve) => page.on("exit", resolve)), 0);

  // Disconnecting takes the hooks out and the login the page made, and keeps
  // the shared configuration.
  const gone = spawnSync(process.execPath, [login, "--disconnect"], { env, encoding: "utf8" });
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(installed(), undefined, "the plugin is uninstalled");
  assert.ok(!existsSync(join(home, ".memorylake/harness/workbuddy-auto-memory")));
  assert.ok(existsSync(link), "the CLI copy stays, for the other MemoryLake tools");
  assert.ok(existsSync(config));
  assert.match(realCli("auth", "status").stdout, /Logged in: no/, "the login the page made is gone");
  assert.match(spawnSync(process.execPath, [login, "--status"], { env, encoding: "utf8" }).stdout, /Logged in: no/);
  console.log("ok: install, hooks, stand-down, reconnect, workspace change, switches, disconnect");
} finally {
  for (const child of children) child.kill();
  rmSync(root, { recursive: true, force: true });
}
