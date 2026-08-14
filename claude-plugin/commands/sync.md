---
description: Show or change whether this project's memories sync to Memory Lake
argument-hint: "[on|off]"
allowed-tools: Bash, Read, Write, Edit
---

Control the memory-sync switch for the **current project**. The argument is
`$ARGUMENTS`: `off` stops this project's memories from uploading, `on` turns
uploading (back) on, and no argument reports the current effective policy.

Config changes take effect on the next memory write — the hooks re-read the
config every time they fire. No restart, no reload.

## How the policy is resolved (three layers, most specific wins)

1. **Project file** `.claude/memorylake.local.md` at the repo root, when it
   explicitly sets `sync_on_write` — the final word for this project
2. **Global `sync_deny`** in `~/.memorylake/harness/config.md`: a
   comma-separated list of path prefixes (`~` allowed); a project under any
   listed prefix does not sync. Note: a project file that exists but does not
   set `sync_on_write` does NOT override the deny list
3. **Global `sync_on_write`** — the default for everything else

## No argument — report

Determine and state the effective policy for this project and, crucially,
**where it comes from**. Check in order: does the repo-root
`.claude/memorylake.local.md` set `sync_on_write`? Else, does the project's
repo root fall under any `sync_deny` prefix in the global config? Else, what
does the global `sync_on_write` say (absent means OFF — uploading only ever
happens by explicit opt-in)? Report in the conversation's language, e.g.:

> Write-sync for this project: OFF — source: global `sync_deny` matches
> `~/work`. An explicit `sync_on_write: true` in this project's
> `.claude/memorylake.local.md` overrides it.

Also mention what is and is not affected: the switch governs **writing**
(uploads); recall (`ml-recall`) keeps working either way.

## `off` — stop this project's uploads

Create or edit `.claude/memorylake.local.md` at the **repo root** (not the
cwd, if they differ) so it contains `sync_on_write: false` in its frontmatter.
Preserve any other keys already in the file. If the file does not exist:

```markdown
---
sync_on_write: false
---
```

Ensure `.gitignore` covers `.claude/*.local.md`; append if missing. Then
confirm to the user, and remind them: memories already uploaded are NOT
recalled by this — the switch only governs the future. Offer to list what the
project has in Memory Lake (`memorylake project get --workspace <ws>
<custom-id> --by-custom-id`, then `project document list`) if they want to
review or delete. The custom id is the repo's derived identity — its
normalized remote URL with `/` and `:` folded to `-`
(`github.com-zbyte-foo`), or its dash-folded physical path when it has no
remote; `memorylake project list` shows every project's custom_id when in
doubt.

## `on` — enable (or re-enable) uploads

Set `sync_on_write: true` explicitly in the project file (same editing rules
as above). Explicit `true` matters: it is what overrides a global `sync_deny`
prefix covering this project. If the global config has `sync_on_write: false`
(opt-in mode), this explicit project value is also what turns the project on.

Confirm, and note syncing resumes from the next memory write.
