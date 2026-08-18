/**
 * What the three tools need from the plugin, and how they talk about failure.
 *
 * Collected in one place because the failure wording is the part most easily
 * got wrong: every tool here must make it impossible for the model to read
 * "the call failed" as "there is no such memory".
 */

import type { CliFailure, CliRunner } from '../cli.js'

/** Everything a tool needs, resolved once when the plugin loads. */
export interface ToolDeps {
  /** Absolute path of the `memorylake` binary. */
  binary: string
  /** The configured workspace id. */
  workspace: string
  /** The configured actor id, when one is configured — facts are actor-scoped. */
  actor?: string
  /** How to run an argv array; substituted in tests. */
  run: CliRunner
  /** Per-invocation timeout. */
  timeoutMs: number
  /** Default result count for `memory_search`, overridable per call. */
  defaultTopK: number
}

/**
 * Describe a failure to the model.
 *
 * The closing sentence is not decoration. Without it, a model that asked for a
 * memory and got an error will frequently go on to tell the user they never
 * mentioned the thing — a confident false denial, which is worse than an
 * admitted outage.
 * @param failure - the classified failure.
 * @param action - what was being attempted, e.g. "search Memory Lake".
 * @returns the text to return as the tool result.
 */
export function failureText(failure: CliFailure, action: string): string {
  switch (failure.state) {
    case 'not-installed':
      return `Could not ${action}: the \`memorylake\` CLI is not installed. `
        + 'Memory is UNAVAILABLE this session — do not read this as "no relevant '
        + 'memories". Tell the user the memory backend could not be reached.'
    case 'not-logged-in':
      return `Could not ${action}: Memory Lake is not authenticated. Ask the user `
        + 'to run `memorylake auth login`. Do not read this as "no relevant '
        + 'memories" — the backend was never consulted.'
    case 'unreachable':
      return `Could not ${action}: the memory backend could not be reached `
        + `(${failure.detail}). Do not read this as "no relevant memories" — tell `
        + 'the user the backend is unavailable rather than concluding the memory '
        + 'does not exist.'
  }
}
