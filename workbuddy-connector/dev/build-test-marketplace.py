#!/usr/bin/env python3
"""Build a WorkBuddy connector-marketplace zip = the locally cached official
index + our connector, so a local override keeps every official connector.

usage: build-test-marketplace.py <package-dir> <out.zip> [KEY=VALUE ...]
Extra KEY=VALUE pairs are added to cli.json's env in the zip only (test knobs).
"""
import json, os, shutil, sys, tempfile, zipfile

pkg, out = sys.argv[1], sys.argv[2]
extra_env = dict(kv.split("=", 1) for kv in sys.argv[3:])
cache = os.path.expanduser("~/.workbuddy/connectors-marketplace")
meta = json.load(open(os.path.join(pkg, "connector-meta.json"), encoding="utf-8"))
source = meta["source"]

tmp = tempfile.mkdtemp(prefix="wb-mkt-")
root = os.path.join(tmp, "root")
shutil.copytree(cache, root)

dest = os.path.join(root, "connectors", source)
shutil.rmtree(dest, ignore_errors=True)
os.makedirs(dest)
cli = json.load(open(os.path.join(pkg, "cli.json"), encoding="utf-8"))
cli.setdefault("env", {}).update(extra_env)
json.dump(cli, open(os.path.join(dest, "cli.json"), "w"), indent=2)
shutil.copytree(os.path.join(pkg, "skills"), os.path.join(dest, "skills"))

icon = next(f for f in os.listdir(pkg) if f.startswith("icon."))
shutil.copy(os.path.join(pkg, icon), os.path.join(root, "icons", source + os.path.splitext(icon)[1]))

manifest_path = os.path.join(root, ".codebuddy-connector", "connectors.json")
manifest = json.load(open(manifest_path, encoding="utf-8"))
entries = [e for e in manifest["connectors"] if e.get("source") != source]
entries.insert(0, {"id": source, **meta})
manifest["connectors"] = entries
json.dump(manifest, open(manifest_path, "w", encoding="utf-8"), ensure_ascii=False)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, root))
shutil.rmtree(tmp)
print(f"wrote {out}: {len(entries)} connectors, ours first ({source}), extra env {extra_env}")
