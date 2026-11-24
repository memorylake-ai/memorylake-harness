#!/usr/bin/env node
// The automatic-memory hooks, run the way WorkBuddy runs them, against a
// stand-in CLI. Needs nothing but Node: no git, bash or jq, as on a new
// Windows computer. The uploads run in the background, as they do in
// WorkBuddy, and must survive the turn's process being killed.
//
//   node dev/test-hooks.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, "../memorylake/skills/memorylake-cli/scripts/auto-memory/memorylake-auto");
const WINDOWS = process.platform === "win32";

// The long name: Windows may hand out a temporary directory as C:\Users\RUNNER~1.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ml-hooks-")));
const home = path.join(root, "home");
const data = path.join(home, ".memorylake", "harness");
const workbuddy = path.join(root, "workbuddy");
const calls = path.join(root, "calls.jsonl");
const work = (...parts) => path.join(root, "work", ...parts);
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// A stand-in CLI that records every call. Run through Node by the hooks,
// since its name ends in .mjs.
const stub = path.join(root, "memorylake-stub.mjs");
write(stub, `
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const mode = process.env.STUB_MODE || "";
// Slow enough that the turn's process is gone before the upload is done.
if (mode === "slow") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
const out = (value) => { console.log(JSON.stringify(value, null, 2)); process.exit(0); };
const fail = (message) => { console.error(message); process.exit(1); };
const command = args.slice(0, 3).join(" ");
if (mode === "down") fail("Error: network unreachable");
if (command.startsWith("project list")) out({ items: [{ id: "p1" }, { id: "p2" }] });
if (command.startsWith("actor get")) out({ id: "actor-wb" });
if (command.startsWith("actor bind")) fail("already bound");
if (command.startsWith("conversation get")) fail("[NOT_FOUND]");
if (command.startsWith("project create")) out({ id: "proj-" + args[args.indexOf("--custom-id") + 1] });
if (command.startsWith("conversation create")) out({ id: "conv-1" });
if (command === "conversation message append") {
  if (mode === "appendfail") fail("Error: boom\\nretry later");
  out({ id: "m" });
}
if (command.startsWith("lib mkdir")) out({ item_id: "dir-1" });
if (command.startsWith("lib upload")) out({ item_id: "item-1", name: args[args.indexOf("--name") + 1] });
if (command === "project document import") out({ details: [{ result: "imported", document_id: "doc-1" }] });
if (command.startsWith("search")) out({ facts: [{ fact: "likes tea", id: "f1", score: 0.9 }], documents: [{ document_name: "a.pdf", document_id: "d1", items: [{ text: "passage" }] }] });
fail("stub: unknown " + args.join(" "));
`);

const baseEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CODEBUDDY_CONFIG_DIR: workbuddy,
  MEMORYLAKE_BIN: stub,
  MEMORYLAKE_PLUGIN_DATA: data,
  // Only Node's own directory: nothing else a hook could lean on.
  PATH: path.dirname(process.execPath),
};
delete baseEnv.Path;

const takeCalls = () => {
  const text = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
  fs.rmSync(calls, { force: true });
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
};
function hook(name, input, mode = "") {
  const result = spawnSync(process.execPath, [path.join(plugin, "scripts", "hook.mjs"), name], {
    input: JSON.stringify(input), encoding: "utf8", env: { ...baseEnv, STUB_MODE: mode },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter(Boolean);
  return { lines, json: lines.length ? JSON.parse(lines.at(-1)) : null };
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(what, check, seconds = 30) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    sleep(100);
  }
}
const statusOf = (session, name = "sync.json") => {
  try {
    return JSON.parse(fs.readFileSync(path.join(data, "state", "workbuddy", session, name), "utf8"));
  } catch {
    return null;
  }
};
/** The background upload of a session, finished: its outcome written and its lock gone. */
const settled = (session, state, name = "sync.json", lockName = "sync.lock") => waitFor(`${session} ${name} ${state}`, () => {
  const status = statusOf(session, name);
  const done = status && (state === "synced" ? status.last_detail === "synced" : status.last_state === state);
  return done && !fs.existsSync(path.join(data, "state", "workbuddy", session, lockName)) ? status : null;
});
const context = (output) => output.json?.hookSpecificOutput?.additionalContext ?? "";
const sessionFile = (session, name) => path.join(data, "state", "workbuddy", session, name);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

try {
  // A repository found by reading .git, never by running git: a clone, a
  // worktree of it, and a repository with only other remotes.
  write(work("repo", ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@GitHub.com:Org/Repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  write(work("repo", ".git", "worktrees", "wt", "commondir"), "../..\n");
  write(work("wt", ".git"), `gitdir: ${work("repo", ".git", "worktrees", "wt")}\n`);
  write(work("multi", ".git", "config"), '[remote "upstream"]\n\turl = https://user:pw@gitlab.example.com/g/up.git/\n[remote "beta"]\n\turl = ssh://git@host.example.com:2222/team/beta.git\n');
  fs.mkdirSync(work("repo", "deep"), { recursive: true });
  fs.mkdirSync(work("plain"), { recursive: true });
  fs.mkdirSync(work("WorkBuddy", "2026-11-13-18-10-18", "sub"), { recursive: true });

  // Not configured yet: SessionStart says so, nothing else speaks.
  assert.match(context(hook("session-start", { cwd: work("repo"), session_id: "s1" })), /not set up on this machine/);
  assert.equal(hook("prompt-submit", { cwd: work("repo"), session_id: "s1", prompt: "hi" }).json, null);

  write(path.join(data, "config.md"), "---\nworkspace: ws-1\nactor: actor-me\nsync_conversations: true\nsync_attachments: true\n---\n");

  assert.match(context(hook("session-start", { cwd: work("repo"), session_id: "s1" }, "down")), /unreachable/);
  assert.match(context(hook("session-start", { cwd: work("repo"), session_id: "s1" })), /connected \(workspace ws-1, 2 project\(s\)\)[\s\S]*Documents and images/);
  takeCalls();

  // A turn: the reminder, the user's words queued without WorkBuddy's additions.
  const prompt = hook("prompt-submit", { cwd: work("repo", "deep"), session_id: "s1", prompt: "<system-reminder>noise</system-reminder>\n<user_query> héllo ünïcode ✓ </user_query>" });
  assert.match(context(prompt), /ml-recall "<query>"/);
  const queued = JSON.parse(fs.readFileSync(sessionFile("s1", "outbox.jsonl"), "utf8"));
  assert.equal(queued.text, "héllo ünïcode ✓");
  assert.equal(queued.side, "user");

  // The gate holds back the first tool call of a turn without a search, once.
  const gated = hook("recall-gate", { cwd: work("repo"), session_id: "s1", tool_name: "Read", tool_input: {} });
  assert.equal(gated.json.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(hook("recall-gate", { cwd: work("repo"), session_id: "s1", tool_name: "Read", tool_input: {} }).json, null);
  hook("prompt-submit", { cwd: work("repo"), session_id: "s1", prompt: "second" });
  assert.equal(hook("recall-gate", { cwd: work("repo"), session_id: "s1", tool_name: "Bash", tool_input: { command: 'ml-recall "tea"' } }).json, null);
  assert.equal(hook("recall-gate", { cwd: work("repo"), session_id: "s1", tool_name: "Read", tool_input: {} }).json, null, "searched: everything goes through");
  assert.equal(hook("recall-gate", { cwd: work("repo"), session_id: "subagent", tool_name: "Read", tool_input: {} }).json, null);

  // Stop: says nothing and returns at once; the upload runs on its own,
  // keeps what failed and sends it all next time.
  const failed = hook("sync-turn", { cwd: work("repo"), session_id: "s1", last_assistant_message: "reply\n" }, "appendfail");
  assert.equal(failed.lines.length, 0);
  assert.equal(settled("s1", "error").pending, 3);
  assert.equal(readJson(sessionFile("s1", "session.json")).cwd, work("repo"));
  let made = takeCalls();
  const project = made.find((args) => args[1] === "create" && args[0] === "project");
  assert.equal(project[project.indexOf("--custom-id") + 1], "github.com-Org-Repo", "the project is the git remote");
  hook("sync-turn", { cwd: work("repo"), session_id: "s1", last_assistant_message: "reply\n" });
  const status = settled("s1", "synced");
  assert.deepEqual([status.last_state, status.pending, status.conversation_id], ["ok", 0, "conv-1"]);
  const appended = takeCalls().filter((args) => args[2] === "append").map((args) => args[args.indexOf("--text") + 1]);
  assert.deepEqual(appended, ["héllo ünïcode ✓", "second", "reply"]);
  assert.ok(!fs.existsSync(sessionFile("s1", "outbox.jsonl")));

  // Which project other folders are.
  const projectOf = (dir, session) => {
    hook("prompt-submit", { cwd: dir, session_id: session, prompt: "x" });
    hook("sync-turn", { cwd: dir, session_id: session, last_assistant_message: "y" });
    settled(session, "synced");
    // The stub names a project after its custom id; a known one is cached.
    const create = takeCalls().find((args) => args[0] === "conversation" && args[1] === "create");
    return create[create.indexOf("--project") + 1].replace(/^proj-/, "");
  };
  assert.equal(projectOf(work("wt"), "s-wt"), "github.com-Org-Repo", "a worktree is its repository");
  assert.equal(projectOf(work("multi"), "s-multi"), "host.example.com-2222-team-beta", "no origin: the first remote by name");
  assert.equal(projectOf(work("WorkBuddy", "2026-11-13-18-10-18", "sub"), "s-scratch"), "workbuddy");
  // A folder with no remote is its path, spelled as Git Bash spells it, so
  // the MemoryLake plugin's bash hooks name it the same.
  const spelled = WINDOWS ? work("plain").replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : work("plain");
  assert.equal(projectOf(work("plain"), "s-plain"), spelled.replace(/[/:]/g, "-").replace(/^-+/, ""));

  // An attached document and a pasted image, found in the transcript.
  write(work("files", "report.pdf"), "pdf");
  write(work("files", ".env"), "SECRET=1");
  write(path.join(root, "blob", "0123456789abcdef.png"), "png");
  const transcript = path.join(root, "transcript.jsonl");
  write(transcript, [
    { type: "message", role: "user", content: [
      { type: "input_text", text: `<user_query>see</user_query>\n<user_references>\n${JSON.stringify(work("files", "report.pdf"))}\n${JSON.stringify(work("files", ".env"))}\n</user_references>` },
      { type: "image_blob_ref", blob_path: path.join(root, "blob", "0123456789abcdef.png") },
    ] },
  ].map((line) => JSON.stringify(line) + "\n").join(""));
  const attached = hook("sync-attachments", { cwd: work("repo"), session_id: "s1", transcript_path: transcript });
  assert.equal(attached.lines.length, 0);
  const outcome = settled("s1", "ok", "attachments.json", "attachments.lock");
  assert.equal(outcome.uploaded, 2, JSON.stringify(outcome));
  assert.deepEqual(outcome.skipped.map((entry) => entry.reason), ["file type not synced"]);
  const uploads = takeCalls().filter((args) => args[1] === "upload").map((args) => args[args.indexOf("--name") + 1]);
  assert.deepEqual(uploads, ["image-0123456789ab.png", "report.pdf"]);
  hook("sync-attachments", { cwd: work("repo"), session_id: "s1", transcript_path: transcript });
  sleep(1500);
  assert.equal(takeCalls().length, 0, "nothing new in the transcript, nothing sent");

  // WorkBuddy ends the turn's process about a second after the turn and
  // kills every hook still running, with its children. Here the stand-in
  // turn kills its whole process group (Unix) or tree (Windows), and its
  // exit takes the Windows job Node puts its children in. The upload,
  // slowed down, still gets there. On Windows the hook runs under Git Bash,
  // as WorkBuddy runs it.
  const turn = path.join(root, "turn.mjs");
  write(turn, `
import { execFileSync, spawn } from "node:child_process";
const [command, ...args] = JSON.parse(process.argv[2]);
const hook = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
hook.stdout.resume();
hook.stderr.resume();
hook.stdin.end(process.argv[3]);
hook.on("close", () => {
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(process.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true }); } catch {}
  } else {
    process.kill(-process.pid, "SIGKILL");
  }
  process.exit(0);
});
`);
  const gitBash = WINDOWS ? ["C:\\Program Files\\Git\\bin\\bash.exe"].find((file) => fs.existsSync(file)) : undefined;
  const unix = (file) => file.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const stopCommand = gitBash
    ? [gitBash, "-c", `node "${unix(plugin)}/scripts/hook.mjs" sync-turn`]
    : [process.execPath, path.join(plugin, "scripts", "hook.mjs"), "sync-turn"];
  hook("prompt-submit", { cwd: work("repo"), session_id: "s-kill", prompt: "killed turn" });
  const started = Date.now();
  const killed = spawn(process.execPath, [turn, JSON.stringify(stopCommand), JSON.stringify({ cwd: work("repo"), session_id: "s-kill", last_assistant_message: "answer" })], {
    env: { ...baseEnv, STUB_MODE: "slow" }, stdio: "ignore", detached: !WINDOWS, windowsHide: true,
  });
  await new Promise((resolve) => killed.on("exit", resolve));
  assert.ok(!statusOf("s-kill") || statusOf("s-kill").last_detail !== "synced", "the turn was gone before the upload was done");
  settled("s-kill", "synced");
  console.log(`  upload outlived the killed turn (${Date.now() - started} ms${gitBash ? ", under Git Bash" : ""})`);
  const killedCalls = takeCalls().filter((args) => args[2] === "append").map((args) => args[args.indexOf("--text") + 1]);
  assert.deepEqual(killedCalls, ["killed turn", "answer"]);

  // A session whose upload failed, never continued: the next session start
  // sends what it left.
  hook("prompt-submit", { cwd: work("repo"), session_id: "s-left", prompt: "left behind" });
  hook("sync-turn", { cwd: work("repo"), session_id: "s-left", last_assistant_message: "too" }, "appendfail");
  assert.equal(settled("s-left", "error").pending, 2);
  takeCalls();
  hook("session-start", { cwd: work("plain"), session_id: "s-next" });
  settled("s-left", "synced");
  assert.deepEqual(takeCalls().filter((args) => args[2] === "append").map((args) => args[args.indexOf("--text") + 1]), ["left behind", "too"]);

  // That flush may send the user's message of a turn still in progress (it
  // did in WorkBuddy): the reply still goes when the turn ends.
  hook("prompt-submit", { cwd: work("repo"), session_id: "s-race", prompt: "early" });
  hook("session-start", { cwd: work("repo"), session_id: "s-other" });
  settled("s-race", "synced");
  hook("sync-turn", { cwd: work("repo"), session_id: "s-race", last_assistant_message: "late reply" });
  waitFor("the late reply", () => takeCalls().some((args) => args[2] === "append" && args.includes("late reply")) || null);
  settled("s-race", "synced");

  // ml-recall, the way the model runs it.
  const recall = (args, mode = "") => spawnSync(process.execPath, [path.join(plugin, "bin", "ml-recall"), ...args], {
    cwd: work("repo"), encoding: "utf8", env: { ...baseEnv, STUB_MODE: mode },
  });
  const found = recall(["tea"]);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /^FACTS \(1, most relevant first\)\n  - likes tea  \[f1\]/);
  assert.match(found.stdout, /FILES \(1\)\n  a\.pdf  \[d1\]\n      "passage"/);
  assert.deepEqual(takeCalls().at(-1), ["search", "--workspace", "ws-1", "--projects", "p1,p2", "--top-k", "5", "tea"]);
  const down = recall(["tea"], "down");
  assert.equal(down.status, 1);
  assert.match(down.stderr, /UPSTREAM_UNAVAILABLE[\s\S]*UNAVAILABLE for this call/);
  assert.equal(recall([]).status, 2);
  if (WINDOWS) {
    // The shells WorkBuddy runs hooks and the model's commands in. Its own
    // Git Bash first (with ${CLAUDE_PLUGIN_ROOT} in Git Bash's spelling, as
    // WorkBuddy hands it over), PowerShell where Git Bash is turned off. Each
    // is tried only when present: the hooks themselves need neither.
    const system = process.env.SystemRoot || "C:\\Windows";
    const env = { ...baseEnv, PATH: `${path.dirname(process.execPath)};${system}\\System32;${system}\\System32\\WindowsPowerShell\\v1.0` };
    const viaCmd = spawnSync("cmd.exe", ["/d", "/c", path.join(plugin, "bin", "ml-recall.cmd"), "tea"], { cwd: work("repo"), encoding: "utf8", env });
    assert.equal(viaCmd.status, 0, viaCmd.stderr);
    assert.match(viaCmd.stdout, /likes tea/);
    const powershell = spawnSync("powershell.exe", ["-NoProfile", "-Command", `node "${plugin}\\scripts/hook.mjs" session-start`], {
      input: JSON.stringify({ cwd: work("repo"), session_id: "s1" }), encoding: "utf8", env,
    });
    assert.match(powershell.stdout, /connected \(workspace ws-1/, powershell.stderr);
    const ml = spawnSync("powershell.exe", ["-NoProfile", "-Command", `$env:PATH = "${path.join(plugin, "bin")};" + $env:PATH; ml-recall tea`], { cwd: work("repo"), encoding: "utf8", env });
    assert.match(ml.stdout, /likes tea/, ml.stderr);
    const bash = gitBash;
    if (bash) {
      const viaBash = spawnSync(bash, ["-c", `node "${unix(plugin)}/scripts/hook.mjs" session-start`], {
        input: JSON.stringify({ cwd: work("repo"), session_id: "s1" }), encoding: "utf8", env,
      });
      assert.match(viaBash.stdout, /connected \(workspace ws-1/, viaBash.stderr);
      const byName = spawnSync(bash, ["-c", `PATH="${unix(path.join(plugin, "bin"))}:$PATH" ml-recall tea`], { cwd: work("repo"), encoding: "utf8", env });
      assert.match(byName.stdout, /likes tea/, byName.stderr);
    } else {
      console.log("note: no Git Bash here; hooks under Git Bash not tried");
    }
  }

  // With the MemoryLake plugin enabled, these hooks stand down.
  write(path.join(workbuddy, "settings.json"), JSON.stringify({ enabledPlugins: { "memorylake@memorylake": true } }));
  assert.equal(hook("prompt-submit", { cwd: work("repo"), session_id: "s1", prompt: "hi" }).json, null);
  assert.equal(hook("sync-turn", { cwd: work("repo"), session_id: "s1" }).lines.length, 0);

  console.log("ok: hooks and ml-recall with nothing but Node");
} finally {
  // A flush a session start began may still be running.
  waitFor("the last flush", () => !fs.existsSync(path.join(data, "state", "workbuddy-flush.lock")), 30);
  sleep(300);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
