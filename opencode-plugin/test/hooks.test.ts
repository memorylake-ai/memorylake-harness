import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { describe, expect, it } from 'vitest'

import type { CliResult, CliRunner } from '../src/cli.js'
import type { EffectiveConfig } from '../src/config.js'
import { createServer, probeBackend, scalarOverrides, type PluginEnv } from '../src/index.js'

const BIN = '/usr/local/bin/memorylake'

function ok(stdout: string): CliResult {
  return { argv: [], exitCode: 0, stdout, stderr: '', timedOut: false }
}

/**
 * A ready config with a workspace unique to each call.
 *
 * The connectivity cache is keyed by workspace and shared across harnesses by
 * design, so two tests sharing a workspace id means the second one reads the
 * first one's probe and never exercises its own.
 */
let workspaceSeq = 0
function ready(over: Partial<EffectiveConfig> = {}): EffectiveConfig {
  workspaceSeq += 1
  return { state: 'ready', workspace: `ws-${String(workspaceSeq)}`, actor: 'actor-1', values: {}, ...over }
}

/** A runner that answers the connectivity probe and records every call. */
function runner(response: CliResult = ok('{"items":[{"id":"p1"}]}')): CliRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (argv: string[]) => {
    calls.push(argv)
    return response
  }) as CliRunner & { calls: string[][] }
  run.calls = calls
  return run
}

function env(over: Partial<PluginEnv> = {}): PluginEnv {
  return {
    loadConfig: () => ready(),
    resolveBinary: () => BIN,
    run: runner(),
    ...over,
  }
}

const input = { directory: '/repo', worktree: '/repo' } as unknown as PluginInput

async function load(over: Partial<PluginEnv> = {}, options?: Record<string, unknown>): Promise<Hooks> {
  return await createServer(env(over))(input, options)
}

/**
 * Invoke the system hook and return what it pushed.
 *
 * `hookInput` is passed whole rather than as a defaulted `sessionID` argument:
 * a default parameter would substitute a session id for the explicit
 * `undefined` that the agent-generation path sends, and quietly stop testing
 * the guard.
 */
async function systemBlocks(
  hooks: Hooks,
  hookInput: { sessionID?: string } = { sessionID: 's1' },
): Promise<string[]> {
  const output = { system: ['header'] }
  await hooks['experimental.chat.system.transform']?.(
    { ...hookInput, model: {} as never },
    output,
  )
  return output.system.slice(1)
}

describe('an explicit opt-out is the only true silence', () => {
  it('registers nothing at all when disabled', async () => {
    const hooks = await load({ loadConfig: () => ({ state: 'disabled', values: {} }) })
    expect(hooks).toEqual({})
  })
})

describe('installed but not configured', () => {
  // In opencode a plugin is present only because the user added it, so
  // silence here would be indistinguishable from a broken install.
  it.each([
    ['no config file', { state: 'unconfigured' as const, values: {} }],
    ['a config naming no workspace', { state: 'ready' as const, values: {} }],
  ])('offers setup and nothing else with %s', async (_label, config) => {
    const hooks = await load({ loadConfig: () => config })
    expect(Object.keys(hooks.tool ?? {})).toEqual(['memory_setup'])
  })

  it('tells the model it has no memory, without prompting it to nag', async () => {
    const blocks = await systemBlocks(await load({ loadConfig: () => ({ state: 'unconfigured', values: {} }) }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('memory_setup')
    expect(blocks[0]).toContain('Do not raise it unprompted')
    expect(blocks[0]).toContain('Do not claim to remember')
  })

  it('returns a setup checklist when the tool is called', async () => {
    const hooks = await load({ loadConfig: () => ({ state: 'unconfigured', values: {} }) })
    const text = await hooks.tool?.memory_setup?.execute(
      {},
      { abort: new AbortController().signal, metadata: () => {} } as never,
    )
    expect(String(text)).toContain('memorylake auth login')
    expect(String(text)).toContain('restarted')
  })
})

describe('tool registration', () => {
  it('offers all three tools when the CLI and an actor are present', async () => {
    const hooks = await load()
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      'memory_forget',
      'memory_remember',
      'memory_search',
    ])
  })

  it('offers no write tools without an actor, since writes cannot work', async () => {
    const hooks = await load({ loadConfig: () => ready({ actor: undefined }) })
    expect(Object.keys(hooks.tool ?? {})).toEqual(['memory_search'])
  })

  it('offers setup, not nothing, when configured but the CLI is missing', async () => {
    const hooks = await load({ resolveBinary: () => undefined })
    expect(Object.keys(hooks.tool ?? {})).toEqual(['memory_setup'])
  })
})

describe('system block', () => {
  it('appends exactly one entry', async () => {
    const blocks = await systemBlocks(await load())
    expect(blocks).toHaveLength(1)
  })

  it('is byte-identical across requests, so the cached block survives', async () => {
    const hooks = await load()
    const first = await systemBlocks(hooks)
    const second = await systemBlocks(hooks)
    expect(second).toEqual(first)
  })

  it('stays out of the agent-generation path, which has no session', async () => {
    expect(await systemBlocks(await load(), {})).toEqual([])
  })

  it('states that recall is unavailable when the CLI is missing', async () => {
    const blocks = await systemBlocks(await load({ resolveBinary: () => undefined }))
    expect(blocks[0]).toContain('UNAVAILABLE')
    expect(blocks[0]).toContain('not installed')
  })

  it('states that recall is unavailable when the backend is unreachable', async () => {
    const failing = runner({ argv: [], exitCode: 1, stdout: '', stderr: 'connection refused', timedOut: false })
    const blocks = await systemBlocks(await load({ run: failing }))
    expect(blocks[0]).toContain('UNAVAILABLE')
    expect(blocks[0]).toContain('unreachable')
  })

  it('never tells the model to treat a failure as an absent memory', async () => {
    const failing = runner({ argv: [], exitCode: 1, stdout: '', stderr: 'boom', timedOut: false })
    const blocks = await systemBlocks(await load({ run: failing }))
    expect(blocks[0]).toContain('do not conclude the memory does not exist')
  })

  it('says writes are unavailable when no actor is configured', async () => {
    const blocks = await systemBlocks(await load({ loadConfig: () => ready({ actor: undefined }) }))
    expect(blocks[0]).toContain('do not claim to have saved it')
  })

  it('warns the model that stored memories carry no scope', async () => {
    const blocks = await systemBlocks(await load())
    expect(blocks[0]).toContain('memories carry no scope')
  })
})

describe('compaction', () => {
  it('appends to the compaction context and never replaces the prompt', async () => {
    const hooks = await load()
    const output: { context: string[], prompt?: string } = { context: [] }
    await hooks['experimental.session.compacting']?.({ sessionID: 's1' }, output)
    expect(output.context).toHaveLength(1)
    expect(output.context[0]).toContain('durable facts')
    expect(output.prompt).toBeUndefined()
  })
})

describe('probeBackend', () => {
  it('reports the project count from the CLI', async () => {
    const status = await probeBackend(BIN, 'ws-probe-1', runner(ok('{"items":[{},{}]}')))
    expect(status).toEqual({ state: 'connected', projects: 2 })
  })

  it('distinguishes an auth failure from an outage', async () => {
    const failing = runner({ argv: [], exitCode: 1, stdout: '', stderr: 'not logged in', timedOut: false })
    expect(await probeBackend(BIN, 'ws-probe-2', failing)).toEqual({ state: 'not-logged-in' })
  })

  it('does not run the CLI at all when it is not installed', async () => {
    const run = runner()
    expect(await probeBackend(undefined, 'ws-probe-3', run)).toEqual({ state: 'cli-missing' })
    expect(run.calls).toHaveLength(0)
  })
})

describe('scalarOverrides', () => {
  it('keeps scalars and drops structured values', () => {
    expect(scalarOverrides({ workspace: 'ws', topK: 8, enabled: false, nested: { a: 1 }, list: [1] }))
      .toEqual({ workspace: 'ws', topK: '8', enabled: 'false' })
  })

  it('tolerates no options at all', () => {
    expect(scalarOverrides(undefined)).toEqual({})
  })
})

describe('inline options', () => {
  it('lets opencode.json raise the default result count', async () => {
    const run = runner()
    const hooks = await load({ run }, { topK: 9 })
    await hooks.tool?.memory_search?.execute(
      { query: 'q' },
      { abort: new AbortController().signal, metadata: () => {} } as never,
    )
    const search = run.calls.find(argv => argv.includes('--top-k'))
    expect(search?.[search.indexOf('--top-k') + 1]).toBe('9')
  })
})

describe('write guidance', () => {
  it('says when to remember, not only when to search', async () => {
    const blocks = await systemBlocks(await load())
    expect(blocks[0]).toContain('### When to remember')
    expect(blocks[0]).toContain('standing instruction')
    expect(blocks[0]).toContain('correction')
  })

  it('tells the model to record scope inside the fact', async () => {
    const blocks = await systemBlocks(await load())
    expect(blocks[0]).toContain('Say the scope inside the fact')
  })

  it('names what must not be stored, so the list is not one-sided', async () => {
    const blocks = await systemBlocks(await load())
    expect(blocks[0]).toContain('Do NOT store')
  })

  it('omits the write half when no actor makes writing impossible', async () => {
    const blocks = await systemBlocks(await load({ loadConfig: () => ready({ actor: undefined }) }))
    expect(blocks[0]).not.toContain('### When to remember')
    expect(blocks[0]).toContain('do not claim to have saved it')
  })
})
