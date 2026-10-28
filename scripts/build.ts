/**
 * Build a standalone Bunwrite executable with the migrations and static assets
 * embedded. Run on the target OS/arch so native dependencies (sharp) match.
 *
 *   bun scripts/build.ts [target] [outfile]
 *   bun run build
 *
 * Use a target only when its native dependencies match the build host.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..'))

// sharp and its runtime dependencies (@img holds @img/colour and the native addon).
const sharpAssets = ['sharp', '@img', 'detect-libc', 'semver']

const target = process.argv[2] as Bun.Build.CompileTarget | undefined
const outfile = resolve(process.argv[3] ?? (target ? `dist/bunwrite-${target}` : 'dist/bunwrite'))
mkdirSync(dirname(outfile), { recursive: true })

const result = await Bun.build({
  entrypoints: [resolve('src/main.ts')],
  minify: true,
  compile: {
    outfile,
    ...(target ? { target } : {}),
    assets: ['./drizzle', ...sharpAssets.map((name) => `./node_modules/${name}`)],
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const size = (await Bun.file(outfile).stat()).size
console.log(`built ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`)
