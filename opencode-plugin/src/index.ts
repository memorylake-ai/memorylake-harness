/**
 * Memory Lake for opencode.
 *
 * opencode has no memory of its own — its only ambient instruction mechanism
 * is static `AGENTS.md` files — and it cannot read Claude Code's memory
 * directory. This plugin is therefore the memory layer, not a bridge over one,
 * and a user who already runs Claude Code has memories here on the day they
 * install it.
 *
 * The export shape is load-bearing. opencode's loader
 * (`packages/opencode/src/plugin/index.ts`) first looks for a default-exported
 * object carrying `server()`; only if that is absent does it fall back to a
 * legacy path that iterates `Object.values(mod)` and THROWS if any export is
 * not a function. Default-exporting `{ id, server }` takes the modern path and
 * makes the named exports below (which tests import) harmless.
 */

import type { Hooks, Plugin } from '@opencode-ai/plugin'

import {
  loadEffectiveConfig,
  readStatusCache,
  writeStatusCache,
  type EffectiveConfig,
} from './config.js'
import {
  classifyFailure,
  parseJson,
  projectListArgv,
  resolveBinary,
  runCli,
  succeeded,
  type CliRunner,
} from './cli.js'
import { COMPACTION_CONTEXT, SETUP_BLOCK, buildSystemBlock, type BackendStatus } from './protocol.js'
import type { ToolDeps } from './tools/deps.js'
import { forgetTool } from './tools/forget.js'
import { rememberTool } from './tools/remember.js'
import { searchTool } from './tools/search.js'
import { setupTool } from './tools/setup.js'

/** How long to wait for the connectivity probe before calling it unreachable. */
const PROBE_TIMEOUT_MS = 5_000
/** How long a tool invocation may take. */
const TOOL_TIMEOUT_MS = 30_000
/** How long another harness's probe stays good enough to reuse. */
const STATUS_CACHE_TTL_SECONDS = 600
/** Default number of results for `memory_search`. */
const DEFAULT_TOP_K = 5

/** The environment this plugin touches, injectable so tests need no CLI. */
export interface PluginEnv {
  loadConfig: (cwd: string, overrides: Record<string, string>) => EffectiveConfig
  resolveBinary: () => string | undefined
  run: CliRunner
}

/** The real environment. */
const defaultEnv: PluginEnv = {
  loadConfig: loadEffectiveConfig,
  resolveBinary,
  run: runCli,
}

/**
 * Coerce inline `opencode.json` plugin options into config overrides.
 *
 * Only scalars are taken. An option whose value is an object or array is a
 * user mistake, and silently stringifying it into a workspace id would produce
 * a baffling failure later.
 * @param options - the raw options object from `opencode.json`.
 * @returns the string-valued subset.
 */
export function scalarOverrides(options: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(options ?? {})) {
    if (typeof value === 'string') out[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
  }
  return out
}

/**
 * Probe the backend once per plugin instance.
 *
 * Reuses another harness's recent probe when one exists — a user running
 * Claude Code and opencode together should pay for one round trip, not two —
 * and publishes its own for the same reason.
 * @param binary - the resolved CLI path, or undefined when not installed.
 * @param workspace - the configured workspace id.
 * @param run - the CLI runner.
 * @returns the connectivity state to report in the system block.
 */
export async function probeBackend(
  binary: string | undefined,
  workspace: string,
  run: CliRunner,
): Promise<BackendStatus> {
  if (binary === undefined) return { state: 'cli-missing' }

  const cached = readStatusCache(workspace, STATUS_CACHE_TTL_SECONDS)
  if (cached !== undefined) return { state: 'connected', projects: cached }

  const result = await run(projectListArgv(binary, workspace), { timeoutMs: PROBE_TIMEOUT_MS })
  if (!succeeded(result)) {
    const failure = classifyFailure(result)
    return failure.state === 'not-logged-in' ? { state: 'not-logged-in' } : { state: 'unreachable' }
  }

  const payload = parseJson(result.stdout) as { items?: unknown[] } | undefined
  const projects = Array.isArray(payload?.items) ? payload.items.length : 0
  writeStatusCache(workspace, projects)
  return { state: 'connected', projects }
}

/**
 * Build the plugin's `server()` against an injected environment.
 * @param env - the environment to read config and run the CLI through.
 * @returns the opencode plugin function.
 */
export function createServer(env: PluginEnv): Plugin {
  return async (input, options) => {
    const overrides = scalarOverrides(options)
    const config = env.loadConfig(input.directory, overrides)

    // An explicit `enabled: false` is the one case that earns true silence:
    // the user has opted out in writing, so nothing is registered and nothing
    // is injected.
    if (config.state === 'disabled') return {}

    // Installed but not configured. The other harnesses stay silent here
    // because a plugin can arrive as part of a marketplace bundle the user
    // never asked for. opencode has no such path — a plugin is present only
    // because someone added it to `opencode.json` or dropped a file in
    // `plugin/`, so installation IS the opt-in, and silence would be
    // indistinguishable from a broken install. Offer setup, and nothing else.
    if (config.state !== 'ready' || config.workspace === undefined) {
      return {
        tool: { memory_setup: setupTool() },
        'experimental.chat.system.transform': async (hookInput, output) => {
          if (hookInput.sessionID === undefined) return
          output.system.push(SETUP_BLOCK)
        },
      }
    }

    const workspace = config.workspace
    const binary = env.resolveBinary()

    // Started here but deliberately NOT awaited: `server()` is awaited during
    // opencode startup, and blocking startup on a network round trip would tax
    // every session, including the ones that never touch memory. The first
    // system-prompt build awaits it instead, by which time it has usually
    // resolved.
    const statusPromise = probeBackend(binary, workspace, env.run).catch(
      (): BackendStatus => ({ state: 'unreachable' }),
    )

    const parsedTopK = Number(overrides.top_k ?? overrides.topK ?? '')
    const deps: ToolDeps = {
      binary: binary ?? '',
      workspace,
      actor: config.actor,
      run: env.run,
      timeoutMs: TOOL_TIMEOUT_MS,
      defaultTopK: Number.isInteger(parsedTopK) && parsedTopK > 0 ? parsedTopK : DEFAULT_TOP_K,
    }

    // Tools are registered only when they can actually work. A tool that is
    // guaranteed to fail is not honesty, it is noise in the tool list and a
    // lesson to the model that this plugin's tools do not work. Where nothing
    // can work, offer the fix instead: a configured workspace with no CLI is a
    // half-finished setup, not a mystery the user should have to diagnose.
    const tools: Hooks['tool'] = {}
    if (binary === undefined) {
      tools.memory_setup = setupTool()
    } else {
      tools.memory_search = searchTool(deps)
      if (config.actor !== undefined && config.actor.length > 0) {
        tools.memory_remember = rememberTool(deps, config.actor)
        tools.memory_forget = forgetTool(deps, config.actor)
      }
    }

    const canWrite = binary !== undefined && config.actor !== undefined && config.actor.length > 0
    let systemBlock: string | undefined

    return {
      tool: tools,

      /**
       * The stable half of the injection. Fires on every LLM request, and the
       * text is memoized so it is byte-identical across a session — opencode
       * merges all plugin entries into one second system block, and a block
       * that changes every request is a block that never caches.
       */
      'experimental.chat.system.transform': async (hookInput, output) => {
        // The agent-generation path triggers this hook with no session. A
        // memory protocol has no business in a prompt that writes an agent
        // definition.
        if (hookInput.sessionID === undefined) return
        systemBlock ??= buildSystemBlock(await statusPromise, canWrite)
        output.system.push(systemBlock)
      },

      /**
       * Ask the compaction summary to keep what would otherwise be lost.
       *
       * `output.context` is appended to opencode's own compaction prompt;
       * `output.prompt` would replace it wholesale, which is far beyond what a
       * memory plugin should do to a session it does not own.
       */
      'experimental.session.compacting': async (_hookInput, output) => {
        output.context.push(COMPACTION_CONTEXT)
      },
    }
  }
}

export default {
  id: 'memorylake',
  server: createServer(defaultEnv),
}
