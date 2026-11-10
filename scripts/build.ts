/**
 * Build a standalone Bunwrite executable with the migrations and static assets
 * embedded. Run on the target OS/arch so native dependencies (sharp, canvas)
 * match.
 *
 *   bun scripts/build.ts [target] [outfile]
 *   bun run build
 *
 * Use a target only when its native dependencies match the build host.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..'))

// sharp and its runtime dependencies (@img holds @img/colour and the native addon).
const sharpAssets = ['sharp', '@img', 'detect-libc', 'semver']
// PDF page rendering for OCR; the platform package lives under @napi-rs.
const canvasAssets = ['@napi-rs']

const target = process.argv[2] as Bun.Build.CompileTarget | undefined
const outfile = resolve(process.argv[3] ?? (target ? `dist/bunwrite-${target}` : 'dist/bunwrite'))
mkdirSync(dirname(outfile), { recursive: true })

// A binary built on another OS/arch embeds the build host's sharp addon and
// crashes on startup elsewhere. Fail here instead of shipping that binary.
const nativePlatform = target ? target.replace(/^bun-/, '').replace(/-baseline$/, '') : `${process.platform}-${process.arch}`
for (const name of [`sharp-${nativePlatform}`, `sharp-libvips-${nativePlatform}`]) {
  if (!existsSync(resolve('node_modules', '@img', name))) {
    console.error(
      `Missing @img/${name}. Build on the target platform (or run bun install with the target OS/arch); ` +
        'the compiled binary cannot load another platform\'s sharp addon.',
    )
    process.exit(1)
  }
}

const result = await Bun.build({
  entrypoints: [resolve('src/main.ts')],
  minify: true,
  compile: {
    outfile,
    ...(target ? { target } : {}),
    assets: ['./drizzle', ...sharpAssets.map((name) => `./node_modules/${name}`), ...canvasAssets.map((name) => `./node_modules/${name}`)],
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const size = (await Bun.file(outfile).stat()).size
console.log(`built ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`)
