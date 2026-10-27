/**
 * Function runtime paths. In a compiled binary the Python runner is embedded
 * and copied to the data folder so the external python3 process can read it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Config } from '~/config'
import pythonRunnerPath from './runner-python.py' with { type: 'file' }

export function pythonRunner(config: Config): string {
  if (!Bun.isStandaloneExecutable) return pythonRunnerPath
  const base = config.databasePath === ':memory:' ? join(tmpdir(), 'bunwrite') : dirname(resolve(config.databasePath))
  const dir = join(base, '.runtimes')
  const path = join(dir, 'runner-python.py')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, readFileSync(pythonRunnerPath))
  return path
}
