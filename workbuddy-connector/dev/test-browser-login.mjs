#!/usr/bin/env node
// Signing in through the browser, against the stand-in deployment: a login
// that fails after the browser came back says why on the sign-in page and in
// the browser tab, and keeps the whole of it in a log; one that works
// connects.
//
//   MEMORYLAKE_REAL_BIN=/path/to/memorylake node dev/test-browser-login.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const login = join(here, "../memorylake/skills/memorylake-cli/scripts/login.mjs");
const realBin = process.env.MEMORYLAKE_REAL_BIN || "memorylake";

const root = mkdtempSync(join(tmpdir(), "ml-browser-test-"));
const home = join(root, "home");
for (const dir of [home, join(root, "workbuddy"), join(root, "nothing-to-import")]) mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  MEMORYLAKE_CONFIG_DIR: join(home, ".memorylake"),
  CODEBUDDY_CONFIG_DIR: join(root, "workbuddy"),
  MEMORYLAKE_WORKBUDDY_CLI: join(root, "no-workbuddy"),
  MEMORYLAKE_BIN: realBin,
  MEMORYLAKE_BASE_URL: "http://127.0.0.1:18765",
  MEMORYLAKE_IMPORT_HOME: join(root, "nothing-to-import"),
};
const log = join(home, ".memorylake/harness/logs/workbuddy-connect.log");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startMock(children, extraEnv = {}) {
  const mock = spawn(process.execPath, [join(here, "mock-api.mjs")], { env: { ...process.env, ...extraEnv }, stdio: "ignore" });
  children.push(mock);
  await sleep(400);
  assert.equal(mock.exitCode, null, "mock API did not start (is port 18765 taken?)");
  return mock;
}

/** Start the page and hand back a caller for its API. */
async function openPage(children) {
  const page = spawn(process.execPath, [login], { env, stdio: ["ignore", "pipe", "inherit"] });
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
  const call = async (action, body = {}) => (await fetch(new URL(`/api/${action}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-login-token": url.searchParams.get("t") },
    body: JSON.stringify(body),
  })).json();
  return { page, call };
}

/** Do in the browser what a person would: open the consent page, approve. */
async function approveInBrowser(authorizeUrl) {
  const consent = await (await fetch(authorizeUrl)).text();
  const approve = consent.match(/id="approve" href="([^"]+)"/)[1].replace(/&amp;/g, "&");
  return (await fetch(approve)).text();
}

async function settle(call) {
  for (let i = 0; i < 100; i++) {
    const status = await call("browserStatus");
    if (status.state !== "starting" && status.state !== "waiting") return status;
    await sleep(100);
  }
  throw new Error("the browser login never finished");
}

const children = [];
try {
  // A team where this account may not create keys.
  const forbidding = await startMock(children, { MOCK_KEYS_FORBIDDEN: "1" });
  {
    const { page, call } = await openPage(children);
    const started = await call("browser");
    assert.equal(started.ok, true, JSON.stringify(started));
    const tab = await approveInBrowser(started.url);
    assert.match(tab, /Login failed/, "the browser tab says the login failed");
    assert.match(tab, /not allowed to create API keys/, `the browser tab says why: ${tab}`);
    assert.doesNotMatch(tab, /terminal/, "it does not send anyone to a terminal");

    const status = await settle(call);
    assert.equal(status.state, "failed", JSON.stringify(status));
    assert.match(status.error, /not allowed to create API keys/, "the sign-in page says why");

    assert.ok(existsSync(log), "the failure is logged");
    const logged = readFileSync(log, "utf8");
    assert.match(logged, /browser login to http:\/\/127\.0\.0\.1:18765 failed/);
    assert.match(logged, /no permission to create API keys/, "the log keeps the server's own words");
    page.kill();
  }
  forbidding.kill();
  await sleep(200);

  // The same login where keys may be created.
  await startMock(children);
  {
    const { call } = await openPage(children);
    const started = await call("browser");
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.match(await approveInBrowser(started.url), /Login complete/);
    const status = await settle(call);
    assert.equal(status.state, "done", JSON.stringify(status));
    assert.equal(status.workspaces?.length, 2, "the workspaces are offered");
  }

  console.log("browser login: ok");
} finally {
  for (const child of children) child.kill();
  rmSync(root, { recursive: true, force: true });
}
