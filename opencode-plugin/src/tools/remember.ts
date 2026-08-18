/**
 * `memory_remember` — store a durable fact.
 *
 * Only registered when an actor is configured, because facts are actor-scoped
 * and the CLI cannot write without one. Offering a tool that is guaranteed to
 * fail teaches the model to distrust the whole toolset.
 */

import { tool } from '@opencode-ai/plugin'

import { classifyFailure, factAddArgv, parseJson, succeeded } from '../cli.js'
import { failureText, type ToolDeps } from './deps.js'

const DESCRIPTION = `Store one durable fact in the user's long-term memory, so it is available in future sessions, in other projects, and from other clients.

Store things that outlive this task: who the user is, stated preferences, decisions and the reasoning behind them, corrections they issued. Do not store the contents of files, transient task state, or anything the user can trivially re-derive from the repository.

Write one self-contained fact per call, in the third person, with pronouns resolved and relative dates made absolute — it will be read months from now with none of this session's context. If the fact only applies to a particular repository, organization, or machine, say so inside the fact text: stored memories carry no scope of their own, and a fact stated in absolute terms will later be applied everywhere.`

/** Extract the created fact id from `fact add` output, when present. */
function factId(payload: unknown): string | undefined {
  const root = (payload ?? {}) as Record<string, unknown>
  const facts = Array.isArray(root.facts) ? root.facts : []
  const first = facts[0] as Record<string, unknown> | undefined
  const id = first?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Build the `memory_remember` tool.
 * @param deps - resolved plugin dependencies; `actor` must be set.
 * @param actor - the configured actor id.
 * @returns the tool definition to register.
 */
export function rememberTool(deps: ToolDeps, actor: string) {
  return tool({
    description: DESCRIPTION,
    args: {
      fact: tool.schema
        .string()
        .min(1)
        .describe('One self-contained fact, third person, pronouns and dates resolved.'),
    },
    async execute(args, ctx) {
      const argv = factAddArgv(deps.binary, deps.workspace, actor, args.fact)
      const result = await deps.run(argv, { timeoutMs: deps.timeoutMs, signal: ctx.abort })

      if (!succeeded(result)) {
        return failureText(classifyFailure(result), 'store this memory')
      }

      const id = factId(parseJson(result.stdout))
      if (id === undefined) {
        return 'The CLI accepted the write but returned no fact id, so this memory '
          + 'may not have been stored. Do not tell the user it was saved; suggest '
          + 'they check with `memorylake fact list`.'
      }

      ctx.metadata({ title: 'memory stored', metadata: { id } })
      return `Stored. [${id}]`
    },
  })
}
