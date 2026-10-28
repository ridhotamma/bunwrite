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

function setting<T>(db: Db, key: string): T | null {
  const row = db.sqlite.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get(key)
  return row ? (JSON.parse(row.value) as T) : null
}

describe('instance bootstrap', () => {
  test('server config ignores project environment variables', () => {
    const config = configFromEnv({
      PROJECT_ID: 'env-project',
      ORG_ID: 'org_env',
      PROJECT_NAME: 'Env Project',
      API_KEYS: 'standard_env',
      SECRET: 'z'.repeat(40),
      ALLOWED_ORIGINS: 'shop.example.com',
      SESSION_DURATION: '60',
      SESSIONS_LIMIT: '1',
      SMTP_HOST: 'smtp.example.com',
      GOOGLE_CLIENT_ID: 'google-id',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      FUNCTIONS_SKIP_SCHEDULES: 'cron',
    })
    expect([config.projectId, config.orgId, config.projectName, config.apiKeys, config.secret]).toEqual(['', '', 'Bunwrite', [], ''])
    expect([config.allowedOrigins, config.sessionDuration, config.sessionsLimit, config.smtp, config.google, config.skipSchedules]).toEqual([
      [],
      31536000,
      10,
      null,
      null,
      [],
    ])
  })

  test('DOMAIN supplies the public endpoint unless PUBLIC_ENDPOINT is set', () => {
    expect(configFromEnv({ DOMAIN: 'appwrite.pesanle.com' }).publicEndpoint).toBe('https://appwrite.pesanle.com/v1')
    expect(configFromEnv({ DOMAIN: 'https://appwrite.pesanle.com/' }).publicEndpoint).toBe('https://appwrite.pesanle.com/v1')
    expect(configFromEnv({ DOMAIN: 'appwrite.pesanle.com', PUBLIC_ENDPOINT: 'https://api.example.com/v1/' }).publicEndpoint).toBe(
      'https://api.example.com/v1',
    )
    expect(configFromEnv({ DOMAIN: '   ' }).publicEndpoint).toBe('http://localhost:8080/v1')
    expect(configFromEnv({}).publicEndpoint).toBe('http://localhost:8080/v1')
    expect(configFromEnv({ PORT: '9090' }).publicEndpoint).toBe('http://localhost:9090/v1')
  })

  test('site and function hosts use the configured prefixes', () => {
    const defaults = configFromEnv({ DOMAIN: 'example.com' })
    expect(defaults.sitesDomain).toBe('sites.example.com')
    expect(defaults.functionsDomain).toBe('functions.example.com')

    const custom = configFromEnv({ DOMAIN: 'example.com', SITES_PREFIX: 'web', FUNCTIONS_PREFIX: 'api' })
    expect(custom.sitesDomain).toBe('web.example.com')
    expect(custom.functionsDomain).toBe('api.example.com')

    expect(configFromEnv({ SITES_DOMAIN: 'sites.test', FUNCTIONS_DOMAIN: 'functions.test' }).sitesDomain).toBe('sites.test')
    expect(configFromEnv({ SITES_DOMAIN: 'sites.test', FUNCTIONS_DOMAIN: 'functions.test' }).functionsDomain).toBe('functions.test')

    const local = configFromEnv({})
    expect(local.sitesDomain).toBe('sites.localhost')
    expect(local.functionsDomain).toBe('functions.localhost')
  })

  test('generates and persists credentials on first start', () => {
    const db = openDb(':memory:')
    try {
      const result = bootstrapInstance(db, {})
      expect(result.orgId).toStartWith('org_')
      expect(result.projectId).toStartWith('prj_')
      expect(result.projectName).toBe('Bunwrite')
      expect(result.secret).toHaveLength(64)
      expect(result.apiKey).toStartWith('standard_')
      expect(result.generated).toBe(true)
      expect(result.created).toBe(true)
      expect(result.ignoredEnv).toEqual([])

      const config = configFromEnv({})
      config.orgId = result.orgId
      config.projectId = result.projectId
      config.projectName = result.projectName
      config.secret = result.secret
      expect(config.orgId).toBe(result.orgId)
      expect(config.projectId).toBe(result.projectId)
      expect(config.secret).toBe(result.secret)
      // Project keys are stored hashed, not kept in Config.
      expect(config.apiKeys).toEqual([])
      expect(instanceRecord(db)).toMatchObject({
        orgId: result.orgId,
        projectId: result.projectId,
        projectName: 'Bunwrite',
        secret: result.secret,
        apiKey: result.apiKey!,
      })
      expect(setting<{ version: number }>(db, 'env_seed')).toMatchObject({ version: 1 })
      expect(db.sqlite.query('SELECT id FROM _api_keys WHERE secret_hash = ?').get(sha256(result.apiKey!))).toBeTruthy()

      const again = bootstrapInstance(db, {})
      expect([again.orgId, again.projectId, again.projectName, again.secret, again.apiKey]).toEqual([
        result.orgId,
        result.projectId,
        result.projectName,
        result.secret,
        result.apiKey,
      ])
      expect(again.generated).toBe(false)
      expect(again.created).toBe(false)
      expect(db.sqlite.query('SELECT count(*) AS n FROM _api_keys').get()).toEqual({ n: 1 })
    } finally {
      db.sqlite.close()
    }
  })

  test('seeds a new record from the environment, importing API keys once', () => {
    const db = openDb(':memory:')
    try {
      const result = bootstrapInstance(db, {
        ORG_ID: 'org_custom',
        PROJECT_ID: 'env-project',
        PROJECT_NAME: 'Env Project',
        SECRET: 'z'.repeat(40),
        API_KEYS: 'standard_env',
      })
      expect(result.orgId).toBe('org_custom')
      expect(result.projectId).toBe('env-project')
      expect(result.projectName).toBe('Env Project')
      expect(result.secret).toBe('z'.repeat(40))
      expect(result.apiKey).toBeUndefined()
      expect(result.generated).toBe(false)
      expect(result.created).toBe(true)
      expect(result.ignoredEnv).toEqual([])
      expect(instanceRecord(db)).toMatchObject({
        orgId: 'org_custom',
        projectId: 'env-project',
        projectName: 'Env Project',
        secret: 'z'.repeat(40),
      })
      expect(db.sqlite.query('SELECT name, hint FROM _api_keys WHERE secret_hash = ?').get(sha256('standard_env'))).toEqual({
        name: 'Imported from env',
        hint: 'standard_env'.slice(0, 16),
      })

      // Once stored, a bad env value is ignored rather than validated.
      const ignored = bootstrapInstance(db, { SECRET: 'too-short' })
      expect(ignored.secret).toBe('z'.repeat(40))
      expect(ignored.ignoredEnv).toContain('SECRET')

      const fresh = openDb(':memory:')
      try {
        expect(() => bootstrapInstance(fresh, { SECRET: 'too-short' })).toThrow('SECRET must be at least 32 characters')
      } finally {
        fresh.sqlite.close()
      }
    } finally {
      db.sqlite.close()
    }
  })

  test('stored identity wins over the environment after the first start', () => {
    const db = openDb(':memory:')
    try {
      const first = bootstrapInstance(db, {})
      const override = bootstrapInstance(db, {
        ORG_ID: 'org_custom',
        PROJECT_ID: 'custom-project',
        SECRET: 'y'.repeat(40),
        API_KEYS: 'standard_custom',
      })
      expect([override.orgId, override.projectId, override.projectName, override.secret, override.apiKey]).toEqual([
        first.orgId,
        first.projectId,
        first.projectName,
        first.secret,
        first.apiKey,
      ])
      expect(override.ignoredEnv).toEqual(expect.arrayContaining(['ORG_ID', 'PROJECT_ID', 'SECRET', 'API_KEYS']))
      expect(instanceRecord(db)).toMatchObject({ orgId: first.orgId, projectId: first.projectId, secret: first.secret })
      expect(db.sqlite.query('SELECT id FROM _api_keys WHERE secret_hash = ?').get(sha256('standard_custom'))).toBeNull()

      const fallback = bootstrapInstance(db, {})
      expect([fallback.orgId, fallback.projectId, fallback.secret]).toEqual([first.orgId, first.projectId, first.secret])
      expect(fallback.ignoredEnv).toEqual([])
    } finally {
      db.sqlite.close()
    }
  })

  test('imports project settings from the environment once', () => {
    const db = openDb(':memory:')
    try {
      const first = bootstrapInstance(db, {
        PROJECT_NAME: 'Toko Saya',
        ALLOWED_ORIGINS: 'shop.example.com, localhost',
        SESSION_DURATION: '2592000',
        SESSIONS_LIMIT: '3',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '465',
        SMTP_USERNAME: 'mailer',
        SMTP_PASSWORD: 'secret',
        SMTP_SECURE: 'tls',
        SMTP_SENDER_EMAIL: 'shop@example.com',
        GOOGLE_CLIENT_ID: 'google-id',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        FUNCTIONS_SKIP_SCHEDULES: 'cron,digest',
      })
      expect(first.projectName).toBe('Toko Saya')
      expect(setting(db, 'project')).toEqual({
        projectName: 'Toko Saya',
        allowedOrigins: ['shop.example.com', 'localhost'],
        sessionDuration: 2592000,
        sessionsLimit: 3,
      })
      expect(setting<Record<string, unknown>>(db, 'smtp')).toMatchObject({
        host: 'smtp.example.com',
        port: 465,
        user: 'mailer',
        password: 'secret',
        secure: true,
        senderEmail: 'shop@example.com',
      })
      expect(setting<Record<string, unknown>>(db, 'google')).toMatchObject({ clientId: 'google-id', clientSecret: 'google-secret' })
      expect(setting(db, 'functions')).toEqual({ skipSchedules: ['cron', 'digest'] })

      // A later environment change does not rewrite console-managed settings.
      const again = bootstrapInstance(db, {
        PROJECT_NAME: 'Another name',
        ALLOWED_ORIGINS: 'other.example.com',
        SESSION_DURATION: '60',
        SESSIONS_LIMIT: '1',
        SMTP_HOST: 'other.example.com',
        GOOGLE_CLIENT_ID: 'other-id',
        GOOGLE_CLIENT_SECRET: 'other-secret',
      })
      expect(again.projectName).toBe('Toko Saya')
      expect(again.ignoredEnv).toEqual(expect.arrayContaining(['PROJECT_NAME', 'ALLOWED_ORIGINS', 'SESSION_DURATION', 'SESSIONS_LIMIT', 'SMTP_*', 'GOOGLE_*']))
      expect(setting<Record<string, unknown>>(db, 'project')).toMatchObject({ projectName: 'Toko Saya', allowedOrigins: ['shop.example.com', 'localhost'] })
      expect(setting<Record<string, unknown>>(db, 'smtp')).toMatchObject({ host: 'smtp.example.com' })
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
      expect(instanceRecord(db)).toMatchObject({ projectName: result.projectName })
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
