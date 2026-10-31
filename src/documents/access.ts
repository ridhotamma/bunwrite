/**
 * Permission and date rules shared by the SQL and MongoDB document stores.
 *
 * Keeping these here means a permission or optimistic-concurrency change is
 * made once for both backends, and the stores only deal with storage.
 */
import type { Caller } from '~/auth/caller'
import { aggregatePermissions, grants, parsePermission, type PermissionType } from '~/auth/permissions'
import { normalizeDate } from '~/lib/datetime'
import { err, invalidStructure } from '~/lib/errors'
import type { Collection } from '~/schema/types'
import { ConflictError } from './errors'

/**
 * Resolve the permissions a write will store. `permissions` null/undefined
 * means "use the fallback"; non-privileged callers may only grant roles they
 * hold themselves.
 */
export function resolvePermissions(caller: Caller, permissions: unknown, fallback: string[] | null): string[] | null {
  const aggregated = aggregatePermissions(permissions)
  if (aggregated === null) return fallback
  if (!caller.privileged) {
    for (const permission of aggregated) {
      const { role } = parsePermission(permission)
      if (!caller.roles.has(role)) {
        throw err('user_unauthorized', `Permissions must be one of: (${[...caller.roles].join(', ')})`)
      }
    }
  }
  return aggregated
}

/** The default row permissions for a signed-in user, as Appwrite stores them. */
export function defaultPermissions(caller: Caller): string[] {
  if (caller.privileged || !caller.user) return []
  const id = caller.user.id
  return [`read("user:${id}")`, `update("user:${id}")`, `delete("user:${id}")`]
}

/** `$createdAt` / `$updatedAt` may be set by API keys only; others are ignored. */
export function documentDate(caller: Caller, data: Record<string, unknown>, key: '$createdAt' | '$updatedAt', fallback: string): string {
  const value = data[key]
  if (!caller.privileged || value === undefined || value === null) return fallback
  const date = normalizeDate(value)
  if (!date) {
    throw invalidStructure(`Attribute "${key}" has invalid format. Value must be valid date between 0000-01-01 and 9999-12-31.`)
  }
  return date
}

/** Collection-level or row-level permission check. */
export function canAccess(caller: Caller, collection: Collection, permissions: string[], type: PermissionType): boolean {
  if (caller.privileged || grants(collection.permissions, type, caller.roles)) return true
  return collection.documentSecurity && grants(permissions, type, caller.roles)
}

export function assertCreatePermission(caller: Caller, collection: Collection): void {
  if (!caller.privileged && !grants(collection.permissions, 'create', caller.roles)) throw err('user_unauthorized')
}

/** Bulk operations are API-key/console only, like Appwrite. */
export function assertBulkPermission(caller: Caller): void {
  if (!caller.privileged) throw err('general_unauthorized_scope')
}

/**
 * A transaction operation is a conflict when the document changed after the
 * operation was staged and this transaction did not write it itself.
 */
export function assertUnchangedSince(collection: Collection, id: string, updatedAt: string | undefined, touched: Set<string>, before: string): void {
  const key = `${collection.table}/${id}`
  if (!touched.has(key) && String(updatedAt ?? '') > before) {
    throw new ConflictError('Document was updated after the transaction operation')
  }
}

/** `If-Match` / `$revision`: compare the stored revision with what the client saw. */
export function assertRevision(id: string, revision: number | undefined, expected: number | '*' | undefined): void {
  if (expected === undefined || expected === '*') return
  const current = Number(revision ?? 1)
  if (current !== expected) {
    throw err('document_update_conflict', `Document '${id}' is at revision ${current}, not ${expected}. Fetch it again and retry.`)
  }
}
