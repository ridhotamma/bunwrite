/**
 * Seed a collection through the Appwrite-compatible API. The generator reads
 * the collection definition from appwrite.config.json and fills required
 * columns, so it works with any schema; pass --data for full control.
 */
export interface ColumnDef {
  key: string
  type: string
  required?: boolean
  array?: boolean
  size?: number
  format?: string
  elements?: string[]
  default?: unknown
  min?: number
  max?: number
}

export interface CollectionDef {
  $id: string
  databaseId?: string
  columns?: ColumnDef[]
  attributes?: ColumnDef[]
}

export interface SeedOptions {
  base: string
  headers: Record<string, string>
  database: string
  collection: string
  collectionDef?: CollectionDef
  count: number
  batch: number
  prefix: string
  tenants: number
  data?: Record<string, unknown>
  upsert: boolean
  dryRun: boolean
  log?: (line: string) => void
}

export interface SeedResult {
  count: number
  prefix: string
  firstId: string
  firstTenant: string
  durationMs: number
}

const iso = (day = 0) => new Date(Date.UTC(2026, 0, 1 + day)).toISOString().replace('Z', '+00:00')
const pad = (value: number, size = 6) => String(value).padStart(size, '0')
const truncate = (value: string, size = 256) => value.slice(0, Math.max(1, size))

/** Values that make the seeded rows look like real products/documents. */
function knownValue(column: ColumnDef, index: number, prefix: string, tenant: string): unknown {
  const first = column.elements?.[0]
  switch (column.key) {
    case 'tenantId':
      return tenant
    case 'tenantSlug':
      return `${prefix}-tenant`
    case 'name':
    case 'title':
      return truncate(`Stress ${prefix} ${index}`, column.size)
    case 'displayName':
      return truncate(`Stress Customer ${index}`, column.size)
    case 'slug':
    case 'handle':
      return truncate(`${prefix}-${index}`, column.size)
    case 'status':
      return column.elements?.includes('active') ? 'active' : (first ?? 'active')
    case 'email':
      return `stress-${index}@example.com`
    case 'phone':
      return `+620000${pad(index)}`
    case 'topic':
      return 'stress'
    case 'message':
    case 'body':
      return truncate(`Stress test message ${index}`, column.size)
    case 'description':
      return truncate(`Stress test document ${prefix} ${index}. `.repeat(3), column.size)
    case 'sku':
      return `SKU-${pad(index)}`
    case 'code':
      return `CODE-${pad(index)}`
    case 'number':
      return `NUM-${pad(index)}`
    case 'invoiceNumber':
      return `INV-${pad(index)}`
    case 'purchaseNumber':
      return `PO-${pad(index)}`
    case 'orderNumber':
      return `ORD-${pad(index)}`
    case 'currency':
      return 'IDR'
    case 'locale':
      return 'en'
    case 'categoryId':
      return `cat-${index % 50}`
    case 'collectionIds':
    case 'images':
    case 'tags': {
      if (column.key === 'images') return column.array ? [`https://cdn.example.com/stress/${index}.jpg`] : `https://cdn.example.com/stress/${index}.jpg`
      if (column.key === 'tags') return column.array ? ['stress', `tag-${index % 20}`] : 'stress'
      return column.array ? [`col-${index % 10}`] : `col-${index % 10}`
    }
    case 'capitalPrice':
      return 1000 + (index % 100)
    case 'sellPrice':
    case 'price':
      return 1500 + (index % 200)
    case 'compareAtPrice':
      return 2000
    case 'stockTotal':
      return 100
    case 'stockOnHold':
      return 0
    case 'trackStock':
      return true
    case 'hasVariants':
      return false
    case 'variantCount':
      return 0
    case 'weightGram':
      return 500
    case 'rating':
      return 4.5
    case 'ratingCount':
      return 10
    case 'soldCount':
      return index % 1000
    case 'publishedAt':
      return iso(index % 365)
    case 'productType':
      return 'physical'
    case 'kitchenStation':
      return 'none'
    case 'posEnabled':
      return true
    case 'permissionsJson':
      return '[]'
    case 'draftJson':
    case 'itemsJson':
    case 'tableJson':
    case 'contentJson':
    case 'params':
      return '{}'
    case 'linesJson':
      return '[]'
    case 'passwordHash':
      return 'stress-hash'
    case 'userId':
      return `user-${index}`
    case 'sessionId':
      return `session-${index}`
    case 'orderId':
      return `order-${index}`
    case 'productId':
      return `product-${index}`
    case 'customerId':
      return `customer-${index}`
    case 'purchaseId':
      return `purchase-${index}`
    case 'voucherId':
      return `voucher-${index}`
    case 'eventId':
      return `event-${index}`
    case 'entryId':
      return `entry-${index}`
    case 'targetId':
      return `target-${index}`
    case 'targetType':
      return 'product'
    case 'provider':
      return 'stress'
    case 'method':
      return 'POST'
    case 'path':
      return '/stress'
    case 'direction':
      return 'outbound'
    case 'kind':
      return 'stress'
    case 'scope':
      return 'stress'
    case 'type':
    case 'fromStatus':
    case 'toStatus':
      return first ?? (column.key === 'toStatus' ? 'completed' : 'stress')
    case 'planId':
    case 'planSlug':
    case 'planName':
      return 'plan-stress'
    case 'billingCycle':
      return 'monthly'
    case 'amount':
    case 'unitPrice':
    case 'unitCost':
    case 'lineTotal':
    case 'specialPrice':
    case 'bumpPrice':
      return 1500
    case 'periodStart':
      return iso(0)
    case 'periodEnd':
      return iso(30)
    case 'issuedAt':
    case 'paidAt':
    case 'paymentDate':
    case 'redeemedAt':
    case 'openedAt':
      return iso(index % 30)
    case 'startsAt':
      return iso(0)
    case 'endsAt':
    case 'expiresAt':
      return iso(365)
    case 'createdBy':
      return `user-${index}`
    case 'supplierId':
      return `supplier-${index}`
    case 'supplierName':
      return `Supplier ${index}`
    case 'itemCount':
    case 'quantity':
      return 1
    case 'subtotal':
    case 'grandTotal':
      return 1500
    case 'discountAmount':
      return 1000
    case 'orderTotal':
      return 1500
    case 'debit':
      return 1000
    case 'credit':
      return 0
    case 'points':
      return 10
    case 'reason':
      return 'stress'
    case 'rate':
      return 10
    case 'isSystem':
    case 'isActive':
    case 'isDefault':
    case 'isPublished':
      return true
    case 'failedCount':
      return 0
    case 'key':
      return `${prefix}-${index}`
    case 'token':
    case 'tokenHash':
      return `token-${pad(index)}`
    case 'platform':
      return 'web'
    case 'paramsJson':
      return '{}'
    default:
      return undefined
  }
}

function fallbackValue(column: ColumnDef, index: number, prefix: string): unknown {
  if (column.array) return []
  switch (column.type) {
    case 'integer':
      return column.min ?? 0
    case 'double':
      return column.min ?? 0
    case 'boolean':
      return false
    case 'datetime':
      return iso(index % 365)
    case 'string':
      if (column.elements?.length) return column.elements[0]
      if (column.format === 'email') return `stress-${index}@example.com`
      return truncate(`${prefix}-${column.key}-${index}`, column.size)
    default:
      return `${prefix}-${index}`
  }
}

/** Build one valid document from the collection definition. */
export function makeDocument(collection: CollectionDef, index: number, prefix: string, tenant: string): Record<string, unknown> {
  const columns = collection.columns ?? collection.attributes ?? []
  const doc: Record<string, unknown> = { $id: `${prefix}-${pad(index)}` }
  for (const column of columns) {
    const known = knownValue(column, index, prefix, tenant)
    let value = known !== undefined ? known : column.required ? fallbackValue(column, index, prefix) : undefined
    if (typeof value === 'string' && column.elements?.length && !column.elements.includes(value)) value = column.elements[0]
    if (value !== undefined) doc[column.key] = value
  }
  return doc
}

function replacePlaceholders(value: unknown, vars: { i: number; tenant: string; prefix: string }): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{i}}', String(vars.i))
      .replaceAll('{{tenant}}', vars.tenant)
      .replaceAll('{{prefix}}', vars.prefix)
  }
  if (Array.isArray(value)) return value.map((entry) => replacePlaceholders(entry, vars))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = replacePlaceholders(entry, vars)
    return out
  }
  return value
}

export async function seed(options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? ((line) => console.log(line))
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error('--count must be a positive integer')
  if (!Number.isInteger(options.batch) || options.batch < 1) throw new Error('--batch must be a positive integer')
  if (!Number.isInteger(options.tenants) || options.tenants < 1) throw new Error('--tenants must be a positive integer')
  if (options.prefix.length > 28) throw new Error('--prefix must be 28 characters or fewer (the document ID adds a suffix)')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.prefix)) throw new Error('--prefix must use letters, digits, dots, hyphens and underscores')

  const started = performance.now()
  const firstId = `${options.prefix}-${pad(0)}`
  const firstTenant = `${options.prefix}-tenant-00`
  const url = `${options.base}/databases/${options.database}/collections/${options.collection}/documents`
  const method = options.upsert ? 'PUT' : 'POST'
  const documents: Record<string, unknown>[] = []

  for (let start = 0; start < options.count; start += options.batch) {
    const end = Math.min(start + options.batch, options.count)
    documents.length = 0
    for (let i = start; i < end; i++) {
      const tenant = `${options.prefix}-tenant-${pad(i % options.tenants, 2)}`
      if (options.data) {
        const values = replacePlaceholders(options.data, { i, tenant, prefix: options.prefix }) as Record<string, unknown>
        documents.push({ ...values, $id: `${options.prefix}-${pad(i)}` })
      } else if (options.collectionDef) {
        documents.push(makeDocument(options.collectionDef, i, options.prefix, tenant))
      } else {
        throw new Error('Seed needs --config (to read the collection definition) or --data')
      }
    }

    if (options.dryRun) {
      log(`${method} ${url}`)
      log(JSON.stringify({ documents: documents.slice(0, 1) }, null, 2))
      return { count: 0, prefix: options.prefix, firstId, firstTenant, durationMs: performance.now() - started }
    }

    const response = await fetch(url, {
      method,
      headers: { ...options.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ documents }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Seed batch ${start}-${end} failed: ${response.status} ${body.slice(0, 1000)}`)
    }
    await response.arrayBuffer()
    if (end === options.count || end % (options.batch * 10) === 0) {
      const seconds = Math.max(0.001, (performance.now() - started) / 1000)
      log(`seeded ${end}/${options.count} (${Math.round(end / seconds)}/s)`)
    }
  }

  return {
    count: options.count,
    prefix: options.prefix,
    firstId,
    firstTenant,
    durationMs: performance.now() - started,
  }
}
