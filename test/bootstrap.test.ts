import { describe, expect, test } from 'bun:test'

import { configFromEnv } from '~/config'
import { ConsoleAuth } from '~/console/auth'
import { openDb, type Db } from '~/db/connection'
import { bootstrapInstance, clearInstanceApiKey } from '~/instance/bootstrap'
import { sha256 } from '~/lib/ids'
import { PROJECT, startServer } from './helpers'

function instanceRecord(db: Db): Record<string, unknown> | null {
  const row = db.sqlite.query<{ value: string }, []>("SELECT value FROM _settings WHERE key = 'instance'").get()
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : null
}

describe('instance bootstrap', () => {
  test('generates and persists credentials on first start', () => {
    const db = openDb(':memory:')
    try {
      const result = bootstrapInstance(db, {})
      expect(result.orgId).toStartWith('org_')
      expect(result.projectId).toStartWith('prj_')
      expect(result.env.SECRET).toHaveLength(64)
      expect(result.apiKey).toStartWith('standard_')
      expect(result.generated).toBe(true)
      expect(result.created).toBe(true)

      const config = configFromEnv(result.env)
      expect(config.orgId).toBe(result.orgId)
      expect(config.projectId).toBe(result.projectId)
      expect(config.apiKeys).toEqual([result.apiKey!])
      expect(instanceRecord(db)).toMatchObject({
        orgId: result.orgId,
        projectId: result.projectId,
        secret: result.env.SECRET!,
        apiKey: result.apiKey!,
      })
      expect(db.sqlite.query('SELECT id FROM _api_keys WHERE secret_hash = ?').get(sha256(result.apiKey!))).toBeTruthy()

      const again = bootstrapInstance(db, {})
      expect([again.orgId, again.projectId, again.env.SECRET, again.apiKey]).toEqual([
        result.orgId,
        result.projectId,
        result.env.SECRET,
        result.apiKey,
      ])
      expect(again.generated).toBe(false)
      expect(again.created).toBe(false)
      expect(db.sqlite.query('SELECT count(*) AS n FROM _api_keys').get()).toEqual({ n: 1 })
    } finally {
      db.sqlite.close()
    }
  })

  test('environment overrides stored values without rewriting them', () => {
    const db = openDb(':memory:')
    try {
      const first = bootstrapInstance(db, {})
      const override = bootstrapInstance(db, {
        ORG_ID: 'org_custom',
        PROJECT_ID: 'custom-project',
        SECRET: 'y'.repeat(40),
        API_KEYS: 'standard_custom',
      })
      expect([override.orgId, override.projectId, override.env.SECRET, override.apiKey]).toEqual([
        'org_custom',
        'custom-project',
        'y'.repeat(40),
        undefined,
      ])
      expect(instanceRecord(db)).toMatchObject({ orgId: first.orgId, projectId: first.projectId, secret: first.env.SECRET! })

      const fallback = bootstrapInstance(db, {})
      expect([fallback.orgId, fallback.projectId, fallback.env.SECRET]).toEqual([
        first.orgId,
        first.projectId,
        first.env.SECRET,
      ])
    } finally {
      db.sqlite.close()
    }
  })

  test('seeds a new record from the environment and validates the secret', () => {
    const db = openDb(':memory:')
    try {
      const result = bootstrapInstance(db, { PROJECT_ID: 'env-project', SECRET: 'z'.repeat(40), API_KEYS: 'standard_env' })
      expect(result.projectId).toBe('env-project')
      expect(result.env.SECRET).toBe('z'.repeat(40))
      expect(result.orgId).toStartWith('org_')
      expect(result.apiKey).toBeUndefined()
      expect(result.generated).toBe(true)
      expect(instanceRecord(db)).toMatchObject({ orgId: result.orgId, projectId: 'env-project', secret: 'z'.repeat(40) })

      expect(() => bootstrapInstance(db, { SECRET: 'too-short' })).toThrow('SECRET must be at least 32 characters')
    } finally {
      db.sqlite.close()
    }
  })

  test('drops the plaintext key after the first admin exists', async () => {
    const db = openDb(':memory:')
    try {
      const first = bootstrapInstance(db, {})
      const auth = new ConsoleAuth(db)
      await auth.upsert('admin@example.com', 'password-123')

      const after = bootstrapInstance(db, {})
      expect(after.apiKey).toBeUndefined()
      expect(instanceRecord(db)).not.toHaveProperty('apiKey')
      // The generated key still works: only the plaintext copy is removed.
      expect(db.sqlite.query('SELECT id FROM _api_keys WHERE secret_hash = ?').get(sha256(first.apiKey!))).toBeTruthy()
    } finally {
      db.sqlite.close()
    }
  })

  test('clearInstanceApiKey removes the displayed copy but keeps the key row', () => {
    const db = openDb(':memory:')
    try {
      const result = bootstrapInstance(db, {})
      clearInstanceApiKey(db)
      expect(instanceRecord(db)).not.toHaveProperty('apiKey')
      expect(db.sqlite.query('SELECT id FROM _api_keys WHERE secret_hash = ?').get(sha256(result.apiKey!))).toBeTruthy()
    } finally {
      db.sqlite.close()
    }
  })

  test('console setup page shows the generated credentials', async () => {
    const server = startServer(undefined, {
      bootstrap: { orgId: 'org_setup', projectId: PROJECT, apiKey: 'standard_setup', generated: true },
    })
    try {
      const response = await fetch(`${server.endpoint.replace(/\/v1$/, '')}/console/setup`)
      expect(response.status).toBe(200)
      const page = await response.text()
      expect(page).toContain('Instance credentials')
      expect(page).toContain('org_setup')
      expect(page).toContain(PROJECT)
      expect(page).toContain('standard_setup')
      expect(page).toContain('not shown after you create the admin')
    } finally {
      server.stop()
    }
  })
})
