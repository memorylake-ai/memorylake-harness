#!/usr/bin/env node
// Opens MemoryLake's sign-in page in the user's browser, for the plugin.
//
//   node connect.mjs           start the page (or find the one already
//                              open), open it in the browser, say so, return
//   node connect.mjs --serve   be the page: what the first form starts on its
//                              own, and what the session-start hook starts
//                              the first time (lib/host.mjs)
//
// The page is login.mjs, the connector's, unchanged. There WorkBuddy starts
// it, opens the URL it prints and stops it after five minutes; here this
// script does those three things, and gives the user half an hour.
//
// No dependencies, Node 18+.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliDirs } from "./lib/host.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");
const DATA = process.env.MEMORYLAKE_PLUGIN_DATA || path.join(os.homedir(), ".memorylake", "harness");
// The page being served now: { pid, url }.
const RUNNING = path.join(DATA, "state", "workbuddy-plugin-page.json");
const TIMEOUT_MS = Number(process.env.MEMORYLAKE_LOGIN_TIMEOUT_MS) || 30 * 60_000;
const WINDOWS = process.platform === "win32";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page another run is serving, if it is still there. */
function running() {
  try {
    const page = JSON.parse(fs.readFileSync(RUNNING, "utf8"));
    process.kill(page.pid, 0);
    return page;
  } catch {
    return null;
  }
}

/** Hand a URL to the system's browser. MEMORYLAKE_BROWSER names a program to run instead. */
function open(url) {
  const [file, args] = process.env.MEMORYLAKE_BROWSER ? [process.env.MEMORYLAKE_BROWSER, [url]]
    : process.platform === "darwin" ? ["open", [url]]
    : WINDOWS ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** The environment the page runs in: the plugin's own CLI ahead of any other. */
function pageEnv() {
  const bundled = cliDirs().join(path.delimiter);
  const fallback = path.join(path.dirname(DATA), "bin");
  return {
    ...process.env,
    PATH: [bundled, process.env.PATH, fallback].filter(Boolean).join(path.delimiter),
    MEMORYLAKE_LOGIN_TIMEOUT_MS: String(TIMEOUT_MS),
    // Tells the page the hooks are this plugin's, so it installs none.
    MEMORYLAKE_WORKBUDDY_PLUGIN: "1",
  };
}

async function serve() {
  if (running()) return;
  fs.mkdirSync(path.dirname(RUNNING), { recursive: true });
  const page = spawn(process.execPath, [path.join(ROOT, "scripts", "login.mjs")], {
    env: pageEnv(),
    cwd: os.homedir(),
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let out = "";
  page.stdout.on("data", (chunk) => {
    if (out === null) return;
    out += chunk;
    const url = out.match(/http:\/\/127\.0\.0\.1:\d+\/connect\?t=\w+/)?.[0];
    if (!url) return;
    out = null;
    fs.writeFileSync(RUNNING, JSON.stringify({ pid: process.pid, url }) + "\n", { mode: 0o600 });
    open(url);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => page.kill());
  await new Promise((resolve) => page.on("exit", resolve).on("error", resolve));
  if (running()?.pid === process.pid) fs.rmSync(RUNNING, { force: true });
}

async function start() {
  let page = running();
  if (page) {
    open(page.url);
  } else {
    const child = spawn(process.execPath, [SELF, "--serve"], {
      detached: true, stdio: "ignore", windowsHide: true, cwd: os.homedir(), env: process.env,
    });
    child.on("error", () => {});
    child.unref();
    for (let i = 0; i < 100 && !(page = running()); i++) await sleep(100);
  }
  if (!page) {
    console.error("MemoryLake's sign-in page did not start.");
    process.exit(1);
  }
  console.log(`MemoryLake's sign-in page is open in the user's browser. If it did not appear, they can open this link:\n${page.url}`);
}

await (process.argv.includes("--serve") ? serve() : start());
