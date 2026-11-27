#!/usr/bin/env node
// Builds the plugin people install: the files in this directory plus the
// memorylake CLI for the platforms WorkBuddy's users are on (macOS and
// Windows on x64; --platforms for others), so that installing the plugin is
// all it takes. The binaries are not kept in this repository; they come from the
// CLI's npm packages, the same ones the connector installs.
//
//   node dev/build.mjs [--out DIR] [--cli VERSION] [--registry URL]
//                      [--platforms darwin-arm64,win32-x64,...] [--zip]
//
// Leaves a marketplace directory, DIR/memorylake-plugin (DIR defaults to
// dist/), that WorkBuddy can add as it is; --zip packs it too. The CLI
// release is the one the connector pins (workbuddy-connector/memorylake/cli.json)
// unless --cli names another. Needs npm and tar.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"];
// WorkBuddy is a desktop app for macOS and Windows. On a platform left out,
// the plugin falls back on a CLI in ~/.memorylake/bin or on PATH.
const DEFAULT = ["darwin-arm64", "darwin-x64", "win32-x64"];

const option = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const WINDOWS = process.platform === "win32";

function run(file, args, options = {}) {
  // npm is a .cmd on Windows, which only a shell starts.
  const result = spawnSync(file, args, { encoding: "utf8", shell: WINDOWS && file === "npm", ...options });
  if (result.status !== 0) {
    console.error(`${file} ${args.join(" ")} failed:\n${result.stderr || result.error?.message || result.stdout}`);
    process.exit(1);
  }
  return result.stdout;
}

const pinned = readFileSync(join(plugin, "..", "workbuddy-connector", "memorylake", "cli.json"), "utf8").match(/@memorylake\/cli@([\d.]+)/)?.[1];
const cli = option("cli") || pinned;
if (!cli) {
  console.error("no CLI release to bundle: pass --cli VERSION");
  process.exit(1);
}
const platforms = (option("platforms") || DEFAULT.join(",")).split(",").filter(Boolean);
const unknown = platforms.filter((name) => !PLATFORMS.includes(name));
if (unknown.length) {
  console.error(`unknown platform(s): ${unknown.join(", ")} (known: ${PLATFORMS.join(", ")})`);
  process.exit(1);
}

const out = join(option("out") || join(plugin, "dist"), "memorylake-plugin");
const target = join(out, "memorylake");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Entry by entry: the default output directory is inside this one.
for (const entry of readdirSync(plugin)) {
  if (["dev", "dist", "vendor", ".DS_Store"].includes(entry)) continue;
  cpSync(join(plugin, entry), join(target, entry), { recursive: true, filter: (source) => !source.endsWith(".DS_Store") });
}

const manifest = JSON.parse(readFileSync(join(target, ".workbuddy-plugin", "plugin.json"), "utf8"));
mkdirSync(join(out, ".workbuddy-plugin"));
writeFileSync(join(out, ".workbuddy-plugin", "marketplace.json"), JSON.stringify({
  name: "memorylake",
  description: "MemoryLake integrations for WorkBuddy",
  owner: { name: "MemoryLake" },
  plugins: [{ name: manifest.name, source: "./memorylake", description: manifest.description }],
}, null, 2) + "\n");

const work = mkdtempSync(join(tmpdir(), "ml-plugin-build-"));
try {
  const registry = option("registry") ? ["--registry", option("registry")] : [];
  for (const name of platforms) {
    const exe = name.startsWith("win32") ? "memorylake.exe" : "memorylake";
    const dir = join(work, name);
    mkdirSync(dir);
    const packed = run("npm", ["pack", `@memorylake/cli-${name}@${cli}`, "--pack-destination", dir, "--silent", ...registry], { cwd: dir }).trim().split(/\r?\n/).at(-1);
    run("tar", ["-xzf", packed, `package/bin/${exe}`], { cwd: dir });
    mkdirSync(join(target, "vendor", name), { recursive: true });
    cpSync(join(dir, "package", "bin", exe), join(target, "vendor", name, exe));
    chmodSync(join(target, "vendor", name, exe), 0o755);
    console.log(`  ${name}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
// What the model and the hooks start as programs.
for (const file of ["bin/memorylake", "bin/memorylake-connect", "bin/ml-recall", "scripts/hook.mjs", "scripts/connect.mjs", "scripts/login.mjs"]) {
  chmodSync(join(target, file), 0o755);
}

// The CLI for this computer, run through the launcher the model uses.
const here = `${process.platform}-${process.arch}`;
if (platforms.includes(here)) {
  const launcher = join(target, "bin", WINDOWS ? "memorylake.cmd" : "memorylake");
  const version = run(launcher, ["version"], { shell: WINDOWS }).trim();
  const release = `v${cli.split(".")[0]}`;
  if (!version.startsWith(release)) {
    console.error(`the bundled CLI says ${version}, expected ${release}`);
    process.exit(1);
  }
}

console.log(`${manifest.name} ${manifest.version} with memorylake CLI ${cli} (${platforms.length} platform(s)): ${out}`);
if (process.argv.includes("--zip")) {
  const zip = join(dirname(out), `memorylake-plugin-${manifest.version}.zip`);
  rmSync(zip, { force: true });
  run("zip", ["-q", "-r", "-X", zip, "."], { cwd: out });
  console.log(zip);
}
