/**
 * Build dist/: ESM, CommonJS, a browser script (window.Bunwrite) and type declarations.
 * No source maps: the ESM and CommonJS builds are not minified, and maps would
 * make the package ten times larger.
 *
 *   bun run build
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
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
    minify: format === 'iife',
    define: { __BUNWRITE_SDK_VERSION__: JSON.stringify(version) },
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

// Node's ESM resolution (TypeScript's `nodenext`) needs extensions on relative imports.
for (const file of new Bun.Glob('**/*.d.ts').scanSync(dist)) {
  const path = join(dist, file)
  const text = readFileSync(path, 'utf8')
  const fixed = text.replace(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)(['"])/g, (m, head, spec, tail) =>
    /\.(js|json)$/.test(spec) ? m : `${head}${spec}.js${tail}`,
  )
  if (fixed !== text) writeFileSync(path, fixed)
}
console.log(`Built @bunwrite/sdk ${version} in`, dist)
