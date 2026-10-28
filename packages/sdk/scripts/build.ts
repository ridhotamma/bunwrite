/**
 * Build dist/: ESM, CommonJS, a browser script (window.Bunwrite) and type declarations.
 *
 *   bun run build
 */
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })

for (const [entry, format, naming, target] of [
  ['src/index.ts', 'esm', 'index.js', 'browser'],
  ['src/index.ts', 'cjs', 'index.cjs', 'node'],
  ['src/browser.ts', 'iife', 'bunwrite.iife.js', 'browser'],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: dist,
    naming,
    format,
    target,
    sourcemap: 'linked',
    minify: format === 'iife',
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}

const tsc = Bun.spawnSync(['tsc', '-p', root, '--noEmit', 'false', '--emitDeclarationOnly', '--outDir', dist], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1)
console.log('Built', dist)
