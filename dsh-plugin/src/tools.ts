/**
 * The model-facing face of Memory Lake for dsh: three tools, one static
 * prompt section, one dynamic status context, and two user-invocable skills.
 *
 * Function-form plugin with NAMED exports only. Adding a default export here
 * would make the cordis Loader unwrap it to the bare function and silently
 * drop `inject` — the exact production failure documented in dsh postmortem
 * 0001 — so: no default export, ever.
 *
 * Design lines inherited from the Claude Code integration and this plugin's
 * spec (each was argued once; do not relitigate in code):
 * - No auto-recall and no session-start memory digest. The status line says
 *   whether the system is up — most importantly when it is NOT, because an
 *   unreachable backend must never read as "you never told me that".
 * - Unavailability is a domain value (a `notice` in the canonical output),
 *   not a thrown error: the model must read and act on it.
 * - When nothing is configured, the plugin is completely silent: no network
 *   requests, no prompt injection; only an explicitly invoked tool answers,
 *   and then only to point at the init skill.
 * @module
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-skill'
import type { Availability, Unavailable } from './service.js'
import { statusCacheDir, readStatusCache } from './harness-config.js'
import { EMPTY_RESULT_HINT, renderSearchResult, type SearchFact } from './recall-render.js'
import { INIT_SKILL_CONTENT } from './skills/init.js'
import { STATUS_SKILL_CONTENT } from './skills/status.js'

export const name = 'memorylake-tools'
export const inject = ['tools', 'systemPrompt', 'skills', 'memorylake']

/** Deployment knobs for the model-facing layer. */
export interface Config {
  /** Upper bound a model may request for `top_k`. */
  topKMax: number
  /** Seconds between status-line connectivity refreshes (and cache TTL). */
  statusTtlSeconds: number
}

/** Schemastery schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  topKMax: Schema.number().default(10),
  statusTtlSeconds: Schema.number().default(600),
})

/** The static tool-guidance section (order 150 — the tool guidance band). */
export const MEMORY_SECTION_TEXT = `## Memory Lake

Memory Lake is this harness's persistent long-term memory. Facts stored there
survive across sessions, projects, machines, and clients. Three tools manage
it: \`memory_search\`, \`memory_remember\`, \`memory_forget\`.

### When to remember

Use \`memory_remember\` when the user states a durable preference ("I use
vim"), corrects you on something worth keeping, explicitly asks you to
remember something, or when a stable fact about the user or their projects
emerges that future sessions will need. Write one atomic statement per fact,
with pronouns resolved to entity names and relative dates converted to
absolute dates. Never store secrets, credentials, or ephemeral session
details.

### When to search

Use \`memory_search\` when the user refers to something they told you before
that is not in this session, asks what you know about them or their
preferences, or mentions a past decision, project, or document you have no
record of.

### Writing queries

- Statement-style keywords beat questions: \`user's name\` finds more than
  \`what is my name?\`
- Resolve pronouns to entity names: \`Alice's review deadline\`, not
  \`her deadline\`.
- Convert relative time to absolute dates: \`2026-07 migration\`, not
  \`last month's migration\`.
- One intent per query. For a vague or broad question, pass 2-3
  differently-phrased queries in one call rather than one long query.

### Reading results

Results may include unrelated matches — judge each hit against the question
by its content. On an empty result, retry ONCE with different wording; if
still empty, tell the user honestly and never invent an answer. A failure is
NOT an empty result: when a result carries a notice that the backend is
unreachable, say the memory system could not be reached instead of concluding
the memory does not exist.`

/** Text of the ready status line (connectivity only — never a memory digest). */
export function readyStatusLine(workspace: string): string {
  return `Memory Lake: connected · workspace ${workspace} · memory tools available.`
}

/** Text of the unreachable status line (the "failure is not emptiness" duty). */
export function unreachableStatusLine(workspace: string): string {
  return `Memory Lake workspace ${workspace} is unreachable. Memory recall is `
    + 'UNAVAILABLE this session — if a search returns nothing, say the backend '
    + 'could not be reached rather than concluding the memory does not exist.'
}

/** Text of the logged-out status line (configured, so silence would mislead). */
export const NOT_LOGGED_IN_STATUS_LINE
  = 'Memory Lake is configured but the memorylake CLI is not logged in, so '
    + 'memory recall is UNAVAILABLE this session. Do not treat missing recall '
    + 'results as "no such memory". The /memorylake-init skill walks through login.'

/**
 * The notice attached to a tool result when the operation could not run.
 * Setup-shaped states point at the init skill; unreachable states carry the
 * attribution duty (connection, not absence).
 * @param failure - the classified unavailability.
 * @returns the model-facing notice text.
 */
export function unavailabilityNotice(failure: Unavailable): string {
  switch (failure.state) {
    case 'unconfigured':
      return 'Memory Lake is not configured on this machine, so nothing was '
        + 'searched or stored. If the user wants persistent memory, suggest '
        + 'they invoke the /memorylake-init skill to set it up.'
    case 'disabled':
      return 'Memory Lake is disabled by configuration (enabled: false in the '
        + 'shared config), so nothing was searched or stored. The user can '
        + 're-enable it in ~/.memorylake/harness/config.md or via /memorylake-init.'
    case 'missing-binary':
      return 'The memorylake CLI is not installed, so nothing was searched or '
        + 'stored. The /memorylake-init skill can download and install it.'
    case 'not-logged-in':
      return 'The memorylake CLI is not logged in, so nothing was searched or '
        + 'stored. The /memorylake-init skill walks through login.'
    case 'unreachable':
      return `The memory backend could not be reached (${failure.detail}). `
        + 'Memory recall is unavailable for this call — attribute any empty '
        + 'result to the connection, not to the memory not existing. Tell the '
        + 'user the memory backend could not be reached.'
  }
}

/** The read-only notice for a project whose writes are switched off. */
export function readOnlyNotice(sourcePath: string | undefined): string {
  const where = sourcePath ?? '~/.memorylake/harness/config.md'
  return `Memory writes are disabled for this project (sync_on_write: false in `
    + `${where}). Reads still work. To re-enable writes, set sync_on_write: `
    + 'true in that file (or remove the key), or ask the user to.'
}

/**
 * TTL-cached connectivity state behind the status line. The prompt-context
 * provider has a synchronous signature, so probing happens on a timer (a
 * plugin effect) and the provider only reads the latest snapshot — but the
 * config gates (`status_line`, `enabled`, workspace presence) are re-read
 * live at every assembly, so turning the feature off takes effect on the
 * next prompt, not on the next TTL tick. The disk cache under
 * `~/.memorylake/harness/status/<ws>.txt` is shared with the other
 * harnesses — data only (a project count), never rendered prose.
 */
class StatusCache {
  private availability: Availability | undefined

  constructor(
    private readonly ctx: Context,
    private readonly ttlSeconds: number,
  ) {}

  /**
   * Synchronous first fill so the very first prompt assembly of a session
   * already has a line when the shared tree answers without network: a
   * fresh cross-harness disk cache proves recent connectivity.
   */
  prime(): void {
    const config = this.ctx.memorylake.effectiveConfig()
    if (config.state !== 'ready') {
      this.availability = { state: config.state }
      return
    }
    const workspace = config.workspace ?? ''
    if (workspace.length > 0 && readStatusCache(workspace, this.ttlSeconds) !== undefined) {
      this.availability = { state: 'ready', workspace }
    }
  }

  /**
   * Full refresh: shared config, then one `project list` probe.
   * @param signal - aborts the probe when the plugin is disposed mid-flight.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    const config = this.ctx.memorylake.effectiveConfig()
    if (config.state !== 'ready') {
      this.availability = { state: config.state }
      return
    }
    const workspace = config.workspace ?? ''
    const cached = workspace.length > 0 ? readStatusCache(workspace, this.ttlSeconds) : undefined
    if (cached !== undefined) {
      this.availability = { state: 'ready', workspace }
      return
    }
    const outcome = await this.ctx.memorylake.probeConnectivity({ signal })
    if (outcome.state === 'ready') {
      try {
        mkdirSync(statusCacheDir(), { recursive: true })
        writeFileSync(join(statusCacheDir(), `${outcome.workspace}.txt`), String(outcome.projects))
      } catch {
        // A read-only data tree only loses the cache, not the status line.
      }
      this.availability = { state: 'ready', workspace: outcome.workspace }
      return
    }
    this.availability = outcome
  }

  /** The status line for the current assembly; empty string means silence. */
  text(): string {
    // Live gates first: silence must be immediate when the user disables the
    // line or the whole plugin, not deferred to the next TTL tick.
    const config = this.ctx.memorylake.effectiveConfig()
    if (!config.statusLine || config.state !== 'ready') return ''
    const availability = this.availability
    if (availability === undefined) return ''
    switch (availability.state) {
      case 'ready':
        return readyStatusLine(config.workspace ?? availability.workspace)
      case 'unreachable':
        return unreachableStatusLine(config.workspace ?? 'unknown')
      case 'not-logged-in':
        return NOT_LOGGED_IN_STATUS_LINE
      // Missing-binary (and stale unconfigured/disabled snapshots) stay
      // silent — a session without a working Memory Lake sees no trace of it
      // unless the failure would otherwise masquerade as missing memory.
      default:
        return ''
    }
  }
}

/** Reject an argument violation; defineTool routes the throw to an error result. */
function assertBatch(label: string, values: readonly string[], max: number): void {
  if (values.length === 0) throw new Error(`${label} must contain at least one entry`)
  if (values.length > max) throw new Error(`${label} accepts at most ${max} entries per call`)
  for (const value of values) {
    if (value.trim().length === 0) throw new Error(`${label} entries must be non-empty strings`)
  }
}

/**
 * Register the tools, prompt section, status context, refresh effect, and
 * the two user-invocable skills.
 * @param ctx - registrant context with tools, systemPrompt, skills, and memorylake injected.
 * @param config - deployment knobs for this layer.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isInteger(config.topKMax) || config.topKMax <= 0) {
    throw new Error(`memorylake-tools config topKMax must be a positive integer, got ${String(config.topKMax)}`)
  }
  // Upper bound keeps `ttl * 1000` inside the 32-bit setInterval range — an
  // overflowing delay wraps to ~1 ms and turns the refresh into a spin loop.
  if (!Number.isFinite(config.statusTtlSeconds) || config.statusTtlSeconds <= 0 || config.statusTtlSeconds > 2_000_000) {
    throw new Error(`memorylake-tools config statusTtlSeconds must be a positive number of seconds no greater than 2000000, got ${String(config.statusTtlSeconds)}`)
  }

  const cwdOf = (exec: { agent?: { session: { header: { cwd?: string } } } | undefined }): string =>
    exec.agent?.session.header.cwd ?? process.cwd()

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search the user\'s persistent cross-session memory (Memory Lake) '
      + 'for stored facts. Pass 1-3 differently-phrased, statement-style queries '
      + '(pronouns resolved, dates absolute). Results may include unrelated '
      + 'matches; judge each by content. A `notice` in the result explains empty '
      + 'or unavailable outcomes — an unreachable backend is NOT an empty memory.',
    parameters: {
      queries: {
        type: 'array',
        required: true,
        description: '1-3 statement-style search queries, one intent each.',
        items: { type: 'string' },
      },
      top_k: {
        type: 'integer',
        description: `Max facts per query (default 5, max ${config.topKMax}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          facts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                fact: { type: 'string', required: true },
                created_at: { type: 'string' },
              },
            },
          },
          notice: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertBatch('queries', args.queries, 3)
      const topK = args.top_k ?? 5
      if (!Number.isInteger(topK) || topK < 1 || topK > config.topKMax) {
        throw new Error(`top_k must be an integer between 1 and ${config.topKMax}`)
      }
      const outcome = await ctx.memorylake.search(args.queries, topK, {
        cwd: cwdOf(exec),
        signal: exec.signal,
      })
      if (outcome.state !== 'ok') {
        return { facts: [] as SearchFact[], notice: unavailabilityNotice(outcome) }
      }
      const facts = outcome.facts.map(fact => ({ ...fact }))
      // Partial failure must outrank the empty-result hint: telling the model
      // "nothing matched, be honest about it" while queries silently failed
      // is exactly the failure-looks-like-emptiness confusion this plugin
      // exists to prevent.
      if (outcome.failedQueries > 0) {
        const failed = `${outcome.failedQueries} of ${args.queries.length} queries failed to reach the backend`
        return {
          facts,
          notice: facts.length === 0
            ? `${failed} and the rest matched nothing. Do not conclude the memory does not exist — the backend was partially unreachable; say so instead of inventing an answer.`
            : `${failed}; results may be incomplete.`,
        }
      }
      if (facts.length === 0) {
        return { facts, notice: EMPTY_RESULT_HINT }
      }
      return { facts }
    },
    presentCall: () => ({ card: 'generic', title: 'Search Memory Lake', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Store durable facts in the user\'s persistent cross-session '
      + 'memory (Memory Lake). Use for stated preferences, corrections, and '
      + 'stable facts future sessions will need — one atomic statement per '
      + 'fact, pronouns resolved, dates absolute. Stored facts are searchable '
      + 'immediately. Never store secrets or ephemeral session details.',
    parameters: {
      facts: {
        type: 'array',
        required: true,
        description: '1-10 atomic fact statements to store verbatim.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                fact: { type: 'string', required: true },
              },
            },
          },
          notice: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.notice !== undefined && value.notice.length > 0
          ? value.notice
          : `Stored ${value.added.length} fact(s) in Memory Lake. They are searchable immediately, from any project or device.`,
      }],
    },
    async execute(args, exec) {
      assertBatch('facts', args.facts, 10)
      const cwd = cwdOf(exec)
      const state = ctx.memorylake.effectiveConfig(cwd).state
      if (state === 'ready') {
        const policy = ctx.memorylake.writePolicy(cwd)
        if (!policy.allowed) {
          return { added: [], notice: readOnlyNotice(policy.sourcePath) }
        }
      }
      const outcome = await ctx.memorylake.addFacts(args.facts, { cwd, signal: exec.signal })
      if (outcome.state !== 'ok') {
        // A mid-batch failure must not read as "nothing was stored": name
        // what made it in and what did not.
        const notice = outcome.added.length > 0
          ? `Stored ${outcome.added.length} of ${args.facts.length} facts, then the backend became `
            + `unavailable (${outcome.state === 'unreachable' ? outcome.detail : outcome.state}). `
            + 'The remaining facts were NOT stored — retry those, not the whole batch.'
          : unavailabilityNotice(outcome)
        return { added: outcome.added, notice }
      }
      return { added: outcome.added }
    },
    presentCall: () => ({ card: 'generic', title: 'Remember facts in Memory Lake', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete facts from the user\'s persistent memory (Memory Lake) '
      + 'by fact id (as returned by memory_search). Deletion is immediate and '
      + 'irreversible; an id that never existed lands in not_found.',
    parameters: {
      fact_ids: {
        type: 'array',
        required: true,
        description: '1-20 fact ids to delete.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgotten: { type: 'array', required: true, items: { type: 'string' } },
          not_found: { type: 'array', required: true, items: { type: 'string' } },
          notice: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.notice !== undefined && value.notice.length > 0
          ? value.notice
          : `Forgot ${value.forgotten.length} fact(s)`
            + (value.not_found.length > 0 ? `; ${value.not_found.length} id(s) not found.` : '.'),
      }],
    },
    async execute(args, exec) {
      assertBatch('fact_ids', args.fact_ids, 20)
      const outcome = await ctx.memorylake.forgetFacts(args.fact_ids, {
        cwd: cwdOf(exec),
        signal: exec.signal,
      })
      if (outcome.state !== 'ok') {
        return { forgotten: [], not_found: [], notice: unavailabilityNotice(outcome) }
      }
      return { forgotten: outcome.forgotten, not_found: outcome.notFound }
    },
    presentCall: () => ({ card: 'generic', title: 'Forget facts in Memory Lake', kind: 'other' }),
  }))

  ctx.systemPrompt.section({
    name: 'memorylake:memory',
    order: 150,
    text: MEMORY_SECTION_TEXT,
  })

  const statusCache = new StatusCache(ctx, config.statusTtlSeconds)
  statusCache.prime()
  ctx.systemPrompt.context({
    name: 'memorylake:status',
    order: 100,
    text: () => statusCache.text(),
  })
  ctx.effect(() => {
    const lifetime = new AbortController()
    void statusCache.refresh(lifetime.signal)
    const timer = setInterval(() => {
      void statusCache.refresh(lifetime.signal)
    }, config.statusTtlSeconds * 1000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      // Abort an in-flight probe so a disposed/hot-reloaded plugin does not
      // leave a CLI child running toward its own timeout.
      lifetime.abort(new Error('memorylake-tools disposed'))
    }
  })

  ctx.skills.register({
    name: 'memorylake-init',
    description: 'Set up Memory Lake end to end: CLI install, login, and the shared harness config.',
    whenToUse: 'When the user asks to set up, install, configure, or log in to Memory Lake.',
    content: INIT_SKILL_CONTENT,
    source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: true },
  })
  ctx.skills.register({
    name: 'memorylake-status',
    description: 'Diagnose the Memory Lake setup: CLI, login, effective config, connectivity, recall.',
    whenToUse: 'When the user asks whether Memory Lake works or why memory is unavailable.',
    content: STATUS_SKILL_CONTENT,
    source: 'runtime',
    invocation: { modelInvocable: false, userInvocable: true },
  })
}
