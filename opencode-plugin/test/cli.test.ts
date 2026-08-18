import { describe, expect, it } from 'vitest'

import {
  classifyFailure,
  factAddArgv,
  factDeleteArgv,
  parseJson,
  projectListArgv,
  searchArgv,
  succeeded,
  type CliResult,
} from '../src/cli.js'

const BIN = '/usr/local/bin/memorylake'

function result(over: Partial<CliResult> = {}): CliResult {
  return { argv: [BIN, 'search'], exitCode: 0, stdout: '', stderr: '', timedOut: false, ...over }
}

describe('argv builders', () => {
  it('separates the query with -- so a leading dash is not parsed as a flag', () => {
    const argv = searchArgv(BIN, 'ws-1', 'actor-1', 5, '-dash query')
    expect(argv[argv.length - 2]).toBe('--')
    expect(argv[argv.length - 1]).toBe('-dash query')
  })

  it('omits --actors when no actor is configured', () => {
    expect(searchArgv(BIN, 'ws-1', undefined, 5, 'q')).not.toContain('--actors')
    expect(searchArgv(BIN, 'ws-1', '', 5, 'q')).not.toContain('--actors')
  })

  it('scopes search to facts', () => {
    const argv = searchArgv(BIN, 'ws-1', 'actor-1', 3, 'q')
    expect(argv).toContain('--types')
    expect(argv[argv.indexOf('--types') + 1]).toBe('fact')
    expect(argv[argv.indexOf('--top-k') + 1]).toBe('3')
  })

  it('separates fact text with -- as well', () => {
    const argv = factAddArgv(BIN, 'ws-1', 'actor-1', '--not-a-flag')
    expect(argv[argv.length - 2]).toBe('--')
    expect(argv[argv.length - 1]).toBe('--not-a-flag')
  })

  it('passes every id after -- when deleting', () => {
    const argv = factDeleteArgv(BIN, 'ws-1', 'actor-1', ['a', 'b'])
    expect(argv.slice(-3)).toEqual(['--', 'a', 'b'])
  })

  it('probes connectivity with project list', () => {
    expect(projectListArgv(BIN, 'ws-1')).toEqual([BIN, 'project', 'list', '--workspace', 'ws-1'])
  })
})

describe('succeeded', () => {
  it('requires both a zero exit and no timeout', () => {
    expect(succeeded(result())).toBe(true)
    expect(succeeded(result({ exitCode: 1 }))).toBe(false)
    expect(succeeded(result({ timedOut: true }))).toBe(false)
  })
})

describe('classifyFailure', () => {
  it('reports a timeout as unreachable, naming the subcommand', () => {
    const failure = classifyFailure(result({ timedOut: true, argv: [BIN, 'search', '--workspace'] }))
    expect(failure.state).toBe('unreachable')
    expect(failure).toHaveProperty('detail', expect.stringContaining('search'))
  })

  it.each(['not logged in', 'Unauthenticated', 'HTTP 401', 'invalid api key'])(
    'recognises %s as an auth problem, not an outage',
    (stderr) => {
      expect(classifyFailure(result({ exitCode: 1, stderr })).state).toBe('not-logged-in')
    },
  )

  it('carries the last lines of stderr so the message is specific', () => {
    const failure = classifyFailure(result({ exitCode: 1, stderr: 'a\nb\nc\nd\n' }))
    expect(failure).toHaveProperty('detail', 'b c d')
  })

  it('falls back to the exit code when stderr is silent', () => {
    expect(classifyFailure(result({ exitCode: 3 }))).toHaveProperty('detail', 'exit code 3')
  })
})

describe('parseJson', () => {
  it('returns undefined rather than throwing on non-JSON', () => {
    expect(parseJson('not json')).toBeUndefined()
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
  })
})
