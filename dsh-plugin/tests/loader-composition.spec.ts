// Boots the plugin pair through the REAL cordis Loader from a cordis.yml,
// the way `dsh plugin add` compositions load it. This is the test class dsh
// postmortem 0001 mandates: a hand-mounted plugin cannot catch a default
// export dropping the namespace (and with it `inject`), because only the
// Loader's `unwrapExports` takes that path.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import MemorylakeService from '../src/service.js'
import * as ServiceModule from '../src/service.js'
import * as ToolsModule from '../src/tools.js'
import FakeSubprocessRuntime from './helpers/fake-subprocess.js'
import { makeTestTree, mockBinaryPath, READY_CONFIG, type TestTree } from './helpers/env.js'

let root: string | undefined
let context: Context | undefined
let tree: TestTree | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  tree?.dispose()
  tree = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'ml-dsh-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'test-subprocess'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-skill'",
    "- name: '@memorylake/dsh-plugin/service'",
    '  config:',
    `    binaryPath: '${mockBinaryPath()}'`,
    "- name: '@memorylake/dsh-plugin/tools'",
    '  config:',
    '    topKMax: 7',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ;(ctx as unknown as { baseUrl: string }).baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-subprocess', FakeSubprocessRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-skill', SkillRegistry],
    ['@memorylake/dsh-plugin/service', ServiceModule],
    ['@memorylake/dsh-plugin/tools', ToolsModule],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('real Loader composition through cordis.yml', () => {
  it('the tools module exports no default — the postmortem-0001 guard', () => {
    // A default export would make Loader.unwrapExports discard the module
    // namespace, silently dropping `inject` while every hand-mounted test
    // stays green. Assert the shape directly so a future edit fails here.
    expect((ToolsModule as Record<string, unknown>).default).toBeUndefined()
    expect(ToolsModule.name).toBe('memorylake-tools')
    expect(ToolsModule.inject).toEqual(['tools', 'systemPrompt', 'skills', 'memorylake'])
  })

  it('loads both plugin modules and wires the full surface', async () => {
    tree = makeTestTree()
    tree.writeGlobalConfig(READY_CONFIG)
    const ctx = await boot()

    // The service registered under its real name via the class default export.
    expect(ctx.get('memorylake')).toBeInstanceOf(MemorylakeService)

    // The three tools are visible with their schemas.
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_remember')
    expect(names).toContain('memory_forget')

    // Row config reached the tools plugin (topKMax: 7 shows in the schema text).
    const search = ctx.tools.schemas().find(schema => schema.name === 'memory_search')
    const topK = (search?.parameters as { properties?: { top_k?: { description?: string } } }).properties?.top_k
    expect(topK?.description).toContain('max 7')

    // Prompt section and status context are registered.
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'memorylake:memory')).toBe(true)
    expect(assembly.contexts.some(entry => entry.name === 'memorylake:status')).toBe(true)

    // Both skills are registered, user-invocable only.
    const skills = await ctx.skills.list()
    for (const name of ['memorylake-init', 'memorylake-status']) {
      const skill = skills.find(entry => entry.name === name)
      expect(skill?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    }
  }, 30_000)
})
