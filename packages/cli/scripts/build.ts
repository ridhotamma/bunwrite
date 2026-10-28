/**
 * Build the CLI, with the SDK bundled in, so the package has no dependencies.
 *
 *   bun run build            dist/cli.js for Node.js 20+ and Bun
 *   bun run build:binary     dist/bunwrite, a standalone executable for this machine
 */
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { version: string }
const version = read(join(root, 'package.json')).version
const sdkVersion = read(join(root, '../sdk/package.json')).version
const dist = join(root, 'dist')
const binary = process.argv.includes('--binary')
const target = process.argv.find((a) => a.startsWith('--target='))?.slice(9) as Bun.Build.CompileTarget | undefined
if (!binary) rmSync(dist, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [join(root, 'src/cli.ts')],
  tsconfig: join(root, 'tsconfig.json'),
  minify: binary,
  define: { __BUNWRITE_CLI_VERSION__: JSON.stringify(version), __BUNWRITE_SDK_VERSION__: JSON.stringify(sdkVersion) },
  ...(binary
    ? { compile: { outfile: join(dist, target ? `bunwrite-${target}` : 'bunwrite'), ...(target ? { target } : {}) } }
    : { outdir: dist, naming: 'cli.js', target: 'node', format: 'esm', banner: '#!/usr/bin/env node' }),
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
if (!binary) chmodSync(join(dist, 'cli.js'), 0o755)
console.log(`Built @bunwrite/cli ${version} (SDK ${sdkVersion}) in`, dist)
