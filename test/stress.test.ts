import { describe, expect, test } from 'bun:test'

import { makeDocument, type CollectionDef } from '../scripts/stress/seed'

describe('stress seed generator', () => {
  test('fills known product columns', () => {
    const products: CollectionDef = {
      $id: 'products',
      columns: [
        { key: 'tenantId', type: 'string', required: true, size: 64 },
        { key: 'name', type: 'string', required: true, size: 256 },
        { key: 'slug', type: 'string', required: true, size: 256 },
        { key: 'status', type: 'string', required: true, format: 'enum', elements: ['draft', 'active', 'archived'] },
        { key: 'sellPrice', type: 'integer' },
        { key: 'tags', type: 'string', array: true },
      ],
    }
    const doc = makeDocument(products, 7, 'stress-x', 'stress-x-tenant-00')
    expect(doc.$id).toBe('stress-x-000007')
    expect(doc.tenantId).toBe('stress-x-tenant-00')
    expect(doc.name).toBe('Stress stress-x 7')
    expect(doc.slug).toBe('stress-x-7')
    expect(doc.status).toBe('active')
    expect(doc.sellPrice).toBe(1507)
    expect(doc.tags).toEqual(['stress', 'tag-7'])
  })

  test('falls back for unknown required columns', () => {
    const collection: CollectionDef = {
      $id: 'custom',
      columns: [{ key: 'customCode', type: 'string', required: true, size: 20 }],
    }
    const doc = makeDocument(collection, 3, 'p', 't')
    expect(doc.$id).toBe('p-000003')
    expect(doc.customCode).toBe('p-customCode-3')
  })

  test('uses a valid enum member when the generated value is not allowed', () => {
    const collection: CollectionDef = {
      $id: 'custom',
      columns: [{ key: 'kind', type: 'string', required: true, format: 'enum', elements: ['manual', 'auto'] }],
    }
    expect(makeDocument(collection, 0, 'p', 't').kind).toBe('manual')
  })
})
