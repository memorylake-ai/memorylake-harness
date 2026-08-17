import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemorylakeService from '../src/service.js'
import FakeSubprocessRuntime from './helpers/fake-subprocess.js'
import { makeTestTree, mockBinaryPath, READY_CONFIG, type TestTree } from './helpers/env.js'

describe('MemorylakeService', () => {
  let tree: TestTree
  let ctx: Context

  beforeEach(() => {
    tree = makeTestTree()
    ctx = new Context()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    tree.dispose()
  })

  async function service(config: Record<string, unknown> = {}): Promise<MemorylakeService> {
    await ctx.plugin(FakeSubprocessRuntime)
    await ctx.plugin(MemorylakeService, { binaryPath: mockBinaryPath(), ...config })
    return ctx.get('memorylake') as MemorylakeService
  }

  it('rejects invalid deployment config at load (fail loud)', async () => {
    await ctx.plugin(FakeSubprocessRuntime)
    expect(() => new MemorylakeService(ctx, {
      timeoutMs: -1,
      killGraceMs: 2_000,
      maxOutputBytes: 1_000_000,
    })).toThrow('timeoutMs')
    expect(() => new MemorylakeService(ctx, {
      binaryPath: 'relative/memorylake',
      timeoutMs: 30_000,
      killGraceMs: 2_000,
      maxOutputBytes: 1_000_000,
    })).toThrow('absolute')
  })

  describe('availability', () => {
    it('is unconfigured with no shared config, without any spawn', async () => {
      const memorylake = await service()
      expect(await memorylake.availability()).toEqual({ state: 'unconfigured' })
    })

    it('is disabled on enabled: false', async () => {
      tree.writeGlobalConfig('enabled: false\nworkspace: ws-test')
      const memorylake = await service()
      expect(await memorylake.availability()).toEqual({ state: 'disabled' })
    })

    it('is missing-binary when no location resolves', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      await ctx.plugin(FakeSubprocessRuntime)
      await ctx.plugin(MemorylakeService, {})
      const memorylake = ctx.get('memorylake') as MemorylakeService
      const savedPath = process.env.PATH
      process.env.PATH = '/nonexistent-dir-for-test'
      try {
        expect(await memorylake.availability()).toEqual({ state: 'missing-binary' })
      } finally {
        process.env.PATH = savedPath
      }
    })

    it('is not-logged-in when auth status fails with auth-shaped output', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'auth status': { exitCode: 1, stderr: 'Error: not logged in' } })
      const memorylake = await service()
      expect(await memorylake.availability()).toEqual({ state: 'not-logged-in' })
    })

    it('is unreachable on a network-shaped auth failure, carrying detail', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'auth status': { exitCode: 1, stderr: 'error sending request: connection refused' } })
      const memorylake = await service()
      const availability = await memorylake.availability()
      expect(availability.state).toBe('unreachable')
      expect(availability.state === 'unreachable' && availability.detail).toContain('connection refused')
    })

    it('is ready when auth status succeeds', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'auth status': { exitCode: 0, stdout: { profile: 'default' } } })
      const memorylake = await service()
      expect(await memorylake.availability()).toEqual({ state: 'ready', workspace: 'ws-test' })
    })
  })

  describe('search', () => {
    it('merges concurrent per-query results by fact id, ordered by score, score stripped', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({
        search: {
          exitCode: 0,
          stdout: { facts: [] },
          byLastArg: {
            'query one': {
              exitCode: 0,
              stdout: { facts: [
                { id: 'f-low', fact: 'shared hit', score: 0.2 },
                { id: 'f-a', fact: 'only in one', score: 0.9, created_at: '2026-08-01' },
              ] },
            },
            'query two': {
              exitCode: 0,
              stdout: { facts: [
                { id: 'f-low', fact: 'shared hit', score: 0.5 },
                { id: 'f-b', fact: 'only in two', score: 0.3 },
              ] },
            },
          },
        },
      })
      const memorylake = await service()
      const outcome = await memorylake.search(['query one', 'query two'], 5)
      expect(outcome.state).toBe('ok')
      if (outcome.state !== 'ok') return
      expect(outcome.facts.map(fact => fact.id)).toEqual(['f-a', 'f-low', 'f-b'])
      expect(outcome.facts[0]).toEqual({ id: 'f-a', fact: 'only in one', created_at: '2026-08-01' })
      for (const fact of outcome.facts) {
        expect(fact).not.toHaveProperty('score')
      }
      expect(outcome.failedQueries).toBe(0)
    })

    it('reports unreachable when every query fails', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ search: { exitCode: 1, stderr: 'connection reset' } })
      const memorylake = await service()
      const outcome = await memorylake.search(['q'], 5)
      expect(outcome.state).toBe('unreachable')
    })

    it('returns partial results with a failed-query count when one query fails', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({
        search: {
          exitCode: 1,
          stderr: 'boom',
          byLastArg: {
            good: { exitCode: 0, stdout: { facts: [{ id: 'f-1', fact: 'hit', score: 1 }] } },
          },
        },
      })
      const memorylake = await service()
      const outcome = await memorylake.search(['good', 'bad'], 5)
      expect(outcome.state).toBe('ok')
      if (outcome.state !== 'ok') return
      expect(outcome.facts).toHaveLength(1)
      expect(outcome.failedQueries).toBe(1)
    })
  })

  describe('addFacts', () => {
    it('stores facts one call at a time and extracts ids best-effort', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'fact add': { exitCode: 0, stdout: { facts: [{ id: 'f-new', fact: 'stored' }] } } })
      const memorylake = await service()
      const outcome = await memorylake.addFacts(['user uses vim', 'user prefers dark mode'])
      expect(outcome.state).toBe('ok')
      expect(outcome.added).toEqual([
        { id: 'f-new', fact: 'user uses vim' },
        { id: 'f-new', fact: 'user prefers dark mode' },
      ])
    })

    it('keeps the partial list when a later add fails', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({
        'fact add': {
          exitCode: 1,
          stderr: 'connection refused',
          byLastArg: { first: { exitCode: 0, stdout: { facts: [{ id: 'f-1', fact: 'first' }] } } },
        },
      })
      const memorylake = await service()
      const outcome = await memorylake.addFacts(['first', 'second'])
      expect(outcome.state).toBe('unreachable')
      expect(outcome.added).toEqual([{ id: 'f-1', fact: 'first' }])
    })

    it('refuses to write without a configured actor', async () => {
      tree.writeGlobalConfig('workspace: ws-test')
      const memorylake = await service()
      const outcome = await memorylake.addFacts(['fact'])
      expect(outcome.state).toBe('unconfigured')
    })
  })

  describe('forgetFacts', () => {
    it('trusts the payload over the non-zero exit code (not_found convention)', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'fact delete': { exitCode: 2, stdout: { forgotten: ['f-1'], not_found: ['f-404'] } } })
      const memorylake = await service()
      const outcome = await memorylake.forgetFacts(['f-1', 'f-404'])
      expect(outcome).toEqual({ state: 'ok', forgotten: ['f-1'], notFound: ['f-404'] })
    })

    it('classifies a payload-less failure', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'fact delete': { exitCode: 1, stderr: 'connection refused' } })
      const memorylake = await service()
      const outcome = await memorylake.forgetFacts(['f-1'])
      expect(outcome.state).toBe('unreachable')
    })

    it('does not mistake a JSON error object for a successful delete', async () => {
      // A failing CLI can print a JSON error to stdout; without the shape
      // check this would read as "forgot zero facts, success".
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'fact delete': { exitCode: 1, stdout: { error: 'boom' }, stderr: 'request failed' } })
      const memorylake = await service()
      const outcome = await memorylake.forgetFacts(['f-1'])
      expect(outcome.state).toBe('unreachable')
    })
  })

  describe('probeConnectivity and version', () => {
    it('counts projects on success', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'project list': { exitCode: 0, stdout: { items: [{ id: 'p-1' }, { id: 'p-2' }] } } })
      const memorylake = await service()
      expect(await memorylake.probeConnectivity()).toEqual({ state: 'ready', workspace: 'ws-test', projects: 2 })
    })

    it('returns the trimmed version string', async () => {
      tree.setScenario({ version: { exitCode: 0, stdout: 'memorylake 1.2.3\n' } })
      const memorylake = await service()
      expect(await memorylake.version()).toBe('memorylake 1.2.3')
    })
  })

  describe('writePolicy', () => {
    it('reports the deciding file for a project-level sync_on_write: false', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      const project = tree.makeProjectDir('readonly')
      const projectPath = tree.writeProjectConfig(project, 'sync_on_write: false')
      const memorylake = await service()
      expect(memorylake.writePolicy(project)).toEqual({ allowed: false, sourcePath: projectPath })
      expect(memorylake.writePolicy(tree.makeProjectDir('normal')).allowed).toBe(true)
    })
  })
})
