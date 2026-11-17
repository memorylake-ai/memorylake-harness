// Replays WorkBuddy 5.3.14's CLI-connector connect flow (doConnectCli +
// ConnectorCliExecutor) against a connector package, from a shell.
//   node wb-sim.mjs connect|disconnect <package-dir> <packages-dir> [KEY=VALUE ...]
// <packages-dir> stands in for ~/.workbuddy/binaries/node/cli-connector-packages.
import { exec, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const execAsync = promisify(exec);
const [mode, pkg, packagesDir, ...extra] = process.argv.slice(2);
const cli = JSON.parse(readFileSync(path.join(pkg, "cli.json"), "utf8"));
const plat = os.platform();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function buildEnv() {
  const env = { ...process.env };
  delete env.MEMORYLAKE_API_KEY;
  if (cli.runtime?.type === "node") { // applyNodeRuntimeEnv
    env.PATH = [path.join(packagesDir, "bin"), path.dirname(process.execPath), env.PATH].join(path.delimiter);
    env.npm_config_prefix = packagesDir;
  }
  for (const [k, raw] of Object.entries(cli.env || {})) env[k] = raw.replace(/\$\{HOME\}|\$HOME/g, os.homedir()); // applyCliConfigEnv
  for (const kv of extra) { const i = kv.indexOf("="); env[kv.slice(0, i)] = kv.slice(i + 1); } // test knobs
  return env;
}
const env = buildEnv();
async function run(cmd, timeout) {
  try { const { stdout, stderr } = await execAsync(cmd, { timeout, env }); return { success: true, stdout, stderr, exitCode: 0 }; }
  catch (e) { return { success: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, exitCode: e.code ?? -1 }; }
}
const extractExecutable = (cmd) => cmd.trim().split(/[\s|;&<>()`$]/)[0];
const firstAuth = Array.isArray(cli.auth) ? cli.auth[0]?.command : cli.auth;
async function isInstalled() {
  const exe = extractExecutable((firstAuth ?? {})[plat] || cli.status[plat]);
  const r = await run(`which '${exe}'`, 5000);
  log(`isCliInstalled: which ${exe} ->`, r.success ? r.stdout.trim() : "not found");
  return r.success;
}
const semverGte = (a, b) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x > y) return true; if (x < y) return false; } return true; };
async function checkVersion() {
  const r = await run(cli.versionCheck.command[plat], 10000);
  if (r.exitCode !== 0) return { needsUpgrade: true };
  const m = r.stdout.match(new RegExp(cli.versionCheck.versionPattern || "(\\d+\\.\\d+\\.\\d+)")) || r.stderr.match(new RegExp(cli.versionCheck.versionPattern));
  if (!m?.[1]) return { needsUpgrade: true };
  return { needsUpgrade: !semverGte(m[1], cli.versionCheck.minVersion), currentVersion: m[1] };
}
async function status() {
  const r = await run(cli.status[plat], 10000);
  const ok = r.exitCode === 0 && (!cli.statusMatch || new RegExp(cli.statusMatch).test(r.stdout + r.stderr));
  return ok;
}
function extractAuthUrl(text, domain) {
  const re = /https?:\/\/[^\s\n\r"'<>]+/g; let m;
  while ((m = re.exec(text)) !== null) { if (domain) { if (m[0].includes(domain)) return m[0]; } else if (m[0].startsWith("https://")) return m[0]; }
}
function runAuth() {
  const waitForExit = cli.authWaitForExit === true;
  return new Promise((resolve) => {
    const child = spawn(firstAuth[plat], { shell: true, timeout: waitForExit ? 300000 : 10000, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", opened = false;
    const tryUrl = (text) => {
      if (opened) return; const url = extractAuthUrl(text, cli.authUrlDomain); if (!url) return;
      opened = true; log("Auth URL found -> openExternal"); writeFileSync(process.env.SIM_URL_FILE, url);
      if (!waitForExit) { child.kill(); resolve({ success: true, authUrl: url }); }
    };
    child.stdout.on("data", (d) => { out += d; tryUrl(out); });
    child.stderr.on("data", (d) => { err += d; tryUrl(err); });
    child.on("close", (code) => resolve({ success: code === 0, exitCode: code, stderr: err, authUrl: opened ? extractAuthUrl(out + err, cli.authUrlDomain) : undefined }));
  });
}

if (mode === "disconnect") {
  const r = await run(cli.unAuth[plat], 30000);
  log("unAuth exit:", r.exitCode, "| status after:", await status());
  process.exit(0);
}

log("Phase 1 - Check CLI installation");
if (!(await isInstalled())) {
  log("not installed, running init:", cli.init[plat].slice(0, 60) + "...");
  const r = await run(cli.init[plat], 300000);
  if (!r.success) { log("CLI install failed:", r.stderr.trim().split("\n").slice(-3).join(" | ")); process.exit(1); }
  log("install completed:", r.stdout.trim().split("\n").filter(Boolean).slice(0, 2).join(" | "));
  log("installed now?", await isInstalled());
}
if (cli.versionCheck) {
  let v = await checkVersion(); log("checkVersion:", JSON.stringify(v));
  if (v.needsUpgrade) { const r = await run(cli.init[plat], 300000); log("upgrade:", r.success); v = await checkVersion(); log("recheck:", JSON.stringify(v)); if (v.needsUpgrade) process.exit(1); }
}
log("Phase 2 - Check status");
if (await status()) { log("already authenticated -> finalizeCliConnect"); process.exit(0); }
log("Phase 3 - Running auth");
if (!cli.auth) { log("No auth command configured"); process.exit(1); }
const auth = await runAuth();
log("auth process ended: success=%s exit=%s authUrl=%s", auth.success, auth.exitCode, !!auth.authUrl);
if (!auth.authUrl && !auth.success) { log("CLI auth failed:", auth.stderr.trim()); process.exit(1); }
log("Phase 4 - Polling for auth completion");
for (let i = 0; i < 5; i++) { if (await status()) { log("CONNECTED -> finalizeCliConnect (skills get installed)"); process.exit(0); } await new Promise((r) => setTimeout(r, 3000)); }
log("auth timed out"); process.exit(1);
