/**
 * Invocation of the `memorylake` CLI.
 *
 * Two deliberate choices here, both about not corrupting user text:
 *
 * 1. `execFile`, not opencode's `$` (BunShell). The plugin input offers a
 *    shell, but every argument we pass is arbitrary user language — a search
 *    query, the text of a fact — and a shell is a quoting hazard we have no
 *    reason to accept. `execFile` takes an argv array and never involves a
 *    shell. It also means the CLI works from every hook context regardless of
 *    whether `$` is available there.
 *
 * 2. `--` before every positional. This is load-bearing and was verified
 *    against the real CLI: a query beginning with `-` is otherwise a clap
 *    usage error ("unexpected argument '-d' found"), which this plugin would
 *    then misreport as an unreachable backend. `--` ends option parsing and
 *    the positional passes through verbatim.
 *
 * The argv shapes below are a cross-harness contract. They must stay
 * byte-identical to what the Claude Code, Codex, and dsh plugins send, or the
 * four harnesses stop being one identity.
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

import { binDir } from './config.js'

/** The outcome of one CLI invocation. */
export interface CliResult {
  argv: string[]
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Why a CLI invocation did not produce a usable answer. */
export type CliFailure =
  | { state: 'not-installed' }
  | { state: 'not-logged-in' }
  | { state: 'unreachable', detail: string }

/** Anything that can run an argv array — the seam tests substitute. */
export type CliRunner = (argv: string[], options: { timeoutMs: number, signal?: AbortSignal }) => Promise<CliResult>

const AUTH_FAILURE_PATTERN = /not\s+logged\s+in|unauthenticated|401|invalid\s+api\s+key/i

/** Whether a path exists and is executable by this process. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate the `memorylake` binary.
 *
 * PATH first, then the privately installed copy — the same order every other
 * harness uses. A user who installed the CLI themselves should get their copy,
 * not one a plugin dropped in a hidden directory.
 * @returns the binary path, or undefined when the CLI is not installed.
 */
export function resolveBinary(): string | undefined {
  const path = process.env.PATH ?? ''
  for (const entry of path.split(':')) {
    if (entry.length === 0) continue
    const candidate = join(entry, 'memorylake')
    if (isExecutable(candidate)) return candidate
  }
  const priv = join(binDir(), 'memorylake')
  return isExecutable(priv) ? priv : undefined
}

/**
 * Run an argv array, capturing output and never rejecting.
 *
 * A rejected promise here would surface as a plugin crash inside opencode; a
 * `CliResult` with a non-zero exit code is something callers can turn into an
 * honest message instead.
 * @param argv - the full argv, element 0 being the binary path.
 * @param options - timeout and an optional cancellation signal.
 * @returns the captured result.
 */
export const runCli: CliRunner = async (argv, options) => {
  const [binary, ...args] = argv
  if (binary === undefined) {
    return { argv, exitCode: 127, stdout: '', stderr: 'no binary', timedOut: false }
  }
  return await new Promise<CliResult>((resolve) => {
    execFile(
      binary,
      args,
      {
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const killed = error !== null && (error as { killed?: boolean }).killed === true
        const code = error === null ? 0 : Number((error as { code?: number }).code ?? 1)
        resolve({
          argv,
          exitCode: Number.isFinite(code) ? code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: killed,
        })
      },
    )
  })
}

/** Whether a result carries a usable answer. */
export function succeeded(result: CliResult): boolean {
  return result.exitCode === 0 && !result.timedOut
}

/**
 * Turn a failed result into a specific reason.
 *
 * Specificity matters more than it looks: "the backend is unreachable" and
 * "you are not logged in" lead the user to different actions, and neither of
 * them means "there is no such memory".
 * @param result - a result for which `succeeded` returned false.
 * @returns the classified failure.
 */
export function classifyFailure(result: CliResult): CliFailure {
  if (result.timedOut) {
    return {
      state: 'unreachable',
      detail: `the memorylake CLI timed out (${result.argv.slice(1, 3).join(' ')})`,
    }
  }
  if (AUTH_FAILURE_PATTERN.test(result.stderr)) return { state: 'not-logged-in' }
  const detail = result.stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(-3)
    .join(' ')
  return {
    state: 'unreachable',
    detail: detail.length > 0 ? detail : `exit code ${String(result.exitCode)}`,
  }
}

/**
 * Parse CLI stdout as JSON without throwing.
 * @param text - the captured stdout.
 * @returns the parsed value, or undefined when it was not JSON.
 */
export function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** argv for `memorylake search`, facts only, one query per invocation. */
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

/** argv for `memorylake fact add` — facts are added one per call. */
export function factAddArgv(binary: string, workspace: string, actor: string, fact: string): string[] {
  return [binary, 'fact', 'add', '--workspace', workspace, '--actor', actor, '--', fact]
}

/** argv for `memorylake fact delete` over a batch of ids. */
export function factDeleteArgv(
  binary: string,
  workspace: string,
  actor: string,
  ids: readonly string[],
): string[] {
  return [binary, 'fact', 'delete', '--workspace', workspace, '--actor', actor, '--', ...ids]
}

/** argv for `memorylake project list` — the connectivity probe. */
export function projectListArgv(binary: string, workspace: string): string[] {
  return [binary, 'project', 'list', '--workspace', workspace]
}
