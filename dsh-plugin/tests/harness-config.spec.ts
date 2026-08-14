import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  binDir,
  dataDir,
  flagEnabled,
  loadEffectiveConfig,
  parseFrontmatter,
} from '../src/harness-config.js'
import { makeTestTree, type TestTree } from './helpers/env.js'

describe('parseFrontmatter', () => {
  it('reads simple keys and trims whitespace', () => {
    const values = parseFrontmatter('---\nworkspace: ws-1\n  actor :  act-9  \n---\nbody\n')
    expect(values).toEqual({ workspace: 'ws-1', actor: 'act-9' })
  })

  it('strips one surrounding quote pair, single or double', () => {
    const values = parseFrontmatter('---\na: "quoted"\nb: \'single\'\nc: "unbalanced\n---\n')
    expect(values).toEqual({ a: 'quoted', b: 'single', c: '"unbalanced' })
  })

  it('returns nothing without a leading frontmatter fence', () => {
    expect(parseFrontmatter('workspace: ws-1\n---\n')).toEqual({})
  })

  it('stops reading at the closing fence', () => {
    const values = parseFrontmatter('---\na: 1\n---\nb: 2\n')
    expect(values).toEqual({ a: '1' })
  })

  it('ignores lines without a separator and empty keys', () => {
    const values = parseFrontmatter('---\nnot a pair\n: novalue\nk: v\n---\n')
    expect(values).toEqual({ k: 'v' })
  })
})

describe('flagEnabled', () => {
  it('treats absent as on (flags only turn features off)', () => {
    expect(flagEnabled(undefined)).toBe(true)
    expect(flagEnabled('')).toBe(true)
    expect(flagEnabled('true')).toBe(true)
    expect(flagEnabled('yes')).toBe(true)
  })

  it('recognizes the explicit false spellings', () => {
    for (const spelling of ['false', 'no', 'off', '0']) {
      expect(flagEnabled(spelling)).toBe(false)
    }
  })
})

describe('loadEffectiveConfig', () => {
  let tree: TestTree

  beforeEach(() => {
    tree = makeTestTree()
  })

  afterEach(() => {
    tree.dispose()
  })

  it('honors the MEMORYLAKE_PLUGIN_DATA seam for the data and bin dirs', () => {
    expect(dataDir()).toBe(tree.dataDir)
    expect(binDir()).toBe(join(tree.root, 'bin'))
  })

  it('is unconfigured with no config file at all', () => {
    const config = loadEffectiveConfig(tree.makeProjectDir('empty'))
    expect(config.state).toBe('unconfigured')
  })

  it('is unconfigured when the config lacks a workspace', () => {
    tree.writeGlobalConfig('enabled: true\nactor: act-1')
    const config = loadEffectiveConfig(tree.makeProjectDir('nows'))
    expect(config.state).toBe('unconfigured')
  })

  it('is disabled on an explicit enabled: false', () => {
    tree.writeGlobalConfig('enabled: false\nworkspace: ws-1')
    const config = loadEffectiveConfig(tree.makeProjectDir('off'))
    expect(config.state).toBe('disabled')
  })

  it('is ready with a workspace, defaulting the write and status flags to on', () => {
    tree.writeGlobalConfig('workspace: ws-1\nactor: act-1')
    const config = loadEffectiveConfig(tree.makeProjectDir('ok'))
    expect(config.state).toBe('ready')
    expect(config.workspace).toBe('ws-1')
    expect(config.actor).toBe('act-1')
    expect(config.syncOnWrite).toBe(true)
    expect(config.statusLine).toBe(true)
  })

  it('MERGES a one-key project override instead of shadowing the global config', () => {
    // Regression guard for the shadow bug: a project file that only sets
    // sync_on_write must not knock out the global workspace (and with it,
    // recall) for that project.
    tree.writeGlobalConfig('workspace: ws-1\nactor: act-1\nsync_on_write: true')
    const project = tree.makeProjectDir('override')
    const projectPath = tree.writeProjectConfig(project, 'sync_on_write: false')
    const config = loadEffectiveConfig(project)
    expect(config.state).toBe('ready')
    expect(config.workspace).toBe('ws-1')
    expect(config.syncOnWrite).toBe(false)
    expect(config.sources.sync_on_write).toBe(projectPath)
    expect(config.sources.workspace).toContain(tree.dataDir)
  })

  it('finds the project override by walking up from a nested directory', () => {
    tree.writeGlobalConfig('workspace: ws-1')
    const project = tree.makeProjectDir('walkup')
    tree.writeProjectConfig(project, 'enabled: false')
    const nested = join(project, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    expect(loadEffectiveConfig(nested).state).toBe('disabled')
  })

  it('ignores empty project values instead of clearing global ones', () => {
    tree.writeGlobalConfig('workspace: ws-1\nactor: act-1')
    const project = tree.makeProjectDir('emptyval')
    tree.writeProjectConfig(project, 'actor:')
    const config = loadEffectiveConfig(project)
    expect(config.actor).toBe('act-1')
  })
})
