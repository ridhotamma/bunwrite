/**
 * Bundle the MCP server and the Bunwrite SDK into one file, so the published
 * package has no runtime dependencies.
 *
 *   bun run build            dist/mcp.js for Node.js 20+ and Bun
 *   bun run build --binary   dist/bunwrite-mcp, a standalone executable
 */
import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { version: string }
const version = read(join(root, 'package.json')).version
const sdkVersion = read(join(root, '../sdk/package.json')).version
const dist = join(root, 'dist')
const binary = process.argv.includes('--binary')
const target = process.argv.find((argument) => argument.startsWith('--target='))?.slice(9) as Bun.Build.CompileTarget | undefined
if (!binary) rmSync(dist, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [join(root, 'src/index.ts')],
  tsconfig: join(root, 'tsconfig.json'),
  minify: binary,
  define: {
    __BUNWRITE_MCP_VERSION__: JSON.stringify(version),
    __BUNWRITE_SDK_VERSION__: JSON.stringify(sdkVersion),
  },
  ...(binary
    ? { compile: { outfile: join(dist, target ? `bunwrite-mcp-${target}` : 'bunwrite-mcp'), ...(target ? { target } : {}) } }
    : { outdir: dist, naming: 'mcp.js', target: 'node', format: 'esm', banner: '#!/usr/bin/env node' }),
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
if (!binary) chmodSync(join(dist, 'mcp.js'), 0o755)
console.log(`Built @bunwrite/mcp ${version} (SDK ${sdkVersion}) in`, dist)
