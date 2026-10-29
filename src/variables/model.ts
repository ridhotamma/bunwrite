/** Appwrite's Variable model, shared by project and site variables. */
import type { VariableRow } from './service'

export function variableModel(row: VariableRow, resourceType: 'project' | 'site', resourceId: string) {
  return {
    $id: row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    key: row.key,
    value: row.secret ? '' : row.value,
    secret: Boolean(row.secret),
    resourceType,
    resourceId,
  }
}
