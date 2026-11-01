/**
 * Architecture guards for the modules that have moved to the database port.
 *
 * These are cheap, deterministic checks: they fail when a refactored module
 * reaches back for the SQLite handle or imports `bun:sqlite` directly, which
 * would silently break a Postgres deployment.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/** Directories that must use the driver port, not a concrete connection. */
const PORTABLE = ['src/documents', 'src/transactions', 'src/logs', 'src/variables', 'src/webhooks']

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('portable modules', () => {
  const files = PORTABLE.flatMap((dir) => walk(join(ROOT, dir)))

  test('do not reach for the SQLite handle or bun:sqlite', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/\.sqlite\b/.test(text)) offenders.push(`${relative(ROOT, file)}: uses .sqlite`)
      if (/from 'bun:sqlite'/.test(text)) offenders.push(`${relative(ROOT, file)}: imports bun:sqlite`)
    }
    expect(offenders).toEqual([])
  })

  test('services do not import the console or the HTTP layer', () => {
    const offenders: string[] = []
    for (const file of files.filter((file) => !file.endsWith('/routes.ts'))) {
      const text = readFileSync(file, 'utf8')
      if (/from '~\/console\//.test(text)) offenders.push(`${relative(ROOT, file)}: imports ~/console`)
      if (/from '~\/app'/.test(text)) offenders.push(`${relative(ROOT, file)}: imports ~/app`)
    }
    expect(offenders).toEqual([])
  })
})
