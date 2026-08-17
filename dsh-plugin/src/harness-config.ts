/**
 * Shared harness configuration: the `~/.memorylake/` tree written by the
 * Claude Code plugin's init wizard and reused verbatim here, so one setup
 * serves every harness on the machine. This module is a TypeScript port of
 * `claude-plugin/scripts/lib/common.sh` and keeps its exact semantics:
 * line-oriented frontmatter parsing (not a YAML parser — same tolerance as
 * the bash implementation), per-key MERGE of the project file over the
 * global one (never shadow: a one-line project override must not knock out
 * the global workspace), and "absent flag means on".
 * @module
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Keys read from the shared config files. Unknown keys are preserved in `values`. */
export const CONFIG_KEYS = [
  'enabled',
  'workspace',
  'actor',
  'sync_on_write',
  'status_line',
  // Parsed and retained but not consumed by v1 (documents/projects are v2):
  'remind_on_read',
  'sync_deny',
  'projects',
  'project_custom_id',
] as const

/** Why the plugin is (or is not) active for a directory, before any network I/O. */
export type ConfigState = 'ready' | 'unconfigured' | 'disabled'

/** The merged view of the global config and an optional project override. */
export interface EffectiveConfig {
  /**
   * `unconfigured`: no config file, or no workspace — the plugin must stay
   * completely silent. `disabled`: an explicit `enabled: false`. `ready`:
   * a workspace is configured and the feature is on.
   */
  state: ConfigState
  /** The configured workspace id; only set when state is `ready`. */
  workspace?: string
  /** The configured actor id (facts are actor-scoped in v1). */
  actor?: string
  /** Whether memory writes are allowed (absent means on). */
  syncOnWrite: boolean
  /** Whether the session status line is enabled (absent means on). */
  statusLine: boolean
  /** Path of the global config file, when present. */
  globalPath?: string
  /** Path of the project override file, when present. */
  projectPath?: string
  /** Merged raw key/value pairs (project wins per key it defines). */
  values: Record<string, string>
  /** Which file supplied each merged key. */
  sources: Record<string, string>
}

/**
 * Root of the shared plugin data tree (`~/.memorylake/harness` by default).
 * `MEMORYLAKE_PLUGIN_DATA` overrides it — the same test seam the Claude Code
 * plugin uses, so isolated fixtures work identically across harnesses.
 */
export function dataDir(): string {
  return process.env.MEMORYLAKE_PLUGIN_DATA ?? join(homedir(), '.memorylake', 'harness')
}

/** Directory of the privately installed CLI: the sibling `bin/` of the data tree. */
export function binDir(): string {
  return join(dirname(dataDir()), 'bin')
}

/** Path of the global shared config file. */
export function globalConfigPath(): string {
  return join(dataDir(), 'config.md')
}

/** Directory of the cross-harness status cache (`status/<workspace>.txt`). */
export function statusCacheDir(): string {
  return join(dataDir(), 'status')
}

/**
 * Read scalar keys out of a Markdown frontmatter block, line by line.
 *
 * Deliberately not a YAML parser: the file is written by our own init flows
 * and documented in the README, and the bash implementation in the Claude
 * Code plugin reads it the same way — keeping both parsers line-oriented
 * keeps their tolerance identical. The first line must be `---`; reading
 * stops at the next `---`. Values may be single- or double-quoted; one
 * surrounding quote pair is stripped.
 * @param text - the file content.
 * @returns the parsed key/value map (possibly empty).
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return values
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const pos = line.indexOf(':')
    if (pos <= 0) continue
    const key = line.slice(0, pos).trim()
    let value = line.slice(pos + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      if ((first === '"' || first === '\'') && value.endsWith(first)) {
        value = value.slice(1, -1)
      }
    }
    if (key.length > 0) values[key] = value
  }
  return values
}

/**
 * Whether a config flag is anything other than an explicit false. Absent
 * means on: every flag in this config turns a feature OFF, and the file only
 * exists because the user opted in.
 * @param value - the raw flag value, or undefined/empty when the key is absent.
 * @returns false only for `false`/`no`/`off`/`0`.
 */
export function flagEnabled(value: string | undefined): boolean {
  switch (value ?? '') {
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false
    default:
      return true
  }
}

/**
 * Find the nearest project override file by walking up from a directory.
 * @param cwd - the directory to start from.
 * @returns the absolute path of `.claude/memorylake.local.md`, or undefined.
 */
export function findProjectConfig(cwd: string): string | undefined {
  let dir = cwd
  for (;;) {
    const candidate = join(dir, '.claude', 'memorylake.local.md')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Read and parse one config file, tolerating a missing or unreadable file. */
function readConfigFile(path: string | undefined): Record<string, string> {
  if (path === undefined) return {}
  try {
    return parseFrontmatter(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Load the effective configuration for a directory by MERGING the project
 * override onto the global config, key by key. Merging, not shadowing: a
 * project file exists to override a field or two (`sync_on_write: false` is
 * the canonical case) and must not have to repeat workspace and actor to
 * stay functional — the earlier shadow semantics silently knocked out recall
 * for any project with a one-line override file.
 *
 * Callers re-invoke this on every tool call and status assembly, so config
 * edits (e.g. right after the init skill finishes) take effect without a
 * restart. The files are tiny; the cost is a couple of stat()s.
 * @param cwd - the directory whose project override applies.
 * @returns the merged view with per-key sources.
 */
export function loadEffectiveConfig(cwd: string): EffectiveConfig {
  const projectPath = findProjectConfig(cwd)
  const globalCandidate = globalConfigPath()
  const globalPath = existsSync(globalCandidate) ? globalCandidate : undefined
  const projectValues = readConfigFile(projectPath)
  const globalValues = readConfigFile(globalPath)

  const values: Record<string, string> = {}
  const sources: Record<string, string> = {}
  for (const [key, value] of Object.entries(globalValues)) {
    if (value.length === 0) continue
    values[key] = value
    if (globalPath !== undefined) sources[key] = globalPath
  }
  for (const [key, value] of Object.entries(projectValues)) {
    if (value.length === 0) continue
    values[key] = value
    if (projectPath !== undefined) sources[key] = projectPath
  }

  const syncOnWrite = flagEnabled(values.sync_on_write)
  const statusLine = flagEnabled(values.status_line)
  const base = { syncOnWrite, statusLine, globalPath, projectPath, values, sources }

  if (projectPath === undefined && globalPath === undefined) {
    return { state: 'unconfigured', ...base }
  }
  if (!flagEnabled(values.enabled)) {
    return { state: 'disabled', ...base }
  }
  const workspace = values.workspace ?? ''
  if (workspace.length === 0) {
    return { state: 'unconfigured', ...base }
  }
  return { state: 'ready', workspace, actor: values.actor, ...base }
}

/**
 * Read the cross-harness status cache for a workspace: the cached project
 * count written by whichever harness probed connectivity last. The cache
 * stores DATA (a bare count), never rendered prose — a cached sentence from
 * one harness would teach another harness's model a command that does not
 * resolve there.
 * @param workspace - the workspace id the cache is keyed by.
 * @param ttlSeconds - maximum acceptable cache age.
 * @returns the cached project count, or undefined when absent/stale/invalid.
 */
export function readStatusCache(workspace: string, ttlSeconds: number): number | undefined {
  const path = join(statusCacheDir(), `${workspace}.txt`)
  try {
    const stat = statSync(path)
    if (Date.now() - stat.mtimeMs > ttlSeconds * 1000) return undefined
    const text = readFileSync(path, 'utf8').trim()
    if (!/^\d+$/.test(text)) return undefined
    return Number(text)
  } catch {
    return undefined
  }
}
