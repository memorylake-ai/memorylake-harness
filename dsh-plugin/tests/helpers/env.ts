/**
 * Shared test scaffolding: an isolated `~/.memorylake`-shaped data tree per
 * test (via the MEMORYLAKE_PLUGIN_DATA seam the shell harnesses also use),
 * a chmod-ed mock binary, and scenario-file plumbing.
 * @module
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the mock `memorylake` binary, made executable. */
export function mockBinaryPath(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mock-memorylake.mjs')
  chmodSync(path, 0o755)
  return path
}

/** One isolated data tree + scenario slot; dispose() restores everything. */
export interface TestTree {
  /** Root temp directory (contains `harness/` and `bin/`). */
  root: string
  /** The data dir (`<root>/harness`) exported through MEMORYLAKE_PLUGIN_DATA. */
  dataDir: string
  /** Write the global config file with the given frontmatter body. */
  writeGlobalConfig(frontmatter: string): void
  /** Write a project override under `<dir>/.claude/memorylake.local.md`. */
  writeProjectConfig(dir: string, frontmatter: string): string
  /** Create a fresh project directory inside the tree. */
  makeProjectDir(name: string): string
  /** Point the mock binary at a scenario object (written to disk as JSON). */
  setScenario(scenario: Record<string, unknown>): void
  /** Remove the tree and restore the environment. */
  dispose(): void
}

/** Create an isolated tree and export it through the environment seams. */
export function makeTestTree(): TestTree {
  const root = mkdtempSync(join(tmpdir(), 'ml-dsh-test-'))
  const dataDir = join(root, 'harness')
  mkdirSync(dataDir, { recursive: true })
  const savedData = process.env.MEMORYLAKE_PLUGIN_DATA
  const savedScenario = process.env.MEMORYLAKE_MOCK_SCENARIO
  process.env.MEMORYLAKE_PLUGIN_DATA = dataDir
  delete process.env.MEMORYLAKE_MOCK_SCENARIO
  return {
    root,
    dataDir,
    writeGlobalConfig(frontmatter: string): void {
      writeFileSync(join(dataDir, 'config.md'), `---\n${frontmatter}\n---\n`)
    },
    writeProjectConfig(dir: string, frontmatter: string): string {
      const claudeDir = join(dir, '.claude')
      mkdirSync(claudeDir, { recursive: true })
      const path = join(claudeDir, 'memorylake.local.md')
      writeFileSync(path, `---\n${frontmatter}\n---\n`)
      return path
    },
    makeProjectDir(name: string): string {
      const dir = join(root, 'projects', name)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    setScenario(scenario: Record<string, unknown>): void {
      const path = join(root, 'scenario.json')
      writeFileSync(path, JSON.stringify(scenario))
      process.env.MEMORYLAKE_MOCK_SCENARIO = path
    },
    dispose(): void {
      if (savedData === undefined) delete process.env.MEMORYLAKE_PLUGIN_DATA
      else process.env.MEMORYLAKE_PLUGIN_DATA = savedData
      if (savedScenario === undefined) delete process.env.MEMORYLAKE_MOCK_SCENARIO
      else process.env.MEMORYLAKE_MOCK_SCENARIO = savedScenario
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The standard ready global config used by most integration tests. */
export const READY_CONFIG = 'enabled: true\nworkspace: ws-test\nactor: act-test\nsync_on_write: true\nstatus_line: true'
