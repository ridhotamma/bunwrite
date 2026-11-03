import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'bun:test'

import { ConsoleAuth } from '~/console/auth'
import { openDb, type Db } from '~/db/connection'
import { bootstrapInstance } from '~/instance/bootstrap'
import { initialiseControlStore } from '~/projects/control'
import { OrganizationService } from '~/organizations/service'
import { testConfig } from './helpers'

const dir = mkdtempSync(join(tmpdir(), 'bunwrite-control-store-'))
const legacyPath = join(dir, 'bunwrite.sqlite')
const controlPath = join(dir, 'control', 'bunwrite.sqlite')
const legacy = openDb(legacyPath)
const control = openDb(controlPath)

afterAll(() => {
  legacy.sqlite.close()
  control.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

function setting(db: Db, key: string): string | null {
  return db.sqlite.query<{ value: string }, [string]>('SELECT value FROM _settings WHERE key = ?').get(key)?.value ?? null
}

describe('control store migration', () => {
  test('moves console data and the registry off the first project database', async () => {
    bootstrapInstance(legacy, { ORG_ID: 'org_legacy', PROJECT_ID: 'legacy-project', SECRET: 's'.repeat(40) }, { projectName: 'Legacy' })
    const stamp = new Date().toISOString()
    legacy.sqlite
      .query('INSERT INTO _projects (id, name, org_id, is_default, legacy, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)')
      .run('legacy-project', 'Legacy', 'org_legacy', stamp, stamp)
    await new ConsoleAuth(legacy).upsert('owner@example.com', 'owner-password')
    await new OrganizationService(legacy).ensure('org_legacy', 'Legacy')

    const config = testConfig({ databasePath: legacyPath, controlDatabasePath: controlPath })
    const migrated = await initialiseControlStore({
      config,
      databaseOptions: { backend: 'sqlite', path: legacyPath },
      control,
      env: {},
      log: () => {},
    })
    expect(migrated.migrated).toBe(true)
    await migrated.legacy?.close()
    expect(JSON.parse(setting(control, 'instance')!)).toMatchObject({ projectId: 'console', orgId: 'org_legacy', secret: 's'.repeat(40) })
    expect(JSON.parse(setting(legacy, 'instance')!)).toMatchObject({ projectId: 'legacy-project' })

    const projects = control.sqlite.query<{ id: string; is_default: number; legacy: number }, []>('SELECT id, is_default, legacy FROM _projects').all()
    expect(projects).toEqual([{ id: 'legacy-project', is_default: 1, legacy: 1 }])
    expect(control.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM _console_admins').get()!.n).toBe(1)
    expect(control.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM _organizations').get()!.n).toBe(1)

    // Running again keeps the migrated control store and does not duplicate rows.
    const again = await initialiseControlStore({
      config,
      databaseOptions: { backend: 'sqlite', path: legacyPath },
      control,
      env: {},
      log: () => {},
    })
    expect(again.migrated).toBe(false)
    expect(control.sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM _projects').get()!.n).toBe(1)
  })

  test('the migration refuses to share one file with the project database', async () => {
    const other = openDb(join(dir, 'same.sqlite'))
    try {
      await expect(
        initialiseControlStore({
          config: testConfig({ databasePath: join(dir, 'same.sqlite'), controlDatabasePath: join(dir, 'same.sqlite') }),
          databaseOptions: { backend: 'sqlite', path: join(dir, 'same.sqlite') },
          control: other,
          env: {},
          log: () => {},
        }),
      ).rejects.toThrow('must not be the same file')
    } finally {
      other.sqlite.close()
    }
  })
})
