/**
 * Function runtime paths. In a compiled binary the Python runner is embedded
 * and copied to the data folder so the external python3 process can read it.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Config } from '~/config'
import pythonRunnerPath from './runner-python.py' with { type: 'file' }
import { allowPassThrough } from './sandbox'

/** Isolated functions run as other users: shared runtime files must be usable by them (the server's umask is 077). */
function shareWithFunctions(config: Config, dir: string, files: [path: string, mode: number][]): void {
  if (!config.functionsSandbox) return
  for (const [path, mode] of files) chmodSync(path, mode)
  chmodSync(dir, 0o711)
  allowPassThrough(config.functionsSandbox.root, dirname(dir))
}

export function pythonRunner(config: Config): string {
  if (!Bun.isStandaloneExecutable) return pythonRunnerPath
  const base = config.databasePath === ':memory:' ? join(tmpdir(), 'bunwrite') : dirname(resolve(config.databasePath))
  const dir = join(base, '.runtimes')
  const path = join(dir, 'runner-python.py')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, readFileSync(pythonRunnerPath))
  shareWithFunctions(config, dir, [[path, 0o644]])
  return path
}

/** Where `pip install` puts packages during a Python build; the runner imports from it. */
export const PYTHON_PACKAGES_DIR = '.python_packages'

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Commands that build commands can always use, even in the Docker image that
 * has nothing but this binary: `bun` and `bunx` run this binary as the Bun
 * CLI (BUN_BE_BUN=1), and `npm`/`npx` cover the usual `npm install`, `npm ci`,
 * `npm run` and `npx` through it. The folder goes at the end of PATH, so a
 * real npm or bun on the server is used when there is one.
 */
export function buildToolsDir(config: Config): string {
  const base = config.databasePath === ':memory:' ? join(tmpdir(), 'bunwrite') : dirname(resolve(config.databasePath))
  const dir = join(base, '.runtimes', 'bin')
  const bun = `BUN_BE_BUN=1 exec ${shellQuote(process.execPath)}`
  const scripts: Record<string, string> = {
    bun: `${bun} "$@"`,
    bunx: `${bun} x "$@"`,
    npx: `${bun} x "$@"`,
    npm: `# npm is not installed here; the common commands run through Bun.
cmd="$1"; [ $# -gt 0 ] && shift
# Drop npm-only flags; the dev-dependency switches become Bun's --production.
n=$#
while [ "$n" -gt 0 ]; do
  a="$1"; shift; n=$((n - 1))
  case "$a" in
    --omit=dev|--only=prod|--only=production|--production) set -- "$@" --production ;;
    --no-audit|--no-fund|--silent|--quiet|--loglevel=*|--legacy-peer-deps|--no-save|--no-package-lock) ;;
    *) set -- "$@" "$a" ;;
  esac
done
packages=0
for a in "$@"; do case "$a" in -*) ;; *) packages=1 ;; esac; done
case "$cmd" in
  install|i|add) if [ "$packages" = 1 ]; then ${bun} add "$@"; else ${bun} install "$@"; fi ;;
  ci) ${bun} install "$@" ;;
  run|run-script) ${bun} run "$@" ;;
  test|start) ${bun} run "$cmd" "$@" ;;
  exec|x) ${bun} x "$@" ;;
  -v|--version|version) ${bun} --version ;;
  *) echo "npm is not installed on this server. Build commands can use npm install, npm ci, npm run and npx (run through Bun), or bun itself." >&2; exit 127 ;;
esac`,
  }
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name)
    const text = `#!/bin/sh\n${body}\n`
    let current = ''
    try {
      current = readFileSync(path, 'utf8')
    } catch {}
    if (current !== text) writeFileSync(path, text, { mode: 0o755 })
  }
  shareWithFunctions(config, dir, Object.keys(scripts).map((name) => [join(dir, name), 0o755]))
  return dir
}
