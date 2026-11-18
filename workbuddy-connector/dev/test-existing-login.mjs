#!/usr/bin/env node
// A computer where the memorylake CLI is already installed and logged in,
// before the connector arrives: WorkBuddy must still show the sign-in page,
// the page offers to keep that login or use another account, the older CLI
// is brought up to the connector's release, and disconnecting logs out only a
// login the connector made.
//
//   MEMORYLAKE_REAL_BIN=/path/to/memorylake node dev/test-existing-login.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const login = join(here, "../memorylake-cli/skills/memorylake-cli/scripts/login.mjs");
const realBin = process.env.MEMORYLAKE_REAL_BIN || "memorylake";

const root = mkdtempSync(join(tmpdir(), "ml-existing-test-"));
const home = join(root, "home");
for (const dir of [home, join(root, "workbuddy"), join(root, "nothing-to-import")]) mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CODEBUDDY_CONFIG_DIR: join(root, "workbuddy"),
  MEMORYLAKE_WORKBUDDY_CLI: join(root, "no-workbuddy"),
  MEMORYLAKE_BIN: realBin,
  MEMORYLAKE_BASE_URL: "http://127.0.0.1:18765",
  MEMORYLAKE_IMPORT_HOME: join(root, "nothing-to-import"),
};
const homeCli = join(home, ".memorylake/bin/memorylake");
const record = join(home, ".memorylake/harness/workbuddy-connector.json");
const cli = (...args) => spawnSync(realBin, args, { env, encoding: "utf8" });
const status = () => spawnSync(process.execPath, [login, "--status"], { env, encoding: "utf8" }).stdout;
const disconnect = () => spawnSync(process.execPath, [login, "--disconnect"], { env, encoding: "utf8" });
const fakeCli = (release) => {
  mkdirSync(dirname(homeCli), { recursive: true });
  writeFileSync(homeCli, `#!/bin/sh\necho "memorylake v${release}"\n`, { mode: 0o755 });
};
const release = (path) => spawnSync(path, ["version"], { encoding: "utf8" }).stdout.match(/v(\d{8})/)?.[1];

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
  const html = await (await fetch(url)).text();
  new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  const exited = new Promise((resolve) => page.on("exit", resolve));
  return { call, exited };
}

const children = [];
try {
  const mock = spawn(process.execPath, [join(here, "mock-api.mjs")], { env: { ...process.env, MOCK_WORKSPACES: "ws-1:Personal" }, stdio: "ignore" });
  children.push(mock);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(mock.exitCode, null, "mock API did not start (is port 18765 taken?)");

  // Another MemoryLake tool installed an older CLI and logged in.
  fakeCli("20250101");
  assert.equal(cli("auth", "login", "--api-key", "sk-test-mock", "--base-url", env.MEMORYLAKE_BASE_URL).status, 0);
  assert.match(cli("auth", "status").stdout, /Logged in: yes/);

  // WorkBuddy does not take that login for a connected connector.
  assert.match(status(), /Logged in: no/);
  assert.doesNotMatch(status(), /Logged in: yes/);

  // The page offers it, and keeping it connects.
  let page = await openPage(children);
  const { existing } = await page.call("existing");
  assert.equal(existing.host, "127.0.0.1:18765");
  assert.ok(existing.account, "something to recognise the account by");
  const kept = await page.call("useExisting");
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.equal(kept.workspace?.id, "ws-1");
  assert.match(status(), /Logged in: yes/);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).ownLogin, false);
  assert.equal(release(homeCli), release(realBin), "the older CLI was replaced by the connector's");
  assert.ok(!lstatSync(homeCli).isSymbolicLink(), "a copy, which outlives the connector");
  await page.call("finish");
  assert.equal(await page.exited, 0);

  // Disconnecting leaves a login the connector did not make.
  assert.equal(disconnect().status, 0);
  assert.ok(!existsSync(record));
  assert.match(cli("auth", "status").stdout, /Logged in: yes/, "the other tool is still logged in");
  assert.match(status(), /Logged in: no/);
  assert.ok(existsSync(homeCli), "the CLI stays for the other tools");

  // A newer CLI is left alone; signing in with another account replaces the
  // login, which disconnecting then removes.
  fakeCli("20990101");
  page = await openPage(children);
  assert.ok((await page.call("existing")).existing);
  const other = await page.call("login", { apiKey: "sk-test-mock" });
  assert.equal(other.ok, true, JSON.stringify(other));
  assert.equal(JSON.parse(readFileSync(record, "utf8")).ownLogin, true);
  assert.equal(release(homeCli), "20990101", "a newer CLI is not downgraded");
  await page.call("finish");
  assert.equal(await page.exited, 0);
  assert.equal(disconnect().status, 0);
  assert.match(cli("auth", "status").stdout, /Logged in: no/, "the connector's own login goes with it");

  // With nothing logged in there is nothing to keep.
  page = await openPage(children);
  assert.equal((await page.call("existing")).existing, null);
  assert.equal((await page.call("useExisting")).ok, false);

  console.log("ok: existing login kept, CLI upgraded, newer CLI kept, other account, disconnect");
} finally {
  for (const child of children) child.kill();
  rmSync(root, { recursive: true, force: true });
}
