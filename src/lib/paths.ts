import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * A path that stays inside a known root. Absolute paths, Windows separators,
 * NUL bytes and `..` segments that escape the root are refused. An empty
 * string is never a safe path; callers that allow "unset" must check first.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return false
  if (isAbsolute(value)) return false
  const normalized = relative('.', value)
  return normalized !== '..' && !normalized.startsWith(`..${sep}`) && !isAbsolute(normalized)
}

/** Resolve `relative` under `root`, or null when it would escape the root. */
export function resolveInside(root: string, relativePath: unknown): string | null {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) return null
  const base = resolve(root)
  const target = resolve(base, relativePath)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}


