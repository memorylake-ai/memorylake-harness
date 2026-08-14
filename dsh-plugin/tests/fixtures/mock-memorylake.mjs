#!/usr/bin/env node
// Mock `memorylake` CLI for tests. Behavior is driven by a scenario JSON
// file named by the MEMORYLAKE_MOCK_SCENARIO environment variable:
//
//   {
//     "auth status":  { "exitCode": 0, "stdout": {...} },
//     "search":       { "exitCode": 0, "stdout": {...},
//                       "byLastArg": { "some query": { ... } } },
//     "fact delete":  { "exitCode": 2, "stdout": {"forgotten": [], ...} }
//   }
//
// The lookup key is the first one or two non-flag arguments ("search",
// "fact add", "auth status", ...). `stdout` may be a JSON value (pretty
// printed like the real CLI) or a raw string. `delayMs` postpones exit,
// covering the caller-owned timeout path. `byLastArg` overrides the entry
// per final positional argument (the query), so one scenario can answer
// different searches differently.
import { readFileSync } from 'node:fs'

const scenarioPath = process.env.MEMORYLAKE_MOCK_SCENARIO
const scenario = scenarioPath === undefined ? {} : JSON.parse(readFileSync(scenarioPath, 'utf8'))
const args = process.argv.slice(2)
const words = args.filter(argument => !argument.startsWith('--')).slice(0, 2)
const twoWordKey = words.join(' ')
let entry = scenario[twoWordKey] ?? scenario[words[0] ?? '']
  ?? { exitCode: 1, stderr: `mock: no scenario for "${twoWordKey}"` }
const lastArg = args[args.length - 1]
if (entry.byLastArg !== undefined && lastArg !== undefined && entry.byLastArg[lastArg] !== undefined) {
  entry = entry.byLastArg[lastArg]
}

const finish = () => {
  if (entry.stdout !== undefined) {
    process.stdout.write(typeof entry.stdout === 'string' ? entry.stdout : JSON.stringify(entry.stdout, null, 2))
  }
  if (entry.stderr !== undefined) process.stderr.write(entry.stderr)
  process.exit(entry.exitCode ?? 0)
}

if (entry.delayMs !== undefined) setTimeout(finish, entry.delayMs)
else finish()
