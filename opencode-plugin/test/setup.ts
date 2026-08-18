/**
 * Global test isolation.
 *
 * `MEMORYLAKE_PLUGIN_DATA` is redirected for every test file before any of
 * them import the plugin, so nothing under test can reach the developer's real
 * `~/.memorylake` tree. This exists because an earlier run of this suite wrote
 * connectivity-cache entries into the real tree: the status cache is shared
 * across harnesses by design, which makes it exactly the kind of state a test
 * must never touch.
 *
 * Individual tests still create their own temp directories when they need to
 * assert on file contents; this is the floor, not a replacement.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const sandbox = mkdtempSync(join(tmpdir(), 'ml-oc-suite-'))
process.env.MEMORYLAKE_PLUGIN_DATA = join(sandbox, 'harness')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})
