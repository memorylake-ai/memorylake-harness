/**
 * Test implementation of the dsh subprocess seam over node:child_process —
 * enough of the contract for this plugin's consumption: executable
 * resolution, collect-mode stdio, abort-driven termination, and exit facts.
 * Terminal spawning is out of scope for these tests.
 * @module
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

class BufferReader implements SubprocessOutputReader {
  private text = ''

  append(chunk: string): void {
    this.text += chunk
  }

  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
    return { text: this.text.slice(fromByte), nextOffset: this.text.length, lossy: false }
  }
}

/** Minimal local subprocess runtime for tests. */
export default class FakeSubprocessRuntime extends SubprocessRuntime {
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<string> {
    if (isAbsolute(command)) {
      if (isExecutableFile(command)) return command
      throw new Error(`executable not found: ${command}`)
    }
    if (command.includes('/') || command.includes('\\')) {
      throw new Error(`relative executable paths are rejected: ${command}`)
    }
    const searchPath = env?.PATH ?? process.env.PATH ?? ''
    for (const dir of searchPath.split(delimiter)) {
      if (dir.length === 0) continue
      const candidate = join(dir, command)
      if (isExecutableFile(candidate)) return candidate
    }
    throw new Error(`executable not on PATH: ${command}`)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const [program, ...args] = spec.argv
    if (program === undefined) throw new Error('argv must not be empty')
    const child = nodeSpawn(program, args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = new BufferReader()
    const stderr = new BufferReader()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => stdout.append(chunk))
    child.stderr?.on('data', (chunk: string) => stderr.append(chunk))
    const terminate = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const killer = setTimeout(() => child.kill('SIGKILL'), spec.graceMs)
        killer.unref()
      }
    }
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) queueMicrotask(terminate)
      else spec.signal.addEventListener('abort', terminate, { once: true })
    }
    const done = new Promise<SubprocessOutcome>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    return {
      pid: child.pid ?? -1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout, stderr },
      done,
      terminate,
      waitForExit: async () => done.then(() => true),
    }
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('terminal spawning is not supported by the test runtime'))
  }
}
