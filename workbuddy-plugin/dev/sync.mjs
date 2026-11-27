#!/usr/bin/env node
// The plugin and the connector run the same code: the hooks, ml-recall, the
// sign-in page and the skills. The connector's copy is the source; this
// copies it here, so the plugin directory stays installable as it is. The
// skills are copied with the passages that say how MemoryLake is set up
// reworded for the plugin (REWRITES).
//
//   node dev/sync.mjs           copy the connector's files over the plugin's
//   node dev/sync.mjs --check   exit 1 when a copy differs (for tests and CI)
//
// What is each packaging's own is not listed: scripts/lib/host.mjs, the
// manifest, the commands.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");
const connector = join(plugin, "..", "workbuddy-connector", "memorylake", "skills");
const auto = join(connector, "memorylake-cli", "scripts", "auto-memory", "memorylake-auto");

// [connector path, plugin path, names left alone on the plugin's side]
const SHARED = [
  [join(auto, "scripts"), "scripts", ["lib/host.mjs", "connect.mjs", "login.mjs"]],
  [join(auto, "bin", "ml-recall"), "bin/ml-recall"],
  [join(auto, "bin", "ml-recall.cmd"), "bin/ml-recall.cmd"],
  [join(auto, "hooks", "hooks.json"), "hooks/hooks.json"],
  [join(connector, "memorylake-cli", "scripts", "login.mjs"), "scripts/login.mjs"],
  [join(connector, "memorylake-cli", "SKILL.md"), "skills/memorylake-cli/SKILL.md"],
  [join(connector, "memorylake-cli-recall"), "skills/memorylake-cli-recall"],
  [join(connector, "memorylake-cli-memory"), "skills/memorylake-cli-memory"],
  [join(connector, "memorylake-cli-import"), "skills/memorylake-cli-import"],
  [join(connector, "memorylake-cli-access"), "skills/memorylake-cli-access"],
];

// By the plugin's path: [the connector's words, the plugin's]. Each must be
// found exactly once, so an edit to the connector's skill that touches one
// stops the sync instead of leaving the plugin saying something stale.
const REWRITES = {
  "skills/memorylake-cli/SKILL.md": [
    ["The MemoryLake connector installed the CLI and keeps it up to date. Run\nevery command through the Bash tool.",
      "The MemoryLake plugin carries the CLI and puts it on `PATH`; a newer plugin\nbrings a newer CLI. Run every command through the Bash tool."],
    ["(the user chose it on the connector's sign-in\npage, or installed the MemoryLake plugin)",
      "(the user chooses it on MemoryLake's sign-in\npage)"],
    ["The connector installs the CLI into WorkBuddy's own tools directory, which\nWorkBuddy puts on `PATH`.",
      "The plugin's own copy is the `memorylake` WorkBuddy puts on `PATH`."],
    ["ask the user to reconnect the MemoryLake\nconnector.\n",
      "tell the user to update or reinstall the\nMemoryLake plugin.\n"],
    ["ask the user to reconnect the\n  MemoryLake connector in WorkBuddy's connector list; that opens a page\n  where they sign in.",
      "run `memorylake-connect` (Bash); that\n  opens a page in the user's browser where they sign in."],
    ["ask the user to reconnect the connector the same way.", "open the sign-in page for the user the same way."],
    ["The\n  connector signs in to China.", "The\n  plugin's sign-in page signs in to China."],
    ["The\n  connector owns the login; disconnecting and reconnecting it in WorkBuddy is\n  how the user changes accounts.",
      "The\n  sign-in page owns the login; opening it again (`memorylake-connect`) is\n  how the user changes accounts."],
  ],
  "skills/memorylake-cli-recall/SKILL.md": [
    ["The user chooses this on the connector's sign-in page.", "The user chooses this on MemoryLake's sign-in page."],
    ["- If a skill named `memorylake` is present (the MemoryLake plugin's own),\n  follow it for recall.\n", ""],
    ["or that the connector needs reconnecting if the error is about the\nAPI key.",
      "or that the user needs to sign in again (`memorylake-connect` opens the\npage) if the error is about the API key."],
    ["- **On**: it is offered on the sign-in page. Ask the user to reconnect the\n  MemoryLake connector in WorkBuddy's connector list and choose it there; it\n  applies from the next new conversation.\n- **Off**: disconnecting the connector removes it.\n- **Down**, when the user wants to keep the connector: the switches are in",
      "- **On or off**: the switches are on the sign-in page. Run\n  `memorylake-connect` (Bash) to open it for the user; what they choose\n  there applies from the next message. Uninstalling the plugin in WorkBuddy\n  removes automatic memory altogether.\n- **Down**, for one setting: the switches are in"],
  ],
  "skills/memorylake-cli-memory/SKILL.md": [
    ["(the user turned\nautomatic memory on at the connector's sign-in page, or installed the\nMemoryLake plugin)",
      "(the user left\nautomatic memory on at MemoryLake's sign-in page)"],
  ],
  "skills/memorylake-cli-import/SKILL.md": [
    ["for example right after the connector was connected.", "for example right after MemoryLake was set up."],
    ["The connector's sign-in page offers the same import when the user connects.", "MemoryLake's sign-in page offers the same import when the user signs in."],
  ],
};

/** A connector file as the plugin has it. */
function forPlugin(source, to) {
  const rewrites = REWRITES[to];
  if (!rewrites) return readFileSync(source);
  let text = readFileSync(source, "utf8");
  for (const [from, into] of rewrites) {
    if (text.split(from).length !== 2) {
      console.error(`${to}: expected the connector's skill to say this exactly once:\n${from}`);
      process.exit(1);
    }
    text = text.replace(from, () => into);
  }
  return Buffer.from(text);
}

function files(root, prefix = "") {
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) return [""];
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(root, name) : [name];
  });
}

const check = process.argv.includes("--check");
const differing = [];
for (const [from, to, own = []] of SHARED) {
  const target = join(plugin, to);
  const wanted = files(from).filter((name) => !own.includes(name));
  for (const name of wanted) {
    const [source, copy] = [join(from, name), join(target, name)];
    const content = forPlugin(source, name ? `${to}/${name}` : to);
    const same = existsSync(copy) && content.equals(readFileSync(copy))
      && (statSync(source).mode & 0o111) === (statSync(copy).mode & 0o111);
    if (same) continue;
    differing.push(relative(plugin, copy));
    if (check) continue;
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, content);
    chmodSync(copy, statSync(source).mode & 0o777);
  }
  // A file the connector no longer has.
  for (const name of files(target)) {
    if (wanted.includes(name) || own.includes(name)) continue;
    differing.push(relative(plugin, join(target, name)));
    if (!check) rmSync(join(target, name));
  }
}

if (check && differing.length) {
  console.error(`not the connector's copy (run node dev/sync.mjs):\n  ${differing.join("\n  ")}`);
  process.exit(1);
}
console.log(check ? "the plugin's shared files match the connector's" : `synced ${differing.length} file(s)`);
