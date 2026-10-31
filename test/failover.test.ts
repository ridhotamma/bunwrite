import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { runFailover } from '~/failover/restore'
import { projectFolder, projectPaths } from '~/projects/paths'

const dirs: string[] = []
const savedEnv = new Map<string, string | undefined>()

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunwrite-failover-'))
  dirs.push(dir)
  return dir
}

function fixtureControl(path: string): void {
  const db = new Database(path)
  db.run('CREATE TABLE _projects (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL)')
  db.run("INSERT INTO _projects (id) VALUES ('p1')")
  db.close()
}

function fixtureProject(path: string): void {
  const db = new Database(path)
  db.run('CREATE TABLE docs (value TEXT)')
  db.run("INSERT INTO docs (value) VALUES ('restored')")
  db.close()
}

function fakeLitestream(dir: string): string {
  const bin = join(dir, 'litestream')
  writeFileSync(
    bin,
    `#!/bin/sh
case "$4" in
  */p1/bunwrite.sqlite) cp "$PROJECT_FIXTURE" "$3" ;;
  *) cp "$CONTROL_FIXTURE" "$3" ;;
esac
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('failover restore', () => {
  test('path layout matches the Litestream replica layout', () => {
    const dataDir = '/app/data'
    expect(projectFolder('p1')).toBe('p1')
    expect(projectPaths(dataDir, 'p1').database).toBe('/app/data/projects/p1/bunwrite.sqlite')
    expect(projectFolder('../bad')).toStartWith('p_')
  })

  test('restores the control database, then every project database', async () => {
    const dir = tempDir()
    const controlFixture = join(dir, 'control.sqlite')
    const projectFixture = join(dir, 'project.sqlite')
    fixtureControl(controlFixture)
    fixtureProject(projectFixture)
    const databasePath = join(dir, 'data', 'bunwrite.sqlite')
    const bin = fakeLitestream(dir)
    setEnv('CONTROL_FIXTURE', controlFixture)
    setEnv('PROJECT_FIXTURE', projectFixture)

    const result = runFailover({
      databasePath,
      replicaUrl: 's3://bucket/bunwrite',
      litestreamBin: bin,
      log: () => {},
    })

    expect(result.projects).toEqual(['p1'])
    expect(result.outcomes.map((outcome) => outcome.result)).toEqual(['restored', 'restored'])
    expect(existsSync(databasePath)).toBe(true)
    expect(existsSync(projectPaths(join(dir, 'data'), 'p1').database)).toBe(true)

    const control = new Database(databasePath, { readonly: true })
    expect(control.query('SELECT id FROM _projects').all()).toEqual([{ id: 'p1' }])
    control.close()

    // The second run is a no-op unless --force is used.
    const again = runFailover({ databasePath, replicaUrl: 's3://bucket/bunwrite', litestreamBin: bin, log: () => {} })
    expect(again.outcomes.every((outcome) => outcome.result === 'skipped')).toBe(true)
  })

  test('allow-empty lets a first deployment start without a restore point', () => {
    const dir = tempDir()
    const bin = join(dir, 'missing-litestream')
    writeFileSync(bin, '#!/bin/sh\nexit 1\n')
    chmodSync(bin, 0o755)

    const result = runFailover({
      databasePath: join(dir, 'data', 'bunwrite.sqlite'),
      replicaUrl: 's3://bucket/bunwrite',
      litestreamBin: bin,
      allowEmpty: true,
      log: () => {},
    })
    expect(result.outcomes[0]?.result).toBe('missing')
    expect(result.projects).toEqual([])
  })
})
