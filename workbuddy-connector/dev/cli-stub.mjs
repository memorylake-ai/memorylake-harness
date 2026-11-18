#!/usr/bin/env node
// A stand-in `memorylake` for testing the sign-in page's import step.
//
// `project`, `library` and `actor` commands are answered from a JSON state file, in
// the shapes the real CLI prints, so a test can see exactly what the page
// uploaded. Every other command goes to the real CLI (MEMORYLAKE_REAL_BIN),
// which talks to dev/mock-api.mjs for login and workspaces.
//
//   MEMORYLAKE_BIN=dev/cli-stub.mjs MEMORYLAKE_REAL_BIN=memorylake \
//   STUB_STATE=/tmp/state.json node .../scripts/login.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.STUB_STATE;
if (!statePath) {
  console.error("STUB_STATE is not set");
  process.exit(2);
}

if (!["project", "library", "actor"].includes(args[0])) {
  const result = spawnSync(process.env.MEMORYLAKE_REAL_BIN || "memorylake", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { project: null, items: [], documents: [], calls: [], next: 1 };
state.bound ??= [];
state.calls.push(args.join(" "));
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const print = (value) => console.log(JSON.stringify(value, null, 2));
const fail = (message) => {
  save();
  console.error(`Error: ${message}`);
  process.exit(1);
};
const id = (prefix) => `${prefix}-${state.next++}`;

const command = args.slice(0, args[1] === "document" ? 3 : 2).join(" ");
switch (command) {
  case "actor me":
    print({ id: "actor-me", display_name: "Test User" });
    break;
  case "actor list":
    print({ items: state.bound.map((actor_id) => ({ actor_id, status: "ACTIVE" })), continuation_token: null });
    break;
  case "actor bind":
    if (!state.bound.includes(flag("--actor"))) state.bound.push(flag("--actor"));
    print({ actor_id: flag("--actor"), workspace_id: flag("--workspace") });
    break;
  case "project list":
    print({ items: state.project ? [state.project] : [], continuation_token: null });
    break;
  case "project get":
    if (!state.project) fail("[PROJECT_NOT_FOUND] no such project");
    print(state.project);
    break;
  case "project create":
    if (state.project) fail("[CONFLICT] custom id already in use");
    state.project = { id: id("proj"), name: flag("--name"), custom_id: flag("--custom-id") };
    print(state.project);
    break;
  case "project document list":
    print({
      items: state.documents.map(({ id, name }) => ({ id, name, project_id: state.project?.id, status: "okay" })),
      continuation_token: null,
    });
    break;
  case "project document delete": {
    const target = args.at(-1);
    if (!state.documents.some((doc) => doc.id === target)) fail("[DOCUMENT_NOT_FOUND] no such document");
    state.documents = state.documents.filter((doc) => doc.id !== target);
    print({ deleted: [target] });
    break;
  }
  case "project document import": {
    const item = state.items.find((candidate) => candidate.item_id === args.at(-1));
    if (!item) fail("[ITEM_NOT_FOUND] no such Library item");
    const existing = state.documents.find((doc) => doc.item_id === item.item_id);
    if (existing) {
      // Like the server: the old content stays indexed.
      print({ details: [{ result: "duplicate", document_id: existing.id }] });
      break;
    }
    const doc = { id: id("doc"), name: item.name, item_id: item.item_id, content: item.content };
    state.documents.push(doc);
    print({ details: [{ result: "imported", document_id: doc.id }] });
    break;
  }
  case "library list":
    print({ items: state.items.map(({ content, ...item }) => item), continuation_token: null });
    break;
  case "library mkdir": {
    const item = { item_id: id("dir"), name: args[2], type: "directory" };
    state.items.push(item);
    print(item);
    break;
  }
  case "library upload": {
    const name = flag("--name");
    const content = readFileSync(args[2], "utf8");
    let item = state.items.find((candidate) => candidate.type === "file" && candidate.name === name);
    if (item) item.content = content;
    else state.items.push((item = { item_id: id("file"), name, type: "file", parent_item_id: flag("--parent"), content }));
    const { content: _, ...shown } = item;
    print(shown);
    break;
  }
  default:
    fail(`cli-stub does not know: ${args.join(" ")}`);
}
save();
