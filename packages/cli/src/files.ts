import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import type { TarEntry } from './tar'

/** A gitignore-style pattern as a test on a slash-separated relative path. */
export function matcher(pattern: string): (path: string, dir: boolean) => boolean {
  let p = pattern.trim()
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/')
  p = p.replace(/^\//, '')
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '*' && p[i + 1] === '*') {
      re += '.*'
      i++
      if (p[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const regex = new RegExp(anchored ? `^${re}(/.*)?$` : `(^|/)${re}(/.*)?$`)
  // Ignored folders are never entered, so a folder-only pattern only needs to test folders.
  return (path, dir) => (!dirOnly || dir) && regex.test(path)
}

/** Patterns from a list, skipping blanks and comments. Negations (`!x`) are not supported and skipped. */
export function patterns(lines: string[]): ((path: string, dir: boolean) => boolean)[] {
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).map(matcher)
}

/**
 * The files of a function folder, without `.git` and the ignored ones. `ignore`
 * comes from the function's config; without it, the folder's .gitignore is used.
 */
export function collect(root: string, ignore?: string[]): TarEntry[] {
  const rules = patterns(ignore ?? (existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8').split('\n') : []))
  const skip = (path: string, dir: boolean) => path === '.git' || path.startsWith('.git/') || rules.some((r) => r(path, dir))
  const out: TarEntry[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const path = relative(root, full).split(sep).join('/')
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (!skip(path, true)) walk(full)
      } else if (stat.isFile() && !skip(path, false)) {
        out.push({ path, data: readFileSync(full), mode: stat.mode & 0o777, mtime: Math.floor(stat.mtimeMs / 1000) })
      }
    }
  }
  walk(root)
  return out
}
