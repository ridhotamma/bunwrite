/** Console-managed Litestream settings: files, quoting, validation and reset. */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  litestreamConfigPath,
  litestreamEnvPath,
  litestreamSettingsFromEnv,
  litestreamSettingsPath,
  readLitestreamSettings,
  resetLitestreamSettings,
  validateLitestreamSettings,
  writeLitestreamSettings,
  type LitestreamSettings,
} from '~/backups/litestream-settings'

const settings: LitestreamSettings = {
  enabled: true,
  replicaUrl: 's3://my-bucket/bunwrite/',
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: "secret'value",
  region: 'auto',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  forcePathStyle: true,
  syncInterval: '2s',
  heartbeatUrl: 'https://hc.example.com/ping/uuid',
  snapshotInterval: '12h',
  snapshotRetention: '72h',
  l0Retention: '12h',
}

describe('litestream console settings', () => {
  test('reads defaults from the server environment', () => {
    expect(
      litestreamSettingsFromEnv({
        LITESTREAM_REPLICA_URL: 's3://bucket/prefix ',
        LITESTREAM_SYNC_INTERVAL: '5s',
        LITESTREAM_S3_ENDPOINT: 'https://r2.example.com',
        LITESTREAM_S3_FORCE_PATH_STYLE: 'true',
        AWS_ACCESS_KEY_ID: 'key',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_DEFAULT_REGION: 'auto',
      }),
    ).toMatchObject({
      enabled: true,
      replicaUrl: 's3://bucket/prefix',
      syncInterval: '5s',
      endpoint: 'https://r2.example.com',
      forcePathStyle: true,
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      region: 'auto',
    })
  })

  test('writes private settings, shell env and a complete replication config', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-litestream-'))
    const database = join(root, 'bunwrite.sqlite')
    try {
      writeLitestreamSettings(database, settings)
      for (const path of [litestreamSettingsPath(database), litestreamEnvPath(database), litestreamConfigPath(database)]) {
        expect(statSync(path).mode & 0o777).toBe(0o600)
      }

      const env = readFileSync(litestreamEnvPath(database), 'utf8')
      expect(env).toContain("LITESTREAM_REPLICA_URL='s3://my-bucket/bunwrite'")
      expect(env).toContain("LITESTREAM_SYNC_INTERVAL='2s'")
      expect(env).toContain("LITESTREAM_S3_ENDPOINT='https://account.r2.cloudflarestorage.com'")
      expect(env).toContain("LITESTREAM_S3_FORCE_PATH_STYLE='true'")
      expect(env).toContain("AWS_SECRET_ACCESS_KEY='secret'\\''value'")
      expect(env).toContain(`LITESTREAM_CONFIG='${litestreamConfigPath(database)}'`)

      const yaml = readFileSync(litestreamConfigPath(database), 'utf8')
      expect(yaml).toContain(`path: ${JSON.stringify(database)}`)
      expect(yaml).toContain(`url: "s3://my-bucket/bunwrite/${'bunwrite.sqlite'}"`)
      expect(yaml).toContain('url: "s3://my-bucket/bunwrite/projects"')
      expect(yaml).toContain('endpoint: "https://account.r2.cloudflarestorage.com"')
      expect(yaml).toContain('force-path-style: true')
      expect(yaml).toContain('interval: "12h"')
      expect(yaml).toContain('retention: "72h"')
      expect(yaml).toContain('l0-retention: "12h"')
      expect(yaml).toContain('heartbeat-url: "https://hc.example.com/ping/uuid"')

      expect(readLitestreamSettings(database)).toMatchObject({
        enabled: true,
        replicaUrl: 's3://my-bucket/bunwrite',
        secretAccessKey: "secret'value",
        endpoint: 'https://account.r2.cloudflarestorage.com',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('turning replication off clears the URL and removes the generated config', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-litestream-off-'))
    const database = join(root, 'bunwrite.sqlite')
    try {
      writeLitestreamSettings(database, { ...settings, enabled: false })
      expect(readFileSync(litestreamEnvPath(database), 'utf8')).toContain("LITESTREAM_REPLICA_URL=''")
      expect(existsSync(litestreamConfigPath(database))).toBe(false)
      expect(readLitestreamSettings(database)?.enabled).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('validates replica, endpoint and durations', () => {
    expect(() => validateLitestreamSettings({ ...settings, replicaUrl: 'https://example.com' })).toThrow('s3://')
    expect(() => validateLitestreamSettings({ ...settings, syncInterval: 'soon' })).toThrow('sync interval')
    expect(() => validateLitestreamSettings({ ...settings, endpoint: 'ftp://example.com' })).toThrow('http or https')
    expect(() => validateLitestreamSettings({ ...settings, accessKeyId: '', secretAccessKey: 'secret' })).toThrow('together')
    expect(validateLitestreamSettings({ ...settings, enabled: false, replicaUrl: '' }).enabled).toBe(false)
  })

  test('reset removes every console file', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunwrite-litestream-reset-'))
    const database = join(root, 'bunwrite.sqlite')
    try {
      writeLitestreamSettings(database, settings)
      resetLitestreamSettings(database)
      for (const path of [litestreamSettingsPath(database), litestreamEnvPath(database), litestreamConfigPath(database)]) {
        expect(existsSync(path)).toBe(false)
      }
      expect(readLitestreamSettings(database)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
