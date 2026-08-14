import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
import MemorylakeService from '../src/service.js'
import * as tools from '../src/tools.js'
import { EMPTY_RESULT_HINT } from '../src/recall-render.js'
import FakeSubprocessRuntime from './helpers/fake-subprocess.js'
import { makeTestTree, mockBinaryPath, READY_CONFIG, type TestTree } from './helpers/env.js'

const testSignal = new AbortController().signal
let callCounter = 0

describe('memorylake-tools plugin', () => {
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

  async function boot(config: Partial<tools.Config> = {}): Promise<Context> {
    await ctx.plugin(FakeSubprocessRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(MemorylakeService, { binaryPath: mockBinaryPath() })
    await ctx.plugin(tools, { topKMax: 10, statusTtlSeconds: 600, ...config })
    return ctx
  }

  function call(name: string, args: unknown, cwd?: string) {
    const agent = cwd === undefined
      ? undefined
      : { session: { header: { cwd } } } as unknown as Agent
    return ctx.tools.execute({
      signal: testSignal,
      callId: CallId(`ml-call-${++callCounter}`),
      name,
      arguments: args,
      ...agent === undefined ? {} : { agent },
    })
  }

  function text(result: { content: { type: string; text?: string }[] }): string {
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  }

  it('registers the three memory tools and the guidance section', async () => {
    await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_remember')
    expect(names).toContain('memory_forget')
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === 'memorylake:memory')
    expect(section?.text).toContain('## Memory Lake')
    expect(section?.text).toContain('Statement-style keywords beat questions')
  })

  it('registers init and status as user-only runtime skills', async () => {
    await boot()
    const skills = await ctx.skills.list()
    const init = skills.find(skill => skill.name === 'memorylake-init')
    const status = skills.find(skill => skill.name === 'memorylake-status')
    expect(init?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    expect(status?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    const definition = await ctx.skills.get('memorylake-init')
    expect(definition?.content).toContain('Stage 1 — CLI binary')
    expect(definition?.content).toContain('checksum verification is not optional')
  })

  it('rejects invalid deployment knobs at load', async () => {
    await ctx.plugin(FakeSubprocessRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(MemorylakeService, { binaryPath: mockBinaryPath() })
    const scope = ctx.plugin(tools, { topKMax: 0, statusTtlSeconds: 600 })
    await expect(scope).rejects.toThrow('topKMax')
  })

  describe('memory_search', () => {
    it('returns an init pointer when nothing is configured — and never spawns', async () => {
      await boot()
      // No scenario file: any spawn of the mock would fail loudly.
      const result = await call('memory_search', { queries: ['anything'] })
      expect(result.isError).toBe(false)
      if (result.isError) return
      const value = result.value as { facts: unknown[]; notice?: string }
      expect(value.facts).toEqual([])
      expect(value.notice).toContain('/memorylake-init')
      expect(text(result)).toContain('/memorylake-init')
    })

    it('returns facts with rendered digest on the happy path', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({
        search: { exitCode: 0, stdout: { facts: [{ id: 'f-1', fact: 'user prefers vim', score: 0.9 }] } },
      })
      await boot()
      const result = await call('memory_search', { queries: ['user editor preference'] })
      expect(result.isError).toBe(false)
      if (result.isError) return
      expect(result.value).toEqual({ facts: [{ id: 'f-1', fact: 'user prefers vim' }] })
      expect(text(result)).toContain('FACTS (1, most relevant first)')
      expect(text(result)).not.toMatch(/0\.9/)
    })

    it('carries the empty-result hint instead of a bare empty list', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ search: { exitCode: 0, stdout: { facts: [] } } })
      await boot()
      const result = await call('memory_search', { queries: ['nothing matches this'] })
      if (result.isError) throw new Error('expected success')
      expect((result.value as { notice?: string }).notice).toBe(EMPTY_RESULT_HINT)
    })

    it('attributes an unreachable backend to the connection, not to missing memory', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ search: { exitCode: 1, stderr: 'error sending request: connection refused' } })
      await boot()
      const result = await call('memory_search', { queries: ['q'] })
      if (result.isError) throw new Error('expected domain notice, not a tool error')
      const notice = (result.value as { notice?: string }).notice ?? ''
      expect(notice).toContain('could not be reached')
      expect(notice).toContain('not to the memory not existing')
    })

    it('validates queries and top_k bounds', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      await boot()
      expect((await call('memory_search', { queries: [] })).isError).toBe(true)
      expect((await call('memory_search', { queries: ['a', 'b', 'c', 'd'] })).isError).toBe(true)
      expect((await call('memory_search', { queries: ['q'], top_k: 99 })).isError).toBe(true)
      expect((await call('memory_search', { queries: ['  '] })).isError).toBe(true)
    })
  })

  describe('memory_remember', () => {
    it('stores facts and reports immediate searchability', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'fact add': { exitCode: 0, stdout: { facts: [{ id: 'f-9', fact: 'x' }] } } })
      await boot()
      const result = await call('memory_remember', { facts: ['user uses vim'] })
      if (result.isError) throw new Error('expected success')
      expect(result.value).toEqual({ added: [{ id: 'f-9', fact: 'user uses vim' }] })
      expect(text(result)).toContain('searchable immediately')
    })

    it('refuses writes for a sync_on_write: false project, naming the source file', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      const project = tree.makeProjectDir('readonly')
      const projectPath = tree.writeProjectConfig(project, 'sync_on_write: false')
      await boot()
      const result = await call('memory_remember', { facts: ['should not be stored'] }, project)
      if (result.isError) throw new Error('expected domain refusal, not a tool error')
      const value = result.value as { added: unknown[]; notice?: string }
      expect(value.added).toEqual([])
      expect(value.notice).toContain('sync_on_write: false')
      expect(value.notice).toContain(projectPath)
      expect(value.notice).toContain('Reads still work')
    })

    it('points at init when unconfigured', async () => {
      await boot()
      const result = await call('memory_remember', { facts: ['a fact'] })
      if (result.isError) throw new Error('expected success')
      expect((result.value as { notice?: string }).notice).toContain('/memorylake-init')
    })
  })

  describe('memory_forget', () => {
    it('reports per-id outcomes from the payload, exit code notwithstanding', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'fact delete': { exitCode: 2, stdout: { forgotten: ['f-1'], not_found: ['f-404'] } } })
      await boot()
      const result = await call('memory_forget', { fact_ids: ['f-1', 'f-404'] })
      if (result.isError) throw new Error('expected success')
      expect(result.value).toEqual({ forgotten: ['f-1'], not_found: ['f-404'] })
      expect(text(result)).toContain('1 id(s) not found')
    })
  })

  describe('status line', () => {
    async function statusText(): Promise<string> {
      const assembly = await ctx.systemPrompt.assemble()
      return assembly.contexts.find(entry => entry.name === 'memorylake:status')?.text ?? ''
    }

    it('is completely silent when unconfigured', async () => {
      await boot()
      expect(await statusText()).toBe('')
    })

    it('is silent when status_line is off, even with a reachable backend', async () => {
      tree.writeGlobalConfig(`${READY_CONFIG.replace('status_line: true', 'status_line: false')}`)
      tree.setScenario({ 'project list': { exitCode: 0, stdout: { items: [] } } })
      await boot()
      await vi.waitFor(async () => {
        expect(await statusText()).toBe('')
      })
    })

    it('reports connected from a fresh cross-harness disk cache without probing', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      // A fresh cache written by another harness; no scenario file, so any
      // network probe would fail and flip the line to unreachable.
      mkdirSync(join(tree.dataDir, 'status'), { recursive: true })
      writeFileSync(join(tree.dataDir, 'status', 'ws-test.txt'), '3')
      await boot()
      expect(await statusText()).toBe('Memory Lake: connected · workspace ws-test · memory tools available.')
    })

    it('reports UNAVAILABLE loudly when the workspace is unreachable', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'project list': { exitCode: 1, stderr: 'connection refused' } })
      await boot()
      await vi.waitFor(async () => {
        const line = await statusText()
        expect(line).toContain('Memory Lake workspace ws-test is unreachable')
        expect(line).toContain('UNAVAILABLE')
        expect(line).toContain('rather than concluding the memory does not exist')
      })
    })

    it('probes once and reports connected, writing the shared cache', async () => {
      tree.writeGlobalConfig(READY_CONFIG)
      tree.setScenario({ 'project list': { exitCode: 0, stdout: { items: [{ id: 'p-1' }] } } })
      await boot()
      await vi.waitFor(async () => {
        expect(await statusText()).toContain('Memory Lake: connected')
      })
    })
  })
})
