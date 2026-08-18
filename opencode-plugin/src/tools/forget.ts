/**
 * `memory_forget` — delete facts by id.
 *
 * Deletion is the one irreversible thing this plugin can do, so the tool
 * description tells the model to confirm with the user first, and the ids must
 * be ones it actually saw rather than ones it constructed.
 */

import { tool } from '@opencode-ai/plugin'

import { classifyFailure, factDeleteArgv, succeeded } from '../cli.js'
import { failureText, type ToolDeps } from './deps.js'

const MAX_IDS = 20

const DESCRIPTION = `Delete facts from the user's long-term memory, by id.

Use the ids exactly as they appeared in \`memory_search\` output — never construct or guess an id.

Deletion is permanent and affects every project and client the user has. Confirm with the user before calling this, unless they explicitly asked for the deletion in the message you are responding to.`

/**
 * Build the `memory_forget` tool.
 * @param deps - resolved plugin dependencies; `actor` must be set.
 * @param actor - the configured actor id.
 * @returns the tool definition to register.
 */
export function forgetTool(deps: ToolDeps, actor: string) {
  return tool({
    description: DESCRIPTION,
    args: {
      ids: tool.schema
        .array(tool.schema.string().min(1))
        .min(1)
        .max(MAX_IDS)
        .describe('Fact ids, exactly as shown in memory_search results.'),
    },
    async execute(args, ctx) {
      const argv = factDeleteArgv(deps.binary, deps.workspace, actor, args.ids)
      const result = await deps.run(argv, { timeoutMs: deps.timeoutMs, signal: ctx.abort })

      if (!succeeded(result)) {
        return failureText(classifyFailure(result), 'delete these memories')
      }

      const count = args.ids.length
      ctx.metadata({ title: `${String(count)} deleted`, metadata: { ids: args.ids } })
      return `Deleted ${String(count)} ${count === 1 ? 'memory' : 'memories'}.`
    },
  })
}
