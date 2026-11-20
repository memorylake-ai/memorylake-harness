#!/usr/bin/env node
// End-to-end check of the sign-in page's import step, without a browser:
// starts dev/mock-api.mjs and the page, signs in with the stand-in's test
// key, and drives the page's own API the way its script does.
//
//   node dev/test-import.mjs            # uses `memorylake` on PATH
//   MEMORYLAKE_REAL_BIN=/path/to/memorylake node dev/test-import.mjs
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "ml-import-test-"));
const home = join(root, "home");
const statePath = join(root, "state.json");
const put = (path, text) => {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text);
};

// What a WorkBuddy user's disk looks like.
put(".workbuddy/USER.md", "# USER.md\n- **Name:** Test User\n- **City:** Hangzhou\n");
put(".workbuddy/SOUL.md", "The assistant's persona. Must never be imported.\n");
put(".workbuddy/memory/acc-1234_memory.md", "# User Memory Profile\nPrefers pnpm.\nstaging password: hunter2-do-not-store\nWorks on billing.\n");
put(".workbuddy/memory/acc-1234_memory.md.bak", "old copy\n");
put("WorkBuddy/2026-10-08-11-04-41/.workbuddy/memory/MEMORY.md", "Project uses Go.\n");
put("WorkBuddy/2026-10-08-11-04-41/.workbuddy/memory/2026-10-08.md", "# 2026-10-08\nFixed a bug.\n");
put("WorkBuddy/2026-10-08-11-04-41/.workbuddy/memory/empty.md", "");

const children = [];
const start = (file, env) => {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
};
const cleanup = () => {
  for (const child of children) child.kill();
  rmSync(root, { recursive: true, force: true });
};

try {
  const mock = start(join(here, "mock-api.mjs"), { MOCK_WORKSPACES: "ws-1:Personal" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(mock.exitCode, null, "mock API did not start (is port 18765 taken?)");

  const page = start(join(here, "../memorylake/skills/memorylake-cli/scripts/login.mjs"), {
    HOME: join(root, "cli-home"), // the CLI's own credentials, away from the real ones
    USERPROFILE: join(root, "cli-home"),
    MEMORYLAKE_BIN: join(here, "cli-stub.mjs"),
    MEMORYLAKE_REAL_BIN: process.env.MEMORYLAKE_REAL_BIN || "memorylake",
    MEMORYLAKE_BASE_URL: "http://127.0.0.1:18765",
    MEMORYLAKE_IMPORT_HOME: home,
    STUB_STATE: statePath,
    STUB_QUOTA_FILE: join(root, "no-quota"),
  });
  mkdirSync(join(root, "cli-home"), { recursive: true });
  const url = await new Promise((resolve, reject) => {
    let out = "";
    page.stdout.on("data", (chunk) => {
      out += chunk;
      const found = out.match(/http:\/\/127\.0\.0\.1:\d+\/connect\?t=\w+/);
      if (found) resolve(new URL(found[0]));
    });
    page.on("exit", (code) => reject(new Error(`page exited early with ${code}`)));
  });
  const token = url.searchParams.get("t");
  const call = async (action, body = {}) => {
    const response = await fetch(new URL(`/api/${action}`, url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-login-token": token },
      body: JSON.stringify(body),
    });
    return response.json();
  };

  // The page itself: its script must parse, and offers no deployment choice.
  const html = await (await fetch(url)).text();
  new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  assert.ok(!/name="endpoint"|id="endpoints"/.test(html), "the deployment choice is gone");
  assert.ok(html.includes('id="step-memory"'));

  const login = await call("login", { apiKey: "sk-test-mock" });
  assert.equal(login.ok, true, JSON.stringify(login));
  assert.equal(login.workspace?.id, "ws-1", "the only workspace is picked");
  assert.deepEqual(login.workspaces.map((w) => w.id), ["ws-1"], "and still listed, next to making a new one");

  // A new workspace, made on the page, becomes the default.
  assert.equal((await call("workspaceCreate", { name: "  " })).ok, false);
  const created = await call("workspaceCreate", { name: "WorkBuddy" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.workspace.name, "WorkBuddy");
  assert.match(created.workspace.id, /^ws-\d+$/);
  const listed = await fetch("http://127.0.0.1:18765/api/v3/workspaces", { headers: { authorization: "Bearer sk-test-mock" } }).then((r) => r.json());
  assert.match(listed.data.items.find((w) => w.id === created.workspace.id).custom_id, /^workbuddy-/);
  const current = await new Promise((resolve) => execFile(process.env.MEMORYLAKE_REAL_BIN || "memorylake", ["workspace", "current"], { env: { ...process.env, HOME: join(root, "cli-home"), USERPROFILE: join(root, "cli-home") } }, (error, stdout, stderr) => resolve(stdout + stderr)));
  assert.ok(current.includes(created.workspace.id), current);

  const scan = await call("importScan");
  const groups = Object.fromEntries(scan.groups.map((group) => [group.id, group]));
  assert.deepEqual(Object.keys(groups).sort(), ["account", "notes:2026-10-08-11-04-41", "profile", "workspace:2026-10-08-11-04-41"]);
  assert.equal(groups.account.removed, 1, "the password line is counted");
  assert.equal(groups.account.count, 1, "the .bak copy is ignored");
  assert.equal(groups["notes:2026-10-08-11-04-41"].suggested, false, "daily notes are not suggested");
  assert.equal(groups.profile.stored, false);

  const suggested = scan.groups.filter((group) => group.suggested).map((group) => group.id);

  // An account with no quota: said as such, after one refused file, and
  // nothing is left half-stored.
  writeFileSync(join(root, "no-quota"), "");
  const refused = await call("importRun", { ids: suggested });
  assert.equal(refused.ok, false);
  assert.equal(refused.quota, true, JSON.stringify(refused));
  assert.equal(refused.failed.length, 1, "it stops at the first refusal");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).documents.length, 0);
  rmSync(join(root, "no-quota"));
  const first = await call("importRun", { ids: suggested });
  assert.deepEqual({ ok: first.ok, imported: first.imported, failed: first.failed }, { ok: true, imported: 3, failed: [] });

  let state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(state.documents.map((doc) => doc.name).sort(), [
    "workbuddy-2026-10-08-11-04-41-MEMORY.md", "workbuddy-USER.md", "workbuddy-account-memory.md",
  ]);
  const account = state.documents.find((doc) => doc.name === "workbuddy-account-memory.md");
  assert.ok(!account.content.includes("hunter2"), "the secret never left the computer");
  assert.ok(account.content.includes("Prefers pnpm.") && account.content.includes("Works on billing."));
  assert.ok(!JSON.stringify(state).includes("persona"), "SOUL.md is not imported");
  assert.equal(state.project.custom_id, "workbuddy-memory");
  assert.equal(state.items.filter((item) => item.type === "directory").length, 1);

  // A repeat import after the file changed replaces the document.
  put(".workbuddy/USER.md", "# USER.md\n- **Name:** Test User\n- **City:** Shanghai\n");
  const rescan = await call("importScan");
  assert.equal(rescan.groups.find((group) => group.id === "profile").stored, true, "the page says it will be replaced");
  const second = await call("importRun", { ids: ["profile"] });
  assert.equal(second.imported, 1);
  state = JSON.parse(readFileSync(statePath, "utf8"));
  const profiles = state.documents.filter((doc) => doc.name === "workbuddy-USER.md");
  assert.equal(profiles.length, 1, "no second copy");
  assert.ok(profiles[0].content.includes("Shanghai"), "the new content is what is indexed");
  assert.equal(state.documents.length, 3);
  assert.equal(state.items.filter((item) => item.type === "directory").length, 1, "the folder is reused");
  assert.equal(state.calls.filter((line) => line.startsWith("project create")).length, 1, "the project is reused");

  // Ids the scan did not hand out select nothing.
  assert.equal((await call("importRun", { ids: ["../../etc/passwd"] })).ok, false);

  await call("finish");
  const code = await new Promise((resolve) => page.on("exit", resolve));
  assert.equal(code, 0, "the page exits 0 once logged in");
  console.log("ok: sign-in, new workspace, scan, out of quota, import, repeat import");
} finally {
  cleanup();
}
