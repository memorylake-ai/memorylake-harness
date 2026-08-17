/**
 * Body of the `memorylake-status` runtime skill: the setup health check,
 * ported from the Claude Code plugin's `/memorylake:status` command. Two
 * meta rules survive the port unchanged: never stop at the first failure
 * (the user needs the whole picture), and end with the single most useful
 * next action. The jq check is gone — this plugin parses JSON itself and
 * depends on no external tools.
 * @module
 */

/** Model-facing instructions for the Memory Lake health check. */
export const STATUS_SKILL_CONTENT = `Run the checks below in order and report each one as pass or fail with the
detail shown. Do not stop at the first failure — the user needs the whole
picture. End with the single most useful next action.

## 1. CLI installed

\`\`\`bash
command -v memorylake || ls "$HOME/.memorylake/bin/memorylake"
\`\`\`

Report which location was found (a PATH install takes precedence over the
shared private download at \`~/.memorylake/bin/\`) and its
\`memorylake version\`. Missing from both → the plugin cannot do anything;
point at \`/memorylake-init\`, which can download a prebuilt binary.

## 2. Logged in

\`\`\`bash
memorylake auth status
\`\`\`

Report the profile, base URL, and where each came from. Not logged in →
\`memorylake auth login --api-key <KEY>\` (never echo the key anywhere else).

## 3. Effective config

Two levels, merged key by key with the project file winning per key it
defines:

1. \`.claude/memorylake.local.md\` from the project root (walk up from the
   working directory) — optional per-project override
2. \`~/.memorylake/harness/config.md\` — the global default written by
   \`/memorylake-init\`, shared with the Claude Code and Codex integrations

Report which files exist and, for each of \`enabled\`, \`workspace\`, \`actor\`,
\`sync_on_write\`, and \`status_line\`, the effective value AND which file
supplied it. Neither file exists → point at \`/memorylake-init\`.

\`workspace\` is the only strictly required field; without it the plugin
stays completely silent. \`actor\` is required for writing facts.

Also resolve and report this project's **write policy with its source**:
a project-file \`sync_on_write\` (explicit) beats the global default. E.g.
"writes: OFF — sync_on_write: false in <project file>; reads still work".

## 4. Connectivity

Only if steps 1–3 passed:

\`\`\`bash
memorylake project list --workspace <workspace from config>
\`\`\`

Report the project count. A failure here means recall is unavailable — say
so explicitly, because a silently unavailable memory backend is
indistinguishable from an empty memory unless someone says it out loud.

## 5. End-to-end recall

Only if step 4 passed: call the \`memory_search\` tool once with any query.

An empty result is a pass — it proves the path works. A notice saying the
backend is unreachable or the plugin is unconfigured is a failure; report it
verbatim.`
