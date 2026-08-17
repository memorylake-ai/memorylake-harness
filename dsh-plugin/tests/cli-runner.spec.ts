import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
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
} from '../src/cli-runner.js'
import FakeSubprocessRuntime from './helpers/fake-subprocess.js'
import { makeTestTree, mockBinaryPath, type TestTree } from './helpers/env.js'

describe('argv builders', () => {
  it('builds search argv as an explicit array — no shell, no escaping needed', () => {
    const hostile = 'user\'s "editor"; $(rm -rf /) `backticks`'
    const argv = searchArgv('/bin/memorylake', 'ws-1', 'act-1', 5, hostile)
    expect(argv).toEqual([
      '/bin/memorylake', 'search',
      '--workspace', 'ws-1',
      '--actors', 'act-1',
      '--types', 'fact',
      '--top-k', '5',
      '--', hostile,
    ])
    // The hostile query is exactly one element, verbatim.
    expect(argv[argv.length - 1]).toBe(hostile)
  })

  it('escapes leading-dash positionals with -- so clap never eats them as flags', () => {
    expect(searchArgv('/m', 'ws', undefined, 3, '-dash query').slice(-2)).toEqual(['--', '-dash query'])
    expect(factAddArgv('/m', 'ws', 'act', '--weird fact').slice(-2)).toEqual(['--', '--weird fact'])
  })

  it('omits --actors when no actor is configured', () => {
    const argv = searchArgv('/bin/memorylake', 'ws-1', undefined, 3, 'q')
    expect(argv).not.toContain('--actors')
  })

  it('builds fact add/delete, auth, version, and project list argv', () => {
    expect(factAddArgv('/m', 'ws', 'act', 'a fact')).toEqual(['/m', 'fact', 'add', '--workspace', 'ws', '--actor', 'act', '--', 'a fact'])
    expect(factDeleteArgv('/m', 'ws', 'act', ['f-1', 'f-2'])).toEqual(['/m', 'fact', 'delete', '--workspace', 'ws', '--actor', 'act', '--', 'f-1', 'f-2'])
    expect(authStatusArgv('/m')).toEqual(['/m', 'auth', 'status'])
    expect(versionArgv('/m')).toEqual(['/m', 'version'])
    expect(projectListArgv('/m', 'ws')).toEqual(['/m', 'project', 'list', '--workspace', 'ws'])
  })
})

describe('runCli against the mock binary', () => {
  let tree: TestTree
  let ctx: Context
  let subprocess: SubprocessRuntime

  beforeEach(async () => {
    tree = makeTestTree()
    ctx = new Context()
    await ctx.plugin(FakeSubprocessRuntime)
    subprocess = ctx.get('subprocess') as SubprocessRuntime
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    tree.dispose()
  })

  const options = { timeoutMs: 5_000, killGraceMs: 200, maxOutputBytes: 1_000_000 }

  it('parses the payload FIRST, then reads the exit code (fact delete convention)', async () => {
    tree.setScenario({
      'fact delete': {
        exitCode: 2,
        stdout: { forgotten: ['f-1'], not_found: ['f-404'] },
      },
    })
    const result = await runCli(subprocess, factDeleteArgv(mockBinaryPath(), 'ws', 'act', ['f-1', 'f-404']), options)
    expect(result.hasPayload).toBe(true)
    expect(result.payload).toEqual({ forgotten: ['f-1'], not_found: ['f-404'] })
    expect(succeeded(result)).toBe(false)
    expect(result.exitCode).toBe(2)
  })

  it('classifies a run past the deadline as unreachable with timedOut set', async () => {
    tree.setScenario({ search: { exitCode: 0, stdout: { facts: [] }, delayMs: 5_000 } })
    const result = await runCli(
      subprocess,
      searchArgv(mockBinaryPath(), 'ws', 'act', 5, 'q'),
      { ...options, timeoutMs: 300 },
    )
    expect(succeeded(result)).toBe(false)
    expect(result.timedOut).toBe(true)
    const failure = classifyFailure(result)
    expect(failure.state).toBe('unreachable')
    expect(failure.state === 'unreachable' && failure.detail).toContain('timed out')
  }, 10_000)

  it('classifies auth-shaped failures as not-logged-in', async () => {
    tree.setScenario({ 'auth status': { exitCode: 1, stderr: 'Error: not logged in (no active profile)' } })
    const result = await runCli(subprocess, authStatusArgv(mockBinaryPath()), options)
    expect(classifyFailure(result)).toEqual({ state: 'not-logged-in' })
  })

  it('never reads auth failure out of stdout or embedded digits', async () => {
    // "401" inside a larger number must not match, and user content echoed on
    // stdout (a fact containing "unauthorized") must not flip the remediation.
    tree.setScenario({
      'fact add': {
        exitCode: 1,
        stdout: '{"echo": "note that unauthorized access is forbidden"}',
        stderr: 'connect failed: os error 14012',
      },
    })
    const result = await runCli(subprocess, factAddArgv(mockBinaryPath(), 'ws', 'act', 'x'), options)
    expect(classifyFailure(result).state).toBe('unreachable')
  })

  it('classifies other failures as unreachable with a stderr summary', async () => {
    tree.setScenario({
      'project list': {
        exitCode: 1,
        stderr: 'error sending request\nconnection refused (os error 61)\n',
      },
    })
    const result = await runCli(subprocess, projectListArgv(mockBinaryPath(), 'ws'), options)
    const failure = classifyFailure(result)
    expect(failure.state).toBe('unreachable')
    expect(failure.state === 'unreachable' && failure.detail).toContain('connection refused')
  })

  it('leaves non-JSON stdout unparsed but available (version prose)', async () => {
    tree.setScenario({ version: { exitCode: 0, stdout: 'memorylake 1.2.3' } })
    const result = await runCli(subprocess, versionArgv(mockBinaryPath()), options)
    expect(result.hasPayload).toBe(false)
    expect(result.stdout).toBe('memorylake 1.2.3')
    expect(succeeded(result)).toBe(true)
  })
})
