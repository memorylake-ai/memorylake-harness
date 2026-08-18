/**
 * The shared Memory Lake harness configuration, as read by opencode.
 *
 * The file, its keys, and their semantics are a CROSS-HARNESS CONTRACT: the
 * Claude Code, Codex, dsh, and opencode plugins all read the same
 * `~/.memorylake/harness/config.md`, which is what makes them one identity
 * rather than four installations. The parsing here is written for opencode,
 * but every rule it implements is fixed by that contract — in particular:
 *
 *   - a missing flag means ON (absence is not opt-out)
 *   - no config file at all means `unconfigured`, and an unconfigured machine
 *     must see no evidence this plugin is installed
 *   - `MEMORYLAKE_PLUGIN_DATA` relocates the whole data tree; it is the test
 *     seam every harness uses, so fixtures work identically across all four
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Why the plugin is, or is not, active — decided before any network I/O. */
export type ConfigState = 'ready' | 'unconfigured' | 'disabled'

/** The merged view of the global config and an optional project override. */
export interface EffectiveConfig {
  /**
   * `unconfigured`: no config file, or a config with no workspace. The plugin
   * must stay completely silent. `disabled`: an explicit `enabled: false`.
   * `ready`: a workspace is configured and the plugin is on.
   */
  state: ConfigState
  /** The configured workspace id; only set when state is `ready`. */
  workspace?: string
  /** The configured actor id — facts are actor-scoped. */
  actor?: string
  /** Path of the global config file, when one exists. */
  globalPath?: string
  /** Path of the project override file, when one exists. */
  projectPath?: string
  /** Merged raw key/value pairs; the project file wins per key it defines. */
  values: Record<string, string>
}

/**
 * Root of the shared data tree (`~/.memorylake/harness` by default).
 * @returns the absolute path of the data tree root.
 */
export function dataDir(): string {
  return process.env.MEMORYLAKE_PLUGIN_DATA ?? join(homedir(), '.memorylake', 'harness')
}

/**
 * Directory of the privately installed CLI: the sibling `bin/` of the data
 * tree, so relocating the tree relocates the binary lookup with it.
 * @returns the absolute path of the private bin directory.
 */
export function binDir(): string {
  return join(dirname(dataDir()), 'bin')
}

/**
 * Path of the global shared config file.
 * @returns the absolute path of `config.md` inside the data tree.
 */
export function globalConfigPath(): string {
  return join(dataDir(), 'config.md')
}

/**
 * Directory of the cross-harness connectivity cache.
 *
 * The cache stores DATA — a bare project count — and never rendered prose. A
 * sentence cached by one harness and served to another would teach that
 * harness's model a command that does not resolve there.
 * @returns the absolute path of the status cache directory.
 */
export function statusCacheDir(): string {
  return join(dataDir(), 'status')
}

/**
 * Read another harness's recent connectivity probe, if one is fresh enough.
 *
 * Sharing this cache is why a user running Claude Code and opencode side by
 * side pays for one probe rather than two.
 * @param workspace - the workspace id the cache is keyed by.
 * @param ttlSeconds - the maximum acceptable age.
 * @returns the cached project count, or undefined when absent, stale, or invalid.
 */
export function readStatusCache(workspace: string, ttlSeconds: number): number | undefined {
  try {
    const path = join(statusCacheDir(), `${workspace}.txt`)
    const stat = statSync(path)
    if (Date.now() - stat.mtimeMs > ttlSeconds * 1000) return undefined
    const text = readFileSync(path, 'utf8').trim()
    if (!/^\d+$/.test(text)) return undefined
    return Number(text)
  } catch {
    return undefined
  }
}

/**
 * Publish this harness's probe for the others to reuse. Best effort: a
 * read-only data tree must not break the session.
 * @param workspace - the workspace id to key the cache by.
 * @param projects - the observed project count.
 */
export function writeStatusCache(workspace: string, projects: number): void {
  try {
    const dir = statusCacheDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${workspace}.txt`), String(projects), 'utf8')
  } catch {
    /* best effort */
  }
}

/**
 * Parse a YAML-ish frontmatter block. Deliberately not a YAML parser: the
 * contract is flat `key: value` pairs, and pulling in a YAML dependency to
 * read six scalars would be a poor trade.
 * @param text - the full file contents.
 * @returns the key/value pairs, or an empty object when there is no block.
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
      const quote = value[0]
      if ((quote === '"' || quote === '\'') && value.endsWith(quote)) {
        value = value.slice(1, -1)
      }
    }
    if (key.length > 0) values[key] = value
  }
  return values
}

/**
 * Interpret a config flag. An absent or empty value means ON — the contract
 * treats absence as "not opted out", not as "off".
 * @param value - the raw string from the frontmatter, if present.
 * @returns whether the flag is enabled.
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
 * Walk up from a directory looking for a project-level override.
 *
 * `.opencode/` is checked before `.claude/` so an opencode user can configure
 * a repo without a directory named after a different tool, while a repo
 * already configured for Claude Code keeps working untouched — the shared
 * config is the whole point.
 * @param cwd - the directory to start from.
 * @returns the override path, or undefined when none exists above `cwd`.
 */
export function findProjectConfig(cwd: string): string | undefined {
  let dir = cwd
  for (;;) {
    for (const harness of ['.opencode', '.claude']) {
      const candidate = join(dir, harness, 'memorylake.local.md')
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Read and parse a config file, tolerating every failure as "no values". */
function readConfigFile(path: string | undefined): Record<string, string> {
  if (path === undefined) return {}
  try {
    return parseFrontmatter(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Resolve the effective configuration for a session directory.
 *
 * Never throws: a malformed or unreadable config resolves to `unconfigured`,
 * which by contract means the plugin does nothing at all. A plugin that
 * crashed the host on a stray character would be worse than one that stayed
 * quiet.
 * @param cwd - the session directory.
 * @param overrides - inline options from `opencode.json`, which win per key.
 * @returns the merged, classified configuration.
 */
export function loadEffectiveConfig(
  cwd: string,
  overrides: Record<string, string> = {},
): EffectiveConfig {
  const projectPath = findProjectConfig(cwd)
  const globalCandidate = globalConfigPath()
  const globalPath = existsSync(globalCandidate) ? globalCandidate : undefined

  const values: Record<string, string> = {}
  const merge = (source: Record<string, string>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (value.length > 0) values[key] = value
    }
  }
  merge(readConfigFile(globalPath))
  merge(readConfigFile(projectPath))
  merge(overrides)

  const base = { globalPath, projectPath, values }

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
