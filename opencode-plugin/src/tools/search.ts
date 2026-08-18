/**
 * `memory_search` — recall from Memory Lake.
 */

import { tool } from '@opencode-ai/plugin'

import { classifyFailure, parseJson, searchArgv, succeeded } from '../cli.js'
import { normalizeSearchPayload, renderSearchResult } from '../render.js'
import { failureText, type ToolDeps } from './deps.js'

const MAX_TOP_K = 20

const DESCRIPTION = `Search the user's long-term memory in Memory Lake — memories written across projects, machines, and clients, including from Claude Code, which opencode cannot otherwise see.

Reach for this when the user refers to something they told you before, asks what you know about them or their preferences, mentions a past decision or project you have no record of, or whenever you are about to guess at something they may already have told you.

Write the query as statement-style keywords with pronouns resolved to names and relative dates made absolute: "user's preferred editor", not "what editor do you like?". One intent per query.`

/**
 * Build the `memory_search` tool.
 * @param deps - resolved plugin dependencies.
 * @returns the tool definition to register.
 */
export function searchTool(deps: ToolDeps) {
  return tool({
    description: DESCRIPTION,
    args: {
      query: tool.schema
        .string()
        .min(1)
        .describe('Statement-style keywords. Resolve pronouns, make dates absolute.'),
      top_k: tool.schema
        .number()
        .int()
        .min(1)
        .max(MAX_TOP_K)
        .optional()
        .describe(`How many results to return (default ${String(deps.defaultTopK)}).`),
    },
    async execute(args, ctx) {
      const topK = args.top_k ?? deps.defaultTopK
      const argv = searchArgv(deps.binary, deps.workspace, deps.actor, topK, args.query)
      const result = await deps.run(argv, { timeoutMs: deps.timeoutMs, signal: ctx.abort })

      if (!succeeded(result)) {
        return failureText(classifyFailure(result), 'search Memory Lake')
      }

      const payload = parseJson(result.stdout)
      if (payload === undefined) {
        return failureText(
          { state: 'unreachable', detail: 'the CLI did not return JSON' },
          'search Memory Lake',
        )
      }

      const rendering = normalizeSearchPayload(payload)
      ctx.metadata({
        title: `${String(rendering.facts.length)} memories`,
        metadata: { query: args.query, facts: rendering.facts.length },
      })
      return renderSearchResult(rendering)
    },
  })
}
