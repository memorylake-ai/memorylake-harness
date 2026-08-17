/**
 * Spawn wrapper around the `memorylake` CLI via the dsh subprocess seam.
 *
 * Three deliberate properties, each inherited from a measured failure in the
 * bash-based Claude Code integration or from the CLI's own contract:
 *
 * - argv is built as an explicit array and NEVER shell-interpreted, so a
 *   query containing quotes, `$(...)`, or backslashes is immune to injection
 *   and needs no escaping.
 * - stdout is parsed as JSON FIRST, then the exit code is read: the CLI's
 *   convention is "print the full payload, then decide the exit code from
 *   the business result" (`fact delete` exits non-zero when `not_found` is
 *   non-empty, `document import` on partial failure). Treating any non-zero
 *   exit as a hard failure would discard a perfectly good payload.
 * - the subprocess seam scrubs credential-shaped names out of the child
 *   environment, so an ambient `MEMORYLAKE_API_KEY` never reaches the CLI.
 *   Authentication must come from the CLI's own `~/.memorylake/credentials.toml`
 *   login state — which is also the CLI's contract ("env vars alone are not
 *   a session").
 * @module
 */

import { homedir } from 'node:os'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Deployment knobs a spawn needs; a subset of the service Config. */
export interface CliRunOptions {
  /** Hard deadline for the whole invocation, owned by this caller. */
  timeoutMs: number
  /** SIGTERM-to-SIGKILL grace for the process tree. */
  killGraceMs: number
  /** In-memory cap per collected stream; a single search payload can be large. */
  maxOutputBytes: number
  /** Optional caller cancellation, combined with the timeout. */
  signal?: AbortSignal | undefined
}

/** Everything one CLI invocation produced, with the payload pre-parsed. */
export interface CliResult {
  /** The exact argv that ran (program first). */
  argv: readonly string[]
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** True when this runner's own deadline fired. */
  timedOut: boolean
  /** True when the caller's signal aborted the run. */
  aborted: boolean
  /** Collected stdout text (tail when truncated). */
  stdout: string
  /** Collected stderr text (tail when truncated). */
  stderr: string
  /** Parsed JSON from stdout, when stdout parsed; undefined otherwise. */
  payload: unknown
  /** True when a payload was parsed from stdout. */
  hasPayload: boolean
}

/** Domain classification of a failed CLI invocation. */
export type CliFailure =
  | { state: 'not-logged-in' }
  | { state: 'unreachable'; detail: string }

/**
 * stderr shapes that mean "the login state is the problem, not the network".
 * Word-bounded 401 (a request id or errno like "os error 14012" must not
 * match), and applied to stderr ONLY: stdout can echo user content (a fact
 * containing the word "unauthorized"), which must never flip the remediation
 * from "backend unreachable" to "log in again".
 */
const AUTH_FAILURE_PATTERN = /not logged in|no active profile|no credentials|unauthorized|invalid api key|\b401\b/i

/**
 * Run one CLI invocation to completion and collect its outcome.
 * @param subprocess - the dsh subprocess seam.
 * @param argv - full argv, program first, one element per argument.
 * @param options - timeout, grace, output cap, and optional caller signal.
 * @returns the collected result with stdout pre-parsed as JSON when possible.
 */
export async function runCli(
  subprocess: SubprocessRuntime,
  argv: readonly string[],
  options: CliRunOptions,
): Promise<CliResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const handle = subprocess.spawn({
    argv,
    // The CLI reads all its state from ~/.memorylake; the invoking project's
    // directory must not matter, and may not even exist in every execution
    // world — the home directory always does.
    cwd: homedir(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: options.maxOutputBytes },
      stderr: { maxBytes: options.maxOutputBytes },
    },
    graceMs: options.killGraceMs,
    signal,
    env: {},
  })
  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    // Spawn-level failure (e.g. the binary vanished between resolution and
    // spawn). Normalize into the same result shape as a signal death.
    return {
      argv,
      exitCode: null,
      timedOut: timeout.aborted,
      aborted: options.signal?.aborted ?? false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      payload: undefined,
      hasPayload: false,
    }
  }
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  let payload: unknown
  let hasPayload = false
  const trimmed = stdout.trim()
  if (trimmed.length > 0) {
    try {
      payload = JSON.parse(trimmed)
      hasPayload = true
    } catch {
      // Not JSON (e.g. `memorylake version` prose) — callers read stdout raw.
    }
  }
  return {
    argv,
    exitCode: outcome.exitCode,
    timedOut: timeout.aborted,
    aborted: options.signal?.aborted ?? false,
    stdout,
    stderr,
    payload,
    hasPayload,
  }
}

/** Whether an invocation exited zero (a signal death is never a success). */
export function succeeded(result: CliResult): boolean {
  return result.exitCode === 0
}

/**
 * Classify a failed invocation for the availability vocabulary. A timeout is
 * always `unreachable`; auth-shaped output is `not-logged-in`; everything
 * else is `unreachable` with a stderr summary as detail, because a failed
 * search and an empty search must never look the same to the model.
 * @param result - a result for which {@link succeeded} returned false.
 * @returns the domain failure classification.
 */
export function classifyFailure(result: CliResult): CliFailure {
  if (result.timedOut) {
    return { state: 'unreachable', detail: `the memorylake CLI timed out (${result.argv.slice(1, 3).join(' ')})` }
  }
  if (AUTH_FAILURE_PATTERN.test(result.stderr)) return { state: 'not-logged-in' }
  const detail = result.stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(-3)
    .join(' ')
  return { state: 'unreachable', detail: detail.length > 0 ? detail : `exit code ${String(result.exitCode)}` }
}

// The `--` before each positional below is load-bearing: queries and fact
// texts are arbitrary user language, and one starting with `-` would
// otherwise be a clap usage error ("unexpected argument '-d' found") that
// this plugin then misclassifies as an unreachable backend. Verified against
// the real CLI: `--` ends option parsing and the positional passes verbatim.

/** argv for `memorylake search`, facts only (v1), one query per invocation. */
export function searchArgv(
  binary: string,
  workspace: string,
  actor: string | undefined,
  topK: number,
  query: string,
): string[] {
  const argv = [binary, 'search', '--workspace', workspace]
  if (actor !== undefined && actor.length > 0) argv.push('--actors', actor)
  argv.push('--types', 'fact', '--top-k', String(topK), '--', query)
  return argv
}

/** argv for `memorylake fact add` with one fact (facts are added one per call). */
export function factAddArgv(binary: string, workspace: string, actor: string, fact: string): string[] {
  return [binary, 'fact', 'add', '--workspace', workspace, '--actor', actor, '--', fact]
}

/** argv for `memorylake fact delete` over a batch of ids. */
export function factDeleteArgv(binary: string, workspace: string, actor: string, ids: readonly string[]): string[] {
  return [binary, 'fact', 'delete', '--workspace', workspace, '--actor', actor, '--', ...ids]
}

/** argv for `memorylake auth status`. */
export function authStatusArgv(binary: string): string[] {
  return [binary, 'auth', 'status']
}

/** argv for `memorylake version`. */
export function versionArgv(binary: string): string[] {
  return [binary, 'version']
}

/** argv for `memorylake project list` (the connectivity probe). */
export function projectListArgv(binary: string, workspace: string): string[] {
  return [binary, 'project', 'list', '--workspace', workspace]
}
