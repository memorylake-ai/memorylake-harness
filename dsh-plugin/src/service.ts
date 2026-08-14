/**
 * `ctx.memorylake` — the Memory Lake capability service for dsh.
 *
 * A class-form plugin (default export, as the cordis Loader expects for the
 * class shape) that shells out to the `memorylake` CLI through the
 * subprocess seam. It owns binary resolution, shared-config reads, payload
 * parsing, and failure classification; the model-facing tools, prompt
 * sections, and skills live in the sibling `tools` plugin module.
 *
 * Configuration comes from two places with a strict split:
 * - deployment knobs (timeouts, output caps, an explicit binary path) ride
 *   this plugin's cordis config and fail loud at load when invalid;
 * - identity and switches (workspace, actor, enabled, sync_on_write) come
 *   from the shared `~/.memorylake/` tree written by any harness's init
 *   flow, re-read on every call so edits take effect without a restart —
 *   and their ABSENCE is silence, not an error, because an unconfigured
 *   project must see no trace of this plugin.
 * @module
 */

import { isAbsolute, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  authStatusArgv,
  classifyFailure,
  factAddArgv,
  factDeleteArgv,
  projectListArgv,
  runCli,
  searchArgv,
  succeeded,
  versionArgv,
  type CliResult,
  type CliRunOptions,
} from './cli-runner.js'
import { binDir, loadEffectiveConfig, type EffectiveConfig } from './harness-config.js'
import type { SearchFact } from './recall-render.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memorylake: MemorylakeService
  }
}

/** Deployment-level knobs. Identity and switches live in the shared config tree. */
export interface Config {
  /** Optional absolute path of the `memorylake` binary, overriding resolution. */
  binaryPath?: string
  /** Hard deadline per CLI invocation, in milliseconds. */
  timeoutMs: number
  /** SIGTERM-to-SIGKILL grace for a timed-out or cancelled invocation. */
  killGraceMs: number
  /** In-memory cap per collected CLI stream, in bytes. */
  maxOutputBytes: number
}

/** Whether Memory Lake can serve this session, and if not, why. */
export type Availability =
  | { state: 'ready'; workspace: string }
  | { state: 'unconfigured' }
  | { state: 'disabled' }
  | { state: 'missing-binary' }
  | { state: 'not-logged-in' }
  | { state: 'unreachable'; detail: string }

/** The non-ready arm of {@link Availability}, reused by operation outcomes. */
export type Unavailable = Exclude<Availability, { state: 'ready' }>

/** Search outcome: merged facts, or the reason nothing could be searched. */
export type SearchOutcome =
  | { state: 'ok'; facts: SearchFact[]; failedQueries: number }
  | Unavailable

/** One stored fact; the id is best-effort extracted from the CLI payload. */
export interface AddedFact {
  id?: string
  fact: string
}

/** Write outcome; a mid-batch failure reports the facts already stored. */
export type AddOutcome =
  | { state: 'ok'; added: AddedFact[] }
  | (Unavailable & { added: AddedFact[] })

/** Delete outcome, mirroring the CLI's `{forgotten, not_found}` payload. */
export type ForgetOutcome =
  | { state: 'ok'; forgotten: string[]; notFound: string[] }
  | Unavailable

/** Connectivity probe outcome (`project list`), used by the status line. */
export type ConnectivityOutcome =
  | { state: 'ready'; workspace: string; projects: number }
  | Unavailable

/** Per-call options: the directory whose project override applies, and cancellation. */
export interface CallOptions {
  cwd?: string | undefined
  signal?: AbortSignal | undefined
}

/** A fact hit while its ordering score is still attached (never rendered). */
interface ScoredFact extends SearchFact {
  score: number
}

/** Assert a positive finite config number; deployment config fails loud at load. */
function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`memorylake config ${name} must be a positive finite number, got ${String(value)}`)
  }
}

/**
 * Validate the deployment config and return the service name. Invoked inside
 * the `super()` argument list so an invalid config fails BEFORE the service
 * registers — a half-constructed instance must not occupy the service slot.
 */
function validatedServiceName(config: Config): string {
  assertPositive('timeoutMs', config.timeoutMs)
  assertPositive('killGraceMs', config.killGraceMs)
  assertPositive('maxOutputBytes', config.maxOutputBytes)
  if (config.binaryPath !== undefined && !isAbsolute(config.binaryPath)) {
    throw new Error(`memorylake config binaryPath must be an absolute path, got "${config.binaryPath}"`)
  }
  return 'memorylake'
}

/** Read a string property off an unknown payload node, or undefined. */
function stringField(node: unknown, key: string): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const value = (node as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** Read an array property off an unknown payload node, or []. */
function arrayField(node: unknown, key: string): unknown[] {
  if (typeof node !== 'object' || node === null) return []
  const value = (node as Record<string, unknown>)[key]
  return Array.isArray(value) ? value : []
}

/** Parse one search payload's facts, keeping the score for ordering only. */
function parseSearchFacts(payload: unknown): ScoredFact[] {
  const facts: ScoredFact[] = []
  for (const item of arrayField(payload, 'facts')) {
    const fact = stringField(item, 'fact')
    if (fact === undefined || fact.length === 0) continue
    const rawScore = typeof item === 'object' && item !== null
      ? (item as Record<string, unknown>).score
      : undefined
    facts.push({
      id: stringField(item, 'id') ?? '?',
      fact,
      ...(() => {
        const created = stringField(item, 'created_at')
        return created === undefined ? {} : { created_at: created }
      })(),
      score: typeof rawScore === 'number' ? rawScore : 0,
    })
  }
  return facts
}

/**
 * Best-effort fact ids from a `fact add` payload. The wire shape is not
 * pinned by the CLI README, so accept the plausible shapes and degrade to
 * "stored, id unknown" rather than failing a successful write.
 */
function extractAddedIds(payload: unknown): string[] {
  const ids: string[] = []
  for (const key of ['facts', 'added', 'items']) {
    for (const item of arrayField(payload, key)) {
      const id = stringField(item, 'id') ?? stringField(item, 'fact_id')
      if (id !== undefined) ids.push(id)
    }
    if (ids.length > 0) return ids
  }
  for (const item of arrayField(payload, 'fact_ids')) {
    if (typeof item === 'string') ids.push(item)
  }
  if (ids.length > 0) return ids
  const single = stringField(payload, 'id') ?? stringField(payload, 'fact_id')
  return single === undefined ? [] : [single]
}

/** Parse the `fact delete` payload (`{forgotten, not_found}`). */
function parseForgetPayload(payload: unknown): { forgotten: string[]; notFound: string[] } {
  const strings = (key: string): string[] =>
    arrayField(payload, key).filter((item): item is string => typeof item === 'string')
  return { forgotten: strings('forgotten'), notFound: strings('not_found') }
}

/** The Memory Lake capability service (`ctx.memorylake`). */
export default class MemorylakeService extends Service {
  static inject = ['subprocess']

  static Config: Schema<Config> = Schema.object({
    binaryPath: Schema.string(),
    timeoutMs: Schema.number().default(30_000),
    killGraceMs: Schema.number().default(2_000),
    maxOutputBytes: Schema.number().default(1_000_000),
  })

  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, validatedServiceName(config))
    this.config = config
  }

  /**
   * The merged shared configuration for a directory. Re-read on every call —
   * the files are tiny and hot-reload matters more: the init skill's writes
   * must take effect in the very next tool call, without a restart.
   * @param cwd - directory whose project override applies (defaults to the process cwd).
   * @returns the merged view.
   */
  effectiveConfig(cwd?: string): EffectiveConfig {
    return loadEffectiveConfig(cwd ?? process.cwd())
  }

  /**
   * Whether memory writes are allowed for a directory, with the file that
   * decided it (for the model-facing read-only notice).
   * @param cwd - directory whose project override applies.
   * @returns the write policy and its source file.
   */
  writePolicy(cwd?: string): { allowed: boolean; sourcePath?: string } {
    const config = this.effectiveConfig(cwd)
    const sourcePath = config.sources.sync_on_write
    return sourcePath === undefined
      ? { allowed: config.syncOnWrite }
      : { allowed: config.syncOnWrite, sourcePath }
  }

  /**
   * Resolve the `memorylake` binary, re-resolved on every call so an install
   * performed mid-session (the init skill's stage 1) is picked up without a
   * restart. Order: explicit config path → PATH → the shared private install
   * location (`~/.memorylake/bin/memorylake`) populated by any harness's
   * init flow.
   * @param signal - optional cancellation for the lookup.
   * @returns the canonical executable path, or undefined when not installed.
   */
  async resolveBinary(signal?: AbortSignal): Promise<string | undefined> {
    const candidates = [
      ...this.config.binaryPath === undefined ? [] : [this.config.binaryPath],
      'memorylake',
      join(binDir(), 'memorylake'),
    ]
    for (const candidate of candidates) {
      try {
        return await this.ctx.subprocess.resolveExecutable(candidate, undefined, signal)
      } catch {
        // Try the next location; "not installed anywhere" is a domain state.
      }
    }
    return undefined
  }

  /** The spawn options every CLI invocation shares. */
  private runOptions(signal?: AbortSignal): CliRunOptions {
    return {
      timeoutMs: this.config.timeoutMs,
      killGraceMs: this.config.killGraceMs,
      maxOutputBytes: this.config.maxOutputBytes,
      signal,
    }
  }

  /** Local (no-network) preconditions shared by every operation. */
  private async preflight(options: CallOptions): Promise<
    | { ok: true; config: EffectiveConfig & { state: 'ready'; workspace: string }; binary: string }
    | { ok: false; failure: Unavailable }
  > {
    const config = this.effectiveConfig(options.cwd)
    if (config.state !== 'ready' || config.workspace === undefined) {
      return { ok: false, failure: { state: config.state === 'disabled' ? 'disabled' : 'unconfigured' } }
    }
    const binary = await this.resolveBinary(options.signal)
    if (binary === undefined) return { ok: false, failure: { state: 'missing-binary' } }
    return { ok: true, config: config as EffectiveConfig & { state: 'ready'; workspace: string }, binary }
  }

  /**
   * Current availability: local checks (shared config, binary), then a
   * `memorylake auth status` probe. The probe validates against the API, so
   * this method can cost a network round trip — callers on a hot path cache
   * it (the status line does) or skip straight to the operation and let its
   * failure be classified instead.
   * @param options - directory and cancellation.
   * @returns the availability state.
   */
  async availability(options: CallOptions = {}): Promise<Availability> {
    const pre = await this.preflight(options)
    if (!pre.ok) return pre.failure
    const result = await runCli(this.ctx.subprocess, authStatusArgv(pre.binary), this.runOptions(options.signal))
    if (succeeded(result)) return { state: 'ready', workspace: pre.config.workspace }
    return classifyFailure(result)
  }

  /**
   * Search facts across the workspace: one CLI invocation per query,
   * concurrently, merged by fact id with the best score deciding the order.
   * Scores never leave this method (they are weakly calibrated; ordering is
   * the only thing they are good for).
   * @param queries - 1–3 differently-phrased queries.
   * @param topK - per-query result cap.
   * @param options - directory and cancellation.
   * @returns merged facts, or the failure classification.
   */
  async search(queries: readonly string[], topK: number, options: CallOptions = {}): Promise<SearchOutcome> {
    const pre = await this.preflight(options)
    if (!pre.ok) return pre.failure
    const { workspace, actor } = pre.config
    const results = await Promise.all(queries.map(async query =>
      runCli(
        this.ctx.subprocess,
        searchArgv(pre.binary, workspace, actor, topK, query),
        this.runOptions(options.signal),
      )))
    const failures: CliResult[] = []
    const byKey = new Map<string, ScoredFact>()
    for (const result of results) {
      if (!succeeded(result) || !result.hasPayload) {
        failures.push(result)
        continue
      }
      for (const fact of parseSearchFacts(result.payload)) {
        const key = fact.id === '?' ? `text:${fact.fact}` : fact.id
        const existing = byKey.get(key)
        if (existing === undefined || fact.score > existing.score) byKey.set(key, fact)
      }
    }
    if (failures.length === results.length && results.length > 0) {
      const classified = failures.map(classifyFailure)
      return classified.find(failure => failure.state === 'not-logged-in') ?? classified[0]!
    }
    const facts = [...byKey.values()]
      .sort((a, b) => b.score - a.score)
      .map(({ score: _score, ...fact }) => fact)
    return { state: 'ok', facts, failedQueries: failures.length }
  }

  /**
   * Store facts verbatim, one CLI invocation per fact, sequentially. The
   * backend indexes facts synchronously, so a stored fact is searchable in
   * the very next call — which is what makes "remember I use vim" answerable
   * one question later.
   * @param facts - the statements to store.
   * @param options - directory and cancellation.
   * @returns the stored facts (ids best-effort), or a failure carrying the partial list.
   */
  async addFacts(facts: readonly string[], options: CallOptions = {}): Promise<AddOutcome> {
    const pre = await this.preflight(options)
    if (!pre.ok) return { ...pre.failure, added: [] }
    const { workspace, actor } = pre.config
    if (actor === undefined || actor.length === 0) {
      // Facts are actor-scoped in v1; a config without an actor cannot write.
      return { state: 'unconfigured', added: [] }
    }
    const added: AddedFact[] = []
    for (const fact of facts) {
      const result = await runCli(
        this.ctx.subprocess,
        factAddArgv(pre.binary, workspace, actor, fact),
        this.runOptions(options.signal),
      )
      if (!succeeded(result)) {
        return { ...classifyFailure(result), added }
      }
      const id = extractAddedIds(result.payload)[0]
      added.push(id === undefined ? { fact } : { id, fact })
    }
    return { state: 'ok', added }
  }

  /**
   * Delete facts by id. The CLI prints per-id outcomes FIRST and then exits
   * non-zero when `not_found` is non-empty — so the payload, not the exit
   * code, is the source of truth here.
   * @param ids - fact ids to forget.
   * @param options - directory and cancellation.
   * @returns per-id outcomes, or the failure classification.
   */
  async forgetFacts(ids: readonly string[], options: CallOptions = {}): Promise<ForgetOutcome> {
    const pre = await this.preflight(options)
    if (!pre.ok) return pre.failure
    const { workspace, actor } = pre.config
    if (actor === undefined || actor.length === 0) {
      return { state: 'unconfigured' }
    }
    const result = await runCli(
      this.ctx.subprocess,
      factDeleteArgv(pre.binary, workspace, actor, ids),
      this.runOptions(options.signal),
    )
    if (result.hasPayload) {
      const { forgotten, notFound } = parseForgetPayload(result.payload)
      return { state: 'ok', forgotten, notFound }
    }
    if (!succeeded(result)) return classifyFailure(result)
    return { state: 'ok', forgotten: [], notFound: [] }
  }

  /**
   * Connectivity probe for the status line: `project list` against the
   * configured workspace. Cheap enough for a TTL cache, honest enough to
   * distinguish "reachable" from "logged out" from "down".
   * @param options - directory and cancellation.
   * @returns the probe outcome with the project count on success.
   */
  async probeConnectivity(options: CallOptions = {}): Promise<ConnectivityOutcome> {
    const pre = await this.preflight(options)
    if (!pre.ok) return pre.failure
    const result = await runCli(
      this.ctx.subprocess,
      projectListArgv(pre.binary, pre.config.workspace),
      this.runOptions(options.signal),
    )
    if (!succeeded(result)) return classifyFailure(result)
    const projects = arrayField(result.payload, 'items').length
    return { state: 'ready', workspace: pre.config.workspace, projects }
  }

  /**
   * The installed CLI version string.
   * @param signal - optional cancellation.
   * @returns trimmed `memorylake version` output.
   */
  async version(signal?: AbortSignal): Promise<string> {
    const binary = await this.resolveBinary(signal)
    if (binary === undefined) throw new Error('the memorylake CLI is not installed')
    const result = await runCli(this.ctx.subprocess, versionArgv(binary), this.runOptions(signal))
    if (!succeeded(result)) throw new Error(`memorylake version failed: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }
}
