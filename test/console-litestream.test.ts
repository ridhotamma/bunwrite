/** The organization Backups page manages Litestream without editing .env. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { litestreamConfigPath, litestreamEnvPath, litestreamSettingsPath } from '~/backups/litestream-settings'
import { ConsoleAuth } from '~/console/auth'
import { PROJECT, startServer, type TestServer } from './helpers'

const stops: Array<{ stop: () => void; root: string }> = []

afterEach(() => {
  for (const { stop, root } of stops.splice(0)) {
    stop()
    rmSync(root, { recursive: true, force: true })
  }
})

async function open() {
  const root = mkdtempSync(join(tmpdir(), 'bunwrite-console-litestream-'))
  const database = join(root, 'bunwrite.sqlite')
  const server = startServer(undefined, {}, undefined, {}, database)
  stops.push({ stop: server.stop, root })
  const base = server.endpoint.replace(/\/v1$/, '')
  await new ConsoleAuth(server.db).upsert('admin@example.com', 'console-password')
  const login = await fetch(`${base}/console/login`, {
    method: 'POST',
    body: new URLSearchParams({ email: 'admin@example.com', password: 'console-password' }),
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  const cookie = `${login.headers.get('set-cookie')!.split(';')[0]!}; console_project=${PROJECT}`
  return { server: server as TestServer, base, cookie, database }
}

async function form(base: string, cookie: string, path: string, fields: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    body: new URLSearchParams(fields),
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  })
}

describe('console Litestream settings', () => {
  test('saves the replica configuration to private deployment files', async () => {
    const { base, cookie, database } = await open()
    const page = await (await fetch(`${base}/console/organization/backups`, { headers: { cookie } })).text()
    expect(page).toContain('Continuous replication (Litestream)')
    expect(page).toContain('name="litestreamReplicaUrl"')
    expect(page).toContain('name="litestreamSecretAccessKey"')
    expect(page).toContain('Not configured')

    const saved = await form(base, cookie, '/console/organization/backups/litestream', {
      litestreamEnabled: 'on',
      litestreamReplicaUrl: 's3://my-bucket/bunwrite',
      litestreamAccessKeyId: 'AKIA_TEST',
      litestreamSecretAccessKey: 'secret-value',
      litestreamRegion: 'auto',
      litestreamEndpoint: 'https://account.r2.cloudflarestorage.com',
      litestreamForcePathStyle: 'on',
      litestreamSyncInterval: '2s',
      litestreamHeartbeatUrl: 'https://hc.example.com/ping/uuid',
      litestreamSnapshotInterval: '24h',
      litestreamSnapshotRetention: '168h',
      litestreamL0Retention: '24h',
    })
    expect(saved.status).toBe(303)
    expect(saved.headers.get('location')).toContain('/console/organization/backups')
    for (const path of [litestreamSettingsPath(database), litestreamEnvPath(database), litestreamConfigPath(database)]) {
      expect(existsSync(path)).toBe(true)
    }

    const updated = await (await fetch(`${base}/console/organization/backups`, { headers: { cookie } })).text()
    expect(updated).toContain('Console settings saved')
    expect(updated).toContain('s3://my-bucket/bunwrite')
    expect(updated).toContain('Restart Bunwrite to apply')
    expect(updated).toContain('Reset to environment')
    // The secret is not rendered back into the page.
    expect(updated).not.toContain('secret-value')
  })

  test('reset removes the console override and its deployment files', async () => {
    const { base, cookie, database } = await open()
    await form(base, cookie, '/console/organization/backups/litestream', {
      litestreamEnabled: 'on',
      litestreamReplicaUrl: 's3://my-bucket/bunwrite',
      litestreamSyncInterval: '1s',
      litestreamSnapshotInterval: '24h',
      litestreamSnapshotRetention: '168h',
      litestreamL0Retention: '24h',
    })
    expect(existsSync(litestreamEnvPath(database))).toBe(true)

    const reset = await form(base, cookie, '/console/organization/backups/litestream/reset', {})
    expect(reset.status).toBe(303)
    for (const path of [litestreamSettingsPath(database), litestreamEnvPath(database), litestreamConfigPath(database)]) {
      expect(existsSync(path)).toBe(false)
    }
    const page = await (await fetch(`${base}/console/organization/backups`, { headers: { cookie } })).text()
    expect(page).toContain('Not configured')
    expect(page).not.toContain('Reset to environment')
  })

  test('an invalid replica URL is rejected without writing files', async () => {
    const { base, cookie, database } = await open()
    const invalid = await form(base, cookie, '/console/organization/backups/litestream', {
      litestreamEnabled: 'on',
      litestreamReplicaUrl: 'https://example.com/not-a-replica',
      litestreamSyncInterval: '1s',
      litestreamSnapshotInterval: '24h',
      litestreamSnapshotRetention: '168h',
      litestreamL0Retention: '24h',
    })
    expect(invalid.status).toBe(303)
    expect(new URL(invalid.headers.get('location')!, base).searchParams.get('err')).toContain('s3://')
    expect(existsSync(litestreamSettingsPath(database))).toBe(false)
  })
})
