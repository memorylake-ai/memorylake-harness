#!/usr/bin/env node
// Sign-in page for the memorylake CLI, for hosts that run `auth` without a
// terminal (WorkBuddy's CLI connector).
//
// WorkBuddy runs this command with no terminal and no standard input, reads
// standard output for a URL, opens that URL in the browser, and waits for the
// process to exit (`authWaitForExit`).
//
// So this serves a one-off page on the loopback interface. The user picks the
// deployment, signs in, and picks a default workspace. Signing in is the
// CLI's browser login (`auth login --no-browser`): the page opens the
// MemoryLake authorization page the CLI hands it, and the CLI receives the
// result on a loopback port of its own and stores the API key MemoryLake
// creates for it. A CLI too old for that, or a user who prefers it, can paste
// an API key instead. Every step is carried out by the CLI, which stays the
// only thing that reads or writes its credentials.
// Exit status: 0 once logged in, 1 otherwise.
//
// No dependencies, Node 18+.

import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";

const CLI = process.env.MEMORYLAKE_BIN || "memorylake";
// WorkBuddy gives up after five minutes; leave before it does so the page can
// say why.
const TIMEOUT_MS = Number(process.env.MEMORYLAKE_LOGIN_TIMEOUT_MS) || 280_000;
const STARTED_AT = Date.now();
// A browser login is worth starting only with this much time left.
const MIN_BROWSER_SECONDS = 30;

const ENDPOINTS = [
  { id: "cn", console: "https://app.memorylake.cn", baseUrl: "https://app.memorylake.cn/openapi/memorylake" },
  { id: "global", console: "https://app.memorylake.ai", baseUrl: "https://app.memorylake.ai/openapi/memorylake" },
];
// A deployment of one's own, named the way the CLI names it.
if (process.env.MEMORYLAKE_BASE_URL) {
  ENDPOINTS.unshift({ id: "custom", console: "", baseUrl: process.env.MEMORYLAKE_BASE_URL });
}

const token = randomBytes(24).toString("hex");
let done = false;
// Once the CLI holds a valid login the connection has succeeded, even if the
// page is closed before a workspace is picked.
let loggedIn = false;
// The browser login in progress, if any (see `startBrowserLogin`).
let attempt = null;

/** Run the CLI and resolve with its exit code and output. Never rejects. */
function cli(args) {
  return new Promise((resolve) => {
    execFile(CLI, args, { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      // `error.code` is the exit status, or a string such as ENOENT when the
      // binary could not be started at all.
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || "") });
    });
  });
}

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

// Browser login arrived in the CLI after v20261102; older ones only take a key.
const browserLoginSupported = await cli(["auth", "login", "--help"]).then(
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
      if (picked.code === 0) return { workspaces: [], workspace: workspaces[0] };
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

const handlers = {
  async login({ endpoint, apiKey }) {
    const target = ENDPOINTS.find((candidate) => candidate.id === endpoint);
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!target || !key) return { ok: false, error: "missing endpoint or API key" };
    stopBrowserLogin();
    // The key travels as an argument because that is the only way the CLI
    // takes one without a terminal. It is visible to this user's own
    // processes for the moment the command runs.
    const result = await cli(["auth", "login", "--api-key", key, "--base-url", target.baseUrl]);
    if (result.code !== 0) return { ok: false, refused: keyRefused(result), error: failureText(result, key) };
    loggedIn = true;
    return { ok: true, ...(await afterLogin()) };
  },

  async browser({ endpoint }) {
    const target = ENDPOINTS.find((candidate) => candidate.id === endpoint);
    if (!target) return { ok: false, error: "missing endpoint" };
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
    return result.code === 0 ? { ok: true } : { ok: false, error: failureText(result) };
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
  const endpoints = ENDPOINTS.map(({ id, console: consoleUrl, baseUrl }) => ({ id, console: consoleUrl, baseUrl }));
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
  .choice input { margin-top: 4px; accent-color: var(--accent); }
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
      <fieldset>
        <legend data-t="endpoint"></legend>
        <div id="endpoints"></div>
      </fieldset>
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

  <section id="step-done" hidden>
    <h1 class="done" data-t="doneTitle"></h1>
    <p id="done-detail"></p>
    <p data-t="doneIntro"></p>
  </section>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const ENDPOINTS = ${JSON.stringify(endpoints).replace(/</g, "\\u003c")};
const BROWSER_LOGIN = ${JSON.stringify(browserLoginSupported)};
const TEXT = {
  en: {
    title: "Connect MemoryLake", intro: "Sign the memorylake CLI on this computer in to your MemoryLake account. Its key stays on this computer.",
    endpoint: "Deployment", cn: "China", global: "Global", custom: "Custom endpoint",
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
    workspaceSet: "Default workspace: ", workspaceLater: "No default workspace was set; the assistant will ask which one to use.",
    lost: "This page lost contact with WorkBuddy. Reconnect MemoryLake from WorkBuddy to try again.",
    refused: "MemoryLake did not accept this key. Check that it was copied whole and that it belongs to the deployment selected above; the two deployments have separate accounts.",
  },
  zh: {
    title: "连接 MemoryLake", intro: "让这台电脑上的 memorylake 命令行登录到你的 MemoryLake 账号。API key 只保存在本机。",
    endpoint: "站点", cn: "中国站", global: "国际站", custom: "自定义端点",
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
    workspaceSet: "默认工作区：", workspaceLater: "尚未设置默认工作区，助手会在需要时询问你用哪一个。",
    lost: "此页面已与 WorkBuddy 失去联系。请回到 WorkBuddy 重新连接 MemoryLake。",
    refused: "MemoryLake 没有接受这个 key。请确认复制完整，并且它属于上面选中的站点：两个站点的账号互不相通。",
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

function radio(name, value, title, detail, checked) {
  const label = document.createElement("label");
  label.className = "choice";
  const input = document.createElement("input");
  Object.assign(input, { type: "radio", name, value, checked });
  const text = document.createElement("span");
  text.textContent = title;
  if (detail) { const small = document.createElement("small"); small.textContent = detail; text.append(small); }
  label.append(input, text);
  return label;
}

ENDPOINTS.forEach((endpoint, index) => {
  const host = endpoint.baseUrl.replace(/^https?:\\/\\//, "").split("/")[0];
  $("endpoints").append(radio("endpoint", endpoint.id, t[endpoint.id], endpoint.id === "custom" ? endpoint.baseUrl : host, index === 0));
});
const chosenEndpoint = () => ENDPOINTS.find((e) => e.id === new FormData($("login-form")).get("endpoint"));
function syncConsoleLink() {
  const url = chosenEndpoint().console;
  $("console-link").href = url || "#";
  $("console-link").parentElement.hidden = !url;
}
$("endpoints").addEventListener("change", syncConsoleLink);
syncConsoleLink();

function showKeyForm(visible) {
  $("key-part").hidden = !visible;
  $("show-key").hidden = visible;
  $("api-key").required = visible;
}
$("browser-part").hidden = !BROWSER_LOGIN;
showKeyForm(!BROWSER_LOGIN);
$("show-key").addEventListener("click", () => { showKeyForm(true); $("api-key").focus(); });

async function finish(workspace) {
  $("done-detail").textContent = workspace ? t.workspaceSet + workspace.name : t.workspaceLater;
  show("step-done");
  await call("finish");
}

function loggedIn(result) {
  if (!result.workspaces.length) return finish(result.workspace);
  result.workspaces.forEach((w, index) => $("workspaces").append(radio("workspace", w.id, w.name, w.id, index === 0)));
  $("workspace-form").workspaces = result.workspaces;
  show("step-workspace");
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("key-part").hidden) return;
  const button = $("login-button");
  button.disabled = true; button.textContent = t.connecting; fail("login-error", "");
  const result = await call("login", { endpoint: chosenEndpoint().id, apiKey: $("api-key").value });
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
  const started = await call("browser", { endpoint: chosenEndpoint().id });
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
  finish(form.workspaces.find((w) => w.id === id));
});
</script>
</body>
</html>`;
}
