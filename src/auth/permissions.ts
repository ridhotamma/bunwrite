import { err } from '../lib/errors'

export type PermissionType = 'read' | 'create' | 'update' | 'delete' | 'write'

export interface ParsedPermission {
  type: PermissionType
  role: string
}

const PERMISSION = /^(read|create|update|delete|write)\("([^"]+)"\)$/
const ROLE =
  /^(any|guests|users(\/(verified|unverified))?|user:[a-zA-Z0-9._-]+(\/(verified|unverified))?|team:[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?|member:[a-zA-Z0-9._-]+|label:[a-zA-Z0-9]+)$/

export function parsePermission(value: unknown): ParsedPermission {
  const m = typeof value === 'string' ? PERMISSION.exec(value) : null
  if (!m) {
    throw err(
      'general_argument_invalid',
      `Invalid \`permissions\` param: Permission "${String(value)}" is not allowed. Must be one of: read, create, update, delete, write.`,
    )
  }
  const role = m[2]!
  if (!ROLE.test(role)) {
    throw err('general_argument_invalid', `Invalid \`permissions\` param: Role "${role}" is not allowed.`)
  }
  return { type: m[1] as PermissionType, role }
}

export const formatPermission = (type: string, role: string) => `${type}("${role}")`

/**
 * Validate and expand permissions the way Appwrite stores them: `write`
 * becomes each allowed non-read type, duplicates collapse, order is kept.
 * Returns null when `permissions` is null/undefined (meaning "use defaults").
 */
export function aggregatePermissions(
  permissions: unknown,
  allowed: PermissionType[] = ['read', 'update', 'delete'],
): string[] | null {
  if (permissions === null || permissions === undefined) return null
  if (!Array.isArray(permissions)) {
    throw err('general_argument_invalid', 'Invalid `permissions` param: Value must be a valid array.')
  }
  const out: string[] = []
  const seen = new Set<string>()
  const push = (type: string, role: string) => {
    const p = formatPermission(type, role)
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  for (const raw of permissions) {
    const { type, role } = parsePermission(raw)
    if (type === 'write') {
      for (const t of allowed) if (t !== 'read') push(t, role)
    } else {
      push(type, role)
    }
  }
  return out
}

/** Does any of `permissions` grant `type` to one of `roles`? */
export function grants(permissions: string[], type: PermissionType, roles: Set<string>): boolean {
  for (const p of permissions) {
    const m = PERMISSION.exec(p)
    if (!m) continue
    const t = m[1]
    if ((t === type || (t === 'write' && type !== 'read')) && roles.has(m[2]!)) return true
  }
  return false
}
